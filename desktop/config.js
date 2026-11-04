/**
 * Desktop-only preferences and window geometry.
 *
 * Deliberately separate from the manager's own `data/settings.json`: these are
 * properties of *this machine's window*, not of the server configuration, so
 * they live in the OS user-data folder and survive reinstalls.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const DEFAULTS = {
  /** `'tray'` keeps servers running when the window is closed. `'quit'` exits. */
  closeAction: 'tray',
  /** Show a balloon the first time the window is hidden to the tray. */
  trayHintShown: false,
  /** Native notification when a server finishes booting / crashes. */
  notifications: true,
  /** Re-open the window automatically when the app is launched twice. */
  focusOnSecondLaunch: true,
  window: { width: 1440, height: 940, x: null, y: null, maximized: false },
  /** Set once the user has seen the "closing keeps servers running" dialog. */
  closePromptShown: false,
};

let cache = null;
let file = null;

function configPath() {
  if (!file) file = path.join(app.getPath('userData'), 'desktop-config.json');
  return file;
}

export function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    cache = {
      ...DEFAULTS,
      ...raw,
      window: { ...DEFAULTS.window, ...(raw.window ?? {}) },
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

export function get() {
  return { ...load() };
}

let saveTimer = null;

/**
 * Merge a patch and persist. Writes are debounced because window `resize` fires
 * continuously while dragging.
 */
export function set(patch, { immediate = false } = {}) {
  const next = load();
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key === 'window' && value && typeof value === 'object') {
      next.window = { ...next.window, ...value };
    } else {
      next[key] = value;
    }
  }
  cache = next;

  const write = () => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    } catch {
      /* a lost preference is never worth crashing over */
    }
  };

  if (immediate) {
    clearTimeout(saveTimer);
    write();
  } else {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(write, 400);
  }

  return get();
}

export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), `${JSON.stringify(load(), null, 2)}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

export { configPath };
export default { load, get, set, flush, configPath };
