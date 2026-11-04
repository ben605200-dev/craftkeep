/**
 * Servers list — a filterable, sortable view of every configured server.
 */

import { el, mount } from '../dom.js';
import { icon } from '../icons.js';
import { serverCard, updateServerCard, emptyState, skeletonGrid, serverActions, statusBadge } from '../components.js';
import { state, serverList, subscribe, wireLive, setServers } from '../store.js';
import { bytes, count, durationShort, percent, mibFromMb, relativeTime } from '../format.js';
import { toast, confirmDialog } from '../ui.js';
import api from '../api.js';

const SORTS = [
  ['name', 'Name'],
  ['status', 'Status'],
  ['players', 'Players'],
  ['memory', 'Memory'],
  ['recent', 'Recently started'],
  ['created', 'Newest first'],
];

export async function renderServers({ query }) {
  wireLive();

  const filters = {
    search: query.q ?? '',
    status: query.status ?? 'all',
    platform: query.platform ?? 'all',
    sort: query.sort ?? 'name',
    view: query.view ?? 'grid',
  };

  const cardsHost = el('div.servercards');
  const tableHost = el('div.card.card--flush');
  const resultsLine = el('span.muted.small');
  let cardIndex = new Map();

  const searchInput = el('input.input', {
    value: filters.search,
    placeholder: 'Search by name, version or port…',
    oninput: (event) => {
      filters.search = event.target.value;
      paint();
    },
  });

  const statusSegments = el(
    'div.segmented',
    ...[
      ['all', 'All'],
      ['running', 'Running'],
      ['stopped', 'Stopped'],
      ['crashed', 'Crashed'],
    ].map(([value, label]) =>
      el(
        'button.segmented__opt',
        {
          type: 'button',
          class: filters.status === value ? 'segmented__opt--active' : '',
          onclick: (event) => {
            filters.status = value;
            for (const sibling of event.target.parentElement.children) sibling.classList.remove('segmented__opt--active');
            event.target.classList.add('segmented__opt--active');
            paint();
          },
        },
        label,
      ),
    ),
  );

  const platformSelect = el(
    'select.select.input--sm',
    {
      style: 'max-width:150px',
      onchange: (event) => {
        filters.platform = event.target.value;
        paint();
      },
    },
    ...[['all', 'All platforms'], ['vanilla', 'Vanilla'], ['paper', 'Paper'], ['fabric', 'Fabric']].map(([value, label]) =>
      el('option', { value, selected: filters.platform === value }, label),
    ),
  );

  const sortSelect = el(
    'select.select.input--sm',
    {
      style: 'max-width:180px',
      onchange: (event) => {
        filters.sort = event.target.value;
        paint();
      },
    },
    ...SORTS.map(([value, label]) => el('option', { value, selected: filters.sort === value }, label)),
  );

  const page = el(
    'div.page',
    el(
      'div.page__head',
      el(
        'div',
        el('h1.page__title', 'Servers'),
        el('p.page__sub', 'Every server this manager knows about.'),
      ),
      el(
        'div.page__actions',
        el(
          'button.btn.btn--sm',
          { type: 'button', onclick: () => refresh() },
          el('span', { html: icon('refresh', { size: 14 }) }),
          'Refresh',
        ),
        el('a.btn.btn--primary', { href: '#/create' }, el('span', { html: icon('plus', { size: 15 }) }), 'New server'),
      ),
    ),
    el(
      'div.card.card--pad',
      el(
        'div.row.row--wrap',
        { style: 'gap:0.6rem' },
        el('div.search.grow', { style: 'min-width:200px' }, el('span.search__icon', { html: icon('search', { size: 15 }) }), searchInput),
        statusSegments,
        platformSelect,
        sortSelect,
      ),
      el('div.row', { style: 'margin-top:0.7rem' }, resultsLine),
    ),
    cardsHost,
    tableHost,
  );

  // ---------------------------------------------------------------------
  // Filtering + sorting
  // ---------------------------------------------------------------------
  function visibleServers() {
    let list = serverList();

    if (filters.search) {
      const needle = filters.search.toLowerCase();
      list = list.filter((s) =>
        [s.name, s.version, s.platform, String(s.port), s.slug].some((value) => String(value ?? '').toLowerCase().includes(needle)),
      );
    }

    if (filters.status !== 'all') {
      list = list.filter((s) => (filters.status === 'running' ? ['running', 'starting', 'stopping'].includes(s.status) : s.status === filters.status));
    }

    if (filters.platform !== 'all') list = list.filter((s) => s.platform === filters.platform);

    const statusRank = { running: 0, starting: 1, stopping: 2, crashed: 3, error: 4, stopped: 5 };
    const sorters = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      status: (a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || a.name.localeCompare(b.name),
      players: (a, b) => (b.onlineCount ?? 0) - (a.onlineCount ?? 0) || a.name.localeCompare(b.name),
      memory: (a, b) => (b.metrics?.rssBytes ?? 0) - (a.metrics?.rssBytes ?? 0) || a.name.localeCompare(b.name),
      recent: (a, b) => (b.lastStartedAt ?? 0) - (a.lastStartedAt ?? 0),
      created: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    };
    return list.sort(sorters[filters.sort] ?? sorters.name);
  }

  // ---------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------
  function paint() {
    const list = visibleServers();
    const all = serverList();
    const running = all.filter((s) => ['running', 'starting', 'stopping'].includes(s.status)).length;

    mount(
      resultsLine,
      el('span', `${list.length} of ${all.length} server${all.length === 1 ? '' : 's'}`),
      all.length ? el('span.dim', ' · ') : null,
      all.length ? el('span', { class: 'success' }, `${running} running`) : null,
      all.length ? el('span.dim', ' · ') : null,
      all.length ? el('span', `${count(all.reduce((sum, s) => sum + (s.onlineCount ?? 0), 0))} players online`) : null,
    );

    if (!all.length) {
      mount(
        cardsHost,
        el(
          'div.card',
          { style: 'grid-column:1/-1' },
          emptyState({
            icon: 'rocket',
            title: 'No servers configured',
            text: 'The manager can install and configure a Vanilla, Paper or Fabric server in a couple of minutes — jar download, Java detection, EULA and optimised config included.',
            action: el('a.btn.btn--primary.btn--lg', { href: '#/create', style: 'margin-top:0.6rem' }, el('span', { html: icon('plus', { size: 16 }) }), 'Create a server'),
          }),
        ),
      );
      mount(tableHost);
      return;
    }

    if (!list.length) {
      mount(cardsHost, el('div.card', { style: 'grid-column:1/-1' }, emptyState({ icon: 'search', title: 'Nothing matches those filters', text: 'Try clearing the search box or picking a different status.' })));
      mount(tableHost);
      return;
    }

    mount(cardsHost, ...list.map((server) => serverCard(server, { onAction: handleAction })));
    cardIndex = new Map();
    for (const card of cardsHost.querySelectorAll('.scard')) cardIndex.set(card.dataset.serverId, card);
  }

  function paintTable() {
    // The table view is opt-in via ?view=table; keep it lightweight.
    if (filters.view !== 'table') {
      mount(tableHost);
      return;
    }
    const list = visibleServers();
    mount(
      tableHost,
      el('table.table',
        el('thead', el('tr',
          el('th', 'Name'), el('th', 'Platform'), el('th', 'Status'),
          el('th.table__num', 'Port'), el('th.table__num', 'Players'),
          el('th.table__num', 'CPU'), el('th.table__num', 'Memory'),
          el('th', 'Uptime'), el('th'),
        )),
        el('tbody', ...list.map((server) =>
          el('tr',
            { style: 'cursor:pointer', onclick: () => { location.hash = `#/servers/${server.id}`; } },
            el('td', el('strong', server.name)),
            el('td', el('span.chip', `${server.platform} ${server.version}`)),
            el('td', statusBadge(server.status)),
            el('td.table__num', String(server.port)),
            el('td.table__num', `${server.onlineCount ?? 0} / ${server.maxPlayers ?? '—'}`),
            el('td.table__num', percent(server.metrics?.cpuPercent ?? 0, 0)),
            el('td.table__num', `${Math.round((server.metrics?.rssBytes ?? 0) / 1024 / 1024)} MiB`),
            el('td', ['running', 'starting'].includes(server.status) ? durationShort(server.uptimeMs) : '—'),
            el('td', el('button.btn.btn--sm', { type: 'button', onclick: (e) => { e.stopPropagation(); location.hash = `#/servers/${server.id}`; } }, 'Open')),
          ),
        )),
      ),
    );
  }

  function handleAction(action, server) {
    if (action === 'console') {
      location.hash = `#/servers/${server.id}`;
      return;
    }
    serverActions.dispatch(action, server, { onDone: refresh });
  }

  async function refresh() {
    try {
      const result = await api.listServers();
      setServers(result.servers);
      paint();
      toast.success('Refreshed');
    } catch (error) {
      toast.fromError(error, 'Could not refresh');
    }
  }

  // ---------------------------------------------------------------------
  // Live
  // ---------------------------------------------------------------------
  const offs = [
    subscribe('servers', () => {
      paint();
      paintTable();
    }),
    subscribe('metrics', () => {
      for (const [serverId, card] of cardIndex) {
        const server = serverList().find((s) => s.id === serverId);
        if (server) updateServerCard(card, server, server.metrics);
      }
    }),
  ];

  paint();
  paintTable();

  if (!state.servers.size) {
    mount(cardsHost, skeletonGrid(3));
    api
      .listServers()
      .then((result) => {
        setServers(result.servers);
        paint();
        paintTable();
      })
      .catch((error) => {
        mount(cardsHost, el('div.card.card--pad', el('div.callout.callout--error', el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }), el('div', error.message))));
      });
  }

  return {
    el: page,
    title: 'Servers',
    crumbs: [{ label: 'Servers' }],
    onEnter: () => paint(),
    onLeave() {
      for (const off of offs) off();
    },
  };
}

export default renderServers;
