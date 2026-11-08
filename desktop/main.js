/**
 * Electron main process — the desktop shell.
 *
 * Responsibilities, in order:
 *   1. Take the single-instance lock, so a second launch focuses the first.
 *   2. Decide where servers and data live (the OS user-data folder when
 *      packaged, the repo when running from source).
 *   3. Boot the backend *in this process* by importing `startManager()` — this
 *      is the only caller, so there is no second implementation to keep in sync.
 *   4. Show a splash while that happens, then swap in the real window.
 *   5. Keep the app alive in the tray when the window closes, because servers
 *      are supposed to outlive the window.
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Notification,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  Menu,
} from 'electron';

import { startManager } from '../server/index.js';
import { buildAppMenu } from './menu.js';
import { AppTray, setBadge } from './tray.js';
import desktopConfig from './config.js';
import { adoptLegacyUserData } from './userData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ICON_PATH = path.join(__dirname, 'icons', 'icon.png');

/** Seconds to wait for the backend before giving up on the splash. */
const BOOT_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Identity — must happen before anything reads a path
// ---------------------------------------------------------------------------

const PRODUCT_NAME = 'Craftkeep';

/**
 * The app shipped briefly under this name; user data may still live there.
 * @see adoptLegacyUserData
 */
const LEGACY_PRODUCT_NAME = 'Minecraft Server Manager';

app.setName(PRODUCT_NAME);
app.setAppUserModelId('com.craftkeep.desktop');

/*
 * Pin `userData` explicitly.
 *
 * Electron derives it from `app.getName()`, but Chromium resolves some paths
 * during startup — before this module runs — so relying on `setName()` alone
 * left the folder named after the npm package (`craftkeep`) instead of the
 * product. Setting the path is deterministic either way.
 */
if (process.platform !== 'darwin') {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), PRODUCT_NAME));
  } catch {
    /* not fatal — we simply keep Electron's default location */
  }
}

/*
 * Adopt data from the previous name.
 *
 * Servers, backups, logs, downloaded JDKs and window preferences all live in
 * the user-data folder, which is derived from the product name. Renaming the
 * app would otherwise look like a factory reset, so on first launch under the
 * new name those entries are moved across. The mechanics live in
 * `desktop/userData.js`, where they are covered by tests.
 */
if (process.platform !== 'darwin') {
  const adopted = adoptLegacyUserData({
    targetDir: app.getPath('userData'),
    legacyDir: path.join(app.getPath('appData'), LEGACY_PRODUCT_NAME),
  });
  if (adopted.moved.length) {
    console.log(`[desktop] adopted user data from the previous name: ${adopted.moved.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // Another copy owns the servers. Hand over and exit quietly.
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Where servers and data live.
 *
 * Packaged: the OS user-data folder — an installed app's own directory is
 * read-only (and inside an asar archive), so writing there would fail.
 * From source: the repository, so `npm run app` works against the checkout you
 * are editing. An explicit CRAFTKEEP_* environment variable always wins.
 */
function resolvePaths() {
  const fromEnv = (key) => (process.env[key] ? path.resolve(process.env[key]) : null);

  if (!app.isPackaged) {
    return {
      root: REPO_ROOT,
      servers: fromEnv('CRAFTKEEP_SERVERS_DIR') ?? path.join(REPO_ROOT, 'servers'),
      data: fromEnv('CRAFTKEEP_DATA_DIR') ?? path.join(REPO_ROOT, 'data'),
      readme: path.join(REPO_ROOT, 'README.md'),
      mode: 'development',
    };
  }

  const userData = app.getPath('userData');
  const data = fromEnv('CRAFTKEEP_DATA_DIR') ?? path.join(userData, 'data');
  return {
    root: userData,
    servers: fromEnv('CRAFTKEEP_SERVERS_DIR') ?? path.join(userData, 'servers'),
    data,
    readme: path.join(REPO_ROOT, 'README.md'),
    mode: 'packaged',
  };
}

const paths = resolvePaths();
const backups = path.join(paths.data, 'backups');
const logs = path.join(paths.data, 'logs');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let manager = null;
let mainWindow = null;
let splashWindow = null;
let tray = null;
let quitting = false;
let bootFailed = false;

/**
 * Per-launch session token for the renderer↔main transport.
 *
 * Regenerated every start, never written to disk. It is the only thing that
 * makes the loopback API private to this app's window — anything else on the
 * machine, including a browser, gets 401 without it.
 */
const sessionToken = crypto.randomBytes(32).toString('base64url');
/** Route the renderer is showing, so "the server in view" menu items work. */
let currentServerId = null;
let runningCount = 0;

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 340,
    height: 250,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    transparent: false,
    backgroundColor: '#08090c',
    icon: ICON_PATH,
    title: 'Craftkeep',
    // No untrusted content: the preload writes into the DOM directly.
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow?.show());
  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  return splashWindow;
}

function splashStatus(message, error = false) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  splashWindow.webContents.send('splash:status', { message, error });
}

function createMainWindow(url, { route = null } = {}) {
  const prefs = desktopConfig.get();
  const bounds = prefs.window ?? {};

  mainWindow = new BrowserWindow({
    width: bounds.width ?? 1440,
    height: bounds.height ?? 940,
    x: bounds.x ?? undefined,
    y: bounds.y ?? undefined,
    minWidth: 940,
    minHeight: 640,
    show: false,
    // A plain native frame. It matches platform expectations (snap, aero
    // snap, accessibility) and there is no custom titlebar to get wrong.
    frame: true,
    backgroundColor: '#08090c',
    icon: ICON_PATH,
    title: 'Craftkeep',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // The console is a legitimate reason to keep rendering in the background.
      backgroundThrottling: true,
    },
  });

  if (bounds.maximized) mainWindow.maximize();

  /*
   * Tell the backend when nobody is looking.
   *
   * While the window is hidden, minimised or simply not focused — the normal
   * state while a game is fullscreen — the manager stops per-process sampling.
   * On Windows that sampling is a PowerShell process spawn every couple of
   * seconds, competing with whatever else the machine is doing.
   */
  const syncSamplingMode = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const background = !mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused();
    manager?.registry?.setBackgroundMode?.(background);
  };
  for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) {
    mainWindow.on(event, syncSamplingMode);
  }
  syncSamplingMode();

  // Load the backend URL. A `--route` argument opens straight onto a page.
  mainWindow.loadURL(route ? `${url}/${route}` : url);

  /*
   * Reveal the app, exactly once.
   *
   * `ready-to-show` is the intended trigger, but it is not guaranteed to fire
   * (it depends on the renderer producing a first paint, which can be delayed
   * or skipped). If it never fires, the splash stays up and the main window —
   * created hidden — is never shown, so the app appears to hang on the splash
   * forever while actually running fine behind it. Three independent triggers,
   * whichever comes first, and only one of them ever wins.
   */
  let revealed = false;
  const reveal = () => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    mainWindow.show();
    mainWindow.focus();
  };

  mainWindow.once('ready-to-show', reveal);
  mainWindow.webContents.once('did-finish-load', reveal);
  const revealFallback = setTimeout(reveal, 15_000);
  revealFallback.unref?.();
  mainWindow.once('closed', () => clearTimeout(revealFallback));

  // -- Geometry persistence ------------------------------------------------
  const remember = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const normal = mainWindow.getNormalBounds();
    desktopConfig.set({ window: { ...normal, maximized } });
  };
  mainWindow.on('resize', remember);
  mainWindow.on('move', remember);
  mainWindow.on('maximize', remember);
  mainWindow.on('unmaximize', remember);

  // -- Close means hide ----------------------------------------------------
  mainWindow.on('close', (event) => {
    if (quitting) return;
    const prefs = desktopConfig.get();

    if (prefs.closeAction === 'quit') {
      event.preventDefault();
      requestQuit();
      return;
    }

    event.preventDefault();
    mainWindow.hide();

    // Explain the behaviour once, so the window does not seem to vanish.
    if (!prefs.trayHintShown) {
      desktopConfig.set({ trayHintShown: true }, { immediate: true });
      if (Notification.isSupported()) {
        const note = new Notification({
          title: 'Still running in the tray',
          body: runningCount
            ? `Your ${runningCount} server${runningCount === 1 ? '' : 's'} keep running. Click the tray icon to bring the window back.`
            : 'Click the tray icon to bring the window back. Use Quit to exit completely.',
          icon: nativeImage.createFromPath(ICON_PATH),
          silent: true,
        });
        note.on('click', () => showWindow());
        note.show();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the real browser, never as an app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  // Block in-app navigation away from the local service.
  mainWindow.webContents.on('will-navigate', (event, target) => {
    const allowed = manager && target.startsWith(manager.url);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/i.test(target)) shell.openExternal(target);
    }
  });

  // A renderer crash should offer a reload rather than a blank window.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[desktop] renderer gone:', details.reason);
    if (details.reason === 'clean-exit') return;
    dialog
      .showMessageBox({
        type: 'error',
        title: 'The window stopped responding',
        message: 'The interface crashed.',
        detail: `Reason: ${details.reason}. Your servers are unaffected — they run in the background.`,
        buttons: ['Reload the window', 'Quit'],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) mainWindow?.reload();
        else requestQuit();
      });
  });

  // Keep the shell informed about which server is on screen.
  mainWindow.webContents.on('did-navigate-in-page', () => updateShellState());

  return mainWindow;
}

function showWindow(route = null) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (manager) createMainWindow(manager.url);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (route) sendToRenderer('navigate', { to: route });
}

// ---------------------------------------------------------------------------
// Renderer messaging
// ---------------------------------------------------------------------------

function sendToRenderer(action, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.send('app:command', { action, ...(payload ?? {}) });
  return true;
}

/** Ask the renderer to report its current state back to us. */
async function updateShellState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const state = await mainWindow.webContents.executeJavaScript(
      `(() => {
         const hash = location.hash || '';
         const match = hash.match(/#\\/servers\\/([^/?]+)/);
         return { serverId: match ? decodeURIComponent(match[1]) : null };
       })()`,
      true,
    );
    if (state && typeof state.serverId !== 'undefined') currentServerId = state.serverId;
  } catch {
    /* the page may not be ready yet */
  }
}

// ---------------------------------------------------------------------------
// Quit flow
// ---------------------------------------------------------------------------

async function requestQuit() {
  if (quitting) return;
  const summary = manager?.registry.summary();
  const running = summary?.running ?? 0;

  if (running > 0) {
    const { response } = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      title: 'Quit Craftkeep?',
      message: `${running} server${running === 1 ? ' is' : 's are'} still running.`,
      detail:
        'Quitting asks each server to stop cleanly and saves every world first, so this can take a moment.\n\n' +
        (summary?.totalPlayers ? `${summary.totalPlayers} player${summary.totalPlayers === 1 ? '' : 's'} will be disconnected.` : ''),
      buttons: ['Stop servers and quit', 'Keep running in the tray', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });

    if (response === 1) {
      mainWindow?.hide();
      return;
    }
    if (response !== 0) return;
  }

  quitting = true;
  desktopConfig.flush();

  // Show progress if stopping takes more than a moment.
  let progressTimer = null;
  if (running > 0) {
    progressTimer = setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) return;
      const window = new BrowserWindow({
        width: 380,
        height: 180,
        frame: false,
        resizable: false,
        show: true,
        backgroundColor: '#08090c',
        icon: ICON_PATH,
        webPreferences: {
          preload: path.join(__dirname, 'splash-preload.cjs'),
          contextIsolation: false,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      window.loadFile(path.join(__dirname, 'splash.html'));
      window.webContents.once('did-finish-load', () => {
        window.webContents.send('splash:status', { message: `Saving and stopping ${running} server(s)…` });
      });
      splashWindow = window;
    }, 700);
  }

  try {
    await manager?.shutdown({ reason: 'app-quit' });
  } catch (error) {
    console.error('[desktop] shutdown error:', error);
  }

  clearTimeout(progressTimer);
  tray?.destroy();
  app.exit(0);
}

// ---------------------------------------------------------------------------
// Backend wiring
// ---------------------------------------------------------------------------

function wireBackendEvents(instance) {
  const { registry } = instance;

  const refreshBadge = () => {
    const summary = registry.summary();
    runningCount = summary.running;
    setBadge(summary.running);
  };

  registry.on('metrics', refreshBadge);
  registry.on('status', refreshBadge);
  registry.on('lifecycle', (payload) => {
    refreshBadge();
    if (!desktopConfig.get().notifications) return;
    if (!Notification.isSupported()) return;

    const server = registry.find(payload.serverId);
    const name = server?.def.name ?? payload.serverId;

    if (payload.phase === 'crashed') {
      const note = new Notification({
        title: `${name} crashed`,
        body: payload.failure?.title
          ? `${payload.failure.title} — ${payload.failure.hint}`
          : 'The server exited unexpectedly. Open the console for details.',
        icon: nativeImage.createFromPath(ICON_PATH),
        urgency: 'critical',
      });
      note.on('click', () => {
        showWindow();
        sendToRenderer('navigate', { to: `#/servers/${payload.serverId}?tab=console` });
      });
      note.show();
    } else if (payload.phase === 'started' && payload.reason !== 'auto-restart') {
      // Only announce a *finished* boot, not the spawn.
    }
  });

  registry.on('console-event', (payload) => {
    if (payload.type !== 'ready') return;
    if (!desktopConfig.get().notifications || !Notification.isSupported()) return;
    const server = registry.find(payload.serverId);
    const note = new Notification({
      title: `${server?.def.name ?? 'Server'} is ready`,
      body: `Booted in ${payload.seconds}s — players can connect now.`,
      icon: nativeImage.createFromPath(ICON_PATH),
      silent: true,
    });
    note.on('click', () => {
      showWindow();
      sendToRenderer('navigate', { to: `#/servers/${payload.serverId}?tab=console` });
    });
    note.show();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, payload) => fn(payload));

  // -- Shell ---------------------------------------------------------------
  handle('shell:reveal', async (target) => {
    if (typeof target !== 'string' || !target) return { ok: false, error: 'no path' };
    // Guard: only ever open things this app manages.
    const resolved = path.resolve(target);
    const allowedRoots = [paths.servers, paths.data, paths.root].map((p) => path.resolve(p));
    const permitted = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
    if (!permitted) return { ok: false, error: 'Path is outside the manager folders.' };

    // A file inside a folder is more useful revealed than launched.
    const stats = await fs.promises.stat(resolved).catch(() => null);
    if (stats?.isDirectory()) {
      const error = await shell.openPath(resolved);
      return error ? { ok: false, error } : { ok: true };
    }
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  handle('shell:openExternal', async (url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http(s) URLs.' };
    await shell.openExternal(url);
    return { ok: true };
  });

  handle('dialog:pickFolder', async (options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: options.title ?? 'Choose a folder',
      defaultPath: options.defaultPath ?? paths.servers,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: options.buttonLabel ?? 'Select',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('dialog:pickFile', async (options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: options.title ?? 'Choose a file',
      defaultPath: options.defaultPath ?? paths.root,
      properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: options.filters ?? [{ name: 'All files', extensions: ['*'] }],
      buttonLabel: options.buttonLabel ?? 'Select',
    });
    return result.canceled ? null : options.multiple ? result.filePaths : result.filePaths[0];
  });

  handle('app:notify', async (payload = {}) => {
    if (!desktopConfig.get().notifications) return { ok: false, error: 'notifications disabled' };
    if (!Notification.isSupported()) return { ok: false, error: 'unsupported' };
    new Notification({
      title: String(payload.title ?? 'Craftkeep'),
      body: String(payload.body ?? ''),
      icon: nativeImage.createFromPath(ICON_PATH),
      silent: payload.silent !== false,
    }).show();
    return { ok: true };
  });

  // -- App -----------------------------------------------------------------
  handle('app:info', () => ({
    version: app.getVersion(),
    name: app.getName(),
    isPackaged: app.isPackaged,
    paths: { ...paths, backups, logs },
    configFile: desktopConfig.configPath(),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  }));

  handle('app:quit', () => {
    requestQuit();
    return { ok: true };
  });

  handle('app:setBadge', (count) => ({ ok: setBadge(Number(count) || 0) }));

  handle('prefs:get', () => {
    const prefs = desktopConfig.get();
    // `window` is the shell's business, not the renderer's.
    const { window: _ignored, ...rest } = prefs;
    return rest;
  });

  handle('prefs:set', (patch) => {
    if (!patch || typeof patch !== 'object') return { ok: false };
    // Whitelist: the renderer may only touch user-facing preferences.
    const allowed = ['closeAction', 'notifications', 'trayHintShown'];
    const safe = {};
    for (const key of allowed) if (key in patch) safe[key] = patch[key];
    const next = desktopConfig.set(safe, { immediate: true });
    const { window: _ignored, ...rest } = next;
    return rest;
  });

  // -- Window --------------------------------------------------------------
  handle('window:minimize', () => {
    mainWindow?.minimize();
    return { ok: true };
  });

  handle('window:toggleMaximize', () => {
    if (!mainWindow) return { ok: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });

  // The renderer tells us which server is in view, so menu/tray items that say
  // "the server in view" behave as labelled.
  ipcMain.on('app:currentServer', (_event, serverId) => {
    currentServerId = typeof serverId === 'string' && serverId ? serverId : null;
  });

  ipcMain.on('splash:ready', () => {
    splashWindow?.webContents.send('splash:version', app.getVersion());
  });

  // The session token, handed to the renderer's preload synchronously.
  // Scoped to the window we created: a different webContents asking for it
  // gets an empty string rather than the secret.
  ipcMain.on('app:token', (event) => {
    const senderIsAppWindow =
      (mainWindow && event.sender === mainWindow.webContents) ||
      (splashWindow && event.sender === splashWindow.webContents);
    event.returnValue = senderIsAppWindow ? sessionToken : '';
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Parse `--route=#/servers/abc?tab=connect` so the app can be launched straight
 * onto a page. Useful for shortcuts and for scripts that want to open a
 * specific server.
 */
function parseRouteArgument() {
  const arg = process.argv.find((a) => a.startsWith('--route='));
  if (!arg) return null;
  const value = arg.slice('--route='.length).trim();
  if (!value) return null;
  // Only ever a hash route inside our own app.
  return value.startsWith('#') ? value : `#${value}`;
}

async function boot() {
  const devUrl = process.env.CRAFTKEEP_DEV_URL;
  const startRoute = parseRouteArgument();

  // A dev URL means "attach to an already-running backend", which is the fast
  // path while iterating on the UI.
  if (devUrl) {
    manager = { url: devUrl, registry: null, shutdown: async () => {} };
    createMainWindow(devUrl);
    return;
  }

  createSplash();
  splashStatus('Checking your Java runtimes…');

  const bootTimer = setTimeout(() => {
    splashStatus('This is taking longer than expected — still working…');
  }, 6000);

  try {
    manager = await startManager({
      token: sessionToken,
      // A port of 0 lets the OS pick a free one, so there is no stable URL to
      // collide over (or to bookmark). CRAFTKEEP_PORT pins it for diagnostics only.
      port: Number(process.env.CRAFTKEEP_PORT) || 0,
      paths: { serversDir: paths.servers, dataDir: paths.data, backupsDir: backups },
      banner: false,
    });
  } catch (error) {
    clearTimeout(bootTimer);
    bootFailed = true;
    splashStatus('Could not start the local service.', true);
    console.error('[desktop] boot failed:', error);

    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Craftkeep could not start',
      message: error?.message ?? 'Unknown error',
      detail:
        `${error?.hint ?? ''}\n\n` +
        `Data folder: ${paths.data}\n` +
        `Servers folder: ${paths.servers}`,
      buttons: ['Copy details and quit', 'Open the data folder'],
      defaultId: 0,
    });
    if (response === 1) shell.openPath(paths.data);
    app.exit(1);
    return;
  }

  clearTimeout(bootTimer);
  splashStatus('Preparing the dashboard…');

  wireBackendEvents(manager);
  registerIpc();

  // Keep the shell's idea of state fresh for menu enablement.
  const refresh = () => {
    runningCount = manager.registry.summary().running;
    setBadge(runningCount);
  };
  manager.registry.on('status', refresh);
  manager.registry.on('metrics', refresh);

  tray = new AppTray({
    registry: manager.registry,
    onShow: (route) => showWindow(route),
    onOpenServer: (id) => {
      showWindow();
      sendToRenderer('navigate', { to: `#/servers/${id}?tab=console` });
    },
    onQuit: () => requestQuit(),
    onCommand: (action, payload) => {
      // Tray actions reuse the renderer's implementations.
      if (action === 'open-servers-folder') {
        shell.openPath(paths.servers);
        return;
      }
      sendToRenderer(action, payload);
      if (action !== 'open-servers-folder') showWindow();
    },
  }).start();

  buildAppMenu({
    send: sendToRenderer,
    getState: () => {
      const summary = manager?.registry?.summary?.() ?? { running: 0, total: 0 };
      return { runningCount: summary.running, serverCount: summary.total, serverId: currentServerId };
    },
    onQuit: () => requestQuit(),
    paths: { servers: paths.servers, data: paths.data, backups, logs, readme: paths.readme },
    configFile: desktopConfig.configPath(),
  });

  createMainWindow(manager.url, { route: startRoute });

  // Second launch → focus the existing window instead of starting over.
  // A route passed by the second launch is honoured too.
  app.on('second-instance', (_event, argv) => {
    if (!desktopConfig.get().focusOnSecondLaunch) return;
    const route = argv.find((a) => a.startsWith('--route='));
    showWindow(route ? route.slice('--route='.length) : null);
  });

  console.log(`[desktop] transport ready on ${manager.url} (${paths.mode} paths, loopback + token)`);
  if (process.env.CRAFTKEEP_DEBUG_TRANSPORT === '1') {
    // Opt-in only: lets a local diagnostic tool attach to the transport.
    console.log(`[desktop] debug transport token: ${sessionToken}`);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on('window-all-closed', () => {
  // No windows does not mean "quit" — the tray owns the app while servers run.
  if (process.platform === 'darwin') return;
  if (!tray) app.quit();
});

app.on('activate', () => {
  // macOS dock click.
  showWindow();
});

app.on('before-quit', (event) => {
  if (quitting || bootFailed) return;
  // Route every quit path through the same graceful shutdown.
  event.preventDefault();
  requestQuit();
});

app.on('will-quit', () => {
  desktopConfig.flush();
});

// A crash in the shell must not take the servers with it silently.
process.on('uncaughtException', (error) => {
  console.error('[desktop] uncaught exception:', error);
});

app.whenReady().then(boot).catch((error) => {
  console.error('[desktop] fatal:', error);
  app.exit(1);
});
