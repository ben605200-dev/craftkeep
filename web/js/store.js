/**
 * Application state.
 *
 * A tiny observable store — deliberately not a framework. Views subscribe to
 * the slices they care about and re-render only those, which keeps the console
 * (hundreds of frames/second) from re-rendering the sidebar.
 */

import ws from './ws.js';
import api from './api.js';

const listeners = new Map();

export const state = {
  /** @type {Map<string, object>} serverId -> live snapshot */
  servers: new Map(),
  system: null,
  summary: null,
  settings: null,
  platforms: null,

  /** Live metrics keyed by serverId (kept out of `servers` to avoid churn). */
  metrics: new Map(),
  systemMetrics: { cpuPercent: 0, memory: null },

  connection: { state: 'idle', latencyMs: null, attempt: 0, since: null },
  bootedAt: Date.now(),
  activeServerId: null,
  onboarding: null,
  java: null,
};

// ---------------------------------------------------------------------------
// Pub/sub
// ---------------------------------------------------------------------------

/**
 * Subscribe to a topic. Returns an unsubscribe function.
 * Special topics: `*` (everything), `servers` (any list change).
 */
export function subscribe(topic, handler) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(handler);
  return () => listeners.get(topic)?.delete(handler);
}

export function publish(topic, payload) {
  for (const handler of listeners.get(topic) ?? []) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[store] listener for "${topic}" threw`, error);
    }
  }
  if (topic !== '*') publish('*', { topic, payload });
}

// ---------------------------------------------------------------------------
// Derived selectors
// ---------------------------------------------------------------------------

export const getServer = (id) => state.servers.get(String(id)) ?? null;

export const serverList = () =>
  [...state.servers.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

export const runningServers = () => serverList().filter((s) => ['running', 'starting', 'stopping'].includes(s.status));

export const getMetrics = (id) => state.metrics.get(String(id)) ?? null;

export const totalOnlinePlayers = () => serverList().reduce((sum, s) => sum + (s.onlineCount ?? 0), 0);

/** Latest rolling metrics for a server, from either source. */
export function metricsFor(id) {
  const live = getMetrics(id);
  if (live) return live;
  const server = getServer(id);
  if (!server) return null;
  return {
    serverId: server.id,
    status: server.status,
    cpuPercent: server.metrics?.cpuPercent ?? 0,
    rssBytes: server.metrics?.rssBytes ?? 0,
    rssMb: Math.round((server.metrics?.rssBytes ?? 0) / 1024 / 1024),
    heapMaxMb: server.memory?.maxHeapMb ?? null,
    uptimeMs: server.uptimeMs ?? 0,
    onlineCount: server.onlineCount ?? 0,
    sampledAt: server.metrics?.sampledAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function upsertServer(snapshot, { silent = false } = {}) {
  if (!snapshot?.id) return null;
  const previous = state.servers.get(snapshot.id) ?? null;
  const merged = { ...(previous ?? {}), ...snapshot };
  state.servers.set(snapshot.id, merged);
  if (!silent) publish('servers', { type: previous ? 'update' : 'add', server: merged, previous });
  return merged;
}

export function setServers(list, { silent = false } = {}) {
  const incoming = new Set();
  for (const snapshot of list ?? []) {
    if (!snapshot?.id) continue;
    incoming.add(snapshot.id);
    state.servers.set(snapshot.id, { ...(state.servers.get(snapshot.id) ?? {}), ...snapshot });
  }
  for (const id of [...state.servers.keys()]) {
    if (!incoming.has(id)) {
      state.servers.delete(id);
      state.metrics.delete(id);
    }
  }
  if (!silent) publish('servers', { type: 'reset', servers: serverList() });
}

export function removeServer(id) {
  state.servers.delete(String(id));
  state.metrics.delete(String(id));
  publish('servers', { type: 'remove', id: String(id) });
}

export function patchServer(id, patch) {
  const existing = state.servers.get(String(id));
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  state.servers.set(String(id), merged);
  publish('servers', { type: 'patch', server: merged });
  return merged;
}

export function setMetrics(serverId, metrics) {
  state.metrics.set(String(serverId), metrics);
  publish(`metrics:${serverId}`, metrics);
}

// ---------------------------------------------------------------------------
// Live wiring
// ---------------------------------------------------------------------------

let wired = false;

/** Connect the store to the WebSocket feed. Safe to call once. */
export function wireLive() {
  if (wired) return;
  wired = true;

  ws.on('hello', (message) => {
    setServers(message.servers);
    state.summary = message.system ?? null;
    state.connection = { ...state.connection, state: 'open', since: Date.now(), attempt: 0 };
    publish('connection', state.connection);
    publish('hello', message);
  });

  ws.on('servers', (list) => setServers(list));

  ws.on('open', () => {
    state.connection = { ...state.connection, state: 'open', attempt: 0, since: Date.now() };
    publish('connection', state.connection);
  });

  ws.on('reconnecting', ({ attempt, delayMs }) => {
    state.connection = { ...state.connection, state: 'reconnecting', attempt, delayMs };
    publish('connection', state.connection);
  });

  ws.on('close', () => {
    state.connection = { ...state.connection, state: 'closed' };
    publish('connection', state.connection);
  });

  ws.on('latency', (latencyMs) => {
    state.connection = { ...state.connection, latencyMs };
    publish('latency', latencyMs);
  });

  ws.on('metrics', (message) => {
    for (const sample of message.servers ?? []) {
      state.metrics.set(sample.serverId, sample);
      publish(`metrics:${sample.serverId}`, sample);
    }
    state.systemMetrics = message.system ?? state.systemMetrics;
    publish('metrics', message);
  });

  ws.on('status', (payload) => {
    const server = patchServer(payload.serverId, {
      status: payload.status,
      failure: payload.failure ?? (payload.status === 'running' ? null : undefined),
    });
    if (server) publish('status', { ...payload, server });
  });

  ws.on('server-update', (snapshot) => upsertServer(snapshot));
  ws.on('server-created', (snapshot) => {
    upsertServer(snapshot);
    publish('server-created', snapshot);
  });
  ws.on('server-deleted', ({ serverId, id }) => {
    removeServer(serverId ?? id);
    publish('server-deleted', { serverId: serverId ?? id });
  });

  ws.on('lifecycle', (payload) => {
    patchServer(payload.serverId, {
      ...(payload.phase === 'started' ? { status: 'starting', startedAt: Date.now() } : {}),
      ...(payload.phase === 'stopped' ? { status: 'stopped', uptimeMs: 0, pid: null } : {}),
      ...(payload.phase === 'crashed' ? { status: 'crashed', failure: payload.failure } : {}),
    });
    publish('lifecycle', payload);
  });

  ws.on('players', (payload) => {
    patchServer(payload.serverId, {
      onlinePlayers: payload.players?.online ?? [],
      onlineCount: payload.players?.onlineCount ?? 0,
      playerHistory: payload.players?.history ?? undefined,
    });
    publish('players', payload);
  });

  ws.on('console-event', (payload) => {
    // Keep the roster badge honest even when the players frame is throttled.
    if (payload.type === 'join' || payload.type === 'leave') {
      const server = getServer(payload.serverId);
      if (server && typeof payload.onlineCount === 'number') {
        patchServer(payload.serverId, { onlineCount: payload.onlineCount });
      }
    }
    publish('console-event', payload);
  });

  ws.on('schedule-event', (payload) => publish('schedule-event', payload));
  ws.on('job', (payload) => publish('job', payload));

  ws.connect();
}

// ---------------------------------------------------------------------------
// Bootstrap fetches
// ---------------------------------------------------------------------------

export async function loadSettings() {
  try {
    state.settings = await api.settings();
    publish('settings', state.settings);
    return state.settings;
  } catch (error) {
    console.warn('[store] settings load failed', error.message);
    return null;
  }
}

export async function loadPlatforms({ force = false } = {}) {
  if (state.platforms && !force) return state.platforms;
  state.platforms = await api.platforms();
  publish('platforms', state.platforms);
  return state.platforms;
}

export async function loadServers() {
  const result = await api.listServers();
  setServers(result.servers);
  state.summary = result.summary ?? state.summary;
  publish('summary', state.summary);
  return result;
}

export async function refreshSystem() {
  const info = await api.system();
  state.system = info;
  state.summary = info.servers ?? state.summary;
  state.java = info.java ?? state.java;
  publish('system', info);
  return info;
}

export default state;
