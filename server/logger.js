/**
 * Tiny zero-dependency structured logger.
 *
 * - Colourised, aligned console output for humans.
 * - Writes a machine-readable JSONL mirror to `data/logs/manager.log` (rotated).
 * - Keeps the last N records in memory so the UI can show a diagnostics panel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirectories } from './config.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const activeLevel = LEVELS[(process.env.MCSM_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[97m',
};
const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (text, ...codes) => (colorEnabled ? `${codes.join('')}${text}${ANSI.reset}` : text);

const MEMORY_LIMIT = 1000;
const memoryLog = [];

let logStream = null;
let logStreamBytes = 0;
let logStreamDay = '';

function streamFor(now) {
  const day = now.toISOString().slice(0, 10);
  if (logStream && logStreamDay === day) return logStream;
  try {
    logStream?.end();
    ensureDirectories();
    const file = path.join(config.logsDir, `manager-${day}.log`);
    logStream = fs.createWriteStream(file, { flags: 'a' });
    logStreamDay = day;
    logStreamBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    logStream = null;
  }
  return logStream;
}

function writeFileLine(line) {
  const stream = streamFor(new Date());
  if (!stream) return;
  stream.write(line);
  logStreamBytes += Buffer.byteLength(line);
  if (logStreamBytes > config.logRotateBytes) {
    // Recycle the stream; the next write opens a fresh, timestamped file.
    logStreamDay = '';
    logStream.end();
    logStream = null;
    logStreamBytes = 0;
  }
}

function formatArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function emit(level, scope, args) {
  if (LEVELS[level] < activeLevel) return;
  const now = new Date();
  const time = now.toISOString().slice(11, 23);
  const message = formatArgs(args);

  const record = { ts: now.toISOString(), level, scope, message };
  memoryLog.push(record);
  if (memoryLog.length > MEMORY_LIMIT) memoryLog.splice(0, memoryLog.length - MEMORY_LIMIT);

  writeFileLine(`${JSON.stringify(record)}\n`);

  const tag = paint(level.toUpperCase().padEnd(5), ANSI[level], ANSI.bold);
  const label = paint(`[${scope}]`.padEnd(14), ANSI.dim);
  const out = `${paint(time, ANSI.dim)} ${tag} ${label} ${message}`;
  if (LEVELS[level] >= LEVELS.error) process.stderr.write(`${out}\n`);
  else process.stdout.write(`${out}\n`);
}

function createLogger(scope) {
  return {
    scope,
    trace: (...a) => emit('trace', scope, a),
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    fatal: (...a) => emit('fatal', scope, a),
    /** Child logger with a nested scope, e.g. `servers.alpha`. */
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Read back recent in-memory records for the diagnostics endpoint. */
export const recentLogs = (limit = 300) => memoryLog.slice(-limit);

/**
 * The default export is the *factory* — every module does
 * `import createLogger from '../logger.js'` and calls it with its own scope.
 * The shared application logger is available as the named export `logger`.
 */
export const logger = createLogger('app');
export { createLogger };
export default createLogger;
