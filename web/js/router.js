/**
 * Hash router.
 *
 * Hash routing (not history API) because the app is served from a local
 * directory where a refresh on a deep link must not 404 — and because a
 * file:// style deployment stays possible.
 *
 * A route's `render` returns `{ el, title, crumbs, flush, onLeave, onEnter }`.
 * Views that stream (the console) use `onEnter`/`onLeave` to subscribe and
 * unsubscribe, so nothing keeps ticking in the background.
 */

import { closeAllModals } from './ui.js';

const routes = [];
let current = null;
let viewport = null;
let onNavigate = null;

/**
 * @param {string} pattern e.g. `#/servers/:id` (a leading `#` is optional —
 *   `parseLocation` strips it before matching, so we normalise here to keep the
 *   two in sync no matter how the caller writes it)
 * @param {{ name?: string, render: Function, title?: Function|string }} definition
 */
export function route(pattern, definition) {
  const normalized = String(pattern).replace(/^#/, '') || '/';
  routes.push({ pattern: normalized, ...definition, regex: patternToRegex(normalized) });
}

export function setViewport(node) {
  viewport = node;
}

export function setNavigator(handler) {
  onNavigate = handler;
}

function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, '(?<$1>[^/]+)');
  return new RegExp(`^${escaped}/?$`);
}

/** Parse the current location into `{ path, params, query }`. */
export function parseLocation(hash = location.hash) {
  const raw = (hash || '#/dashboard').replace(/^#/, '') || '/dashboard';
  const [path, search = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(search));
  return { path: path || '/dashboard', query, hash: raw };
}

export function matchRoute(path) {
  for (const entry of routes) {
    const match = path.match(entry.regex);
    if (match) return { entry, params: match.groups ?? {} };
  }
  return null;
}

export const currentRoute = () => current;
export const currentParams = () => current?.params ?? {};

/** Programmatic navigation. */
export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) {
    handleRoute();
    return;
  }
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) handleRoute();
}

export function buildUrl(path, query = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return `#${path}${text ? `?${text}` : ''}`;
}

/** Navigate back if possible, otherwise fall back to the dashboard. */
export function goBack(fallback = '#/dashboard') {
  if (history.length > 1) history.back();
  else navigate(fallback);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * How long a view gets to produce its element before we give up on it.
 *
 * Views do real work (API calls, directory scans), so this is generous — but it
 * has to exist. Without it, a view whose promise never settles leaves the
 * navigation permanently blocked, which reads to the user as "nothing works
 * any more".
 */
const RENDER_TIMEOUT_MS = 25_000;

/** Incremented on every navigation; stale renders are discarded. */
let renderSeq = 0;

/** Reject if `promise` does not settle in time, with a message worth showing. */
function withTimeout(promise, ms, path) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(
            new Error(`This page took longer than ${Math.round(ms / 1000)}s to load and was abandoned.`),
            { code: 'render-timeout', path },
          ),
        );
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Render whatever the current location points at.
 *
 * Deliberately NOT queue-based. A previous version refused to start a new
 * navigation while one was in flight and queued it instead; one view that never
 * resolved therefore froze every link in the app. Now a new navigation simply
 * supersedes the old one — the in-flight render is discarded when it lands, and
 * the timeout above stops it hanging around forever.
 */
async function handleRoute() {
  const seq = (renderSeq += 1);
  const { path, query } = parseLocation();
  const match = matchRoute(path);

  // Let the outgoing view release its subscriptions before we swap DOM.
  if (current?.onLeave) {
    try {
      current.onLeave();
    } catch (error) {
      console.error('[router] onLeave threw', error);
    }
  }
  current = null;
  closeAllModals();

  if (!match) {
    renderNotFound(path);
    return;
  }

  const { entry, params } = match;
  let result;
  try {
    result = await withTimeout(Promise.resolve(entry.render({ params, query, path })), RENDER_TIMEOUT_MS, path);
  } catch (error) {
    if (seq !== renderSeq) return; // superseded while we were waiting
    console.error('[router] render failed', error);
    renderError(error, path);
    return;
  }

  // A newer navigation started while this one was in flight — throw this away
  // rather than clobbering the view the user asked for.
  if (seq !== renderSeq) {
    try {
      result?.onLeave?.();
    } catch {
      /* the discarded view may still need to clean up */
    }
    return;
  }

  if (!result?.el) {
    renderError(new Error('The view returned nothing to display.'), path);
    return;
  }

  current = { entry, params, query, path, ...result };

  viewport.classList.toggle('view--flush', Boolean(result.flush));
  viewport.replaceChildren(result.el);
  viewport.scrollTop = 0;

  const title =
    typeof entry.title === 'function' ? entry.title({ params, query }) : result.title ?? entry.title ?? 'Dashboard';
  document.title = `${title} · Minecraft Server Manager`;

  onNavigate?.({ path, params, query, title, crumbs: result.crumbs ?? [], result });

  try {
    result.onEnter?.();
  } catch (error) {
    console.error('[router] onEnter threw', error);
  }
}

function renderNotFound(path) {
  viewport.classList.remove('view--flush');
  const node = document.createElement('div');
  node.className = 'page page--narrow';
  node.innerHTML = `
    <div class="empty" style="padding-top:5rem">
      <div class="empty__art" data-icon="question"></div>
      <p class="empty__title">Page not found</p>
      <p class="empty__text">There is nothing at <code>${escapeHtml(path)}</code>.</p>
      <a class="btn btn--primary" href="#/dashboard" style="margin-top:0.5rem">Back to the dashboard</a>
    </div>`;
  viewport.replaceChildren(node);
  document.title = 'Not found · Minecraft Server Manager';
  onNavigate?.({ path, params: {}, query: {}, title: 'Not found', crumbs: [] });
}

function renderError(error, path) {
  viewport.classList.remove('view--flush');
  const node = document.createElement('div');
  node.className = 'page page--narrow';
  node.innerHTML = `
    <div class="card card--pad" style="margin-top:3rem">
      <div class="row" style="gap:0.7rem;align-items:flex-start">
        <span class="callout__icon" data-icon="alert"></span>
        <div class="grow">
          <h2 style="font-size:1rem"></h2>
          <p class="muted small" style="margin-top:0.35rem" id="err-msg"></p>
          <p class="dim tiny" style="margin-top:0.5rem">Route: <code id="err-route"></code></p>
          <div class="row" style="margin-top:1rem;gap:0.5rem;flex-wrap:wrap">
            <button class="btn btn--primary btn--sm" id="err-retry">Try again</button>
            <a class="btn btn--sm" href="#/dashboard">Go to the dashboard</a>
            <button class="btn btn--sm btn--ghost" id="err-reload">Reload the page</button>
          </div>
        </div>
      </div>
    </div>`;

  const timedOut = error?.code === 'render-timeout';
  node.querySelector('h2').textContent = timedOut ? 'This page took too long to load' : 'This page could not be rendered';
  node.querySelector('#err-msg').textContent = error?.message ?? String(error);
  node.querySelector('#err-route').textContent = path;
  node.querySelector('#err-retry').addEventListener('click', () => handleRoute());
  node.querySelector('#err-reload').addEventListener('click', () => location.reload());

  viewport.replaceChildren(node);
  document.title = 'Error · Minecraft Server Manager';
  onNavigate?.({ path, params: {}, query: {}, title: 'Error', crumbs: [] });
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Start listening. */
export function startRouter() {
  window.addEventListener('hashchange', handleRoute);
  if (!location.hash) history.replaceState(null, '', '#/dashboard');
  return handleRoute();
}

/** Re-render the current route in place (after a data change). */
export const refresh = () => handleRoute();

export default { route, startRouter, navigate, buildUrl, currentRoute, currentParams, refresh, goBack, setViewport, setNavigator };
