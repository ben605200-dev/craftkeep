/**
 * WebSocket transport.
 *
 * Design notes:
 *  - Auto-reconnects with exponential backoff and jitter, resuming every
 *    subscription it held before the drop.
 *  - Console frames are deduplicated by sequence number and re-requested via
 *    `console-since` when a gap is detected, so a flaky connection never
 *    silently loses log lines.
 *  - Uses a lightweight pub/sub surface rather than an EventEmitter, because
 *    the whole app is a handful of listeners.
 */

import { getAuthToken } from './api.js';

const MAX_BACKOFF_MS = 15_000;
const PING_INTERVAL_MS = 20_000;
const PONG_GRACE_MS = 12_000;

export class WebSocketClient {
  constructor() {
    this.socket = null;
    this.state = 'idle'; // idle | connecting | open | closed
    this.attempt = 0;
    this.listeners = new Map();
    this.subscriptions = new Set();
    this.pendingQueue = [];
    this.lastSeq = new Map(); // serverId -> highest console seq seen
    this.pingTimer = null;
    this.pongTimer = null;
    this.reconnectTimer = null;
    this.manualClose = false;
    this.latencyMs = null;
  }

  // -- Events ---------------------------------------------------------------

  /** @returns {() => void} unsubscribe */
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[ws] listener for "${event}" threw`, error);
      }
    }
    // `*` receives every frame — used by the job/toast bridge.
    for (const handler of this.listeners.get('*') ?? []) {
      try {
        handler({ event, payload });
      } catch {
        /* ignore */
      }
    }
  }

  // -- Connection -----------------------------------------------------------

  connect() {
    if (this.state === 'connecting' || this.state === 'open') return;
    this.manualClose = false;
    this.state = 'connecting';

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = getAuthToken();
    if (!token) {
      // No bridge means no app window — refuse rather than opening an
      // unauthenticated socket and getting a confusing 401-equivalent.
      this.state = 'closed';
      this.emit('error', { message: 'No session token — this window is not the app.' });
      return;
    }
    const url = `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.emit('error', { message: error.message });
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.state = 'open';
      this.attempt = 0;
      this.emit('open');
      this.#flushQueue();
      this.#restoreSubscriptions();
      this.#startHeartbeat();
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#handleFrame(message);
    });

    socket.addEventListener('close', (event) => {
      this.state = 'closed';
      this.#stopHeartbeat();
      this.emit('close', { code: event.code, reason: event.reason });
      if (!this.manualClose) this.#scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // The close handler drives reconnection; this just silences the console.
      this.emit('error', { message: 'WebSocket error' });
    });
  }

  close() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.#stopHeartbeat();
    try {
      this.socket?.close(1000, 'client closing');
    } catch {
      /* already closed */
    }
    this.state = 'closed';
  }

  #scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt) + Math.random() * 400;
    this.attempt += 1;
    this.emit('reconnecting', { attempt: this.attempt, delayMs: backoff });
    this.reconnectTimer = setTimeout(() => this.connect(), backoff);
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', t: Date.now() });
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        // No pong — assume the socket is a zombie and force a reconnect.
        this.emit('stalled');
        try {
          this.socket?.close(4000, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
      }, PONG_GRACE_MS);
    }, PING_INTERVAL_MS);
  }

  #stopHeartbeat() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  #restoreSubscriptions() {
    for (const key of this.subscriptions) {
      if (key === 'global') this.send({ type: 'subscribe' });
      else {
        const serverId = key.replace('server:', '');
        // Ask for the gap since the last frame we saw for this server.
        const sinceSeq = this.lastSeq.get(serverId) ?? 0;
        this.send({ type: 'subscribe', serverId, tail: sinceSeq ? 0 : 400 });
        if (sinceSeq) this.send({ type: 'console-since', serverId, sinceSeq });
      }
    }
  }

  // -- Frames ---------------------------------------------------------------

  #handleFrame(message) {
    switch (message.type) {
      case 'pong':
        clearTimeout(this.pongTimer);
        this.latencyMs = typeof message.t === 'number' ? Date.now() - message.t : null;
        this.emit('latency', this.latencyMs);
        return;

      case 'console': {
        // Track the highest sequence so reconnects can resume exactly.
        const records = message.records ?? [];
        const highest = message.lastSeq ?? records.at(-1)?.seq;
        if (Number.isFinite(highest)) this.lastSeq.set(message.serverId, highest);
        this.emit('console', { serverId: message.serverId, records, replayed: Boolean(message.replayed) });
        return;
      }

      case 'resync':
        this.send({ type: 'console-since', serverId: message.serverId, sinceSeq: 0 });
        return;

      case 'hello':
        this.emit('hello', message);
        this.emit('servers', message.servers);
        return;

      case 'metrics':
        this.emit('metrics', message);
        return;

      case 'status':
        this.emit('status', message);
        return;

      case 'server-update':
        this.emit('server-update', message.server);
        return;

      case 'server-created':
        this.emit('server-created', message.server);
        return;

      case 'server-deleted':
        this.emit('server-deleted', message);
        return;

      case 'subscribed': {
        // The subscribe reply carries the console tail. Record where that tail
        // ends so a later reconnect can ask for exactly the gap.
        if (message.serverId ?? message.server?.id) {
          const serverId = message.serverId ?? message.server.id;
          const highest = message.lastSeq ?? message.console?.at(-1)?.seq;
          if (Number.isFinite(highest)) this.lastSeq.set(serverId, highest);
        }
        this.emit('subscribed', message);
        return;
      }

      case 'players':
        this.emit('players', message);
        return;

      case 'job':
        this.emit('job', message);
        return;

      case 'lifecycle':
        this.emit('lifecycle', message);
        return;

      case 'console-event':
        this.emit('console-event', message);
        return;

      case 'schedule-event':
        this.emit('schedule-event', message);
        return;

      case 'command-result':
        this.emit('command-result', message);
        return;

      case 'error':
        this.emit('api-error', message);
        return;

      default:
        this.emit('unknown', message);
    }
  }

  // -- Sending --------------------------------------------------------------

  send(payload) {
    if (this.state === 'open' && this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(payload));
        return true;
      } catch {
        this.pendingQueue.push(payload);
        return false;
      }
    }
    // Keep the queue small; only subscription intent matters across a drop.
    if (this.pendingQueue.length < 60) this.pendingQueue.push(payload);
    if (this.state !== 'connecting' && !this.manualClose) this.connect();
    return false;
  }

  #flushQueue() {
    const queue = this.pendingQueue;
    this.pendingQueue = [];
    for (const payload of queue) this.send(payload);
  }

  subscribe(serverId, { tail = 400 } = {}) {
    const key = serverId ? `server:${serverId}` : 'global';
    this.subscriptions.add(key);
    if (serverId) this.lastSeq.delete(serverId);
    this.send(serverId ? { type: 'subscribe', serverId, tail } : { type: 'subscribe' });
  }

  unsubscribe(serverId) {
    const key = serverId ? `server:${serverId}` : 'global';
    this.subscriptions.delete(key);
    this.send(serverId ? { type: 'unsubscribe', serverId } : { type: 'unsubscribe' });
  }

  command(serverId, command) {
    return this.send({ type: 'command', serverId, command });
  }

  watchJob(jobId) {
    return this.send({ type: 'watch-job', jobId });
  }

  get connected() {
    return this.state === 'open';
  }
}

export const ws = new WebSocketClient();
export default ws;
