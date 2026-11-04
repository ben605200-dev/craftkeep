/**
 * A bounded, replayable console buffer for one server.
 *
 * Responsibilities:
 *   - accumulate raw stdout/stderr and decode it into structured records
 *   - keep a fixed-size scrollback so long-running servers cannot OOM the app
 *   - mirror everything to `data/logs/<serverId>.log` with rotation
 *   - expose a `since(seq)` cursor so a reconnecting WebSocket client gets
 *     exactly the lines it missed instead of the whole buffer
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, ensureDirectories } from '../config.js';
import { parseLine, splitLines, applyPlayerEvent, startProgressFor } from './mcLogs.js';

const decoder = new TextDecoder('utf-8', { fatal: false });

export class ConsoleBuffer {
  /**
   * @param {string} serverId
   * @param {{ size?: number, onRecord?: (records: object[]) => void, onEvent?: (record: object) => void }} [opts]
   */
  constructor(serverId, { size = config.consoleBufferSize, onRecord, onEvent } = {}) {
    this.serverId = serverId;
    this.maxSize = Math.max(200, size);
    this.onRecord = onRecord;
    this.onEvent = onEvent;

    /** @type {object[]} */
    this.records = [];
    this.seq = 0;
    this.carry = '';
    this.decoder = decoder;

    /** @type {Map<string, {name:string, online:boolean, joinedAt?:number, leftAt?:number, ip?:string|null, reason?:string|null}>} */
    this.players = new Map();

    /** `[timestamp, count]` samples of "players online" for the sparkline. */
    this.playerHistory = [];
    this.startProgress = 0;
    this.flushTimer = null;
    this.pendingFlush = [];

    this.logStream = null;
    this.logBytes = 0;
    this.logPath = null;
    this.rotateIndex = 0;
    this._openLog();
  }

  // -- disk mirror ----------------------------------------------------------

  _openLog() {
    try {
      ensureDirectories();
      const dir = path.join(config.logsDir, 'servers');
      fs.mkdirSync(dir, { recursive: true });
      this.logPath = path.join(dir, `${this.serverId}.log`);
      if (fs.existsSync(this.logPath)) {
        const stats = fs.statSync(this.logPath);
        if (stats.size > config.logRotateBytes) {
          // Rotate: keep one previous generation.
          const rotated = `${this.logPath}.1`;
          fs.rmSync(rotated, { force: true });
          fs.renameSync(this.logPath, rotated);
          this.logBytes = 0;
        } else {
          this.logBytes = stats.size;
        }
      }
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
      this.logStream.on('error', () => {
        this.logStream = null;
      });
    } catch {
      this.logStream = null;
    }
  }

  _writeLog(record) {
    if (!this.logStream) return;
    const stamp = new Date(record.ts ?? Date.now()).toISOString();
    const line = `${stamp} [${record.stream}] ${record.text}\n`;
    this.logStream.write(line);
    this.logBytes += Buffer.byteLength(line);
    if (this.logBytes > config.logRotateBytes) {
      this.logStream.end();
      this._openLog();
    }
  }

  /** Absolute path of the on-disk log, for the "download log" action. */
  get diskPath() {
    return this.logPath;
  }

  // -- ingest ---------------------------------------------------------------

  /** Feed a raw Buffer or string straight from the child process pipe. */
  push(chunk, stream = 'stdout') {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const { lines, carry } = splitLines(this.carry, text);
    this.carry = carry;

    const added = [];
    for (const { text: raw, carriage } of lines) {
      const record = parseLine(raw, stream);
      record.ts = Date.now();
      record.seq = (this.seq += 1);
      record.serverId = this.serverId;

      if (record.kind === 'blank') continue;

      // A carriage-return rewrite replaces the previous line rather than
      // appending (progress bars, "Preparing spawn area: 42%").
      if (carriage && this.records.length && this.records[this.records.length - 1].carriage) {
        record.replaces = this.records[this.records.length - 1].seq;
        this.records.pop();
      }
      record.carriage = carriage;

      this.startProgress = Math.max(this.startProgress, startProgressFor(record.text || record.message));

      const playerAction = applyPlayerEvent(this.players, record);
      if (playerAction) {
        record.playerAction = playerAction;
        record.onlineCount = this.onlineCount;
        this.playerHistory.push([record.ts, record.onlineCount]);
        if (this.playerHistory.length > 720) this.playerHistory.shift();
      }

      this.records.push(record);
      added.push(record);
      this._writeLog(record);

      if (record.event && this.onEvent) {
        try {
          this.onEvent(record);
        } catch {
          /* listeners must never break ingestion */
        }
      }
    }

    if (this.records.length > this.maxSize) {
      this.records.splice(0, this.records.length - this.maxSize);
    }

    // Coalesce UI pushes into ~10 frames/second max.
    if (added.length) {
      this.pendingFlush.push(...added);
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          const batch = this.pendingFlush;
          this.pendingFlush = [];
          try {
            this.onRecord?.(batch);
          } catch {
            /* ignore */
          }
        }, 90);
        this.flushTimer.unref?.();
      }
    }

    return added.length;
  }

  /**
   * Prime the in-memory scrollback from the tail of the on-disk log.
   *
   * Without this, restarting the manager shows an empty console even though
   * every line is sitting in `data/logs/servers/<id>.log` — which is confusing
   * exactly when someone is trying to work out what happened.
   *
   * Records are parsed and stored but deliberately *not* re-written to the log
   * and not emitted as live events, so nothing is duplicated.
   *
   * @param {{ maxBytes?: number, maxLines?: number }} [opts]
   */
  async seedFromDisk({ maxBytes = 256 * 1024, maxLines = 2000 } = {}) {
    if (!this.logPath) return 0;

    let handle;
    try {
      const stats = await fsp.stat(this.logPath);
      if (!stats.size) return 0;

      handle = await fsp.open(this.logPath, 'r');
      const readBytes = Math.min(stats.size, maxBytes);
      const buffer = Buffer.alloc(readBytes);
      await handle.read(buffer, 0, readBytes, Math.max(0, stats.size - readBytes));

      let text = buffer.toString('utf8');
      // Drop the partial first line when we started mid-file.
      if (readBytes < stats.size) {
        const newline = text.indexOf('\n');
        text = newline === -1 ? '' : text.slice(newline + 1);
      }

      const lines = text.split('\n').filter(Boolean).slice(-maxLines);
      for (const line of lines) {
        // Written as: `<isoTimestamp> [<stream>] <raw text>`
        const match = line.match(/^(\S+)\s+\[(\w+)\]\s([\s\S]*)$/);
        const record = match
          ? { ...parseLine(match[3], match[2]), ts: Date.parse(match[1]) || Date.now() }
          : { ...parseLine(line, 'stdout'), ts: Date.now() };

        if (record.kind === 'blank') continue;
        record.seq = (this.seq += 1);
        record.serverId = this.serverId;
        record.fromDisk = true;

        // Rebuild the player roster from history so the "who is online" panel
        // is populated the moment the manager comes back up.
        const action = applyPlayerEvent(this.players, record);
        if (action) {
          record.playerAction = action;
          record.onlineCount = this.onlineCount;
          this.playerHistory.push([record.ts, record.onlineCount]);
        }

        this.startProgress = Math.max(this.startProgress, startProgressFor(record.text || record.message));
        this.records.push(record);
      }

      if (this.playerHistory.length > 720) {
        this.playerHistory.splice(0, this.playerHistory.length - 720);
      }

      return lines.length;
    } catch {
      return 0;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Drop the buffered tail (used when a start attempt fails and we retry). */
  clear() {
    this.records = [];
    this.pendingFlush = [];
    this.carry = '';
    this.startProgress = 0;
  }

  // -- read -----------------------------------------------------------------

  /** Most recent `limit` records, oldest first. */
  tail(limit = 500) {
    if (limit <= 0) return [];
    return this.records.slice(-limit);
  }

  /** Records newer than a sequence cursor (for WebSocket reconnects). */
  since(seq, limit = 2000) {
    if (!Number.isFinite(seq) || seq <= 0) return this.tail(limit);
    const index = this.records.findIndex((r) => r.seq > seq);
    if (index === -1) return [];
    return this.records.slice(index, index + limit);
  }

  get lastSeq() {
    return this.seq;
  }

  get onlineCount() {
    let n = 0;
    for (const player of this.players.values()) if (player.online) n += 1;
    return n;
  }

  onlinePlayers() {
    return [...this.players.values()].filter((p) => p.online);
  }

  allPlayers() {
    return [...this.players.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  seedPlayers(names = []) {
    for (const name of names) {
      const existing = this.players.get(name);
      this.players.set(name, { ...(existing ?? {}), name, online: existing?.online ?? false });
    }
  }

  /** Full-text search across the scrollback, newest first. */
  search(term, limit = 500) {
    const needle = String(term ?? '').toLowerCase();
    if (!needle) return [];
    const hits = [];
    for (let i = this.records.length - 1; i >= 0 && hits.length < limit; i -= 1) {
      const record = this.records[i];
      if ((record.text ?? '').toLowerCase().includes(needle)) hits.push(record);
    }
    return hits;
  }

  /** Serializable export, used by `GET /api/servers/:id/console/export`. */
  export({ format = 'text', limit } = {}) {
    const rows = this.tail(Number.isFinite(limit) ? limit : this.maxSize);
    if (format === 'json') return JSON.stringify(rows, null, 2);
    return rows
      .map((r) => `${new Date(r.ts).toISOString()} [${r.level}] ${r.text}`)
      .join('\n');
  }

  dispose() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    try {
      this.logStream?.end();
    } catch {
      /* already closed */
    }
    this.logStream = null;
  }
}

export default ConsoleBuffer;
