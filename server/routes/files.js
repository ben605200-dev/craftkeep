/**
 * `/api/files` — a scoped file browser for server directories.
 *
 * Security model: every path is resolved through `safeJoin` against the
 * server's own directory, so nothing outside it is reachable — no symlink
 * escapes, no `..`, no absolute paths, no Windows device names.
 *
 * Content endpoints are text-only and size-capped. Uploads arrive as a raw
 * request body (`PUT` with `x-file-name`) rather than multipart, which keeps
 * the server dependency-free and makes large world-file uploads streamable.
 */

import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { asyncHandler, validateBody } from './middleware.js';
import { safeJoin, listDirectory, formatBytes, atomicWrite, directorySize, ensureDir, exists } from '../lib/fsUtil.js';
import { parseLine } from '../lib/mcLogs.js';

/** Files the UI refuses to open in the editor (binary / huge). */
const BINARY_EXTENSIONS = new Set([
  '.jar', '.zip', '.gz', '.tar', '.zst', '.mca', '.mcr', '.dat', '.dat_old', '.nbt', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ogg', '.mp3', '.wav', '.class', '.lock', '.exe', '.dll', '.so', '.dylib', '.bin', '.mca',
]);

/** Well-known files worth surfacing at the top of the browser. */
const QUICK_FILES = [
  { path: 'server.properties', label: 'server.properties', kind: 'properties' },
  { path: 'eula.txt', label: 'eula.txt', kind: 'text' },
  { path: 'ops.json', label: 'ops.json', kind: 'json' },
  { path: 'whitelist.json', label: 'whitelist.json', kind: 'json' },
  { path: 'banned-players.json', label: 'banned-players.json', kind: 'json' },
  { path: 'banned-ips.json', label: 'banned-ips.json', kind: 'json' },
  { path: 'start.bat', label: 'start.bat', kind: 'script' },
  { path: 'start.sh', label: 'start.sh', kind: 'script' },
  { path: 'latest.log', label: 'logs/latest.log', kind: 'log' },
  { path: 'configured', label: 'config/', kind: 'directory' },
  { path: 'mods', label: 'mods/', kind: 'directory' },
  { path: 'plugins', label: 'plugins/', kind: 'directory' },
  { path: 'world', label: 'world/', kind: 'directory' },
];

const MAX_EDIT_BYTES = 4 * 1024 * 1024; // 4 MiB of text is plenty for any config

export function fileRoutes({ registry }) {
  const router = express.Router();

  const resolveServer = (id) => registry.get(id);
  const safe = (managed, relative) => {
    const resolved = safeJoin(managed.def.dir, relative);
    return resolved;
  };

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  router.get('/:id/list', asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const relative = String(req.query.path ?? '');
    const target = safe(managed, relative);

    const stats = await fsp.stat(target).catch(() => null);
    if (!stats) return res.status(404).json({ error: 'That path does not exist.', code: 'not-found' });
    if (!stats.isDirectory()) return res.status(400).json({ error: 'Not a directory.', code: 'not-a-directory' });

    // NOTE: `listDirectory` returns plain objects where `isFile` / `isDirectory`
    // are already booleans — not `fs.Dirent`s with those as methods.
    const entries = await listDirectory(target);
    const withMeta = entries.map((entry) => {
      const ext = path.extname(entry.name).toLowerCase();
      return {
        ...entry,
        path: path.posix.join(String(relative).replace(/\\/g, '/'), entry.name).replace(/^\//, ''),
        extension: ext.replace('.', ''),
        editable: entry.isFile && !BINARY_EXTENSIONS.has(ext) && entry.size < MAX_EDIT_BYTES,
        formatted: entry.isFile ? formatBytes(entry.size) : null,
      };
    });

    res.json({
      path: String(relative).replace(/\\/g, '/'),
      parent: String(relative).replace(/\\/g, '/').split('/').slice(0, -1).join('/'),
      entries: withMeta,
      quickFiles: String(relative) === '' ? QUICK_FILES : [],
      root: managed.def.dir,
      totals: await directorySize(target).catch(() => ({ bytes: 0, files: 0, dirs: 0 })),
    });
  }));

  router.get('/:id/tree', asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const depth = Math.min(Number(req.query.depth) || 2, 4);

    const walk = async (dir, relative, level) => {
      if (level > depth) return [];
      let entries;
      try {
        entries = await listDirectory(dir);
      } catch {
        return [];
      }
      const out = [];
      for (const entry of entries) {
        if (out.length >= 120) break;
        // Region files are thousands of entries; collapse them into one node.
        if (/^r\.(-?\d+)\.(-?\d+)\.mca$/i.test(entry.name)) {
          if (!out.some((n) => n.name === 'region files')) {
            out.push({ name: 'region files', path: path.posix.join(relative, '(region)'), isDirectory: true, collapsed: true });
          }
          continue;
        }
        const node = {
          name: entry.name,
          path: path.posix.join(relative, entry.name),
          isDirectory: entry.isDirectory,
          size: entry.size,
          modified: entry.modified,
        };
        if (entry.isDirectory && level < depth) {
          node.children = await walk(path.join(dir, entry.name), node.path, level + 1);
        }
        out.push(node);
      }
      return out;
    };

    res.json({ tree: await walk(managed.def.dir, '', 0) });
  }));

  // -------------------------------------------------------------------------
  // Read / write text
  // -------------------------------------------------------------------------

  router.get('/:id/read', asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const target = safe(managed, req.query.path);

    const stats = await fsp.stat(target).catch(() => null);
    if (!stats) return res.status(404).json({ error: 'File not found.', code: 'not-found' });
    if (stats.isDirectory()) return res.status(400).json({ error: 'That is a directory.', code: 'is-directory' });
    if (stats.size > MAX_EDIT_BYTES) {
      return res.status(413).json({
        error: `That file is ${formatBytes(stats.size)} — too large to open in the editor.`,
        code: 'too-large',
        limit: MAX_EDIT_BYTES,
      });
    }

    const extension = path.extname(target).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) {
      return res.status(415).json({
        error: 'Binary files cannot be opened in the text editor.',
        code: 'binary',
        hint: 'Download it instead.',
        size: stats.size,
      });
    }

    const content = await fsp.readFile(target, 'utf8');
    res.json({
      path: String(req.query.path).replace(/\\/g, '/'),
      content,
      size: stats.size,
      modified: stats.mtimeMs,
      lines: content.split('\n').length,
      language: extension === '.json' ? 'json' : extension === '.properties' ? 'properties' : extension === '.yml' || extension === '.yaml' ? 'yaml' : extension === '.toml' ? 'toml' : 'text',
    });
  }));

  router.put('/:id/write', validateBody({
    path: { type: 'string', minLength: 1, maxLength: 500, optional: false },
    content: { type: 'string', maxLength: MAX_EDIT_BYTES, optional: false },
  }), asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const target = safe(managed, req.validated.path);

    // Refuse to silently overwrite a running server's region data.
    if (managed.status === 'running' && /\.mca$/i.test(target)) {
      return res.status(409).json({ error: 'Refusing to edit region files while the server is running.', code: 'locked' });
    }

    // Keep one generation of history for the files people actually break.
    const name = path.basename(target);
    if (['server.properties', 'ops.json', 'whitelist.json', 'eula.txt'].includes(name)) {
      const backup = `${target}.bak`;
      await fsp.copyFile(target, backup).catch(() => {});
    }

    await atomicWrite(target, req.validated.content);
    const stats = await fsp.stat(target);
    managed.console.push(`\n[manager] ${name} was edited in the dashboard (${formatBytes(stats.size)}).\n\n`, 'stdout');

    res.json({ ok: true, size: stats.size, modified: stats.mtimeMs });
  }));

  // -------------------------------------------------------------------------
  // Upload / download / delete / mkdir
  // -------------------------------------------------------------------------

  /**
   * Raw-body upload. The browser sends the `File` object directly as the body,
   * which avoids multipart parsing entirely and streams straight to disk.
   */
  router.put('/:id/upload', asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const directory = String(req.query.path ?? '');
    const rawName = req.get('x-file-name');

    if (!rawName) {
      return res.status(400).json({ error: 'Missing x-file-name header.', code: 'missing-filename' });
    }
    const filename = path.basename(decodeURIComponent(rawName));
    if (!filename || filename === '.' || filename === '..') {
      return res.status(400).json({ error: 'Invalid filename.', code: 'bad-filename' });
    }

    const dir = safe(managed, directory);
    await ensureDir(dir);
    const target = safeJoin(dir, filename);

    // `safeJoin` already blocked traversal; this catches the encoded variants.
    if (!target.startsWith(path.resolve(managed.def.dir))) {
      return res.status(400).json({ error: 'Upload target escapes the server directory.', code: 'bad-path' });
    }

    await fsp.writeFile(target, req.body);
    const stats = await fsp.stat(target);
    managed.console.push(`\n[manager] Uploaded ${filename} (${formatBytes(stats.size)}).\n\n`, 'stdout');

    res.status(201).json({ ok: true, file: filename, size: stats.size, formatted: formatBytes(stats.size) });
  }));

  router.get('/:id/download', asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const target = safe(managed, req.query.path);
    const stats = await fsp.stat(target).catch(() => null);
    if (!stats) return res.status(404).json({ error: 'File not found.', code: 'not-found' });
    if (stats.isDirectory()) return res.status(400).json({ error: 'Directories cannot be downloaded directly — create a backup instead.', code: 'is-directory' });
    res.download(target, path.basename(target));
  }));

  router.delete('/:id', validateBody({
    path: { type: 'string', minLength: 1, maxLength: 500, optional: false },
  }), asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const target = safe(managed, req.validated.path);
    const relative = path.relative(path.resolve(managed.def.dir), target);

    // Never allow deleting the server root itself.
    if (!relative || relative === '' || relative.startsWith('..')) {
      return res.status(400).json({ error: 'Refusing to delete the server root.', code: 'bad-path' });
    }
    const base = path.basename(target);
    if (['server.properties', 'eula.txt', managed.def.jarFile].includes(base)) {
      return res.status(409).json({
        error: `${base} is required for the server to run.`,
        code: 'protected',
        hint: 'Reinstall the server from its Settings tab if it is damaged.',
      });
    }

    const stats = await fsp.stat(target).catch(() => null);
    if (!stats) return res.status(404).json({ error: 'That path does not exist.', code: 'not-found' });

    const size = stats.isDirectory() ? (await directorySize(target).catch(() => ({ bytes: 0 }))).bytes : stats.size;
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 3 });
    managed.console.push(`\n[manager] Deleted ${relative} (${formatBytes(size)}).\n\n`, 'stdout');

    res.json({ ok: true, deleted: relative, freedBytes: size, freed: formatBytes(size) });
  }));

  router.post('/:id/mkdir', validateBody({
    path: { type: 'string', minLength: 1, maxLength: 200, optional: false },
  }), asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const target = safe(managed, req.validated.path);
    if (await exists(target)) {
      return res.status(409).json({ error: 'That folder already exists.', code: 'exists' });
    }
    await ensureDir(target);
    res.status(201).json({ ok: true, path: req.validated.path });
  }));

  // -------------------------------------------------------------------------
  // Log viewer
  // -------------------------------------------------------------------------

  /** Tail a log file with the same parser the live console uses, so colours match. */
  router.get('/:id/log', asyncHandler(async (req, res) => {
    const managed = resolveServer(req.params.id);
    const relative = String(req.query.path ?? 'logs/latest.log');
    const target = safe(managed, relative);
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);

    const stats = await fsp.stat(target).catch(() => null);
    if (!stats) return res.status(404).json({ error: 'Log file not found.', code: 'not-found' });

    // Read only the tail of large logs instead of the whole file.
    const handle = await fsp.open(target, 'r');
    try {
      const readBytes = Math.min(stats.size, 512 * 1024);
      const buffer = Buffer.alloc(readBytes);
      await handle.read(buffer, 0, readBytes, Math.max(0, stats.size - readBytes));
      let text = buffer.toString('utf8');
      if (readBytes < stats.size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
      const lines = text.split('\n').filter(Boolean).slice(-limit).map((line) => parseLine(line, 'stdout'));
      res.json({ path: relative, lines, size: stats.size, modified: stats.mtimeMs, truncated: readBytes < stats.size });
    } finally {
      await handle.close();
    }
  }));

  return router;
}

export default fileRoutes;
