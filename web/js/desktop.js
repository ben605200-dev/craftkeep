/**
 * Desktop-shell bridge.
 *
 * There is exactly one host for this UI: the Electron shell. Everything that
 * needs the OS — file dialogs, revealing folders, notifications, quitting —
 * goes through here rather than sprinkling `window.mcsm` checks through the
 * views.
 *
 * The functions below still return null/silently when the bridge is absent
 * rather than throwing. That is not browser support; it is so a missing bridge
 * degrades into "that button did nothing" instead of taking the window down.
 * `isDesktop` is the guard the shell uses to refuse to start at all in that case.
 *
 * The preload exposes a small, named API — see `desktop/preload.cjs`.
 */

/**
 * Read the bridge lazily rather than capturing it at module load.
 *
 * It costs nothing (the preload always runs first in Electron), and it means the
 * renderer can be exercised — and its desktop-only branches tested — without a
 * running shell.
 */
const getBridge = () => (typeof window === 'undefined' ? undefined : window.mcsm);

// ---------------------------------------------------------------------------
// Shell integration
// ---------------------------------------------------------------------------

/**
 * Reveal a path in the OS file manager.
 * @returns {Promise<boolean>} whether anything happened
 */
export async function revealPath(target) {
  const bridge = getBridge();
  if (!bridge?.revealPath || !target) return false;
  try {
    const result = await bridge.revealPath(target);
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

/** Open a URL in the user's default browser. */
export async function openExternal(url) {
  const bridge = getBridge();
  if (!bridge?.openExternal) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  try {
    const result = await bridge.openExternal(url);
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

/**
 * Native folder picker.
 *
 * @param {{ title?: string, defaultPath?: string, buttonLabel?: string }} options
 * @returns {Promise<string|null>} chosen path, or null when cancelled — or when
 *   there is no desktop shell, in which case callers fall back to a text prompt.
 */
export async function pickFolder(options = {}) {
  const bridge = getBridge();
  if (!bridge?.pickFolder) return null;
  try {
    return await bridge.pickFolder(options);
  } catch {
    return null;
  }
}

/** Native file picker. Returns a path, an array of paths, or null. */
export async function pickFile(options = {}) {
  const bridge = getBridge();
  if (!bridge?.pickFile) return null;
  try {
    return await bridge.pickFile(options);
  } catch {
    return null;
  }
}

/** Native OS notification (respects the user's desktop preference). */
export async function notify({ title, body, silent = true }) {
  const bridge = getBridge();
  if (!bridge?.notify) {
    // Browser fallback: use the Notification API when the user has opted in.
    try {
      if (typeof Notification === 'undefined') return false;
      if (Notification.permission === 'granted') {
        new Notification(title, { body, silent });
        return true;
      }
      if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          new Notification(title, { body, silent });
          return true;
        }
      }
    } catch {
      /* ignore */
    }
    return false;
  }
  try {
    const result = await bridge.notify({ title, body, silent });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// App control
// ---------------------------------------------------------------------------

/** Paths and versions from the shell. `null` in a browser. */
export async function getAppInfo() {
  const bridge = getBridge();
  if (!bridge?.getAppInfo) return null;
  try {
    return await bridge.getAppInfo();
  } catch {
    return null;
  }
}

/** Desktop-only preferences (close behaviour, notifications). */
export async function getPrefs() {
  const bridge = getBridge();
  if (!bridge?.getPrefs) return null;
  try {
    return await bridge.getPrefs();
  } catch {
    return null;
  }
}

export async function setPrefs(patch) {
  const bridge = getBridge();
  if (!bridge?.setPrefs) return null;
  try {
    return await bridge.setPrefs(patch);
  } catch {
    return null;
  }
}

/** Ask the desktop shell to quit, stopping servers first. */
export async function quitApp() {
  const bridge = getBridge();
  if (!bridge?.quit) return false;
  try {
    await bridge.quit();
    return true;
  } catch {
    return false;
  }
}

/** Live "servers running" count on the taskbar/dock icon. */
export function setBadge(count) {
  try {
    getBridge()?.setBadge?.(count);
  } catch {
    /* not critical */
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Commands from the native menu, tray and shortcuts.
 * No-op subscription in a browser so callers need no branching.
 *
 * @param {(command: { action: string, [key: string]: any }) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onCommand(handler) {
  const bridge = getBridge();
  if (!bridge?.onCommand) return () => {};
  return bridge.onCommand(handler);
}

/** Tell the shell which server is on screen, for "the server in view" menus. */
export function reportCurrentServer(serverId) {
  try {
    getBridge()?.reportCurrentServer?.(serverId);
  } catch {
    /* ignore */
  }
}

/** True when the shell can show real OS file dialogs. */
export function hasNativeDialogs() {
  return Boolean(getBridge()?.pickFolder);
}

export default {
  /** Getters so the answer is always current, not captured at import time. */
  get isDesktop() {
    return Boolean(getBridge()?.isDesktop);
  },
  get platform() {
    return getBridge()?.platform ?? 'web';
  },
  get shellVersions() {
    return getBridge()?.versions ?? null;
  },
  get hasNativeDialogs() {
    return hasNativeDialogs();
  },
  revealPath,
  openExternal,
  pickFolder,
  pickFile,
  notify,
  getAppInfo,
  getPrefs,
  setPrefs,
  quitApp,
  setBadge,
  onCommand,
  reportCurrentServer,
};
