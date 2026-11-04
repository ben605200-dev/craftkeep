/**
 * World backups.
 *
 * A naive `zip` of a live server directory produces silently corrupt region
 * files. So we follow the standard safe procedure:
 *
 *   1. `save-off`      — suspend the chunk autosave
 *   2. `save-all flush`— force every dirty chunk to disk, then wait
 *   3. archive         — using the system `tar` (zip on Windows, tar.gz elsewhere)
 *   4. `save-on`       — always restored, even if the archive failed
 *
 * Archives land in `data/backups/<serverId>/` and are pruned to the newest N.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, ensureDirectories } from '../config.js';
import { ensureDir, directorySize, formatBytes, timestampSlug, atomicWrite } from './fsUtil.js';
import { isLive } from './processManager.js';
import createLogger from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('backup');

const IS_WINDOWS = process.platform === 'win32';

/** Directories that are pure noise in an archive. */
const EXCLUDES = ['logs', 'cache', 'crash-reports', '.fabric', 'libraries', 'versions', 'mods/.index', 'backups', '*.lock'];

/**
 * Paths that must be included even when a broad exclude rule would match.
 * `world/region` is the whole point of the backup.
 */
export const PROTECTED_PATHS = ['world', 'world_nether', 'world_the_end', 'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'config', 'mods', 'plugins', 'datapacks'];

export const backupDirFor = (serverId) => path.join(config.backupsDir, serverId);

/**
 * Create an archive of a server directory.
 *
 * @param {import('./processManager.js').ManagedServer} managed
 * @param {{ label?: string, includeLogs?: boolean, onProgress?: Function, signal?: AbortSignal }} [opts]
 */
export async function createBackup(managed, { label = null, includeLogs = false, onProgress, signal } = {}) {
  ensureDirectories();
  const dir = managed.def.dir;
  if (!fs.existsSync(dir)) {
    const error = new Error(`Server directory is missing: ${dir}`);
    error.status = 410;
    throw error;
  }

  const target = backupDirFor(managed.id);
  await ensureDir(target);

  const name = `${managed.def.slug}-${timestampSlug()}${label ? `-${label.replace(/[^a-z0-9-]/gi, '')}` : ''}${IS_WINDOWS ? '.zip' : '.tar.gz'}`;
  const archive = path.join(target, name);

  const live = isLive(managed.status) && !managed.adopted;
  const report = (stage, extra = {}) => onProgress?.({ stage, ...extra });

  const sizeBefore = await directorySize(dir).catch(() => ({ bytes: 0 }));
  report('preparing', { detail: `Source is ${formatBytes(sizeBefore.bytes)}` });

  // -- quiesce the world ---------------------------------------------------
  let resumed = false;
  if (live) {
    try {
      report('quiescing', { detail: 'Flushing chunks to disk…' });
      managed.sendMany(['save-off', 'save-all flush'], { silent: true });
      await waitForFlush(managed, 12_000);
      resumed = true;
    } catch (error) {
      log.warn(`Could not quiesce "${managed.id}" — continuing with a hot copy: ${error.message}`);
    }
  }

  try {
    report('archiving', { detail: `Writing ${name}` });
    await runTar(dir, archive, { includeLogs, signal });

    const stats = await fsp.stat(archive);
    const manifest = {
      id: path.basename(archive, path.extname(archive).replace('.tar', '')),
      file: path.basename(archive),
      path: archive,
      serverId: managed.id,
      createdAt: Date.now(),
      bytes: stats.size,
      sourceBytes: sizeBefore.bytes,
      label,
      version: managed.def.version,
      platform: managed.def.platform,
      hot: live,
      checksum: null,
    };

    await atomicWrite(`${archive}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    report('done', { archive: manifest });
    log.info(`Backup created: ${name} (${formatBytes(stats.size)}) for "${managed.id}"`);
    return manifest;
  } catch (error) {
    await fsp.rm(archive, { force: true }).catch(() => {});
    log.error(`Backup failed for "${managed.id}": ${error.message}`);
    const wrapped = new Error(`Backup failed: ${error.message}`);
    wrapped.status = 500;
    throw wrapped;
  } finally {
    if (resumed && live && managed.child) {
      try {
        managed.send('save-on', { silent: true });
      } catch {
        /* server stopped mid-backup; nothing to resume */
      }
    }
  }
}

/** Wait until the server reports the save completed (or the timeout elapses). */
function waitForFlush(managed, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const tail = managed.console.tail(40).map((r) => r.text).join('\n');
      if (/Saved the game|Saved the world|Saved .*chunks|All chunks are saved/i.test(tail) || Date.now() - started > timeoutMs) {
        // Give the OS a moment to finish the final write syscalls.
        setTimeout(resolve, 900);
        return;
      }
      setTimeout(check, 400);
    };
    setTimeout(check, 800);
  });
}

/** Run the platform archiver. `tar` ships with Windows 10 1803+, macOS and Linux. */
async function runTar(sourceDir, archive, { includeLogs = false, signal } = {}) {
  const isZip = archive.toLowerCase().endsWith('.zip');
  const excludes = EXCLUDES.filter((e) => includeLogs || e !== 'logs').map((e) => `--exclude=${e}`);

  const args = [
    ...(isZip ? ['-a', '-c', '-f', archive] : ['-c', '-z', '-f', archive]),
    ...excludes,
    '-C',
    sourceDir,
    '.',
  ];

  try {
    await execFileAsync('tar', args, {
      timeout: 60 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('Backup cancelled.');
    if (error?.code === 'ENOENT') {
      throw new Error(
        'The system `tar` command is unavailable. On Windows, `tar.exe` ships with Windows 10 1803+ — ' +
          'check that C:\\Windows\\System32 is on your PATH.',
      );
    }
    const detail = String(error?.stderr ?? error?.message ?? '').split('\n')[0];
    throw new Error(`tar exited with an error: ${detail || 'unknown error'}`);
  }

  if (!fs.existsSync(archive)) throw new Error('tar reported success but produced no archive.');
}

/** Restore an archive over a server directory (in place). */
export async function restoreBackup(managed, archivePath, { onProgress } = {}) {
  if (!fs.existsSync(archivePath)) {
    const error = new Error('That backup file no longer exists.');
    error.status = 404;
    throw error;
  }
  if (isLive(managed.status)) {
    const error = new Error('Stop the server before restoring a backup.');
    error.status = 409;
    throw error;
  }

  const dir = managed.def.dir;
  onProgress?.({ stage: 'safety-copy' });

  // Always keep a safety copy of the current state before overwriting it.
  const safety = `${path.resolve(dir)}.pre-restore-${Date.now()}`;
  await fsp.cp(dir, safety, { recursive: true, force: true, errorOnExist: false }).catch((error) => {
    log.warn(`Could not create a pre-restore safety copy: ${error.message}`);
  });

  onProgress?.({ stage: 'extracting' });
  const isZip = archivePath.toLowerCase().endsWith('.zip');
  const args = [...(isZip ? ['-x', '-f', archivePath] : ['-x', '-z', '-f', archivePath]), '-C', dir];

  try {
    await execFileAsync('tar', args, { timeout: 60 * 60 * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const wrapped = new Error(`Restore failed: ${String(error?.stderr ?? error.message).split('\n')[0]}`);
    wrapped.status = 500;
    wrapped.safetyCopy = safety;
    throw wrapped;
  }

  onProgress?.({ stage: 'done' });
  log.info(`Restored ${path.basename(archivePath)} into "${managed.id}" (safety copy at ${safety})`);
  return { restored: true, safetyCopy: safety, archive: archivePath };
}

/** Every archive for a server, newest first, enriched with sidecar metadata. */
export async function listBackups(serverId) {
  const dir = backupDirFor(serverId);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const archives = entries.filter((e) => e.isFile() && /\.(zip|tar\.gz)$/i.test(e.name));
  const out = [];

  for (const entry of archives) {
    const full = path.join(dir, entry.name);
    let stats;
    try {
      stats = await fsp.stat(full);
    } catch {
      continue;
    }
    let meta = null;
    try {
      meta = JSON.parse(await fsp.readFile(`${full}.json`, 'utf8'));
    } catch {
      /* sidecar missing — derive what we can from the filename */
    }
    out.push({
      file: entry.name,
      path: full,
      bytes: stats.size,
      createdAt: meta?.createdAt ?? stats.mtimeMs,
      label: meta?.label ?? null,
      hot: meta?.hot ?? null,
      version: meta?.version ?? null,
      serverId,
      hasMetadata: Boolean(meta),
    });
  }

  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteBackup(serverId, file) {
  const dir = backupDirFor(serverId);
  const safeName = path.basename(String(file));
  const full = path.join(dir, safeName);
  if (!full.startsWith(path.resolve(dir))) {
    const error = new Error('Invalid backup name.');
    error.status = 400;
    throw error;
  }
  await fsp.rm(full, { force: true });
  await fsp.rm(`${full}.json`, { force: true });
  return { deleted: safeName };
}

/** Keep only the newest `keep` archives for a server. */
export async function pruneBackups(serverId, keep = 7) {
  if (!Number.isFinite(keep) || keep <= 0) return { removed: [] };
  const backups = await listBackups(serverId);
  const doomed = backups.slice(keep);
  for (const backup of doomed) {
    await fsp.rm(backup.path, { force: true }).catch(() => {});
    await fsp.rm(`${backup.path}.json`, { force: true }).catch(() => {});
  }
  if (doomed.length) log.info(`Pruned ${doomed.length} old backup(s) for "${serverId}"`);
  return { removed: doomed.map((b) => b.file) };
}

/** Total disk usage of the backup store. */
export async function backupStats() {
  const summary = await directorySize(config.backupsDir).catch(() => ({ bytes: 0, files: 0 }));
  return { bytes: summary.bytes, files: summary.files, dir: config.backupsDir };
}
