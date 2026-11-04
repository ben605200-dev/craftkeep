/**
 * Central configuration for Craftkeep.
 *
 * Everything is derived from (in order of precedence):
 *   1. real environment variables
 *   2. a `.env` file in the project root
 *   3. built-in defaults tuned for a local, single-machine install
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const ROOT_DIR = path.resolve(path.dirname(__filename), '..');

// ---------------------------------------------------------------------------
// Minimal .env loader (no dependency, never overwrites real env vars)
// ---------------------------------------------------------------------------
function loadDotEnv(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT_DIR, '.env'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const resolvePath = (value, fallback) => {
  if (!value) return fallback;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(ROOT_DIR, value);
};

/**
 * The transport between the Electron main process and its own renderer.
 *
 * This is private plumbing, not a web server: it always binds loopback, takes
 * an ephemeral port by default, and every API call and WebSocket upgrade must
 * present the per-launch session token. Only the app's own preload knows that
 * token, so nothing else on the machine — and certainly no browser — can drive
 * it. There is deliberately no way to expose it on a network.
 */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Port to listen on.
 *
 * `0` means "let the OS pick a free port", which is the default: an unguessable
 * port is one less thing to get wrong. `CRAFTKEEP_PORT` pins a specific one, which is
 * only useful for diagnostics.
 */
const PORT = toInt(process.env.CRAFTKEEP_PORT, 0);

export const config = {
  rootDir: ROOT_DIR,
  /** Port the renderer talks to. Resolved to the real value once bound. */
  port: PORT,
  /** Always loopback. There is no supported way to change this. */
  host: LOOPBACK_HOST,
  /**
   * Per-launch secret required on every `/api` request and WebSocket upgrade.
   * The desktop shell generates it and hands it to the renderer through the
   * preload bridge.
   */
  token: (process.env.CRAFTKEEP_TOKEN || '').trim(),
  /** Always true — kept so defences can assert "loopback only" explicitly. */
  isLocalOnly: true,
  /** Where the renderer was told to connect. */
  get publicUrl() {
    return `http://${this.host}:${this.port}`;
  },

  // -- Filesystem layout ----------------------------------------------------
  serversDir: resolvePath(process.env.CRAFTKEEP_SERVERS_DIR, path.join(ROOT_DIR, 'servers')),
  dataDir: resolvePath(process.env.CRAFTKEEP_DATA_DIR, path.join(ROOT_DIR, 'data')),

  /*
   * `backupsDir` and `jdkDir` default to subfolders of `dataDir`, so they are
   * getters — but they also need to be *overridable* at runtime (the Electron
   * shell points them at the OS user-data folder, since a packaged app's own
   * directory is read-only). Hence the explicit setters and backing fields.
   */
  _backupsDirOverride: null,
  _jdkDirOverride: null,

  get backupsDir() {
    return this._backupsDirOverride ?? resolvePath(process.env.CRAFTKEEP_BACKUPS_DIR, path.join(this.dataDir, 'backups'));
  },
  set backupsDir(value) {
    this._backupsDirOverride = value ? path.resolve(value) : null;
  },

  get jdkDir() {
    return this._jdkDirOverride ?? resolvePath(process.env.CRAFTKEEP_JDK_DIR, path.join(this.dataDir, 'java'));
  },
  set jdkDir(value) {
    this._jdkDirOverride = value ? path.resolve(value) : null;
  },
  get registryFile() {
    return path.join(this.dataDir, 'servers.json');
  },
  get settingsFile() {
    return path.join(this.dataDir, 'settings.json');
  },
  get cacheDir() {
    return path.join(this.dataDir, 'cache');
  },
  get logsDir() {
    return path.join(this.dataDir, 'logs');
  },
  get downloadsDir() {
    return path.join(this.dataDir, 'downloads');
  },
  get crashDir() {
    return path.join(this.dataDir, 'crash-reports');
  },

  // -- Resource tuning ------------------------------------------------------
  /** Interval between CPU/RAM samples, in milliseconds. */
  statsIntervalMs: Math.max(1000, toInt(process.env.CRAFTKEEP_STATS_INTERVAL_MS, 2000)),
  /** RAM (MiB) always left available for the OS + the manager itself. */
  reservedRamMb: Math.max(512, toInt(process.env.CRAFTKEEP_RESERVED_RAM_MB, 2048)),
  /** Upper bound for a single server heap when auto-tuning. 0 = derive from RAM. */
  maxHeapMbOverride: toInt(process.env.CRAFTKEEP_MAX_HEAP_MB, 0),
  /** Allow fetching a JDK from Adoptium when the required one is missing. */
  autoDownloadJava: toBool(process.env.CRAFTKEEP_AUTO_DOWNLOAD_JAVA, false),
  /** Additional directories to search for JDKs. */
  extraJavaDirs: (process.env.CRAFTKEEP_EXTRA_JAVA_DIRS || '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean),

  // -- Process / networking behaviour --------------------------------------
  /** How long a graceful `stop` gets before we force-kill the JVM. */
  gracefulStopMs: 30_000,
  /** How long we wait for "Done (x.xxs)!" before declaring a slow start. */
  startTimeoutMs: 300_000,
  /** Default player-facing port for a brand new server. */
  defaultMcPort: 25565,
  /** Console scrollback kept per server (in-memory ring buffer). */
  consoleBufferSize: 20_000,
  /** On-disk console log rotation size, in bytes (16 MiB). */
  logRotateBytes: 16 * 1024 * 1024,
  /** How long directory listings are cached for the version APIs. */
  versionCacheTtlMs: 10 * 60 * 1000,
  /** Retries for transient network failures against Mojang/PaperMC/Fabric. */
  httpRetries: 3,
  httpTimeoutMs: 30_000,
  /** User-Agent sent to upstream APIs. */
  userAgent: `Craftkeep/1.0.0 (${os.platform()}; Node ${process.versions.node})`,
  /** Version of the bundled web UI, surfaced to clients. */
  uiVersion: '1.0.0',
};

/**
 * Sanity-check the configuration before anything binds a socket.
 *
 * The old "you exposed this on a LAN without a token" check is gone along with
 * LAN exposure itself — the only remaining failure mode is a caller forgetting
 * to supply a session token, which would leave the API open to anything that
 * guessed the port.
 */
export function validateConfig() {
  const errors = [];
  if (!config.token || config.token.length < 16) {
    errors.push(
      'No session token was supplied.\n' +
        '         The transport is loopback-only, but it still refuses to run without one\n' +
        '         so the API can never be driven by another local process.',
    );
  }
  return errors;
}

/** Create every runtime directory the app expects. Safe to call repeatedly. */
export function ensureDirectories() {
  for (const dir of [
    config.dataDir,
    config.serversDir,
    config.backupsDir,
    config.jdkDir,
    config.cacheDir,
    config.logsDir,
    config.downloadsDir,
    config.crashDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
