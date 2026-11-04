/**
 * WebSocket hub.
 *
 * One gateway, two subscription levels:
 *   - `global`  : server list + status changes + system metrics (the dashboard)
 *   - `server:X`: console lines, resource samples, player roster (one console UI)
 *
 * Traffic control matters here: a busy Paper server can emit hundreds of lines
 * per second. We therefore (a) coalesce console writes server-side in
 * `ConsoleBuffer`, (b) throttle per-client metric frames, (c) drop console
 * frames for a client that stopped reading rather than buffering without bound,
 * and (d) fall back to a client-driven `since` cursor for console recovery so a
 * reconnect can't lose lines.
 */

import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { isLive } from '../lib/processManager.js';
import createLogger from '../logger.js';

const log = createLogger('ws');

/** Timing-safe comparison so the token cannot be probed byte by byte. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

const HEARTBEAT_MS = 25_000;
const METRICS_THROTTLE_MS = 1500;
/** Bytes buffered for a slow client before we drop console frames for it. */
const BACKPRESSURE_LIMIT = 1024 * 1024;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 40;
const MAX_COMMAND_LENGTH = 1000;

export class Gateway {
  /**
   * @param {import('node:http').Server} httpServer
   * @param {{ registry: import('../lib/registry.js').ServerRegistry, scheduler: object, provisioner: object }} deps
   */
  constructor(httpServer, { registry, scheduler, provisioner }) {
    this.registry = registry;
    this.scheduler = scheduler;
    this.provisioner = provisioner;

    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      maxPayload: 512 * 1024,
      // Reject cross-origin upgrades — the browser is the only intended client.
      verifyClient: (info) => this.#verifyClient(info),
    });

    /** @type {Set<Client>} */
    this.clients = new Set();
    /** Server ids that have at least one console subscriber. */
    this.consoleSubscribers = new Map();
    /** Job progress streams, keyed by jobId. */
    this.jobs = new Map();

    this.#attachRegistryListeners();
    this.#startHeartbeat();

    log.info('WebSocket gateway listening on /ws');
  }

  // -------------------------------------------------------------------------
  // Handshake / auth
  // -------------------------------------------------------------------------

  #verifyClient({ req }) {
    // The session token is mandatory — the WebSocket carries the console and
    // command channel, so it is the most privileged surface in the app. The
    // renderer passes it as `?token=` because a WebSocket handshake cannot set
    // headers from a page.
    const url = new URL(req.url, 'http://placeholder');
    const provided = url.searchParams.get('token') ?? '';
    const header = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

    if (!safeEqual(provided, config.token) && !safeEqual(header, config.token)) {
      log.warn(`Rejected WebSocket from ${req.socket.remoteAddress}: bad or missing session token`);
      return false;
    }

    // Second gate: anything presenting a browser Origin that is not us.
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        const host = String(req.headers.host ?? '');
        const sameHost = parsed.host === host;
        const loopbackOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        if (!sameHost && !loopbackOrigin) {
          log.warn(`Rejected WebSocket from origin ${origin}`);
          return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  #attachRegistryListeners() {
    this.registry.on('console', ({ serverId, records }) => {
      if (!this.consoleSubscribers.has(serverId)) return;
      const payload = { type: 'console', serverId, records };
      for (const client of this.consoleSubscribers.get(serverId)) {
        this.#sendConsole(client, payload);
      }
    });

    this.registry.on('status', (payload) => this.broadcast({ type: 'status', ...payload }));
    this.registry.on('update', (snapshot) => this.broadcast({ type: 'server-update', server: snapshot }));
    this.registry.on('created', (snapshot) => this.broadcast({ type: 'server-created', server: snapshot }));
    this.registry.on('deleted', (payload) => this.broadcast({ type: 'server-deleted', ...payload }));
    this.registry.on('players', (payload) => {
      if (!this.consoleSubscribers.has(payload.serverId)) return;
      for (const client of this.consoleSubscribers.get(payload.serverId)) {
        this.#send(client, { type: 'players', ...payload });
      }
    });

    this.registry.on('lifecycle', (payload) => this.broadcast({ type: 'lifecycle', ...payload }));

    this.registry.on('metrics', ({ servers, system }) => {
      this.latestMetrics = { servers, system };
      const now = Date.now();
      for (const client of this.clients) {
        if (now - client.lastMetricsAt < METRICS_THROTTLE_MS) continue;
        client.lastMetricsAt = now;
        // Full-system frame for everyone; per-server readings only for the
        // servers that client actually cares about.
        const relevant = servers.filter((s) => client.subscriptions.has('global') || client.subscriptions.has(`server:${s.serverId}`));
        this.#send(client, { type: 'metrics', system, servers: relevant });
      }
    });

    this.registry.on('console-event', (payload) => {
      this.broadcast({ type: 'console-event', ...payload });
    });
  }

  #startHeartbeat() {
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (client.isAlive === false) {
          log.debug('Terminating unresponsive client');
          client.socket.terminate();
          continue;
        }
        client.isAlive = false;
        try {
          client.socket.ping();
        } catch {
          /* socket already gone */
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  handleConnection(socket, req) {
    const client = {
      id: Math.random().toString(36).slice(2, 10),
      socket,
      remote: req.socket.remoteAddress,
      subscriptions: new Set(['global']),
      isAlive: true,
      lastMetricsAt: 0,
      connectedAt: Date.now(),
    };
    this.clients.add(client);
    log.debug(`Client ${client.id} connected (${this.clients.size} total)`);

    socket.on('pong', () => {
      client.isAlive = true;
    });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        this.#send(client, { type: 'error', code: 'bad-json', message: 'Messages must be JSON.' });
        return;
      }
      this.#handleMessage(client, message).catch((error) => {
        log.error(`Handler failed for ${message?.type}: ${error.message}`);
        this.#send(client, { type: 'error', code: error.code ?? 'handler-failed', message: error.message, ref: message?.type });
      });
    });

    socket.on('close', () => {
      this.clients.delete(client);
      for (const key of client.subscriptions) {
        const set = this.consoleSubscribers.get(key.replace('server:', ''));
        set?.delete(client);
      }
      log.debug(`Client ${client.id} disconnected (${this.clients.size} total)`);
    });

    socket.on('error', (error) => log.debug(`Socket error for ${client.id}: ${error.message}`));

    this.#send(client, {
      type: 'hello',
      clientId: client.id,
      version: config.uiVersion,
      intervals: { metrics: config.statsIntervalMs },
      servers: this.registry.list(),
      system: this.registry.summary(),
      now: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  async #handleMessage(client, message) {
    switch (message?.type) {
      case 'ping':
        this.#send(client, { type: 'pong', t: message.t ?? Date.now(), now: Date.now() });
        return;

      case 'subscribe':
        return this.#subscribe(client, message);

      case 'unsubscribe':
        return this.#unsubscribe(client, message);

      case 'command':
        return this.#command(client, message);

      case 'console-since':
        return this.#replayConsole(client, message);

      case 'cancel-schedule':
        this.scheduler.cancel(message.serverId);
        return this.#send(client, { type: 'schedule-cancelled', serverId: message.serverId });

      case 'watch-job': {
        const job = this.jobs.get(message.jobId);
        if (job) this.#send(client, { type: 'job', ...job });
        return;
      }

      default:
        this.#send(client, { type: 'error', code: 'unknown-type', message: `Unknown message type "${message?.type}".` });
    }
  }

  #subscribe(client, { serverId, tail = 300 }) {
    if (client.subscriptions.size > MAX_SUBSCRIPTIONS_PER_CLIENT) {
      throw Object.assign(new Error('Too many subscriptions.'), { code: 'too-many-subs' });
    }
    if (!serverId) {
      client.subscriptions.add('global');
      this.#send(client, { type: 'subscribed', scope: 'global', system: this.registry.summary() });
      return;
    }

    const managed = this.registry.get(serverId);
    client.subscriptions.add(`server:${managed.id}`);

    if (!this.consoleSubscribers.has(managed.id)) this.consoleSubscribers.set(managed.id, new Set());
    this.consoleSubscribers.get(managed.id).add(client);

    this.#send(client, {
      type: 'subscribed',
      scope: `server:${managed.id}`,
      server: managed.snapshot(),
      players: managed.allPlayersSummary(),
      console: managed.console.tail(Math.min(Number(tail) || 300, config.consoleBufferSize)),
      lastSeq: managed.console.lastSeq,
      history: managed.history.slice(-60),
    });
  }

  #unsubscribe(client, { serverId }) {
    if (!serverId) {
      client.subscriptions.delete('global');
      return;
    }
    client.subscriptions.delete(`server:${serverId}`);
    this.consoleSubscribers.get(serverId)?.delete(client);
    this.#send(client, { type: 'unsubscribed', scope: `server:${serverId}` });
  }

  /**
   * A reconnect sends the last sequence number it saw; we replay the gap so the
   * console is never missing lines.
   */
  #replayConsole(client, { serverId, sinceSeq, limit = 2000 }) {
    const managed = this.registry.get(serverId);
    const records = managed.console.since(Number(sinceSeq) || 0, Math.min(Number(limit) || 2000, 5000));
    this.#send(client, { type: 'console', serverId, records, replayed: true, lastSeq: managed.console.lastSeq });
  }

  async #command(client, { serverId, command }) {
    const managed = this.registry.get(serverId);
    const text = String(command ?? '').slice(0, MAX_COMMAND_LENGTH);
    if (!text.trim()) return;
    if (!isLive(managed.status) || managed.adopted) {
      // Fail loudly but without closing the socket.
      this.#send(client, {
        type: 'command-result',
        serverId,
        command: text,
        ok: false,
        error: managed.adopted
          ? 'This server was adopted from a previous session — restart it from the dashboard to regain console control.'
          : 'The server is not running.',
      });
      return;
    }
    managed.send(text);
    this.#send(client, { type: 'command-result', serverId, command: text, ok: true });
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  #send(client, payload) {
    if (client.socket.readyState !== client.socket.OPEN) return;
    if (client.socket.bufferedAmount > BACKPRESSURE_LIMIT && payload.type === 'console') {
      // The client is not draining fast enough. Tell it to re-sync instead of
      // growing an unbounded send queue in memory.
      client.needsResync = true;
      return;
    }
    try {
      client.socket.send(JSON.stringify(payload));
    } catch (error) {
      log.debug(`Send failed for ${client.id}: ${error.message}`);
    }
  }

  /** Console frames are the only ones large enough to warrant a size check. */
  #sendConsole(client, payload) {
    if (client.needsResync) {
      client.needsResync = false;
      this.#send(client, { type: 'resync', serverId: payload.serverId });
      return;
    }
    this.#send(client, payload);
  }

  broadcast(payload, predicate = null) {
    for (const client of this.clients) {
      if (predicate && !predicate(client)) continue;
      this.#send(client, payload);
    }
  }

  /** Broadcast a provisioning job's progress to every connected client. */
  broadcastJob(progress) {
    if (progress.jobId) this.jobs.set(progress.jobId, progress);
    this.broadcast({ type: 'job', ...progress });
  }

  jobDone(jobId, result) {
    const payload = { jobId, status: result?.error ? 'failed' : 'complete', percent: 100, ...result };
    this.jobs.set(jobId, payload);
    this.broadcast({ type: 'job', ...payload });
    // Keep completed jobs around briefly so a late-joining client can see them.
    const cleanup = setTimeout(() => this.jobs.delete(jobId), 5 * 60 * 1000);
    cleanup.unref?.();
  }

  get stats() {
    return {
      clients: this.clients.size,
      subscriptions: [...this.consoleSubscribers.entries()].map(([id, set]) => ({ serverId: id, subscribers: set.size })),
      jobs: this.jobs.size,
    };
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      try {
        client.socket.close(1001, 'Server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.wss.close();
  }
}

export default Gateway;
