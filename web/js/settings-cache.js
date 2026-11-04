/**
 * Synchronous access to the current settings.
 *
 * The store loads settings asynchronously, but several components need a value
 * *during* their first render (console font size, word wrap, confirm dialogs).
 * This module holds a synchronously-readable cache and applies the settings
 * that live on `<html>`/`<body>` as data attributes.
 */

const DEFAULTS = {
  theme: 'dark',
  accent: 'emerald',
  consoleFontSize: 13,
  consoleAutoScroll: true,
  consoleTimestamps: true,
  consoleWordWrap: true,
  confirmDestructive: true,
  autoDownloadJava: false,
  defaultPlatform: 'paper',
  defaultTimeoutMs: 120000,
  refreshIntervalMs: 2000,
  startServersOnLaunch: false,
  telemetry: false,
};

let cache = { ...DEFAULTS };
const listeners = new Set();

export const getSettings = () => cache;

/** Merge new values into the cache and apply the visual ones. */
export function setSettings(values) {
  cache = { ...cache, ...(values ?? {}) };
  applyAppearance(cache);
  for (const listener of listeners) {
    try {
      listener(cache);
    } catch {
      /* ignore */
    }
  }
  return cache;
}

export function onSettingsChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** Reflect theme/accent/font choices onto the document. */
export function applyAppearance(settings = cache) {
  const root = document.documentElement;
  if (settings.theme) root.dataset.theme = settings.theme;
  else delete root.dataset.theme;

  if (settings.accent) root.dataset.accent = settings.accent;
  else delete root.dataset.accent;

  document.body.style.setProperty('--console-size', `${settings.consoleFontSize ?? 13}px`);
}

/** True when the user wants a confirmation before destructive actions. */
export const shouldConfirmDestructive = () => cache.confirmDestructive !== false;

export default { getSettings, setSettings, onSettingsChange, applyAppearance, shouldConfirmDestructive, DEFAULTS };
