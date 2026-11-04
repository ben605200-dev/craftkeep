/**
 * Preload bridge.
 *
 * This is the *only* code with access to both the page and Electron, so it
 * exposes a deliberately tiny, explicit surface — no `ipcRenderer`, no `require`,
 * no filesystem. Everything is a named function with a fixed shape.
 *
 * CommonJS on purpose: Electron preload scripts are CJS unless you go out of
 * your way, and `.cjs` keeps that true even though the package is `"type":
 * "module"`.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Wrap an IPC round-trip so the renderer sees a normal promise. */
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/*
 * Fetch the per-launch session token once, synchronously, at preload time.
 *
 * Deliberately not passed as a command-line argument: on a shared machine other
 * users can read process command lines, which would leak it. The main process
 * answers only the window it created.
 */
let sessionToken = '';
try {
  sessionToken = String(ipcRenderer.sendSync('app:token') ?? '');
} catch {
  sessionToken = '';
}

const listeners = new Map();

/**
 * Subscribe to a main-process event. Returns an unsubscribe function so views
 * can clean up (the same contract the rest of the front end uses).
 */
function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(wrapped);

  return () => {
    ipcRenderer.removeListener(channel, wrapped);
    listeners.get(channel)?.delete(wrapped);
  };
}

contextBridge.exposeInMainWorld('mcsm', {
  /** Feature flag — the UI uses this to show desktop-only affordances. */
  isDesktop: true,
  platform: process.platform,
  /**
   * Session token for the local transport. Read-only, never persisted, and
   * regenerated on every launch. This is what makes the loopback API private to
   * this window.
   */
  get token() {
    return sessionToken;
  },
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // -- Shell integration ---------------------------------------------------
  /** Open a folder or file in Explorer / Finder / the default app. */
  revealPath: (target) => invoke('shell:reveal', target),
  /** Open a URL in the user's browser, never in an app window. */
  openExternal: (url) => invoke('shell:openExternal', url),
  /** Native folder picker. Resolves to a path or null if cancelled. */
  pickFolder: (options) => invoke('dialog:pickFolder', options ?? {}),
  /** Native file picker. `filters` is a standard Electron filter array. */
  pickFile: (options) => invoke('dialog:pickFile', options ?? {}),
  /** Native notification. No-op when notifications are disabled in prefs. */
  notify: (payload) => invoke('app:notify', payload),

  // -- App control ---------------------------------------------------------
  getAppInfo: () => invoke('app:info'),
  /** Read/write desktop-only preferences (close behaviour, notifications…). */
  getPrefs: () => invoke('prefs:get'),
  setPrefs: (patch) => invoke('prefs:set', patch),
  /** Ask the main process to quit, stopping servers first. */
  quit: () => invoke('app:quit'),
  /** Live count shown on the taskbar icon. Pass 0 to clear. */
  setBadge: (count) => invoke('app:setBadge', count),
  minimize: () => invoke('window:minimize'),
  toggleMaximize: () => invoke('window:toggleMaximize'),
  /**
   * Fire-and-forget: tells the shell which server the UI is showing, so menu
   * and tray items labelled "the server in view" act on the right one.
   */
  reportCurrentServer: (serverId) => ipcRenderer.send('app:currentServer', serverId ?? null),

  // -- Events from the main process ---------------------------------------
  /** Menu items, tray commands and global shortcuts arrive here. */
  onCommand: (handler) => on('app:command', handler),
  /** Native notifications the user clicked, so the UI can navigate. */
  onNavigate: (handler) => on('app:navigate', handler),
});

// Keep the page from navigating away from the app itself (a stray drop of an
// HTML file would otherwise replace the UI), and route real links outward.
window.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    // File drops onto the console are handled by the app; only block the
    // default "navigate to the dropped file" behaviour.
    if (event.dataTransfer && event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
});
