/**
 * Dashboard — the at-a-glance home screen.
 *
 * Layout:
 *   hero stats → ambient health gauges → live server cards → activity feed
 */

import { el, mount, frag, on } from '../dom.js';
import { icon } from '../icons.js';
import { statusBadge, serverCard, updateServerCard, statTile, gauge, emptyState, skeletonGrid, serverActions, sparkline } from '../components.js';
import { state, subscribe, serverList, totalOnlinePlayers, wireLive, setServers } from '../store.js';
import { bytes, count, durationShort, percent, relativeTime, mibFromMb, statusMeta } from '../format.js';
import { toast, openModal, confirmDialog } from '../ui.js';
import api from '../api.js';
import ws from '../ws.js';
import { getSettings } from '../settings-cache.js';

export async function renderDashboard() {
  wireLive();

  const page = el('div.page');

  // ---------------------------------------------------------------------
  // Hero stats
  // ---------------------------------------------------------------------
  const statsRow = el('div.grid.grid--4');
  const healthRow = el('div.grid.grid--3');

  // ---------------------------------------------------------------------
  // Server cards
  // ---------------------------------------------------------------------
  const cardsHost = el('div.servercards');
  const serversSection = el(
    'section.stack--md',
    el(
      'div.section__head',
      el('span.section__title', 'Your servers'),
      el('span.section__line'),
      el(
        'button.btn.btn--sm.btn--ghost',
        { type: 'button', onclick: () => reload() },
        el('span', { html: icon('refresh', { size: 13 }) }),
        'Refresh',
      ),
      el('a.btn.btn--sm.btn--primary', { href: '#/create' }, el('span', { html: icon('plus', { size: 13 }) }), 'New server'),
    ),
    cardsHost,
  );

  // ---------------------------------------------------------------------
  // Activity feed
  // ---------------------------------------------------------------------
  const activity = el('div.list');
  const activitySection = el(
    'div.card.card--flush',
    el(
      'div.card__head',
      el('span.stat__icon', { html: icon('history', { size: 15 }), style: '--stat-rgb:var(--info-rgb)' }),
      el('div.grow', el('div.card__title', 'Activity'), el('div.card__sub', 'Live events from every server')),
      el('span.badge.badge--neutral', { id: 'activity-count' }, '0'),
    ),
    el('div.card__body.card__body--tight', activity),
  );

  const feed = [];
  function pushActivity(entry) {
    feed.unshift({ ...entry, ts: entry.ts ?? Date.now() });
    if (feed.length > 40) feed.pop();
    renderFeed();
  }

  function renderFeed() {
    const counter = activitySection.querySelector('#activity-count');
    if (counter) counter.textContent = String(feed.length);
    if (!feed.length) {
      mount(
        activity,
        el(
          'div.empty',
          { style: 'padding:1.6rem 0.5rem' },
          el('span.empty__art', { html: icon('bell', { size: 22 }) }),
          el('p.empty__title', 'Nothing yet'),
          el('p.empty__text', 'Start a server and the events will show up here.'),
        ),
      );
      return;
    }
    mount(activity, ...feed.slice(0, 14).map(activityRow));
  }

  function activityRow(entry) {
    const meta = statusMeta(entry.status ?? 'stopped');
    return el(
      'div.list__item',
      el('span.statusdot', { style: `--pulse-rgb:${meta.rgb}`, class: meta.dot ? 'statusdot--live' : '' }),
      el(
        'div.list__main',
        el('div.list__title.truncate', entry.title),
        el('div.list__sub', entry.detail ?? ''),
      ),
      el('span.dim.tiny.nowrap', { title: new Date(entry.ts).toLocaleString() }, relativeTime(entry.ts)),
      el(
        'button.iconbtn.iconbtn--xs',
        { type: 'button', 'data-tip': 'Open', onclick: () => { if (entry.serverId) location.hash = `#/servers/${entry.serverId}`; } },
        el('span', { html: icon('chevronRight', { size: 13 }) }),
      ),
    );
  }

  page.append(
    el(
      'div.page__head',
      el(
        'div',
        el('h1.page__title', greeting()),
        el('p.page__sub', 'Everything running on this machine, live.'),
      ),
      el(
        'div.page__actions',
        el(
          'button.btn',
          { type: 'button', id: 'dash-bulk-start', onclick: () => bulkAction('start') },
          el('span', { html: icon('play', { size: 14 }) }),
          'Start all',
        ),
        el(
          'button.btn',
          { type: 'button', onclick: () => bulkAction('stop') },
          el('span', { html: icon('stop', { size: 14 }) }),
          'Stop all',
        ),
      ),
    ),
    statsRow,
    healthRow,
    serversSection,
    activitySection,
  );

  // ---------------------------------------------------------------------
  // Renderers
  // ---------------------------------------------------------------------
  function renderStats() {
    const servers = serverList();
    const running = servers.filter((s) => ['running', 'starting', 'stopping'].includes(s.status));
    const crashed = servers.filter((s) => s.status === 'crashed');
    const players = totalOnlinePlayers();
    const ramUsedMb = running.reduce((sum, s) => sum + Math.round((s.metrics?.rssBytes ?? 0) / 1024 / 1024), 0);
    const ramAllocatedMb = running.reduce((sum, s) => sum + (s.memory?.maxHeapMb ?? 0), 0);
    const cpu = running.reduce((sum, s) => sum + (s.metrics?.cpuPercent ?? 0), 0);
    const system = state.system;

    mount(
      statsRow,
      statTile({
        label: 'Servers running',
        value: running.length,
        unit: `/ ${servers.length}`,
        icon: 'server',
        tone: running.length ? 'success' : 'accent',
        sub: crashed.length
          ? el('span.danger', el('span', { html: icon('alert', { size: 12 }) }), `${crashed.length} crashed`)
          : running.length === servers.length && servers.length
            ? 'All healthy'
            : servers.length
              ? `${servers.length - running.length} stopped`
              : 'No servers yet',
      }),
      statTile({
        label: 'Players online',
        value: count(players),
        icon: 'users',
        tone: 'info',
        sub: running.length ? `across ${running.length} server${running.length === 1 ? '' : 's'}` : 'nothing running',
      }),
      statTile({
        label: 'Memory in use',
        value: ramUsedMb ? (ramUsedMb / 1024).toFixed(1) : '0',
        unit: 'GiB',
        icon: 'memory',
        tone: 'violet',
        sub: ramAllocatedMb ? `of ${mibFromMb(ramAllocatedMb, 0)} allocated` : 'no heap claimed',
      }),
      statTile({
        label: 'CPU load',
        value: percent(cpu, 0),
        icon: 'cpu',
        tone: cpu > 80 ? 'danger' : cpu > 45 ? 'warning' : 'accent',
        sub: system ? `${system.system?.cpuCount ?? '?'} threads · ${percent(system.system?.cpuPercent ?? 0, 0)} system` : 'sampling…',
      }),
    );
  }

  function renderHealth() {
    const system = state.system;
    const java = state.java;
    const memory = system?.system?.memory;
    const memPct = memory?.usedPercent ?? 0;
    const disk = state.storage;
    const servers = serverList();

    const heapAllocatedMb = servers.filter((s) => ['running', 'starting'].includes(s.status)).reduce((sum, s) => sum + (s.memory?.maxHeapMb ?? 0), 0);
    const heapShare = memory?.totalMb ? (heapAllocatedMb / memory.totalMb) * 100 : 0;

    mount(
      healthRow,

      // -- System memory -------------------------------------------------
      el(
        'div.card.card--pad',
        el('div.row', el('span.stat__icon', { html: icon('memory', { size: 15 }), style: '--stat-rgb:var(--accent-rgb)' }), el('div.grow', el('div.card__title', 'System memory'), el('div.card__sub', memory ? `${(memory.usedMb / 1024).toFixed(1)} of ${(memory.totalMb / 1024).toFixed(1)} GiB` : 'sampling…'))),
        el(
          // `flex-wrap` matters: in a narrow three-column grid the gauge and the
          // figures would otherwise squeeze the value column down to a few
          // pixels and wrap "5.0 GB" one character per line.
          'div.row',
          { style: 'margin-top:0.9rem;gap:1rem;align-items:center;flex-wrap:wrap' },
          gauge(memPct, { size: 88, label: 'used', tone: memPct > 90 ? 'danger' : memPct > 75 ? 'warning' : 'accent' }),
          el(
            'div.grow',
            { style: 'min-width:158px' },
            el(
              'div.kv',
              el('div.kv__row', el('span.kv__k', 'Headroom'), el('span.kv__v', memory ? bytes(memory.freeBytes) : '—')),
              el('div.kv__row', el('span.kv__k', 'Reserved for OS'), el('span.kv__v', mibFromMb(state.system?.intervals?.reservedRamMb ?? 2048, 0))),
              el('div.kv__row', el('span.kv__k', 'Claimed by servers'), el('span.kv__v', `${mibFromMb(heapAllocatedMb, 0)} · ${percent(heapShare, 0)}`)),
            ),
          ),
        ),
      ),

      // -- Java runtime --------------------------------------------------
      el(
        'div.card.card--pad',
        el('div.row', el('span.stat__icon', { html: icon('coffee', { size: 15 }), style: '--stat-rgb:var(--warning-rgb)' }), el('div.grow', el('div.card__title', 'Java runtime'), el('div.card__sub', java?.installations?.length ? `${java.installations.length} installation${java.installations.length === 1 ? '' : 's'} detected` : 'checking…'))),
        el(
          'div.stack--sm',
          { style: 'margin-top:0.9rem' },
          java?.installations?.length
            ? frag(
                el(
                  'div.row.row--wrap',
                  { style: 'gap:0.35rem' },
                  ...java.installations.slice(0, 6).map((j) =>
                    el(
                      'span.chip',
                      { class: j.managed ? 'chip--accent' : '', 'data-tip': j.path },
                      el('span', { html: icon('coffee', { size: 12 }) }),
                      `Java ${j.major}`,
                      el('span.dim', j.vendor.split(' ')[0]),
                      j.isJdk ? el('span.accent', 'JDK') : el('span.dim', 'JRE'),
                    ),
                  ),
                ),
                el(
                  'div.kv',
                  el('div.kv__row', el('span.kv__k', 'Newest installed'), el('span.kv__v', java.majors?.length ? `Java ${Math.max(...java.majors)}` : 'none')),
                  el('div.kv__row', el('span.kv__k', 'Can run 1.21.x'), el('span.kv__v', { class: java.canRun?.[21] ? 'success' : 'danger' }, java.canRun?.[21] ? 'Yes' : 'Needs Java 21+')),
                  el('div.kv__row', el('span.kv__k', 'Can run latest'), el('span.kv__v', { class: java.canRun?.[25] ? 'success' : 'warning' }, java.canRun?.[25] ? 'Yes' : 'Needs Java 25+')),
                ),
              )
            : el(
                'div.callout.callout--warn',
                el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
                el('div', el('div.callout__title', 'No Java runtime found'), el('div', 'Servers cannot start without a JDK. Install one from Settings › Java — the manager can download it for you.')),
                el('a.btn.btn--sm', { href: '#/settings' }, 'Open settings'),
              ),
        ),
      ),

      // -- Activity sparkline -------------------------------------------
      el(
        'div.card.card--pad',
        el('div.row', el('span.stat__icon', { html: icon('activity', { size: 15 }), style: '--stat-rgb:var(--violet-rgb)' }), el('div.grow', el('div.card__title', 'Players over time'), el('div.card__sub', 'Last few minutes across all servers'))),
        (() => {
          const history = servers
            .flatMap((s) => (s.playerHistory ?? []).map((entry) => (Array.isArray(entry) ? entry[1] : entry)));
          const host = el('div', { style: 'margin-top:0.9rem' });
          host.appendChild(sparkline(history.slice(-60), { height: 62, tone: 'violet' }));
          return host;
        })(),
        el(
          'div.kv',
          { style: 'margin-top:0.5rem' },
          el('div.kv__row', el('span.kv__k', 'Peak today'), el('span.kv__v', count(Math.max(0, ...servers.flatMap((s) => (s.playerHistory ?? []).map((e) => (Array.isArray(e) ? e[1] : e)))), 0))),
          el('div.kv__row', el('span.kv__k', 'Disk used by servers'), el('span.kv__v', disk ? bytes(disk.servers?.bytes ?? 0) : '—')),
        ),
      ),
    );
  }

  function renderCards() {
    const servers = serverList();
    if (!servers.length) {
      mount(
        cardsHost,
        el(
          'div.card',
          { style: 'grid-column:1/-1' },
          emptyState({
            icon: 'rocket',
            title: 'No servers yet',
            text: 'Create your first Minecraft server. Pick Vanilla, Paper or Fabric — the manager downloads the jar, sorts out Java, accepts the EULA and writes an optimised config for you.',
            action: el(
              'a.btn.btn--primary.btn--lg',
              { href: '#/create', style: 'margin-top:0.6rem' },
              el('span', { html: icon('plus', { size: 16 }) }),
              'Create your first server',
            ),
          }),
        ),
      );
      return;
    }
    mount(cardsHost, ...servers.map((server) => serverCard(server, { onAction: handleAction })));
  }

  function handleAction(action, server) {
    if (action === 'console') {
      location.hash = `#/servers/${server.id}`;
      return;
    }
    serverActions.dispatch(action, server);
  }

  async function bulkAction(action) {
    const targets = serverList().filter((s) =>
      action === 'start' ? !['running', 'starting', 'stopping'].includes(s.status) : ['running', 'starting'].includes(s.status),
    );
    if (!targets.length) {
      toast.info('Nothing to do', `No servers need to be ${action === 'start' ? 'started' : 'stopped'}.`);
      return;
    }
    const ok = await confirmDialog({
      title: `${action === 'start' ? 'Start' : 'Stop'} ${targets.length} server${targets.length === 1 ? '' : 's'}?`,
      message: targets.map((s) => s.name).join(', '),
      confirmLabel: action === 'start' ? 'Start all' : 'Stop all',
      tone: action === 'start' ? 'accent' : 'warning',
      icon: action === 'start' ? 'play' : 'stop',
    });
    if (!ok) return;

    const pending = toast.show({ id: 'bulk', title: `${action === 'start' ? 'Starting' : 'Stopping'} ${targets.length} servers…`, tone: 'info', duration: 0 });
    try {
      const result = await api.bulk(action, targets.map((s) => s.id));
      pending.dismiss();
      const failures = (result.results ?? []).filter((r) => !r.ok);
      if (failures.length) {
        toast.warning('Partly done', `${result.succeeded} succeeded, ${failures.length} failed. ${failures[0].error ?? ''}`);
      } else {
        toast.success('Done', `${result.succeeded} server${result.succeeded === 1 ? '' : 's'} ${action === 'start' ? 'starting' : 'stopping'}.`);
      }
    } catch (error) {
      pending.dismiss();
      toast.fromError(error, `Bulk ${action} failed`);
    }
  }

  async function reload() {
    try {
      await Promise.all([api.listServers().then((r) => setServers(r.servers)), loadStorage()]);
      renderAll();
      toast.success('Refreshed');
    } catch (error) {
      toast.fromError(error, 'Could not refresh');
    }
  }

  async function loadStorage() {
    try {
      state.storage = await api.storage();
    } catch {
      /* non-fatal */
    }
  }

  // ---------------------------------------------------------------------
  // Live subscriptions
  // ---------------------------------------------------------------------
  const offs = [];
  const cardIndex = new Map();

  function renderAll() {
    renderStats();
    renderHealth();
    renderCards();
    cardIndex.clear();
    for (const card of cardsHost.querySelectorAll('.scard')) {
      cardIndex.set(card.dataset.serverId, card);
    }
  }

  offs.push(
    subscribe('servers', () => {
      renderStats();
      renderCards();
      cardIndex.clear();
      for (const card of cardsHost.querySelectorAll('.scard')) cardIndex.set(card.dataset.serverId, card);
    }),
  );

  offs.push(
    subscribe('metrics', () => {
      for (const [serverId, card] of cardIndex) {
        const server = serverList().find((s) => s.id === serverId);
        if (server) updateServerCard(card, server, server.metrics);
      }
      renderStats();
    }),
  );

  offs.push(
    subscribe('system', () => {
      renderHealth();
      renderStats();
    }),
  );

  offs.push(
    subscribe('connection', ({ state: connectionState }) => {
      if (connectionState === 'reconnecting') pushActivity({ title: 'Dashboard reconnecting…', detail: 'The link to the manager dropped. Retrying automatically.', status: 'starting' });
    }),
  );

  offs.push(
    subscribe('lifecycle', (payload) => {
      const server = serverList().find((s) => s.id === payload.serverId);
      const name = server?.name ?? payload.serverId;
      const phrases = {
        started: ['Starting', 'the JVM is booting'],
        stopped: ['Stopped', payload.uptimeMs ? `ran for ${durationShort(payload.uptimeMs)}` : 'shut down cleanly'],
        crashed: ['Crashed', payload.failure?.title ?? 'exited unexpectedly'],
        'scheduled-restart': ['Auto-restart queued', `retrying in ${Math.round((payload.delayMs ?? 0) / 1000)}s`],
      };
      const [verb, detail] = phrases[payload.phase] ?? [payload.phase, ''];
      pushActivity({
        title: `${name}: ${verb}`,
        detail,
        serverId: payload.serverId,
        status: payload.phase === 'crashed' ? 'crashed' : payload.phase === 'stopped' ? 'stopped' : 'running',
      });
    }),
  );

  offs.push(
    subscribe('console-event', (payload) => {
      const server = serverList().find((s) => s.id === payload.serverId);
      const name = server?.name ?? payload.serverId;
      if (payload.type === 'join') pushActivity({ title: `${payload.player} joined ${name}`, serverId: payload.serverId, status: 'running' });
      else if (payload.type === 'leave') pushActivity({ title: `${payload.player} left ${name}`, serverId: payload.serverId, status: 'stopped' });
      else if (payload.type === 'advancement') pushActivity({ title: `${payload.player} earned ${payload.advancement}`, detail: name, serverId: payload.serverId, status: 'running' });
      else if (payload.type === 'ready') pushActivity({ title: `${server?.name ?? 'Server'} is ready`, detail: `booted in ${payload.seconds}s`, serverId: payload.serverId, status: 'running' });
    }),
  );

  offs.push(
    subscribe('schedule-event', (payload) => {
      const server = serverList().find((s) => s.id === payload.serverId);
      const name = server?.name ?? payload.serverId;
      if (payload.type === 'schedule-start') pushActivity({ title: `Scheduled ${payload.kind} started`, detail: name, serverId: payload.serverId, status: 'starting' });
      else if (payload.type === 'schedule-done') pushActivity({ title: `Scheduled ${payload.kind} finished`, detail: `${name} · ${payload.detail ?? ''}`, serverId: payload.serverId, status: 'running' });
      else if (payload.type === 'schedule-failed') pushActivity({ title: `Scheduled ${payload.kind} failed`, detail: payload.error, serverId: payload.serverId, status: 'crashed' });
    }),
  );

  // ---------------------------------------------------------------------
  // Initial paint
  // ---------------------------------------------------------------------
  renderStats();
  renderHealth();
  mount(cardsHost, skeletonGrid(3));
  renderFeed();

  // Hydrate anything the WebSocket has not delivered yet.
  (async () => {
    try {
      const [list, , onboarding] = await Promise.all([
        api.listServers(),
        loadStorage(),
        api.onboarding().catch(() => null),
      ]);
      setServers(list.servers);
      state.onboarding = onboarding;
      renderAll();
      if (onboarding && !onboarding.complete && list.servers.length === 0) showOnboarding(onboarding);
    } catch (error) {
      mount(cardsHost, el('div.card.card--pad', el('div.callout.callout--error', el('span.callout__icon', { html: icon('alert', { size: 16 }) }), el('div', el('div.callout__title', 'Could not load your servers'), el('div', error.message), el('button.btn.btn--sm', { style: 'margin-top:0.6rem', onclick: () => reload() }, 'Try again')))));
    }
  })();

  return {
    el: page,
    title: 'Dashboard',
    crumbs: [{ label: 'Dashboard' }],
    onEnter() {
      renderAll();
    },
    onLeave() {
      for (const off of offs) off();
    },
  };
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** First-run checklist modal. */
function showOnboarding(onboarding) {
  const modal = openModal({
    title: 'Welcome to Craftkeep',
    subtitle: 'A couple of quick checks before your first server',
    icon: 'rocket',
    size: 'default',
    body: el(
      'div.stack--md',
      el(
        'div.stack--xs',
        ...onboarding.steps.map((step) =>
          el(
            'div.list__item',
            el('span.stat__icon', {
              style: `--stat-rgb:${step.done ? 'var(--success-rgb)' : 'var(--warning-rgb)'};width:26px;height:26px`,
              html: icon(step.done ? 'check' : 'alert', { size: 14 }),
            }),
            el('div.list__main', el('div.list__title', step.label), el('div.list__sub', step.detail)),
          ),
        ),
      ),
      el(
        'div.callout',
        el('span.callout__icon', { html: icon('info', { size: 16 }) }),
        el('div', el('div.callout__title', 'What happens when you create a server'), el('div', 'The manager downloads the correct jar, picks a matching Java runtime, accepts the EULA on your behalf, writes an optimised server.properties and generates start scripts. Your world lives in the servers/ folder next to the app.')),
      ),
    ),
    footer: [
      el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Later'),
      el('a.btn.btn--primary', { href: '#/create', onclick: () => modal.close() }, el('span', { html: icon('plus', { size: 15 }) }), 'Create a server'),
    ],
  });
}

export default renderDashboard;
