/**
 * Server detail — the console and everything around it.
 *
 * The tab bodies that do not stream are split into `server-tabs.js`; this file
 * owns the header, the tab bar, the live console and the player roster.
 */

import { el, mount, frag, uuid, isNearBottom, scrollToBottom, downloadText, copyText } from '../dom.js';
import { isIdle } from '../perf.js';
import { icon } from '../icons.js';
import {
  statusBadge,
  platformChip,
  sparkline,
  serverActions,
  playerChip,
  emptyState,
  motdText,
  statTile,
} from '../components.js';
import { createConsole } from '../console.js';
import { createPropertiesTab, createFilesTab, createBackupsTab, createAutomationTab, createConnectTab } from './server-tabs.js';
import { state, getServer, upsertServer, subscribe, wireLive } from '../store.js';
import {
  bytes,
  count,
  dateTime,
  describeVersion,
  durationShort,
  mib,
  mibFromMb,
  memoryPair,
  percent,
  relativeTime,
  statusMeta,
  clockTime,
} from '../format.js';
import { toast, confirmDialog, openModal, promptDialog } from '../ui.js';
import api from '../api.js';
import ws from '../ws.js';
import desktop from '../desktop.js';
import { getSettings } from '../settings-cache.js';

export async function renderServer({ params }) {
  wireLive();
  const serverId = params.id;

  let snapshot;
  try {
    snapshot = await api.getServer(serverId, { disk: true });
  } catch (error) {
    return {
      el: el(
        'div.page.page--narrow',
        el(
          'div.card.card--pad',
          { style: 'margin-top:2rem' },
          emptyState({
            icon: 'alertCircle',
            title: error.status === 404 ? 'That server does not exist' : 'Could not load this server',
            text: error.message,
            action: el('a.btn.btn--primary', { href: '#/servers', style: 'margin-top:0.5rem' }, 'Back to servers'),
          }),
        ),
      ),
      title: 'Not found',
      crumbs: [{ label: 'Servers', href: '#/servers' }, { label: 'Not found' }],
    };
  }

  upsertServer(snapshot, { silent: true });
  const initial = getServer(serverId) ?? snapshot;

  // ---------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------
  const avatar = el('span.detail__avatar');
  const nameHost = el('div.detail__name');
  const metaHost = el('div.detail__meta');
  const badgeHost = el('div');
  const actionsHost = el('div.detail__actions');
  const metricsHost = el('div.detail__metrics');
  const sparkHost = el('div', { style: 'width:130px' });

  let currentTab = new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab') ?? 'console';

  const tabsHost = el('div.tabs', { role: 'tablist' });
  const bodyHost = el('div.detail__body');

  /*
   * Two rows rather than one wrapping line: identity and actions up top, the
   * live numbers on their own row underneath. Six groups on one line was the
   * main reason this header felt cramped.
   */
  const header = el(
    'header.detail__head',
    el('div.detail__row', avatar, el('div.detail__id', nameHost), badgeHost, el('span.spacer'), actionsHost),
    el('div.detail__row.detail__row--meta', metaHost, el('span.spacer'), sparkHost, metricsHost),
  );

  const page = el('div.detail', header, el('div.detail__tabs', tabsHost), bodyHost);

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  const TABS = [
    { id: 'console', label: 'Console', icon: 'terminal', live: true },
    { id: 'overview', label: 'Overview', icon: 'gauge' },
    { id: 'connect', label: 'Connect', icon: 'globe', live: true },
    { id: 'players', label: 'Players', icon: 'users', badge: () => getServer(serverId)?.onlineCount || null },
    { id: 'properties', label: 'Properties', icon: 'sliders' },
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'backups', label: 'Backups', icon: 'archive' },
    { id: 'automation', label: 'Automation', icon: 'clock' },
  ];

  let tabInstance = null;

  function renderTabs() {
    mount(
      tabsHost,
      ...TABS.map((tab) => {
        const badge = tab.badge?.();
        return el(
          'button.tab',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': currentTab === tab.id ? 'true' : 'false',
            class: currentTab === tab.id ? 'tab--active' : '',
            onclick: () => switchTab(tab.id),
          },
          el('span', { html: icon(tab.icon, { size: 14 }) }),
          tab.label,
          badge ? el('span.tab__count', String(badge)) : null,
        );
      }),
    );
  }

  async function switchTab(id, { silent = false } = {}) {
    if (currentTab === id && tabInstance) return;
    tabInstance?.destroy?.();
    tabInstance = null;
    currentTab = id;

    // Keep the tab in the URL so a refresh lands back here.
    const url = new URL(location.href);
    url.hash = `#/servers/${serverId}?tab=${id}`;
    history.replaceState(null, '', url);

    renderTabs();

    // Kept as a reference so we can tell whether the branch below actually
    // replaced it. A tab that builds its element without mounting it would
    // otherwise leave this skeleton on screen indefinitely.
    const skeleton = el('div.pane.pane--loading', el('div.stack--md', el('div.skel', { style: 'height:1.2rem;width:35%' }), el('div.skel.skel--block'), el('div.skel.skel--block')));
    mount(bodyHost, skeleton);

    const server = getServer(serverId) ?? initial;

    try {
      switch (id) {
        case 'console':
          tabInstance = createConsole({ serverId, getServer: () => getServer(serverId) });
          mount(bodyHost, el('div.pane.pane--console', tabInstance.el));
          tabInstance.focus();
          break;

        // NOTE: every branch must mount `tabInstance.el` into `bodyHost`.
        // Overview and Players used to build their element and drop it on the
        // floor, which left the pane showing its loading skeleton forever.
        case 'overview':
          tabInstance = await renderOverview(server);
          mount(bodyHost, el('div.pane', tabInstance.el));
          break;

        case 'connect':
          tabInstance = await createConnectTab({ serverId, getServer: () => getServer(serverId) });
          mount(bodyHost, el('div.pane', tabInstance.el));
          break;

        case 'players':
          tabInstance = await renderPlayers(server);
          mount(bodyHost, el('div.pane', tabInstance.el));
          break;

        case 'properties':
          tabInstance = await createPropertiesTab({ serverId, getServer: () => getServer(serverId) });
          mount(bodyHost, el('div.pane', tabInstance.el));
          break;

        case 'files':
          tabInstance = await createFilesTab({ serverId, getServer: () => getServer(serverId) });
          mount(bodyHost, el('div.pane', tabInstance.el));
          break;

        case 'backups':
          tabInstance = await createBackupsTab({ serverId, getServer: () => getServer(serverId) });
          mount(bodyHost, el('div.pane', tabInstance.el));
          break;

        case 'automation':
          tabInstance = await createAutomationTab({ serverId, getServer: () => getServer(serverId), onSaved: () => refreshHeader() });
          mount(bodyHost, el('div.pane', tabInstance.el));
          break;

        default:
          mount(bodyHost, el('div.pane', emptyState({ icon: 'question', title: 'Unknown tab' })));
      }

      if (bodyHost.firstElementChild === skeleton) {
        console.error(`[server] tab "${id}" returned a view but never mounted it`);
        mount(
          bodyHost,
          el(
            'div.pane',
            emptyState({
              icon: 'alertCircle',
              title: 'This tab did not display',
              text: `The "${id}" view returned nothing to show. This is a bug — the console tab still works.`,
            }),
          ),
        );
      }
    } catch (error) {
      if (!silent) toast.fromError(error, 'Could not open that tab');
      mount(
        bodyHost,
        el(
          'div.pane',
          el(
            'div.callout.callout--error',
            el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }),
            el('div', el('div.callout__title', 'Could not load this tab'), el('div', error.message), el('button.btn.btn--sm', { style: 'margin-top:0.6rem', onclick: () => switchTab(id) }, 'Retry')),
          ),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------
  // Header rendering
  // ---------------------------------------------------------------------
  function renderHeader() {
    const server = getServer(serverId) ?? initial;
    const meta = statusMeta(server.status);
    const platform = platformChip(server.platform, server.version, { build: server.build, loader: server.loader });
    const live = ['running', 'starting', 'stopping'].includes(server.status);

    avatar.style.setProperty('--scard-rgb', meta.rgb);
    avatar.replaceChildren(el('span', { html: icon(meta.icon, { size: 22 }) }));

    mount(
      nameHost,
      el('span', { title: server.name }, server.name),
      statusBadge(server.status, { size: 'lg', adopted: server.adopted }),
    );

    mount(
      metaHost,
      platform,
      el('span.chip', el('span', { html: icon('network', { size: 12 }) }), `:${server.port}`),
      el('span.chip', el('span', { html: icon('coffee', { size: 12 }) }), `Java ${server.java?.major ?? '?'}`),
      el('span.chip', `heap ${mibFromMb(server.memory?.maxHeapMb ?? 0, 0)}`),
      server.disk
        ? el('span.chip', el('span', { html: icon('hardDrive', { size: 12 }) }), bytes(server.disk.bytes))
        : null,
      live && server.uptimeMs ? el('span.chip', el('span', { html: icon('clock', { size: 12 }) }), `up ${durationShort(server.uptimeMs)}`) : null,
      server.adopted ? el('span.badge.badge--warning', 'adopted process') : null,
    );

    mount(
      badgeHost,
      server.failure
        ? el(
            'button.badge.badge--danger',
            {
              type: 'button',
              style: 'cursor:pointer',
              'data-tip': `${server.failure.title} — click for details`,
              onclick: () => openFailureDialog(server),
            },
            el('span', { html: icon('alert', { size: 12 }) }),
            server.failure.title,
          )
        : null,
    );

    // -- Metrics ------------------------------------------------------
    const metrics = server.metrics ?? {};
    const usedMb = Math.round((metrics.rssBytes ?? 0) / 1024 / 1024);
    const heapMb = server.memory?.maxHeapMb ?? 0;

    const memory = memoryPair(metrics.rssBytes, heapMb);

    mount(
      metricsHost,
      metric('CPU', live ? percent(metrics.cpuPercent ?? 0, 1) : '—'),
      metric('Memory', live && usedMb ? memory.used : '—', live ? `/ ${memory.total} ${memory.unit}` : ''),
      metric('Players', String(server.onlineCount ?? 0), `/ ${server.maxPlayers ?? '—'}`),
      metric('Uptime', live ? durationShort(server.uptimeMs) : '—'),
    );

    // -- Sparkline ----------------------------------------------------
    const history = (server.history ?? []).map((entry) => (Array.isArray(entry) ? entry[1] : entry));
    if (live && history.length > 1) {
      sparkHost.style.display = '';
      mount(sparkHost, sparkline(history.slice(-60), { height: 32, tone: metrics.cpuPercent > 85 ? 'danger' : metrics.cpuPercent > 60 ? 'warning' : 'accent' }));
    } else {
      sparkHost.style.display = 'none';
    }

    renderActions(server);
  }

  const metric = (label, value, sub = '') =>
    el('div.dmetric', el('span.dmetric__label', label), el('span.dmetric__value', String(value), sub ? el('small', sub) : null));

  function renderActions(server) {
    const status = server.status;
    const live = ['running', 'starting', 'stopping'].includes(status);
    const hasPlayers = (server.onlineCount ?? 0) > 0;

    mount(
      actionsHost,
      !live
        ? el(
            'button.btn.btn--primary',
            { type: 'button', onclick: () => serverActions.start(server, { onDone: refreshHeader }) },
            el('span', { html: icon('play', { size: 15 }) }),
            'Start',
          )
        : el(
            'button.btn.btn--warn',
            {
              type: 'button',
              onclick: () => serverActions.stop(server, { onDone: refreshHeader }),
            },
            el('span', { html: icon('stop', { size: 15 }) }),
            hasPlayers ? 'Stop (players online)' : 'Stop',
          ),
      el(
        'button.btn',
        { type: 'button', disabled: !live && status !== 'crashed', onclick: () => serverActions.restart(server, { onDone: refreshHeader }) },
        el('span', { html: icon('restart', { size: 15 }) }),
        'Restart',
      ),
      el(
        'button.btn.btn--icon',
        { type: 'button', 'data-tip': 'Backup now', disabled: !server.dir, onclick: () => quickBackup(server) },
        el('span', { html: icon('archive', { size: 15 }) }),
      ),
      el(
        'button.btn.btn--icon',
        { type: 'button', 'data-tip': status === 'running' ? 'Ping the server list protocol' : 'Ping (server must be running)', onclick: () => quickPing(server) },
        el('span', { html: icon('wifi', { size: 15 }) }),
      ),
      el(
        'button.btn.btn--icon',
        { type: 'button', 'data-tip': 'More actions', onclick: (event) => openMoreMenu(event, server) },
        el('span', { html: icon('sliders', { size: 15 }) }),
      ),
    );
  }

  async function refreshHeader() {
    try {
      const fresh = await api.getServer(serverId);
      upsertServer(fresh, { silent: true });
      renderHeader();
    } catch {
      /* non-fatal */
    }
  }

  // ---------------------------------------------------------------------
  // Overview tab
  // ---------------------------------------------------------------------
  async function renderOverview(server) {
    const host = el('div.stack--lg');

    // -- Prompt card -----------------------------------------------------
    const promptCard = el('div.card.card--pad');
    mount(promptCard, el('div.muted.small', 'Loading server details…'));

    (async () => {
      try {
        const demand = await api.pingServer(serverId);
        mount(
          promptCard,
          el('div.row', { style: 'align-items:flex-start;gap:0.9rem' },
            demand.favicon
              ? el('img', { src: demand.favicon, width: '64', height: '64', style: 'border-radius:10px;image-rendering:pixelated;border:1px solid var(--line)' })
              : el('span.stat__icon', { html: icon('globe', { size: 20 }), style: 'width:64px;height:64px;border-radius:10px' }),
            el(
              'div.grow.stack--xs',
              el('div.row', el('strong', { style: 'font-size:0.95rem' }, server.name), demand.online ? el('span.badge.badge--success', `${demand.latencyMs} ms`) : el('span.badge.badge--neutral', 'not responding')),
              demand.rawMotd ? motdText(demand.motd, { className: 'small' }) : el('span.muted.small', demand.error ?? 'No MOTD returned'),
              el(
                'div.row.row--wrap',
                { style: 'gap:0.35rem;margin-top:0.3rem' },
                demand.version ? el('span.chip.chip--mono', `${demand.version.name} (${demand.version.protocol})`) : null,
                demand.players ? el('span.chip', `${demand.players.online} / ${demand.players.max} players`) : null,
                demand.mods?.length ? el('span.chip.chip--accent', `${demand.mods.length} mods`) : null,
              ),
              demand.players?.sample?.length
                ? el('div.roster', { style: 'margin-top:0.5rem' }, ...demand.players.sample.slice(0, 12).map((p) => playerChip(p.name, { online: true })))
                : null,
            ),
          ),
        );
      } catch (error) {
        mount(promptCard, el('div.muted.small', `Could not query the server list: ${error.message}`));
      }
    })();

    // -- Diagnostics -----------------------------------------------------
    const diagCard = el('div.card.card--pad');
    (async () => {
      try {
        const diag = await api.getDiagnostics(serverId);
        mount(
          diagCard,
          el('div.row', { style: 'margin-bottom:0.7rem' },
            el('span.stat__icon', { html: icon('shieldCheck', { size: 15 }), style: '--stat-rgb:var(--success-rgb)' }),
            el('div.grow', el('div.card__title', 'Health checks'), el('div.card__sub', `${diag.passed} of ${diag.total} passing`)),
          ),
          el(
            'div.stack--xs',
            ...diag.checks.map((check) =>
              el(
                'div.list__item',
                el('span.statusdot', { style: `--pulse-rgb:${check.ok ? 'var(--success-rgb)' : check.severity === 'error' ? 'var(--danger-rgb)' : 'var(--warning-rgb)'}` }),
                el('div.list__main', el('div.list__title', check.label), el('div.list__sub.truncate', { title: check.detail }, check.detail)),
                check.ok
                  ? el('span.badge.badge--success', 'ok')
                  : check.fix === 'accept-eula'
                    ? el('button.btn.btn--sm.btn--warn', { type: 'button', onclick: () => fixEula(server) }, 'Fix EULA')
                    : el('span.badge', { class: check.severity === 'error' ? 'badge--danger' : 'badge--warning' }, check.severity),
              ),
            ),
          ),
          el(
            'details',
            { style: 'margin-top:0.8rem' },
            el('summary', { style: 'cursor:pointer;font-size:0.8rem;color:var(--text-muted)' }, 'Show the exact startup command'),
            el('pre', { style: 'margin-top:0.5rem;padding:0.7rem;background:rgba(0,0,0,.4);border-radius:8px;overflow-x:auto;font-size:0.75rem;color:var(--text-soft)' }, diag.startupCommand),
          ),
        );
      } catch (error) {
        mount(diagCard, el('div.muted.small', `Could not run diagnostics: ${error.message}`));
      }
    })();

    // -- Resource plan ---------------------------------------------------
    const resourceCard = el('div.card.card--pad');
    (async () => {
      try {
        const data = await api.getResources(serverId);
        const usedMb = Math.round((server.metrics?.rssBytes ?? 0) / 1024 / 1024);
        mount(
          resourceCard,
          el('div.row', { style: 'margin-bottom:0.7rem' }, el('span.stat__icon', { html: icon('cpu', { size: 15 }) }), el('div.grow', el('div.card__title', 'Resources'), el('div.card__sub', 'Current allocation and what this machine could give'))),
          el(
            'div.kv',
            kv('Heap range', `${mibFromMb(data.memory.minHeapMb, 0)} – ${mibFromMb(data.memory.maxHeapMb, 0)}`),
            kv('Resident memory', usedMb ? mib(usedMb * 1024 * 1024, 0) : 'not running'),
            kv('GC profile', data.memory.gcProfile),
            kv('Java', `Java ${data.java.major} · ${data.java.vendor ?? 'unknown'}`),
            kv('Machine RAM', mibFromMb(data.system.totalRamMb, 0)),
            kv('Safe ceiling', mibFromMb(data.recommendation.ceilingMb, 0)),
            kv('Startup scripts', 'start.bat / start.sh in the server folder'),
          ),
        );
      } catch (error) {
        mount(resourceCard, el('div.muted.small', error.message));
      }
    })();

    // -- Files summary ---------------------------------------------------
    const filesCard = el('div.card.card--pad');
    (async () => {
      try {
        const listing = await api.listFiles(serverId, '');
        mount(
          filesCard,
          el('div.row', { style: 'margin-bottom:0.7rem' }, el('span.stat__icon', { html: icon('folder', { size: 15 }), style: '--stat-rgb:var(--warning-rgb)' }), el('div.grow', el('div.card__title', 'Server folder'), el('div.card__sub', `${listing.entries.length} items · ${bytes(listing.totals.bytes)}`))),
          el('div.stack--xs', ...listing.entries.slice(0, 12).map((entry) => quickFileRow(entry))),
          el('button.btn.btn--sm', { style: 'margin-top:0.6rem', onclick: () => switchTab('files') }, 'Browse all files'),
        );
      } catch (error) {
        mount(filesCard, el('div.muted.small', error.message));
      }
    })();

    host.append(
      el('div.grid.grid--4',
        statTile({ label: 'Uptime', value: server.uptimeMs ? durationShort(server.uptimeMs) : '—', icon: 'clock', tone: 'info', sub: server.lastStartedAt ? `since ${dateTime(server.lastStartedAt)}` : 'never started' }),
        statTile({ label: 'Total playtime', value: durationShort(server.totalUptimeMs ?? 0), icon: 'history', tone: 'violet', sub: 'sum across every session' }),
        statTile({ label: 'Backups', value: count(server.backupCount ?? 0), icon: 'archive', tone: 'accent', sub: server.backupBytes ? bytes(server.backupBytes) : 'none yet' }),
        statTile({
          label: 'Last exit',
          value: server.lastExitCode === null || server.lastExitCode === undefined ? '—' : String(server.lastExitCode),
          icon: 'power',
          tone: server.lastExitCode === 0 ? 'success' : server.lastExitCode ? 'danger' : 'accent',
          sub: server.lastStoppedAt ? relativeTime(server.lastStoppedAt) : 'not yet stopped',
        }),
      ),
      promptCard,
      el('div.pane__grid', el('div.stack--md', diagCard, resourceCard), el('div.stack--md', filesCard, renderExpandedKv(server))),
    );

    return {
      el: host,
      destroy() {
        /* nothing to tear down */
      },
    };
  }

  function quickFileRow(entry) {
    return el(
      'button.list__item',
      {
        type: 'button',
        style: 'width:100%;text-align:left',
        onclick: () => {
          if (entry.isDirectory) switchTab('files');
          else openFilePreview(entry.path);
        },
      },
      el('span.filerow__icon', { class: entry.isDirectory ? 'filerow__icon--dir' : '', html: icon(entry.isDirectory ? 'folder' : 'file', { size: 15 }) }),
      el('div.list__main', el('div.list__title.truncate', { style: 'font-family:var(--font-mono);font-size:0.78rem' }, entry.name)),
      el('span.dim.tiny', entry.formatted ?? ''),
    );
  }

  function renderExpandedKv(server) {
    return el(
      'div.card.card--pad',
      el('div.card__title', { style: 'margin-bottom:0.6rem' }, 'Configuration'),
      el(
        'div.kv',
        kv('Server id', server.id, true),
        kv('Platform', describeVersion(server)),
        kv('Version requirement', server.javaRequirement?.note ?? '—'),
        kv('Java path', server.java?.path ?? '—', true),
        kv('JVM flags', `${(server.jvmArgs ?? []).length} extra · ${server.memory?.gcProfile ?? 'aikar'} profile`),
        kv('Server arguments', (server.serverArgs ?? []).join(' ') || '—', true),
        kv('Auto-restart', server.autoRestart?.enabled ? `on, ${Math.round((server.autoRestart.delayMs ?? 5000) / 1000)}s delay` : 'off'),
        kv('Start on launch', server.options?.autoStart ? 'yes' : 'no'),
        kv('Folder', server.dir, true),
        kv('Created', dateTime(server.createdAt)),
      ),
      el(
        'div.row',
        { style: 'margin-top:0.8rem;gap:0.4rem;flex-wrap:wrap' },
        el('button.btn.btn--sm', { type: 'button', onclick: () => switchTab('properties') }, 'Edit properties'),
        el('button.btn.btn--sm', { type: 'button', onclick: () => switchTab('automation') }, 'Schedules'),
        el('button.btn.btn--sm', { type: 'button', onclick: () => openJvmPreview() }, 'Show JVM command'),
        el(
          'button.btn.btn--sm',
          { type: 'button', onclick: () => revealServerFolder(server) },
          el('span', { html: icon('folder', { size: 14 }) }),
          'Open folder',
        ),
      ),
    );
  }

  const kv = (key, value, mono = false) =>
    el('div.kv__row', el('span.kv__k', key), el('span', { class: `kv__v${mono ? ' kv__v--mono' : ''}` }, value ?? '—'));

  // ---------------------------------------------------------------------
  // Players tab
  // ---------------------------------------------------------------------
  async function renderPlayers(server) {
    const host = el('div.stack--lg');
    const refreshPlayers = async () => {
      try {
        const data = await api.getPlayers(serverId);
        paint(data);
      } catch (error) {
        toast.fromError(error, 'Could not load the player lists');
      }
    };

    const onlineHost = el('div.card.card--pad');
    const opsHost = el('div.card.card--pad');
    const whiteHost = el('div.card.card--pad');
    const banHost = el('div.card.card--pad');

    function paint(data) {
      const isLive = ['running', 'starting'].includes(getServer(serverId)?.status);

      mount(
        onlineHost,
        el('div.row', { style: 'margin-bottom:0.7rem' },
          el('span.stat__icon', { html: icon('users', { size: 15 }), style: '--stat-rgb:var(--success-rgb)' }),
          el('div.grow', el('div.card__title', 'Online right now'), el('div.card__sub', `${data.onlineCount ?? 0} player${data.onlineCount === 1 ? '' : 's'} connected`)),
        ),
        data.online?.length
          ? el('div.roster', ...data.online.map((p) => playerChip(p.name, { online: true })))
          : el('p.muted.small', isLive ? 'Nobody is online. The roster updates the moment someone joins.' : 'The server is not running.'),
        data.known?.length
          ? frag(
              el('hr'),
              el('div.card__sub', { style: 'margin-bottom:0.5rem' }, 'Everyone seen this session'),
              el('div.roster', ...data.known.map((p) => playerChip(p.name, { online: p.online }))),
            )
          : null,
      );

      mount(
        opsHost,
        el('div.row', { style: 'margin-bottom:0.6rem' }, el('span.stat__icon', { html: icon('shield', { size: 15 }), style: '--stat-rgb:var(--violet-rgb)' }), el('div.grow', el('div.card__title', 'Operators'), el('div.card__sub', 'Full access to in-game commands'))),
        data.ops?.length ? el('div.roster', ...data.ops.map((o) => playerChip(o.name, { removable: true, onRemove: () => changePlayer('ops', 'remove', o.name) }))) : el('p.muted.small', 'No operators yet. Add yourself before you join.'),
        el('button.btn.btn--sm', { style: 'margin-top:0.7rem', type: 'button', onclick: () => promptPlayer(opsHost, 'ops', 'add', 'Make someone an operator') }, el('span', { html: icon('userPlus', { size: 14 }) }), 'Add operator'),
      );

      mount(
        whiteHost,
        el('div.row', { style: 'margin-bottom:0.6rem' }, el('span.stat__icon', { html: icon('list', { size: 15 }), style: '--stat-rgb:var(--info-rgb)' }), el('div.grow', el('div.card__title', 'Whitelist'), el('div.card__sub', 'Only used when white-list=true in server.properties'))),
        data.whitelist?.length ? el('div.roster', ...data.whitelist.map((p) => playerChip(p.name, { removable: true, onRemove: () => changePlayer('whitelist', 'remove', p.name) }))) : el('p.muted.small', 'The whitelist is empty.'),
        el('button.btn.btn--sm', { style: 'margin-top:0.7rem', type: 'button', onclick: () => promptPlayer(whiteHost, 'whitelist', 'add', 'Allow a player to join') }, el('span', { html: icon('userPlus', { size: 14 }) }), 'Add to whitelist'),
      );

      mount(
        banHost,
        el('div.row', { style: 'margin-bottom:0.6rem' }, el('span.stat__icon', { html: icon('alertCircle', { size: 15 }), style: '--stat-rgb:var(--danger-rgb)' }), el('div.grow', el('div.card__title', 'Banned players'), el('div.card__sub', `${data.banned?.length ?? 0} banned`))),
        data.banned?.length
          ? el('div.stack--xs', ...data.banned.map((b) =>
              el('div.list__item',
                el('div.list__main', el('div.list__title', b.name), el('div.list__sub', `${b.reason ?? 'No reason given'} · ${b.source ?? ''} ${b.created ? `· ${relativeTime(Date.parse(b.created))}` : ''}`)),
                el('button.btn.btn--sm', { type: 'button', onclick: () => changePlayer('banned', 'remove', b.name) }, 'Pardon'),
              ),
            ))
          : el('p.muted.small', 'Nobody is banned.'),
      );
    }

    async function promptPlayer(host, list, action, title) {
      const name = await promptDialog({
        title,
        label: 'Minecraft username',
        placeholder: 'Notch',
        mono: true,
        confirmLabel: action === 'add' ? 'Add' : 'Remove',
        hint: '1–16 characters: letters, numbers and underscores.',
      });
      if (!name) return;
      await changePlayer(list, action, name);
    }

    async function changePlayer(list, action, name) {
      try {
        const result = await api.updatePlayer(serverId, list, { action, name });
        toast.success(
          `${name} ${action === 'remove' ? 'removed' : 'added'}`,
          result.applied === 'console'
            ? 'Applied live through the server console.'
            : 'Written to the JSON file — it takes effect on the next start (the server was offline).',
        );
        refreshPlayers();
      } catch (error) {
        toast.fromError(error, `Could not update ${list}`);
      }
    }

    host.append(
      el('p.muted.small', 'Changes are sent through the running server console when possible, so they apply instantly. When the server is offline the JSON files are edited directly.'),
      onlineHost,
      el('div.grid.grid--2', opsHost, whiteHost),
      banHost,
    );

    await refreshPlayers();

    const offPlayers = subscribe('players', (payload) => {
      if (payload.serverId === serverId) refreshPlayers();
    });

    return {
      el: host,
      destroy: () => offPlayers(),
    };
  }

  // ---------------------------------------------------------------------
  // Dialogs & helpers
  // ---------------------------------------------------------------------
  function openFailureDialog(server) {
    const modal = openModal({
      title: server.failure?.title ?? 'The server stopped unexpectedly',
      subtitle: 'The manager read the last lines of the log to work out why',
      icon: 'alert',
      tone: 'danger',
      body: el(
        'div.stack--md',
        el('p', { style: 'font-size:0.9rem;line-height:1.6' }, server.failure?.hint ?? 'Check the console for the first red line.'),
        server.lastExitCode !== null && server.lastExitCode !== undefined
          ? el('div.kv', kv('Exit code', String(server.lastExitCode)), kv('When', server.lastStoppedAt ? dateTime(server.lastStoppedAt) : 'unknown'))
          : null,
      ),
      footer: [
        el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Close'),
        el('button.btn', { type: 'button', onclick: () => { modal.close(); switchTab('console'); } }, 'Open console'),
        // When the app knows a specific one-click remedy, offer it instead of
        // making the user find the setting themselves.
        server.failure?.action === 'fix-server-ip'
          ? el(
              'button.btn.btn--warn',
              { type: 'button', onclick: () => { modal.close(); fixBindAddress(); } },
              el('span', { html: icon('wrench', { size: 14 }) }),
              'Clear server-ip',
            )
          : null,
        el(
          'button.btn.btn--primary',
          {
            type: 'button',
            onclick: () => { modal.close(); serverActions.start(getServer(serverId), { onDone: refreshHeader }); },
          },
          el('span', { html: icon('play', { size: 14 }) }),
          'Try again',
        ),
      ].filter(Boolean),
    });
  }

  async function fixBindAddress() {
    const pending = toast.show({ id: `bind-${serverId}`, title: 'Clearing server-ip…', tone: 'info', duration: 0 });
    try {
      const result = await api.fixBindAddress(serverId);
      pending.dismiss();
      toast.success(
        'Fixed',
        result.previous
          ? `server-ip was "${result.previous}" — it is now empty. Start the server again.`
          : 'server-ip was already empty.',
        { duration: 9000 },
      );
      await refreshHeader();
      if (currentTab === 'properties') switchTab('properties');
    } catch (error) {
      pending.dismiss();
      toast.fromError(error, 'Could not update server.properties');
    }
  }

  async function fixEula(server) {
    try {
      await api.acceptEula(serverId);
      toast.success('EULA accepted', 'eula.txt now says eula=true. You can start the server.');
      await refreshHeader();
      if (currentTab === 'overview') switchTab('overview');
    } catch (error) {
      toast.fromError(error, 'Could not update eula.txt');
    }
  }

  async function quickBackup(server) {
    const pending = toast.show({ id: `backup-${serverId}`, title: 'Creating a backup…', text: 'The world is flushed to disk first so the archive is consistent.', tone: 'info', duration: 0 });
    try {
      const result = await api.createBackup(serverId, { label: 'manual' });
      pending.dismiss();
      toast.success('Backup created', `${result.file} · ${result.formatted}${result.hot ? ' (taken while running)' : ''}`, { duration: 8000 });
    } catch (error) {
      pending.dismiss();
      toast.fromError(error, 'Backup failed');
    }
  }

  async function quickPing(server) {
    try {
      const result = await api.pingServer(serverId);
      if (result.online) {
        toast.success(`Server answered in ${result.latencyMs} ms`, `${result.motd ?? ''} — ${result.players?.online ?? 0}/${result.players?.max ?? '?'} players`, { duration: 8000 });
      } else {
        toast.warning('No response', result.error ?? 'Nothing answered the status request.', { duration: 8000 });
      }
    } catch (error) {
      toast.fromError(error, 'Ping failed');
    }
  }

  async function openFilePreview(path) {
    try {
      const file = await api.readFile(serverId, path);
      const modal = openModal({
        title: path.split('/').pop(),
        subtitle: `${file.lines} lines · ${bytes(file.size)}`,
        icon: 'fileText',
        size: 'wide',
        body: el('pre', { style: 'margin:0;padding:0.9rem;background:rgba(0,0,0,.42);border:1px solid var(--line);border-radius:10px;font-size:0.78rem;line-height:1.6;overflow:auto;max-height:56vh;white-space:pre-wrap' }, file.content),
        footer: [
          el('button.btn', { type: 'button', onclick: () => downloadText(path.split('/').pop(), file.content) }, el('span', { html: icon('download', { size: 14 }) }), 'Download'),
          el('button.btn.btn--primary', { type: 'button', onclick: () => { modal.close(); switchTab('files'); } }, 'Open in editor'),
        ],
      });
    } catch (error) {
      toast.fromError(error, 'Could not open that file');
    }
  }

  async function openJvmPreview() {
    try {
      const data = await api.getJvm(serverId);
      const modal = openModal({
        title: 'Startup command',
        subtitle: 'Exactly what the manager runs when you press Start',
        icon: 'terminal',
        size: 'wide',
        body: el(
          'div.stack--md',
          el('pre', { style: 'margin:0;padding:0.9rem;background:rgba(0,0,0,.42);border:1px solid var(--line);border-radius:10px;font-size:0.76rem;line-height:1.65;overflow:auto;white-space:pre-wrap;color:var(--text-soft)' }, data.command),
          el('div.kv',
            kv('Minimum heap', mibFromMb(data.memory.minHeapMb, 0)),
            kv('Maximum heap', mibFromMb(data.memory.maxHeapMb, 0)),
            kv('GC profile', data.memory.gcProfile),
            kv('Suggested for this machine', mibFromMb(data.recommendation.maxHeapMb, 0)),
          ),
          el('p.dim.tiny', 'The same flags are baked into start.bat and start.sh in the server folder, so you can launch it outside the dashboard if you prefer.'),
        ),
        footer: [el('button.btn.btn--primary', { type: 'button', onclick: () => modal.close() }, 'Close')],
      });
    } catch (error) {
      toast.fromError(error, 'Could not build the command');
    }
  }

  function openMoreMenu(event, server) {
    const items = [
      { icon: 'globe', label: 'How players connect', run: () => switchTab('connect') },
      { icon: 'terminal', label: 'Show startup command', run: () => openJvmPreview() },
      { icon: 'wifi', label: 'Ping server list', run: () => quickPing(server) },
      { icon: 'archive', label: 'Back up now', run: () => quickBackup(server) },
      { icon: 'sliders', label: 'Edit server.properties', run: () => switchTab('properties') },
      { icon: 'folder', label: 'Browse files', run: () => switchTab('files') },
      { icon: 'clock', label: 'Schedules & automation', run: () => switchTab('automation') },
      { icon: 'copy', label: 'Copy connection address', run: () => copyAddress(server) },
      { icon: 'hardDrive', label: 'Reveal folder on this PC', run: () => revealServerFolder(server) },
      { icon: 'download', label: 'Export console log', run: () => window.open(api.consoleExportUrl(serverId), '_blank') },
      { divider: true },
      { icon: 'refresh', label: 'Reinstall the server jar', run: () => reinstall(server) },
      { icon: 'power', label: 'Force kill the JVM', danger: true, run: () => forceKill(server) },
      { icon: 'trash', label: 'Delete this server', danger: true, run: () => deleteServerFlow(server) },
    ];

    const menu = el('div.card.card--glass');
    menu.style.cssText = 'position:fixed;z-index:60;min-width:250px;padding:0.35rem;box-shadow:var(--shadow-xl)';
    for (const item of items) {
      if (item.divider) {
        menu.appendChild(el('div', { style: 'height:1px;background:var(--line);margin:0.3rem 0.2rem' }));
        continue;
      }
      menu.appendChild(
        el(
          'button.list__item',
          {
            type: 'button',
            style: 'width:100%;text-align:left;padding:0.42rem 0.6rem',
            onclick: () => {
              closeMenu();
              item.run();
            },
          },
          el('span', { html: icon(item.icon, { size: 15 }), style: item.danger ? 'color:var(--danger)' : 'color:var(--text-muted)' }),
          el('span.grow', { style: item.danger ? 'color:var(--danger);font-size:0.85rem' : 'font-size:0.85rem' }, item.label),
        ),
      );
    }

    document.body.appendChild(menu);
    const rect = event.currentTarget.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.right - menuRect.width))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menuRect.height - 8, rect.bottom + 6)}px`;

    const closeMenu = () => {
      menu.remove();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onEsc, true);
      window.removeEventListener('scroll', closeMenu, true);
    };
    const onOutside = (e) => {
      if (!menu.contains(e.target)) closeMenu();
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') closeMenu();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
      window.addEventListener('scroll', closeMenu, true);
    }, 0);
  }

  async function copyAddress(server) {
    const address = `${location.hostname}:${server.port}`;
    const ok = await copyText(address);
    toast[ok ? 'success' : 'error'](ok ? `Copied ${address}` : 'Clipboard is unavailable');
  }

  async function revealServerFolder(server) {
    const ok = await desktop.revealPath(server.dir);
    if (!ok) toast.warning('Could not open the folder', 'Use the Files tab to browse it in the app instead.');
  }

  async function reinstall(server) {
    const modal = openModal({
      title: 'Reinstall the server jar',
      subtitle: 'Replaces only the jar — your world, configs, plugins and mods stay exactly as they are',
      icon: 'refresh',
      tone: 'warning',
      body: el(
        'div.stack--md',
        el('p.small.muted', `The manager will re-download ${describeVersion(server)} and rewrite start.bat / start.sh with the current settings.`),
        el('div.callout.callout--warn', el('span.callout__icon', { html: icon('alert', { size: 16 }) }), el('div', 'The server must be stopped. If it is running, stop it first.')),
      ),
      footer: [
        el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el(
          'button.btn.btn--primary',
          {
            type: 'button',
            onclick: async () => {
              modal.close();
              const pending = toast.show({ id: 'reinstall', title: 'Reinstalling…', text: 'Downloading a fresh server jar.', tone: 'info', duration: 0 });
              try {
                const result = await api.reinstall(serverId, { force: true });
                pending.dismiss();
                toast.success('Jar replaced', `${bytes(result.bytes)} downloaded. Restart the server when ready.`);
                refreshHeader();
              } catch (error) {
                pending.dismiss();
                toast.fromError(error, 'Reinstall failed');
              }
            },
          },
          'Reinstall',
        ),
      ],
    });
  }

  async function forceKill(server) {
    if (getSettings().confirmDestructive !== false) {
      const ok = await confirmDialog({
        title: `Force kill ${server.name}?`,
        message: 'The JVM is terminated immediately without saving.',
        detail: 'Unsaved chunks are lost. World files can be left in a partially written state. Use Stop unless the server is completely unresponsive.',
        confirmLabel: 'Force kill',
        requireText: server.slug ?? server.name,
        tone: 'danger',
        icon: 'skull',
      });
      if (!ok) return;
    }
    try {
      await api.killServer(serverId);
      toast.warning('Process killed', 'The JVM was terminated. Check the console for damage and restart when ready.');
      refreshHeader();
    } catch (error) {
      toast.fromError(error, 'Could not kill the process');
    }
  }

  async function deleteServerFlow(server) {
    const modal = openModal({
      title: `Delete ${server.name}`,
      subtitle: 'This cannot be undone',
      icon: 'trash',
      tone: 'danger',
      body: el(
        'div.stack--md',
        el('p.small', 'Two options — pick carefully.'),
        el(
          'label.check',
          el('input', { type: 'checkbox', id: 'del-files', checked: false }),
          el('span.check__box'),
          el('div.check__body',
            el('div.check__title', 'Also delete the world and every file in the server folder'),
            el('div.check__desc', `Permanently removes ${server.dir} (${server.disk ? bytes(server.disk.bytes) : 'size unknown'}). Backups in the manager's backup folder are kept.`),
          ),
        ),
        el(
          'div.callout.callout--warn',
          el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
          el('div', 'Leave the box unchecked to remove the server from the dashboard but keep every file on disk. You can re-import it later by pointing a new server at the same folder.'),
        ),
      ),
      footer: [
        el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el(
          'button.btn.btn--danger',
          {
            type: 'button',
            onclick: async () => {
              const deleteFiles = modal.root.querySelector('#del-files').checked;
              if (deleteFiles) {
                const typed = await promptDialog({ title: 'Confirm deletion', label: `Type "${server.name}" to permanently delete the files`, mono: true, confirmLabel: 'Delete everything' });
                if (typed !== server.name) {
                  toast.warning('Not deleted', 'The name did not match, so nothing was removed.');
                  return;
                }
              }
              modal.close();
              const pending = toast.show({ id: 'delete', title: 'Deleting…', tone: 'warning', duration: 0 });
              try {
                await api.deleteServer(serverId, { deleteFiles });
                pending.dismiss();
                toast.success(`${server.name} deleted`, deleteFiles ? 'The server folder was removed from disk.' : 'Files were kept on disk.');
                location.hash = '#/servers';
              } catch (error) {
                pending.dismiss();
                toast.fromError(error, 'Delete failed');
              }
            },
          },
          'Delete',
        ),
      ],
    });
  }

  // ---------------------------------------------------------------------
  // Live wiring
  // ---------------------------------------------------------------------
  const offs = [
    subscribe(`metrics:${serverId}`, () => renderHeader()),
    subscribe('servers', () => {
      renderHeader();
      if (currentTab === 'console' || currentTab === 'players') renderTabs();
    }),
    subscribe('console-event', (payload) => {
      if (payload.serverId !== serverId) return;
      if (payload.type === 'ready') {
        toast.success('Server is ready', `Booted in ${payload.seconds}s — it is accepting connections now.`);
      }
      if (payload.type === 'port-conflict') {
        toast.error('Port conflict', `Port ${getServer(serverId)?.port} is already in use. Change it under Properties.`, { duration: 12_000 });
      }
      if (payload.type === 'eula-required') {
        toast.warning('EULA not accepted', 'eula.txt needs to say eula=true.', {
          duration: 12_000,
          action: { label: 'Fix it now', onClick: () => fixEula(getServer(serverId)) },
        });
      }
    }),
    subscribe('schedule-event', (payload) => {
      if (payload.serverId !== serverId) return;
      if (payload.type === 'schedule-notice') {
        toast.warning(
          'Scheduled restart in 60 seconds',
          `${payload.players} player${payload.players === 1 ? '' : 's'} will be reconnected automatically.`,
          { duration: 15_000, action: { label: 'Cancel restart', onClick: () => api.cancelScheduledRestart(serverId).then(() => toast.info('Restart cancelled')) } },
        );
      }
    }),
  ];

  // The view owns the subscription for the whole server, so status, metrics and
  // the player roster stay live on every tab — not just the console. The console
  // component seeds its own scrollback over REST and consumes these frames.
  ws.subscribe(serverId);

  renderHeader();
  renderTabs();
  await switchTab(currentTab, { silent: true });

  // Sub-second uptime ticker for the header.
  const ticker = setInterval(() => {
    if (!page.isConnected) {
      clearInterval(ticker);
      return;
    }
    // Nobody is watching the uptime while the window is in the background.
    if (isIdle()) return;
    const server = getServer(serverId);
    if (!server || !['running', 'starting', 'stopping'].includes(server.status)) return;
    const host = metricsHost.querySelectorAll('.dmetric__value')[3];
    if (host) host.textContent = durationShort(Date.now() - (server.startedAt ?? Date.now()));
  }, 1000);

  return {
    el: page,
    title: initial.name,
    crumbs: [{ label: 'Servers', href: '#/servers' }, { label: initial.name }],
    flush: true,
    onEnter() {
      refreshHeader();
    },
    onLeave() {
      for (const off of offs) off();
      clearInterval(ticker);
      tabInstance?.destroy?.();
      ws.unsubscribe(serverId);
    },
  };
}

export default renderServer;
