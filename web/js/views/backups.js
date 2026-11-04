/**
 * Global backup browser — every archive across every server, plus storage
 * insight and bulk cleanup.
 */

import { el, mount, frag } from '../dom.js';
import { icon } from '../icons.js';
import { emptyState, statTile } from '../components.js';
import { state, serverList, wireLive, setServers } from '../store.js';
import { bytes, count, dateTime, relativeTime } from '../format.js';
import { toast, confirmDialog, openModal } from '../ui.js';
import api from '../api.js';

export async function renderBackups() {
  wireLive();

  const summaryHost = el('div.grid.grid--4');
  const listHost = el('div.stack--sm');
  const storageHost = el('div.card.card--pad');
  const filterSelect = el('select.select.input--sm', { style: 'max-width:220px' });
  const refreshBtn = el('button.btn.btn--sm', { type: 'button' }, el('span', { html: icon('refresh', { size: 14 }) }), 'Refresh');

  let allBackups = [];
  let storage = null;

  const page = el(
    'div.page',
    el(
      'div.page__head',
      el('div', el('h1.page__title', 'Backups'), el('p.page__sub', 'Every archive the manager has taken, newest first.')),
      el(
        'div.page__actions',
        refreshBtn,
        el('a.btn.btn--primary', { href: '#/servers' }, el('span', { html: icon('server', { size: 15 }) }), 'Pick a server'),
      ),
    ),
    summaryHost,
    el('div.pane__grid', el('div.stack--sm', el('div.row.row--between', el('div.card__title', 'Archive history'), filterSelect), listHost), storageHost),
  );

  async function load() {
    let servers = serverList();

    // The store may still be empty on a cold load of this route (or after every
    // server was deleted). Fetch once — deliberately NOT `return load()`, which
    // recursed forever whenever the list was legitimately empty and left the
    // router's in-flight render pending, freezing all navigation.
    if (!servers.length) {
      try {
        const result = await api.listServers();
        setServers(result.servers);
        servers = result.servers ?? [];
      } catch (error) {
        mount(
          listHost,
          el(
            'div.callout.callout--error',
            el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }),
            el('div', error.message),
          ),
        );
        return;
      }
    }

    if (!servers.length) {
      // Genuinely nothing to show: paint the empty state and stop.
      allBackups = [];
      paint();
      return;
    }

    const results = await Promise.all(
      servers.map(async (server) => {
        try {
          const data = await api.listBackups(server.id);
          return data.backups.map((backup) => ({ ...backup, serverName: server.name, platform: server.platform, dir: data.dir }));
        } catch {
          return [];
        }
      }),
    );

    allBackups = results.flat().sort((a, b) => b.createdAt - a.createdAt);

    try {
      storage = await api.storage();
    } catch {
      storage = null;
    }

    paint();
  }

  function paint() {
    const totalBytes = allBackups.reduce((sum, b) => sum + b.bytes, 0);
    const hotCount = allBackups.filter((b) => b.hot).length;
    const uniqueServers = new Set(allBackups.map((b) => b.serverId)).size;

    mount(
      summaryHost,
      statTile({ label: 'Archives', value: count(allBackups.length), icon: 'archive', tone: 'accent', sub: `across ${uniqueServers} server${uniqueServers === 1 ? '' : 's'}` }),
      statTile({ label: 'Total size', value: (totalBytes / 1024 ** 3).toFixed(2), unit: 'GiB', icon: 'hardDrive', tone: 'violet', sub: storage?.disk ? `${bytes(storage.disk.free)} free on disk` : 'disk usage unknown' }),
      statTile({ label: 'Consistent copies', value: allBackups.length ? percent(Math.round(((allBackups.length - hotCount) / allBackups.length) * 100), 0) : '—', icon: 'shieldCheck', tone: 'success', sub: `${hotCount} taken while running` }),
      statTile({ label: 'Newest', value: allBackups.length ? relativeTime(allBackups[0].createdAt) : '—', icon: 'clock', tone: 'info', sub: allBackups.length ? allBackups[0].serverName : 'no archives yet' }),
    );

    // -- Storage breakdown -------------------------------------------
    mount(
      storageHost,
      el('div.row', { style: 'margin-bottom:0.7rem' }, el('span.stat__icon', { html: icon('database', { size: 15 }) }), el('div.grow', el('div.card__title', 'Disk usage'), el('div.card__sub', storage?.disk ? `${bytes(storage.disk.free)} free of ${storage.disk.totalFormatted}` : 'scanning…'))),
      storage?.disk
        ? el('div.progress.progress--lg', { style: 'margin-bottom:0.8rem' }, el('span.progress__fill', { style: `width:${Math.min(100, storage.disk.usedPercent ?? 0)}%`, class: (storage.disk.usedPercent ?? 0) > 90 ? 'progress--danger' : '' }))
        : null,
      el(
        'div.kv',
        el('div.kv__row', el('span.kv__k', 'Worlds & server folders'), el('span.kv__v', storage ? bytes(storage.servers?.bytes ?? 0) : '—')),
        el('div.kv__row', el('span.kv__k', 'Backups'), el('span.kv__v', storage ? bytes(storage.backups?.bytes ?? 0) : '—')),
        el('div.kv__row', el('span.kv__k', 'Downloaded jars & JDKs'), el('span.kv__v', storage ? bytes(storage.downloads?.bytes ?? 0) : '—')),
      ),
      storage?.perServer?.length
        ? frag(
            el('hr'),
            el('div.card__sub', { style: 'margin-bottom:0.5rem' }, 'Largest server folders'),
            el(
              'div.stack--xs',
              ...storage.perServer.slice(0, 6).map((entry) =>
                el(
                  'div.list__item',
                  el('span.filerow__icon', { html: icon('folder', { size: 14 }) }),
                  el('div.list__main', el('div.list__title', entry.name)),
                  el('span.dim.tiny.tnum', entry.formatted),
                ),
              ),
            ),
          )
        : null,
    );

    // -- Archive list -------------------------------------------------
    const selected = filterSelect.value || 'all';
    const filtered = selected === 'all' ? allBackups : allBackups.filter((b) => b.serverId === selected);

    if (!allBackups.length) {
      mount(
        listHost,
        el('div.card', emptyState({
          icon: 'archive',
          title: 'No backups yet',
          text: 'Open a server and use its Backups tab, or set up a schedule so archives are taken automatically.',
          action: el('a.btn.btn--primary', { href: '#/servers', style: 'margin-top:0.5rem' }, 'Go to servers'),
        })),
      );
      return;
    }

    mount(
      listHost,
      ...filtered.map((backup) =>
        el(
          'div.backuprow',
          el('span.backuprow__icon', { html: icon('archive', { size: 16 }) }),
          el(
            'div.backuprow__id',
            el('div.backuprow__name.truncate', { title: backup.file }, backup.file),
            el(
              'div.backuprow__meta',
              el('span.accent', backup.serverName),
              el('span', bytes(backup.bytes)),
              el('span', dateTime(backup.createdAt)),
              backup.label ? el('span.badge.badge--neutral', backup.label) : null,
              backup.hot ? el('span.badge.badge--warning', 'hot') : el('span.badge.badge--success', 'cold'),
            ),
          ),
          el(
            'div.backuprow__actions',
            el('button.iconbtn.iconbtn--xs', { type: 'button', 'data-tip': 'Open server', onclick: () => { location.hash = `#/servers/${backup.serverId}?tab=backups`; } }, el('span', { html: icon('chevronRight', { size: 13 }) })),
            el('button.iconbtn.iconbtn--xs', { type: 'button', 'data-tip': 'Download', onclick: () => window.open(api.backupDownloadUrl(backup.serverId, backup.file), '_blank') }, el('span', { html: icon('download', { size: 13 }) })),
            el(
              'button.iconbtn.iconbtn--xs',
              {
                type: 'button',
                'data-tip': 'Delete',
                onclick: async () => {
                  const ok = await confirmDialog({
                    title: `Delete ${backup.file}?`,
                    message: `The archive (${bytes(backup.bytes)}) will be removed from disk.`,
                    confirmLabel: 'Delete',
                    tone: 'danger',
                    icon: 'trash',
                  });
                  if (!ok) return;
                  try {
                    await api.deleteBackup(backup.serverId, backup.file);
                    toast.success('Backup deleted');
                    load();
                  } catch (error) {
                    toast.fromError(error, 'Could not delete');
                  }
                },
              },
              el('span', { html: icon('trash', { size: 13 }) }),
            ),
          ),
        ),
      ),
    );
  }

  // -- Server filter -----------------------------------------------------
  function paintFilter() {
    const servers = serverList();
    const previous = filterSelect.value || 'all';
    mount(
      filterSelect,
      el('option', { value: 'all' }, `All servers (${allBackups.length})`),
      ...servers.map((server) => {
        const n = allBackups.filter((b) => b.serverId === server.id).length;
        return el('option', { value: server.id, selected: previous === server.id }, `${server.name} (${n})`);
      }),
    );
    if ([...filterSelect.options].some((o) => o.value === previous)) filterSelect.value = previous;
  }

  filterSelect.addEventListener('change', () => paint());
  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('is-loading');
    load()
      .then(() => toast.success('Backups refreshed'))
      .catch((error) => toast.fromError(error, 'Could not refresh'))
      .finally(() => refreshBtn.classList.remove('is-loading'));
  });

  mount(
    listHost,
    el(
      'div.stack--sm',
      el('div.skel.skel--block'),
      el('div.skel.skel--block'),
      el('div.skel.skel--block'),
    ),
  );

  await load();
  paintFilter();
  paint();

  return {
    el: page,
    title: 'Backups',
    crumbs: [{ label: 'Backups' }],
    onEnter: () => {
      load().then(paintFilter);
    },
  };
}

function percent(value, digits) {
  return `${Number(value).toFixed(digits)}%`;
}

export default renderBackups;
