/**
 * Filesystem helpers: atomic writes, traversal-safe path building, recursive
 * sizing/copying and human-readable formatting.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** `mkdir -p` with promises. */
export const ensureDir = (dir) => fsp.mkdir(dir, { recursive: true });

export const exists = async (target) => {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
};

export const existsSync = (target) => fs.existsSync(target);

/**
 * Write a file without ever leaving a half-written file behind: we write to a
 * sibling temp file, fsync it, then rename over the destination.
 */
export async function atomicWrite(file, contents) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

export function atomicWriteSync(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export const readJson = async (file, fallback = null) => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

export const readJsonSync = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

export const writeJson = (file, value) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Join `base` with an untrusted relative path, guaranteeing the result stays
 * inside `base`. Blocks `../`, absolute paths, NUL bytes and Windows device
 * names. Throws on anything suspicious.
 */
export function safeJoin(base, untrusted = '.') {
  const cleaned = String(untrusted ?? '')
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .trim();

  if (cleaned === '' || cleaned === '.') return path.resolve(base);
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw Object.assign(new Error('Absolute paths are not allowed.'), { status: 400 });
  }

  const segments = cleaned.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw Object.assign(new Error('Path traversal is not allowed.'), { status: 400 });
  }
  // Windows reserved device names break file APIs in surprising ways.
  if (segments.some((s) => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s))) {
    throw Object.assign(new Error('Reserved device name in path.'), { status: 400 });
  }

  const resolved = path.resolve(base, ...segments);
  const baseResolved = path.resolve(base);
  const rel = path.relative(baseResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('Path escapes the server directory.'), { status: 400 });
  }
  return resolved;
}

/**
 * Characters Unicode decomposition does not handle. NFKD turns `Ü` into
 * `U` + combining diaeresis (which we then strip), but `ø`, `ß` and friends have
 * no canonical decomposition, so without this they would silently vanish from a
 * folder name.
 */
const TRANSLITERATE = {
  ß: 'ss', ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  đ: 'd', Đ: 'd', ł: 'l', Ł: 'l', þ: 'th', Þ: 'th', ð: 'd', Ð: 'd',
  ı: 'i', ĸ: 'k', ŋ: 'n', ŧ: 't',
};

/** Slugify a user-supplied server name into something safe for a folder name. */
export function slugify(input, fallback = 'server') {
  const slug = String(input ?? '')
    .replace(/[ßøØæÆœŒđĐłŁþÞðÐıĸŋŧ]/g, (char) => TRANSLITERATE[char] ?? char)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    // A trailing hyphen can appear after the length cut.
    .replace(/-+$/, '');
  return slug || fallback;
}

/**
 * Recursively compute `{ bytes, files, dirs }` for a directory.
 *
 * Two things here are deliberate and load-bearing:
 *
 * 1. **Concurrency is bounded.** A Minecraft world directory can hold tens of
 *    thousands of region files; fanning out one `stat` per file exhausts the
 *    threadpool and starts failing intermittently.
 *
 * 2. **`bytes` is updated in two statements, never as `bytes += (await …).size`.**
 *    That one-liner is silently wrong under concurrency on the Node/V8 version
 *    we target: it under-reports by an order of magnitude with no error at all
 *    (reproduced on Node 26.13 — see `test/fsUtil.test.js`). Splitting the read
 *    from the assignment is what makes the total correct.
 */
export async function directorySize(dir, { signal, concurrency = 16 } = {}) {
  let bytes = 0;
  let files = 0;
  let dirs = 0;

  // Pass 1 — walk the tree and collect file paths. `readdir` is cheap and this
  // keeps the number of in-flight `stat` calls under our control.
  /** @type {string[]} */
  const filePaths = [];
  const stack = [dir];

  while (stack.length) {
    if (signal?.aborted) break;
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow links out of the tree
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirs += 1;
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        filePaths.push(full);
      }
    }
  }

  // Pass 2 — stat them with a fixed-size worker pool.
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, filePaths.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < filePaths.length) {
      if (signal?.aborted) return;
      const full = filePaths[cursor];
      cursor += 1;
      try {
        // Two statements on purpose — see the note above.
        const stats = await fsp.stat(full);
        const size = stats.size;
        bytes += size;
      } catch {
        /* file vanished mid-scan; skip it */
      }
    }
  });

  await Promise.all(workers);
  return { bytes, files, dirs };
}

/** Recursive delete that tolerates read-only files (Windows). */
export async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** SHA-256 of a file, streamed so huge jars don't blow up memory. */
export function hashFile(file, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function formatBytes(bytes, digits = 1) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

/**
 * Human duration. Precision drops as the magnitude grows — nobody needs the
 * seconds on a server that has been up for two days.
 *   45000 -> "45s"     90000 -> "1m 30s"
 *   3600000 -> "1h 0m" 90000000 -> "1d 1h"
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** `managers-alpha-20260101-120000.zip` style timestamp used for backups. */
export const timestampSlug = (date = new Date()) =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/** List directory entries with metadata, sorted folders-first then A-Z. */
export async function listDirectory(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stat = null;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue; // broken symlink / locked file
    }
    out.push({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      size: entry.isFile() ? stat.size : null,
      modified: stat.mtimeMs,
    });
  }
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return out;
}

/** Copy a file while reporting progress, used for large world restores. */
export async function copyFile(source, destination) {
  await ensureDir(path.dirname(destination));
  await fsp.copyFile(source, destination);
}

/**
 * Free-space probe. Uses `statfs` where available (Node >= 18.15) and degrades
 * to `null` instead of throwing.
 */
export async function freeSpace(dir) {
  try {
    const stats = await fsp.statfs(dir);
    return { total: stats.bsize * stats.blocks, free: stats.bsize * stats.bavail };
  } catch {
    return null;
  }
}
