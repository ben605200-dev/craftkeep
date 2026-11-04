/**
 * Splash preload.
 *
 * Runs with `contextIsolation: false` so it can write straight into the splash
 * DOM — there is no untrusted content in that window, and it keeps `splash.html`
 * free of any script tag (and therefore the CSP as strict as possible).
 */

const { ipcRenderer } = require('electron');

const el = (id) => document.getElementById(id);
const setStatus = (text) => {
  const node = el('status');
  if (node) node.textContent = text;
};

ipcRenderer.on('splash:status', (_event, payload = {}) => {
  const node = el('status');
  if (!node) return;
  node.textContent = payload.message ?? '';
  node.classList.toggle('error', Boolean(payload.error));
});

ipcRenderer.on('splash:version', (_event, version) => {
  const node = el('version');
  if (node) node.textContent = version ? `v${version}` : '';
});

window.addEventListener('DOMContentLoaded', () => {
  setStatus('Starting the local service…');
  ipcRenderer.send('splash:ready');
});
