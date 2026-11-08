/**
 * Application bootstrap.
 *
 * Wires the router, sidebar, top bar, global shortcuts and live status
 * indicators. Every view is loaded lazily so the first paint is instant.
 */

import { el, mount, frag, qs, on, debounce, focusSoft, copyText } from './dom.js';
import { hydrateIcons, icon, ICON_NAMES } from './icons.js';
import { route, startRouter, navigate, buildUrl, setViewport, setNavigator, currentRoute } from './router.js';
import {
  state,
  subscribe,
  wireLive,
  serverList,
  loadSettings,
  loadPlatforms,
  loadServers,
  refreshSystem,
  totalOnlinePlayers,
} from './store.js';
import { getSettings, setSettings, applyAppearance } from './settings-cache.js';
import { bytes, count, durationShort, percent, statusMeta, relativeTime } from './format.js';
import { toast, openModal, confirmDialog, initTooltips } from './ui.js';
import { statusDot } from './components.js';
import api from './api.js';
import ws from './ws.js';
import desktop from './desktop.js';
import { isIdle } from './perf.js';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

route('#/dashboard', { name: 'dashboard', title: 'Dashboard', render: () => import('./views/dashboard.js').then((m) => m.renderDashboard()) });
route('#/servers', { name: 'servers', title: 'Servers', render: (ctx) => import('./views/servers.js').then((m) => m.renderServers(ctx)) });
route('#/servers/:id', { name: 'server', title: 'Server', render: (ctx) => import('./views/server.js').then((m) => m.renderServer(ctx)) });
route('#/create', { name: 'create', title: 'Create server', render: () => import('./views/create.js').then((m) => m.renderCreate()) });
route('#/backups', { name: 'backups', title: 'Backups', render: () => import('./views/backups.js').then((m) => m.renderBackups()) });
route('#/settings', { name: 'settings', title: 'Settings', render: (ctx) => import('./views/settings.js').then((m) => m.renderSettings(ctx)) });
route('#/', { name: 'home', title: 'Dashboard', render: () => import('./views/dashboard.js').then((m) => m.renderDashboard()) });

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const app = qs('#app');
const boot = qs('#boot');
const bootStatus = qs('#boot-status');
const view = qs('#view');
const crumbs = qs('#crumbs');
const topbarStats = qs('#topbar-stats');
const topbarActions = qs('#topbar-actions');
const miniServers = qs('#miniservers');
const sidebarFoot = qs('#sidebar-foot');
const navCount = qs('#nav-server-count');

setViewport(view);

function bootFail(message, detail) {
  // A real failure should stay on screen and explain itself, so disarm the
  // watchdog that would otherwise reveal a broken shell over the top of it.
  clearTimeout(splashWatchdog);
  splashWatchdog = null;

  bootStatus.textContent = message;
  bootStatus.classList.add('boot__status--error');
  if (detail) {
    const hint = el('p', { style: 'margin-top:0.6rem;font-size:0.79rem;color:var(--text-muted);max-width:44ch' }, detail);
    bootStatus.after(hint);
  }
  qs('.boot__bar')?.remove();
}

/**
 * Remove the boot splash.
 *
 * Deliberately NOT scheduled with `requestAnimationFrame`. The splash is a
 * full-screen overlay, so if it never goes away it silently swallows every
 * click — and rAF does not fire at all in a background browser tab or a hidden
 * Electron window, which would leave exactly that. A timer is throttled in
 * those cases but always runs.
 */
let splashWatchdog = null;

function dismissSplash() {
  clearTimeout(splashWatchdog);
  splashWatchdog = null;

  const splash = qs('#boot');
  if (!splash) return;

  // Start the fade immediately (a class toggle needs no frame).
  splash.classList.add('boot--leaving');

  const remove = () => splash.remove();
  // `transitionend` gives the nicest timing; the timer is the guaranteed path.
  splash.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 600);
}

/*
 * Safety net.
 *
 * The splash is a full-screen overlay, so anything that stops `boot_()` from
 * reaching `dismissSplash()` — a thrown error, a request that never settles, a
 * starved tab — would otherwise leave a permanent sheet of glass over the whole
 * UI that swallows every click. This timer is started at module load, outside
 * that await chain, precisely so nothing in it can prevent the reveal.
 */
function armSplashWatchdog(ms = 12_000) {
  clearTimeout(splashWatchdog);
  splashWatchdog = setTimeout(() => {
    const splash = qs('#boot');
    if (!splash || splash.classList.contains('boot--leaving')) return;
    console.warn('[boot] still starting after 12s — revealing the app so the UI stays usable');
    dismissSplash();
  }, ms);
}

async function boot_() {
  armSplashWatchdog();

  /*
   * Refuse to run without the desktop shell.
   *
   * Without the preload bridge there is no session token, so every API call
   * would 401 and the UI would appear broken for no visible reason. Say so
   * plainly instead — this is a desktop app, not a web page.
   */
  if (!desktop.isDesktop) {
    bootFail(
      'This window is not running inside the desktop app.',
      'Craftkeep only runs as a desktop app. Launch it from the Start Menu, ' +
        'the desktop shortcut, or `npm run app`.',
    );
    return;
  }

  /*
   * Only block the first paint on what the shell genuinely needs.
   *
   * `api.platforms()` (the version catalogue + JDK scan) is deliberately NOT
   * awaited here — the dashboard never uses it, and waiting on it made the
   * splash linger. The create wizard awaits it itself, where it is actually
   * needed.
   */
  try {
    const settings = await loadSettings().catch(() => null);
    if (settings) setSettings(settings);
    await refreshSystem().catch(() => {});
  } catch (error) {
    bootFail('Could not reach the manager API.', `${error.message} — make sure the server process is still running, then reload this page.`);
    return;
  }

  // Warm the platform catalogue in the background so the wizard is instant.
  loadPlatforms().catch(() => {});

  applyAppearance(getSettings());
  wireLive();

  // -- Reveal the app ----------------------------------------------------
  app.hidden = false;
  hydrateIcons(app);
  dismissSplash();

  // Shell chrome is best-effort: a failure here must never leave the user
  // staring at an empty main pane, so the router starts regardless.
  for (const paint of [renderSidebarFoot, renderTopbarActions, renderTopbarStats]) {
    try {
      paint();
    } catch (error) {
      console.error(`[boot] ${paint.name} failed`, error);
    }
  }
  // Await the first server list. It is a single fast request, and without it a
  // direct load of a deep route (e.g. #/backups) renders against an empty store
  // and has to fetch again.
  await loadServers().catch(() => {});

  setNavigator(handleNavigation);
  await startRouter();

  // -- Live wiring -------------------------------------------------------
  subscribe('connection', renderConnectionPill);
  subscribe('metrics', () => renderTopbarStats());
  subscribe('servers', () => {
    renderMiniServers();
    updateNavCount();
    syncDesktopBadge();
  });
  subscribe('status', () => {
    renderMiniServers();
    syncDesktopBadge();
  });
  subscribe('system', renderSidebarFoot);

  // Keep the taskbar/dock badge in step with what is running.
  function syncDesktopBadge() {
    desktop.setBadge(serverList().filter((s) => ['running', 'starting'].includes(s.status)).length);
  }
  syncDesktopBadge();

  // Commands from the native menu, the tray and global shortcuts.
  desktop.onCommand(handleDesktopCommand);

  // Repaint once now that the listeners exist — the socket may have finished
  // connecting while we were still wiring things up.
  renderConnectionPill();
  renderMiniServers();
  updateNavCount();

  // Keep the clocks honest, and let a missed state transition self-heal.
  // Skipped while idle (hidden or blurred): there is nobody to show it to, and
  // an app that is not being looked at should cost nothing (see perf.js).
  setInterval(() => {
    if (isIdle()) return;
    renderTopbarStats();
    renderConnectionPill();
  }, 5000);

  setInterval(() => {
    if (isIdle()) return;
    renderMiniServers();
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Navigation chrome
// ---------------------------------------------------------------------------

function handleNavigation({ path, title, crumbs: crumbList, result }) {
  // Sidebar active state
  for (const item of document.querySelectorAll('.navitem')) {
    const target = item.dataset.route;
    const active =
      target === `#${path}` ||
      (target === '#/servers' && path.startsWith('/servers')) ||
      (target === '#/dashboard' && (path === '/' || path === '/dashboard'));
    item.classList.toggle('navitem--active', active);
  }

  // Mini server highlight
  const serverId = path.startsWith('/servers/') ? path.split('/')[2] : null;
  for (const item of miniServers.querySelectorAll('.miniserver')) {
    item.classList.toggle('miniserver--active', item.dataset.serverId === serverId);
  }
  state.activeServerId = serverId;

  // Breadcrumbs
  mount(
    crumbs,
    ...(crumbList ?? []).flatMap((crumb, index) => [
      index ? el('span.crumb__sep', { html: icon('chevronRight', { size: 12 }) }) : null,
      crumb.href
        ? el('a.crumb.crumb--link', { href: crumb.href }, crumb.label)
        : index === crumbList.length - 1
          ? el('span.crumb__crumb.crumb--current', { style: 'font-weight:580' }, crumb.label)
          : el('span.crumb', crumb.label),
    ]).filter(Boolean),
  );

  // On mobile, close the drawer after navigating.
  app.classList.remove('app--nav-open');

  // Tell the desktop shell which server is on screen so its menu and tray
  // items can act on "the server in view".
  desktop.reportCurrentServer(serverId);

  if (result?.focusTitle !== false) focusSoft(view);
}

function renderTopbarActions() {
  const paletteBtn = el(
    'button.btn.btn--sm.btn--ghost',
    { type: 'button', 'data-tip-below': '', 'data-tip': 'Command palette (Ctrl+K)', onclick: () => openPalette() },
    el('span', { html: icon('search', { size: 14 }) }),
    el('span', { style: 'opacity:.7' }, 'Search'),
    el('kbd', 'Ctrl K'),
  );

  const connPill = el('span.tstat', { id: 'conn-pill' });

  mount(topbarActions, connPill, paletteBtn);
  renderConnectionPill(state.connection);
}

/**
 * The connection pill.
 *
 * It reads the *live socket* first: the store snapshot can lag by one event
 * when the socket opens before this component has subscribed, which used to
 * leave a permanent "Disconnected" badge on a perfectly healthy connection.
 */
function renderConnectionPill(connection) {
  const pill = qs('#conn-pill');
  if (!pill) return;

  const snapshot = connection ?? state.connection;
  const st = ws.connected ? 'open' : snapshot.state === 'idle' || snapshot.state === 'connecting' ? 'connecting' : snapshot.state;
  const { latencyMs, attempt } = snapshot;

  const tone =
    st === 'open' ? 'var(--success-rgb)'
    : st === 'connecting' || st === 'reconnecting' ? 'var(--warning-rgb)'
    : 'var(--danger-rgb)';

  const title =
    st === 'open' ? 'Live' : st === 'connecting' ? 'Connecting' : st === 'reconnecting' ? 'Reconnecting' : 'Offline';
  const detail =
    st === 'open' ? (latencyMs !== null && latencyMs !== undefined ? `${latencyMs} ms` : 'live')
    : st === 'reconnecting' ? `retry ${attempt ?? 1}`
    : st === 'connecting' ? '…'
    : 'no link';

  mount(
    pill,
    el('span.statusdot', { style: `--pulse-rgb:${tone}`, class: st === 'open' ? 'statusdot--live' : '' }),
    title,
    el('b', detail),
  );
}

function renderTopbarStats() {
  const servers = serverList();
  const running = servers.filter((s) => ['running', 'starting', 'stopping'].includes(s.status));
  const players = totalOnlinePlayers();
  const cpu = running.reduce((sum, s) => sum + (s.metrics?.cpuPercent ?? 0), 0);
  const memory = state.system?.system?.memory;

  mount(
    topbarStats,
    running.length
      ? el('span.tstat', el('span.statusdot', { style: '--pulse-rgb:var(--success-rgb)', class: 'statusdot--live' }), el('b', String(running.length)), 'live')
      : el('span.tstat', el('span.statusdot', { style: '--pulse-rgb:var(--neutral-rgb)' }), 'idle'),
    players ? el('span.tstat', el('span', { html: icon('users', { size: 13 }) }), el('b', count(players)), 'playing') : null,
    running.length ? el('span.tstat', el('span', { html: icon('cpu', { size: 13 }) }), el('b', percent(cpu, 0))) : null,
    memory ? el('span.tstat', el('span', { html: icon('memory', { size: 13 }) }), el('b', `${(memory.usedMb / 1024).toFixed(1)}/${(memory.totalMb / 1024).toFixed(0)} GiB`)) : null,
  );
}

function updateNavCount() {
  const servers = serverList();
  const running = servers.filter((s) => ['running', 'starting'].includes(s.status)).length;
  navCount.textContent = running ? `${running}/${servers.length}` : String(servers.length);
}

function renderMiniServers() {
  const servers = serverList();
  if (!servers.length) {
    mount(miniServers, el('p.dim.tiny', { style: 'padding:0.4rem 0.5rem' }, 'No servers yet.'));
    return;
  }

  mount(
    miniServers,
    ...servers.map((server) => {
      const meta = statusMeta(server.status);
      return el(
        'a.miniserver',
        {
          href: `#/servers/${server.id}`,
          'data-server-id': server.id,
          class: state.activeServerId === server.id ? 'miniserver--active' : '',
          'data-tip--right': '',
          'data-tip': `${server.platform} ${server.version} · port ${server.port}`,
        },
        statusDot(server.status),
        el('span.miniserver__name', { title: server.name }, server.name),
        el('span.miniserver__meta', server.onlineCount ? String(server.onlineCount) : server.status === 'running' ? '' : '—'),
      );
    }),
  );
}

function renderSidebarFoot() {
  const memory = state.system?.system?.memory;
  const java = state.java ?? state.system?.java;
  const freePercent = memory ? 100 - (memory.usedPercent ?? 0) : 0;

  mount(
    sidebarFoot,
    el(
      'div.sysbar',
      memory
        ? frag(
            el('div.sysbar__row', el('span', 'RAM'), el('span', `${(memory.usedMb / 1024).toFixed(1)} / ${(memory.totalMb / 1024).toFixed(0)} GiB`)),
            el('div.sysbar__bar', { class: memory.usedPercent > 90 ? 'sysbar__bar--crit' : memory.usedPercent > 75 ? 'sysbar__bar--warn' : '' },
              el('i', { style: `width:${Math.min(100, memory.usedPercent ?? 0)}%` }),
            ),
          )
        : el('div.sysbar__row', el('span', 'RAM'), el('span', 'sampling…')),
    ),
    el(
      'div.row',
      { style: 'gap:0.35rem;flex-wrap:wrap' },
      java?.majors?.length
        ? java.majors.slice(-3).map((major) => el('span.chip.chip--mono', { 'data-tip': `Java ${major} is installed` }, `J${major}`))
        : el('span.chip', { class: 'chip--accent' }, 'no Java'),
      java?.installations?.length ? null : el('a.chip.chip--clickable', { href: '#/settings' }, 'Install'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

let paletteOpen = false;

function openPalette() {
  const root = qs('#cmdk');
  if (paletteOpen) return;
  paletteOpen = true;

  const input = el('input.cmdk__input', { placeholder: 'Jump to a server, page or action…', autocomplete: 'off' });
  const list = el('div.cmdk__list');
  const box = el('div.cmdk__box', input, list);
  root.replaceChildren(box);
  root.hidden = false;

  let matches = [];
  let activeIndex = 0;

  function buildItems() {
    const items = [];
    const servers = serverList();

    items.push({ id: 'nav-dashboard', group: 'Go to', label: 'Dashboard', icon: 'gauge', run: () => navigate('#/dashboard') });
    items.push({ id: 'nav-servers', group: 'Go to', label: 'Servers', icon: 'server', run: () => navigate('#/servers') });
    items.push({ id: 'nav-create', group: 'Go to', label: 'Create a server', icon: 'plus', run: () => navigate('#/create') });
    items.push({ id: 'nav-backups', group: 'Go to', label: 'Backups', icon: 'archive', run: () => navigate('#/backups') });
    items.push({ id: 'nav-settings', group: 'Go to', label: 'Settings', icon: 'settings', run: () => navigate('#/settings') });

    for (const server of servers) {
      items.push({
        id: `server-${server.id}`,
        group: 'Servers',
        label: server.name,
        hint: `${server.platform} ${server.version} · ${server.status}`,
        icon: 'terminal',
        run: () => navigate(`#/servers/${server.id}`),
      });
      if (['running', 'starting'].includes(server.status)) {
        items.push({ id: `stop-${server.id}`, group: 'Actions', label: `Stop ${server.name}`, icon: 'stop', run: () => api.stopServer(server.id).then(() => toast.success(`Stopping ${server.name}`)).catch((e) => toast.fromError(e)) });
      } else {
        items.push({ id: `start-${server.id}`, group: 'Actions', label: `Start ${server.name}`, icon: 'play', run: () => api.startServer(server.id).then(() => toast.success(`Starting ${server.name}`)).catch((e) => toast.fromError(e)) });
      }
      items.push({ id: `backup-${server.id}`, group: 'Actions', label: `Back up ${server.name}`, icon: 'archive', run: () => api.createBackup(server.id).then((r) => toast.success('Backup created', r.file)).catch((e) => toast.fromError(e)) });
    }

    items.push({ id: 'act-refresh', group: 'Actions', label: 'Refresh everything', icon: 'refresh', run: () => { loadServers().then(() => toast.success('Refreshed')).catch(() => {}); refreshSystem().catch(() => {}); } });
    items.push({ id: 'act-java', group: 'Actions', label: 'Rescan for Java runtimes', icon: 'coffee', run: () => api.java({ refresh: true }).then((j) => toast.success(`Found ${j.installations.length} runtime(s)`)).catch((e) => toast.fromError(e)) });
    items.push({ id: 'act-logs', group: 'Actions', label: 'Export diagnostics', icon: 'download', run: () => api.diagnostics().then((d) => {
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mcsm-diagnostics.json';
      a.click();
      URL.revokeObjectURL(url);
    }).catch((e) => toast.fromError(e)) });
    items.push({ id: 'act-theme', group: 'Actions', label: 'Cycle accent colour', icon: 'sparkles', run: cycleAccent });

    return items;
  }

  const allItems = buildItems();

  function paint(term = '') {
    const needle = term.trim().toLowerCase();
    matches = needle
      ? allItems.filter((item) => `${item.label} ${item.hint ?? ''} ${item.group}`.toLowerCase().includes(needle))
      : allItems;
    matches = matches.slice(0, 40);
    activeIndex = 0;

    if (!matches.length) {
      mount(list, el('p.muted.small', { style: 'padding:1rem;text-align:center' }, 'Nothing found.'));
      return;
    }

    const grouped = [];
    let lastGroup = null;
    for (const [index, item] of matches.entries()) {
      if (item.group !== lastGroup) {
        grouped.push(el('div', { style: 'padding:0.5rem 0.7rem 0.25rem;font-size:0.68rem;text-transform:uppercase;letter-spacing:0.09em;color:var(--text-faint)' }, item.group));
        lastGroup = item.group;
      }
      grouped.push(
        el(
          'button.cmdk__item',
          {
            type: 'button',
            class: index === 0 ? 'cmdk__item--active' : '',
            'data-index': String(index),
            onclick: () => runItem(index),
            onmouseenter: () => setActive(index),
          },
          el('span', { html: icon(item.icon, { size: 15 }) }),
          el('span.grow', item.label),
          item.hint ? el('span.dim.tiny', item.hint) : null,
        ),
      );
    }
    mount(list, ...grouped);
  }

  function setActive(index) {
    activeIndex = index;
    for (const node of list.querySelectorAll('.cmdk__item')) {
      node.classList.toggle('cmdk__item--active', Number(node.dataset.index) === index);
    }
  }

  function runItem(index) {
    const item = matches[index];
    close();
    item?.run?.();
  }

  function close() {
    paletteOpen = false;
    root.hidden = true;
    root.replaceChildren();
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(matches.length - 1, activeIndex + 1));
      list.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(0, activeIndex - 1));
      list.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runItem(activeIndex);
    }
  }

  input.addEventListener('input', () => paint(input.value));
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close();
  });
  document.addEventListener('keydown', onKey, true);

  paint();
  requestAnimationFrame(() => focusSoft(input));
}

async function cycleAccent() {
  const accents = ['emerald', 'indigo', 'violet', 'cyan', 'amber', 'rose'];
  const current = getSettings().accent ?? 'emerald';
  const next = accents[(accents.indexOf(current) + 1) % accents.length];
  setSettings({ accent: next });
  try {
    await api.saveSettings({ accent: next });
  } catch {
    /* offline is fine — it still applies for this session */
  }
  toast.success(`Accent: ${next}`);
}

// ---------------------------------------------------------------------------
// Desktop commands (native menu, tray, shortcuts)
// ---------------------------------------------------------------------------

/**
 * One handler for everything the desktop shell can ask for.
 *
 * The menu and tray deliberately do *not* talk to the backend themselves — they
 * forward an action here, so there is exactly one implementation of "start all
 * servers" and the toasts, optimistic UI and error handling all still apply.
 */
async function handleDesktopCommand(command) {
  const { action, serverId, to } = command ?? {};

  switch (action) {
    case 'navigate':
      if (to) navigate(to);
      return;

    case 'palette':
      openPalette();
      return;

    case 'shortcuts':
      showShortcuts();
      return;

    case 'refresh':
      try {
        await Promise.all([loadServers(), refreshSystem()]);
        navigate(currentRoute()?.path ? `#${currentRoute().path}` : '#/dashboard');
        toast.success('Refreshed');
      } catch (error) {
        toast.fromError(error, 'Could not refresh');
      }
      return;

    case 'export-diagnostics':
      try {
        const data = await api.diagnostics();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `mcsm-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast.success('Diagnostics exported');
      } catch (error) {
        toast.fromError(error, 'Could not collect diagnostics');
      }
      return;

    case 'bulk': {
      const bulkAction = command.bulkAction ?? 'start';
      const targets = serverList().filter((server) =>
        bulkAction === 'start'
          ? !['running', 'starting', 'stopping'].includes(server.status)
          : ['running', 'starting'].includes(server.status),
      );
      if (!targets.length) {
        toast.info('Nothing to do', `No servers need to be ${bulkAction === 'start' ? 'started' : bulkAction === 'stop' ? 'stopped' : 'backed up'}.`);
        return;
      }

      const pending = toast.show({ id: 'bulk', title: `Running "${bulkAction}" on ${targets.length} server(s)…`, tone: 'info', duration: 0 });
      try {
        const result = await api.bulk(bulkAction, targets.map((s) => s.id));
        pending.dismiss();
        toast.success('Done', `${result.succeeded} of ${targets.length} succeeded.`);
      } catch (error) {
        pending.dismiss();
        toast.fromError(error, `Bulk ${bulkAction} failed`);
      }
      return;
    }

    case 'viewed-server': {
      // "The server in view" comes from the shell, which learns about it via
      // `desktop.reportCurrentServer()` on every navigation.
      const targetId = serverId ?? currentRoute()?.params?.id;
      const server = targetId ? serverList().find((s) => s.id === targetId) : null;
      const verb = command.serverAction ?? 'stop';

      if (!server) {
        toast.info('No server selected', 'Open a server first, then use this menu item.');
        return;
      }
      await runServerVerb(verb, server);
      return;
    }

    // Tray actions: sent against one specific server.
    case 'start':
    case 'stop':
    case 'restart':
    case 'kill':
    case 'backup': {
      const target = serverId ? serverList().find((s) => s.id === serverId) : null;
      if (!target) return;
      await runServerVerb(action, target);
      return;
    }

    default:
      console.debug('[desktop] unhandled command', command);
  }
}

/** Shared by the desktop menu and tray so both behave identically. */
async function runServerVerb(verb, server) {
  const verbLabels = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', kill: 'Killing', backup: 'Backing up' };
  const pending = toast.show({
    id: `${verb}-${server.id}`,
    title: `${verbLabels[verb] ?? verb} ${server.name}…`,
    tone: verb === 'stop' || verb === 'kill' ? 'warning' : 'info',
    duration: 0,
  });

  try {
    if (verb === 'backup') {
      const result = await api.createBackup(server.id, { label: 'desktop' });
      pending.dismiss();
      toast.success('Backup created', `${result.file} · ${result.formatted}`);
    } else if (verb === 'kill') {
      await api.killServer(server.id);
      pending.dismiss();
      toast.warning(`Killed ${server.name}`, 'The JVM was terminated without saving.');
    } else {
      await api[`${verb}Server`](server.id);
      pending.dismiss();
    }
  } catch (error) {
    pending.dismiss();
    toast.fromError(error, `Could not ${verb} ${server.name}`);
  }
}

// ---------------------------------------------------------------------------
// Global shortcuts
// ---------------------------------------------------------------------------

function installShortcuts() {
  on(document, 'keydown', (event) => {
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable;

    // Ctrl/Cmd + K — command palette
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
      return;
    }

    if (inField) return;

    // g then d/s/c/b/, — quick navigation
    if (event.key === 'g') {
      const handler = (next) => {
        document.removeEventListener('keydown', handler, true);
        const map = { d: '#/dashboard', s: '#/servers', c: '#/create', b: '#/backups', ',': '#/settings' };
        if (map[next.key]) {
          event.preventDefault();
          navigate(map[next.key]);
        }
      };
      document.addEventListener('keydown', handler, true);
      setTimeout(() => document.removeEventListener('keydown', handler, true), 1500);
      return;
    }

    if (event.key === '?') {
      event.preventDefault();
      showShortcuts();
      return;
    }

    if (event.key === '/') {
      event.preventDefault();
      const search = qs('.search input');
      if (search) focusSoft(search);
      else openPalette();
      return;
    }

    if (event.key === 'r' && !event.ctrlKey && !event.metaKey) {
      const route_ = currentRoute();
      if (route_?.params?.id) {
        const server = serverList().find((s) => s.id === route_.params.id);
        if (server) {
          event.preventDefault();
          api.restartServer(server.id).then(() => toast.info(`Restarting ${server.name}`)).catch((error) => toast.fromError(error));
        }
      }
    }
  });

  // Sidebar collapse
  qs('#sidebar-collapse')?.addEventListener('click', () => {
    app.classList.toggle('app--collapsed');
    try {
      localStorage.setItem('mcsm:sidebar', app.classList.contains('app--collapsed') ? 'collapsed' : 'expanded');
    } catch {
      /* storage unavailable */
    }
  });

  // Restore sidebar state
  try {
    if (localStorage.getItem('mcsm:sidebar') === 'collapsed') app.classList.add('app--collapsed');
  } catch {
    /* ignore */
  }

  // Mobile drawer
  qs('#topbar-menu')?.addEventListener('click', () => app.classList.toggle('app--nav-open'));
  qs('#sidebar-scrim')?.addEventListener('click', () => app.classList.remove('app--nav-open'));

  // Sidebar refresh
  qs('#sidebar-refresh')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.classList.add('is-loading');
    try {
      await Promise.all([loadServers(), refreshSystem()]);
      toast.success('Refreshed');
    } catch (error) {
      toast.fromError(error, 'Could not refresh');
    } finally {
      button.classList.remove('is-loading');
    }
  });

  // Version label
  api.system().then((info) => {
    const label = qs('#brand-version');
    if (label) label.textContent = `v${info.app.version}`;
  }).catch(() => {});

  // Deliberately no `beforeunload` handler: the manager owns the server
  // processes, so closing or reloading this tab never interrupts a boot.
  // Nagging the user about it would be actively misleading.
}

function showShortcuts() {
  const rows = [
    ['Ctrl K', 'Open the command palette'],
    ['G then D', 'Go to the dashboard'],
    ['G then S', 'Go to servers'],
    ['G then C', 'Create a server'],
    ['G then B', 'Backups'],
    ['/', 'Focus the search box'],
    ['R', 'Restart the server you are viewing'],
    ['Enter', 'Send a console command'],
    ['↑ / ↓', 'Walk through command history'],
    ['Tab', 'Complete a command or player name'],
    ['Ctrl L', 'Clear the console view'],
    ['?', 'This list'],
  ];
  const modal = openModal({
    title: 'Keyboard shortcuts',
    icon: 'key',
    size: 'slim',
    body: el(
      'div.kv',
      ...rows.map(([keys, label]) =>
        el('div.kv__row', el('span.kv__k', label), el('span.kv__v', ...keys.split(' / ').flatMap((k, i) => (i ? [el('span.dim', ' / '), el('kbd', k)] : [el('kbd', k)])))),
      ),
    ),
    footer: [el('button.btn.btn--primary', { type: 'button', onclick: () => modal.close() }, 'Got it')],
  });
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

installShortcuts();
// One shared tooltip layer for the whole app — see `initTooltips` for why this
// cannot be a pseudo-element on each trigger.
initTooltips();
boot_();

// Re-hydrate icons in markup injected as raw HTML (the router's not-found and
// error pages). Views build their icons inline, so this guard almost always
// short-circuits — it is a single cheap query per mutation batch.
const observer = new MutationObserver(
  debounce(() => {
    if (document.querySelector('[data-icon]:not([data-icon-done])')) hydrateIcons(document);
  }, 60),
);
observer.observe(view, { childList: true, subtree: true });

// Surface fatal WS-level errors once, without spamming.
let lastApiError = 0;
ws.on('api-error', (message) => {
  const now = Date.now();
  if (now - lastApiError < 3000) return;
  lastApiError = now;
  toast.error('Request rejected', message.message ?? 'The manager refused that request.');
});
