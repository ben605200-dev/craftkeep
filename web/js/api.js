/**
 * REST client.
 *
 * Every mutating request sends `X-Requested-With: Craftkeep`,
 * which the backend requires — it also makes cross-site requests impossible,
 * since a custom header forces a CORS preflight that is never answered.
 */

export class ApiError extends Error {
  constructor(message, { status, code, detail, hint, payload } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.hint = hint;
    this.payload = payload;
  }
}

/**
 * Session token for the local transport.
 *
 * Supplied by the desktop shell through the preload bridge — generated fresh on
 * every launch, so it is never stored anywhere and cannot be copied from a URL.
 * Read lazily so it is always the current value.
 *
 * There is deliberately no fallback. Without the bridge (i.e. a plain browser
 * pointing at the port) every request is unauthenticated and the server answers
 * 401, which is exactly the intent: this is not a website.
 */
export const getAuthToken = () => {
  try {
    return window.mcsm?.token ?? '';
  } catch {
    return '';
  }
};

/** True when the shell handed us a token, i.e. we are the real app window. */
export const hasTransportToken = () => getAuthToken().length > 0;

const BASE = '/api';

async function request(method, path, { body, headers = {}, raw = false, signal, timeoutMs = 120_000 } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  const token = getAuthToken();
  const finalHeaders = {
    'x-requested-with': 'Craftkeep',
    ...headers,
  };
  if (token) finalHeaders.authorization = `Bearer ${token}`;

  let payload = body;
  if (body !== undefined && !raw && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    finalHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: finalHeaders,
      body: payload,
      signal: controller.signal,
    });

    if (response.status === 204) return null;

    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const parsed = isJson ? await response.json().catch(() => null) : await response.text();

    if (!response.ok) {
      const message = (isJson && parsed?.error) || `${method} ${path} failed (${response.status})`;
      throw new ApiError(message, {
        status: response.status,
        code: isJson ? parsed?.code : undefined,
        detail: isJson ? parsed?.detail : undefined,
        hint: isJson ? parsed?.hint : undefined,
        payload: parsed,
      });
    }

    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') {
      throw new ApiError('The request timed out or was cancelled.', { status: 0, code: 'aborted' });
    }
    throw new ApiError(
      'Could not reach the local service. Is the manager still running?',
      { status: 0, code: 'network', hint: error.message },
    );
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const get = (path, options) => request('GET', path, options);
const post = (path, body, options) => request('POST', path, { body, ...options });
const put = (path, body, options) => request('PUT', path, { body, ...options });
const patch = (path, body, options) => request('PATCH', path, { body, ...options });
const del = (path, options) => request('DELETE', path, options);

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export const api = {
  // -- Servers --------------------------------------------------------------
  listServers: () => get('/servers'),
  getServer: (id, { console: includeConsole = false, disk = false, limit = 400 } = {}) =>
    get(`/servers/${encodeURIComponent(id)}${qs({ console: includeConsole, disk, limit })}`),
  summary: () => get('/servers/summary'),
  availablePort: (start) => get(`/servers/available-port${qs({ start })}`),

  preflight: (spec) => post('/servers/preflight', spec),
  createServer: (spec, { jobId } = {}) =>
    post('/servers', spec, { timeoutMs: 45 * 60 * 1000, headers: jobId ? { 'x-job-id': jobId } : {} }),
  updateServer: (id, patchBody) => patch(`/servers/${encodeURIComponent(id)}`, patchBody),
  deleteServer: (id, { deleteFiles = false } = {}) =>
    del(`/servers/${encodeURIComponent(id)}${qs({ deleteFiles, confirm: deleteFiles ? 'yes' : undefined })}`),

  // -- Lifecycle ------------------------------------------------------------
  startServer: (id, { wait = false } = {}) => post(`/servers/${encodeURIComponent(id)}/start${qs({ wait })}`),
  stopServer: (id, { force = false } = {}) => post(`/servers/${encodeURIComponent(id)}/stop${qs({ force })}`),
  restartServer: (id) => post(`/servers/${encodeURIComponent(id)}/restart`),
  killServer: (id) => post(`/servers/${encodeURIComponent(id)}/kill`),
  cancelScheduledRestart: (id) => post(`/servers/${encodeURIComponent(id)}/cancel-schedule`),
  acceptEula: (id) => post(`/servers/${encodeURIComponent(id)}/accept-eula`),
  /** Clear `server-ip` after an UnknownHostException crash. */
  fixBindAddress: (id) => post(`/servers/${encodeURIComponent(id)}/fix/bind-address`),
  bulk: (action, ids) => post(`/servers/bulk/${action}`, { ids }),

  // -- Console --------------------------------------------------------------
  getConsole: (id, { limit = 500, search } = {}) =>
    get(`/servers/${encodeURIComponent(id)}/console${qs({ limit, search })}`),
  sendCommand: (id, command, { silent = false } = {}) =>
    post(`/servers/${encodeURIComponent(id)}/console`, { command, silent }),
  consoleExportUrl: (id, format = 'text') => `${BASE}/servers/${encodeURIComponent(id)}/console/export?format=${format}`,

  // -- Players --------------------------------------------------------------
  getPlayers: (id) => get(`/servers/${encodeURIComponent(id)}/players`),
  updatePlayer: (id, list, body) => post(`/servers/${encodeURIComponent(id)}/players/${list}`, body),

  // -- Properties -----------------------------------------------------------
  getProperties: (id) => get(`/servers/${encodeURIComponent(id)}/properties`),
  saveProperties: (id, values, { restart = false } = {}) =>
    put(`/servers/${encodeURIComponent(id)}/properties`, { values, restart }),

  // -- JVM / diagnostics ----------------------------------------------------
  getJvm: (id) => get(`/servers/${encodeURIComponent(id)}/jvm`),
  getResources: (id) => get(`/servers/${encodeURIComponent(id)}/resources`),
  pingServer: (id) => get(`/servers/${encodeURIComponent(id)}/ping`, { timeoutMs: 12_000 }),
  getDiagnostics: (id) => get(`/servers/${encodeURIComponent(id)}/diagnostics`),

  // -- Connect (getting players in from outside) ----------------------------
  getConnect: (id) => get(`/servers/${encodeURIComponent(id)}/connect`, { timeoutMs: 30_000 }),
  getForwarding: (id) => get(`/servers/${encodeURIComponent(id)}/connect/forwarding`, { timeoutMs: 30_000 }),
  addForwarding: (id) => post(`/servers/${encodeURIComponent(id)}/connect/forward`, undefined, { timeoutMs: 60_000 }),
  removeForwarding: (id) => del(`/servers/${encodeURIComponent(id)}/connect/forward`, { timeoutMs: 60_000 }),
  setFirewall: (id, action) => post(`/servers/${encodeURIComponent(id)}/connect/firewall`, { action }, { timeoutMs: 120_000 }),

  // -- Tunnel (playit.gg) ---------------------------------------------------
  getTunnel: () => get('/tunnel', { timeoutMs: 30_000 }),
  installTunnelAgent: () => post('/tunnel/install', undefined, { timeoutMs: 10 * 60 * 1000 }),
  beginTunnelClaim: (name) => post('/tunnel/claim', { name }, { timeoutMs: 60_000 }),
  cancelTunnelClaim: () => post('/tunnel/claim/cancel'),
  useTunnelSecret: (secret) => post('/tunnel/secret', { secret }),
  startTunnel: () => post('/tunnel/start', undefined, { timeoutMs: 60_000 }),
  stopTunnel: () => post('/tunnel/stop', undefined, { timeoutMs: 60_000 }),
  forgetTunnel: () => post('/tunnel/forget'),
  tunnelLog: () => get('/tunnel/log'),
  reinstall: (id, body) => post(`/servers/${encodeURIComponent(id)}/reinstall`, body, { timeoutMs: 30 * 60 * 1000 }),

  // -- Backups --------------------------------------------------------------
  listBackups: (id) => get(`/servers/${encodeURIComponent(id)}/backups`),
  createBackup: (id, { label = 'manual', includeLogs = false } = {}) =>
    post(`/servers/${encodeURIComponent(id)}/backups`, { label, includeLogs }, { timeoutMs: 60 * 60 * 1000 }),
  deleteBackup: (id, file) => del(`/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(file)}`),
  restoreBackup: (id, file, { stopFirst = false } = {}) =>
    post(`/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(file)}/restore${qs({ stopFirst })}`, undefined, {
      timeoutMs: 60 * 60 * 1000,
    }),
  backupDownloadUrl: (id, file) => `${BASE}/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(file)}/download`,

  // -- Files ----------------------------------------------------------------
  listFiles: (id, path = '') => get(`/files/${encodeURIComponent(id)}/list${qs({ path })}`),
  fileTree: (id, depth = 2) => get(`/files/${encodeURIComponent(id)}/tree${qs({ depth })}`),
  readFile: (id, path) => get(`/files/${encodeURIComponent(id)}/read${qs({ path })}`),
  writeFile: (id, path, content) => put(`/files/${encodeURIComponent(id)}/write`, { path, content }),
  deleteFile: (id, path) => del(`/files/${encodeURIComponent(id)}${qs({ path })}`),
  makeFolder: (id, path) => post(`/files/${encodeURIComponent(id)}/mkdir`, { path }),
  readLog: (id, path = 'logs/latest.log', limit = 1200) =>
    get(`/files/${encodeURIComponent(id)}/log${qs({ path, limit })}`),
  fileDownloadUrl: (id, path) => `${BASE}/files/${encodeURIComponent(id)}/download?path=${encodeURIComponent(path)}`,

  /** Raw-body upload — no multipart parsing on the server. */
  async uploadFile(id, directory, file, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `${BASE}/files/${encodeURIComponent(id)}/upload${qs({ path: directory })}`;

      xhr.open('PUT', url);
      const token = getAuthToken();
      xhr.setRequestHeader('x-requested-with', 'Craftkeep');
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress({ loaded: event.loaded, total: event.total, percent: (event.loaded / event.total) * 100 });
        }
      };
      xhr.onload = () => {
        let parsed = null;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error page */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(parsed);
        else reject(new ApiError(parsed?.error ?? `Upload failed (${xhr.status})`, { status: xhr.status, payload: parsed }));
      };
      xhr.onerror = () => reject(new ApiError('The upload failed: network error.', { status: 0 }));
      xhr.onabort = () => reject(new ApiError('Upload cancelled.', { status: 0, code: 'aborted' }));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });

      xhr.send(file);
    });
  },

  // -- Versions -------------------------------------------------------------
  platforms: () => get('/versions/platforms', { timeoutMs: 60_000 }),
  versions: (platform, { snapshots = false } = {}) =>
    get(`/versions/${encodeURIComponent(platform)}${qs({ snapshots })}`, { timeoutMs: 60_000 }),
  builds: (platform, version, { project } = {}) =>
    get(`/versions/${encodeURIComponent(platform)}/${encodeURIComponent(version)}/builds${qs({ project })}`, {
      timeoutMs: 60_000,
    }),
  plan: (spec) => post('/versions/plan', spec, { timeoutMs: 60_000 }),
  refreshVersions: () => post('/versions/refresh'),

  // -- Java -----------------------------------------------------------------
  java: ({ refresh = false } = {}) => get(`/java${qs({ refresh })}`, { timeoutMs: 90_000 }),
  javaSummary: () => get('/java/summary', { timeoutMs: 90_000 }),
  inspectJava: (path) => post('/java/inspect', { path }, { timeoutMs: 30_000 }),
  selectJava: (body) => post('/java/select', body),
  adoptiumInfo: (feature) => get(`/java/adoptium/${feature}`, { timeoutMs: 45_000 }),
  installJava: (feature, { jobId } = {}) =>
    post('/java/install', { feature, jobId }, { timeoutMs: 30 * 60 * 1000 }),

  // -- System ---------------------------------------------------------------
  system: () => get('/system'),
  storage: () => get('/system/storage'),
  systemLogs: ({ limit = 300, level, search } = {}) => get(`/system/logs${qs({ limit, level, search })}`),
  presets: () => get('/system/presets'),
  diagnostics: () => get('/system/diagnostics', { timeoutMs: 60_000 }),
  onboarding: () => get('/system/onboarding'),

  settings: () => get('/settings'),
  saveSettings: (values) => patch('/settings', values),
  resetSettings: () => post('/settings/reset'),
};

export default api;
