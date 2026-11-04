/**
 * Tab bodies for the server detail view: Properties, Files, Backups and
 * Automation. Each factory returns `{ el, destroy? }` so the router can tear
 * down subscriptions cleanly when the user switches tabs.
 */

import { el, mount, frag, debounce, on, downloadText, copyText, focusSoft, uuid } from '../dom.js';
import { icon } from '../icons.js';
import { emptyState, statTile, serverActions } from '../components.js';
import { bytes, dateTime, durationShort, mibFromMb, percent, relativeTime, statusMeta, count } from '../format.js';
import { toast, confirmDialog, openModal, promptDialog, busyOverlay } from '../ui.js';
import { subscribe, getServer, upsertServer } from '../store.js';
import { getSettings } from '../settings-cache.js';
import api from '../api.js';
import ws from '../ws.js';
import desktop from '../desktop.js';

// ===========================================================================
// Properties
// ===========================================================================

export async function createPropertiesTab({ serverId }) {
  const data = await api.getProperties(serverId);
  const original = { ...data.values };
  const current = { ...data.values };
  const dirty = new Set();

  const host = el('div.stack--lg');
  const search = el('input.input.input--sm', { placeholder: 'Search settings…', style: 'max-width:280px' });
  const groupsHost = el('div.stack--lg');
  const saveBar = el('div.card.card--pad.card--glass');
  saveBar.style.cssText += ';position:sticky;bottom:0.5rem;z-index:5;display:none';

  const restartKeys = new Set(data.restartRequiredKeys ?? []);

  function field(schema) {
    const value = current[schema.key];
    const inputId = `prop-${schema.key}`;

    let control;
    switch (schema.type) {
      case 'bool':
        control = el(
          'label.switch.switch--sm',
          el('input', {
            type: 'checkbox',
            checked: value === 'true',
            onchange: (event) => set(schema.key, event.target.checked ? 'true' : 'false'),
          }),
          el('span.switch__track'),
        );
        break;

      case 'enum':
        control = el(
          'select.select.input--sm',
          { onchange: (event) => set(schema.key, event.target.value) },
          ...schema.values.map((option) => el('option', { value: option, selected: value === option }, option)),
        );
        break;

      case 'int':
        control = el('input.input.input--sm.input--mono', {
          type: 'number',
          value: String(value ?? ''),
          min: schema.min !== undefined ? String(schema.min) : undefined,
          max: schema.max !== undefined ? String(schema.max) : undefined,
          style: 'max-width:150px',
          oninput: (event) => set(schema.key, event.target.value),
        });
        break;

      case 'password':
        control = el('input.input.input--sm.input--mono', {
          type: 'password',
          value: String(value ?? ''),
          style: 'max-width:200px',
          oninput: (event) => set(schema.key, event.target.value),
        });
        break;

      default:
        control = el('input.input.input--sm', {
          value: String(value ?? ''),
          maxlength: schema.maxLength ? String(schema.maxLength) : undefined,
          oninput: (event) => set(schema.key, event.target.value),
        });
    }

    return el(
      'div.settingrow',
      { 'data-key': schema.key, 'data-search': `${schema.key} ${schema.label} ${schema.group}`.toLowerCase() },
      el(
        'div.settingrow__main',
        el(
          'label.settingrow__title',
          { for: inputId },
          schema.label,
          restartKeys.has(schema.key) ? el('span.badge.badge--warning', 'restart') : null,
          // Reference only — revealed on hover, so it does not add a permanent
          // third line to every one of the 51 rows.
          el('span.settingrow__key', { title: schema.key }, schema.key),
        ),
        schema.help ? el('div.settingrow__desc', schema.help) : null,
      ),
      el('div.settingrow__control', control),
    );
  }

  function set(key, value) {
    if (original[key] === value) dirty.delete(key);
    else dirty.add(key);
    current[key] = value;
    paintSaveBar();
  }

  function paintSaveBar() {
    if (!dirty.size) {
      saveBar.style.display = 'none';
      return;
    }
    saveBar.style.display = '';
    mount(
      saveBar,
      el(
        'div.row',
        el('span.stat__icon', { html: icon('pencil', { size: 15 }), style: '--stat-rgb:var(--warning-rgb)' }),
        el(
          'div.grow',
          el('div.card__title', `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}`),
          el('div.card__sub', [...dirty].slice(0, 5).join(', ') + (dirty.size > 5 ? ` +${dirty.size - 5} more` : '')),
        ),
        el('button.btn.btn--sm', { type: 'button', onclick: () => { for (const key of [...dirty]) { current[key] = original[key]; } dirty.clear(); paint(); paintSaveBar(); } }, 'Discard'),
        el(
          'button.btn.btn--sm.btn--primary',
          {
            type: 'button',
            onclick: async (event) => {
              const btn = event.currentTarget;
              btn.classList.add('is-loading');
              btn.replaceChildren(el('span.spinner'), ' Saving…');
              try {
                const payload = {};
                for (const key of dirty) payload[key] = current[key];
                const needsRestart = [...dirty].some((key) => restartKeys.has(key));
                const result = await api.saveProperties(serverId, payload, { restart: false });
                for (const key of dirty) original[key] = current[key];
                dirty.clear();
                paintSaveBar();
                if (result.restartRequired?.length) {
                  const server = getServer(serverId);
                  const live = ['running', 'starting'].includes(server?.status);
                  toast.success('Saved', `${result.restartRequired.length} setting(s) only apply after a restart.`, {
                    duration: 9000,
                    ...(live
                      ? { action: { label: 'Restart now', onClick: () => serverActions.restart(server) } }
                      : {}),
                  });
                } else {
                  toast.success('Settings saved');
                }
              } catch (error) {
                toast.fromError(error, 'Could not save server.properties');
              } finally {
                btn.classList.remove('is-loading');
                btn.replaceChildren('Save changes');
              }
            },
          },
          'Save changes',
        ),
      ),
    );
  }

  function paint(filterText = '') {
    const needle = filterText.trim().toLowerCase();
    const byGroup = new Map();
    for (const schema of data.schema) {
      const haystack = `${schema.key} ${schema.label} ${schema.group} ${schema.help ?? ''}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      if (!byGroup.has(schema.group)) byGroup.set(schema.group, []);
      byGroup.get(schema.group).push(schema);
    }

    if (!byGroup.size) {
      mount(groupsHost, emptyState({ icon: 'search', title: 'No settings match', text: `Nothing matched "${filterText}".`, compact: true }));
      return;
    }

    mount(
      groupsHost,
      ...[...byGroup.entries()].map(([group, schemas]) =>
        el(
          'div.card.card--flush',
          el(
            'div.card__head',
            el('div.grow', el('div.card__title', group), el('div.card__sub', `${schemas.length} setting${schemas.length === 1 ? '' : 's'}`)),
          ),
          el('div.card__body', ...schemas.map(field)),
        ),
      ),
    );
  }

  search.addEventListener('input', debounce((event) => paint(event.target.value), 150));
  paint();

  const unknownKeys = Object.keys(data.values).filter((key) => !data.schema.some((s) => s.key === key));

  mount(
    host,
    el(
      'div.callout',
      el('span.callout__icon', { html: icon('info', { size: 16 }) }),
      el(
        'div',
        el('div.callout__title', 'This is the real server.properties'),
        el('div', 'The manager writes the file atomically and keeps a .bak copy. Settings marked "restart" are only read when the JVM boots; everything else applies as soon as the server reloads it.'),
      ),
    ),
    el(
      'div.row.row--between.row--wrap',
      { style: 'gap:0.6rem' },
      el('div.search', search, el('span.search__icon', { html: icon('search', { size: 15 }) })),
      el(
        'div.row',
        { style: 'gap:0.35rem' },
        el('button.btn.btn--sm', { type: 'button', onclick: () => openRawEditor() }, el('span', { html: icon('code', { size: 14 }) }), 'Raw editor'),
        el('button.btn.btn--sm', { type: 'button', onclick: () => reload() }, el('span', { html: icon('refresh', { size: 14 }) }), 'Reload from disk'),
      ),
    ),
    groupsHost,
    unknownKeys.length
      ? el(
          'div.card.card--pad',
          el('div.card__title', { style: 'margin-bottom:0.4rem' }, 'Additional keys found in the file'),
          el('div.card__sub', { style: 'margin-bottom:0.6rem' }, 'These were written by the server or a plugin. They are preserved on save.'),
          el('div.row.row--wrap', { style: 'gap:0.3rem' }, ...unknownKeys.map((key) => el('span.chip.chip--mono', { 'data-tip': data.values[key] }, key))),
        )
      : null,
    saveBar,
  );

  // -- Raw editor --------------------------------------------------------
  async function openRawEditor() {
    try {
      const file = await api.readFile(serverId, 'server.properties');
      const area = el('textarea.editor__area', { spellcheck: 'false', style: 'min-height:52vh' }, file.content);
      const modal = openModal({
        title: 'server.properties',
        subtitle: 'Directly editing the file. The manager reloads it after saving.',
        icon: 'code',
        size: 'wide',
        body: area,
        footer: [
          el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
          el(
            'button.btn.btn--primary',
            {
              type: 'button',
              onclick: async () => {
                try {
                  await api.writeFile(serverId, 'server.properties', area.value);
                  modal.close();
                  toast.success('File saved', 'Reloading the parsed view…');
                  reload();
                } catch (error) {
                  toast.fromError(error, 'Could not save the file');
                }
              },
            },
            'Save file',
          ),
        ],
      });
    } catch (error) {
      toast.fromError(error, 'Could not open the raw file');
    }
  }

  async function reload() {
    try {
      const fresh = await api.getProperties(serverId);
      Object.assign(data, fresh);
      Object.keys(current).forEach((key) => delete current[key]);
      Object.assign(current, fresh.values);
      Object.keys(original).forEach((key) => delete original[key]);
      Object.assign(original, fresh.values);
      dirty.clear();
      paint(search.value);
      paintSaveBar();
      toast.success('Reloaded from disk');
    } catch (error) {
      toast.fromError(error, 'Could not reload');
    }
  }

  return { el: host };
}

// ===========================================================================
// Files
// ===========================================================================

export async function createFilesTab({ serverId }) {
  let cwd = '';
  const listing = el('div.stack--xs');
  const crumbBar = el('div.crumbbar');
  const metaLine = el('div.card__sub');
  const preview = el('div.card.card--pad');
  let currentFile = null;

  const host = el(
    'div.stack--md',
    el(
      'div.row.row--between.row--wrap',
      { style: 'gap:0.6rem' },
      crumbBar,
      el(
        'div.row',
        { style: 'gap:0.35rem' },
        el('button.btn.btn--sm', { type: 'button', onclick: () => newFolder() }, el('span', { html: icon('folder', { size: 14 }) }), 'New folder'),
        el('button.btn.btn--sm', { type: 'button', onclick: () => uploadFlow() }, el('span', { html: icon('upload', { size: 14 }) }), 'Upload'),
        el('button.btn.btn--sm', { type: 'button', onclick: () => load(cwd) }, el('span', { html: icon('refresh', { size: 14 }) })),
      ),
    ),
    el(
      'div.pane__grid',
      el(
        'div.card.card--flush',
        el(
          'div.card__head',
          el('span.stat__icon', { html: icon('folder', { size: 15 }), style: '--stat-rgb:var(--warning-rgb)' }),
          el('div.grow', el('div.card__title', 'Files'), metaLine),
        ),
        el('div.card__body.card__body--tight', { style: 'min-height:340px' }, listing),
      ),
      preview,
    ),
  );

  // -- Navigation --------------------------------------------------------
  async function load(path = '') {
    try {
      const data = await api.listFiles(serverId, path);
      cwd = data.path;
      renderCrumbs(data.path);
      metaLine.textContent = `${data.entries.length} item${data.entries.length === 1 ? '' : 's'} · ${bytes(data.totals.bytes)}`;

      const rows = [];

      if (cwd) {
        rows.push(
          el(
            'button.filerow',
            { type: 'button', style: 'width:100%;text-align:left', onclick: () => load(parentOf(cwd)) },
            el('span.filerow__icon', { html: icon('arrowUp', { size: 15 }) }),
            el('span.filerow__name', '..'),
          ),
        );
      }

      for (const entry of data.entries) {
        rows.push(
          el(
            'div.filerow',
            {
              onclick: () => (entry.isDirectory ? load(entry.path) : openFile(entry)),
              ondblclick: () => (entry.isDirectory ? load(entry.path) : openFile(entry)),
            },
            el('span.filerow__icon', { class: entry.isDirectory ? 'filerow__icon--dir' : '', html: icon(fileIcon(entry), { size: 15 }) }),
            el('span.filerow__name', { title: entry.name }, entry.name),
            el('span.filerow__size', entry.isDirectory ? '' : entry.formatted),
            el(
              'div.filerow__actions',
              el(
                'button.iconbtn.iconbtn--xs',
                { type: 'button', 'data-tip': 'Download', onclick: (event) => { event.stopPropagation(); window.open(api.fileDownloadUrl(serverId, entry.path), '_blank'); } },
                el('span', { html: icon('download', { size: 12 }) }),
              ),
              el(
                'button.iconbtn.iconbtn--xs',
                {
                  type: 'button',
                  'data-tip': 'Delete',
                  onclick: async (event) => {
                    event.stopPropagation();
                    const ok = await confirmDialog({
                      title: `Delete ${entry.name}?`,
                      message: entry.isDirectory ? 'The folder and everything inside it will be removed.' : 'The file will be removed from disk.',
                      detail: 'This cannot be undone. Consider taking a backup first.',
                      confirmLabel: 'Delete',
                      tone: 'danger',
                      icon: 'trash',
                    });
                    if (!ok) return;
                    try {
                      const result = await api.deleteFile(serverId, entry.path);
                      toast.success(`Deleted ${entry.name}`, `${result.freed} reclaimed.`);
                      load(cwd);
                    } catch (error) {
                      toast.fromError(error, 'Could not delete');
                    }
                  },
                },
                el('span', { html: icon('trash', { size: 12 }) }),
              ),
            ),
          ),
        );
      }

      if (!rows.length || (rows.length === 1 && cwd)) {
        rows.push(emptyState({ icon: 'folder', title: 'This folder is empty', text: 'Drop files onto the console, or use the Upload button.', compact: true }));
      }

      mount(listing, ...rows);
    } catch (error) {
      mount(listing, el('div.callout.callout--error', el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }), el('div', error.message)));
    }
  }

  function renderCrumbs(path) {
    const parts = path ? path.split('/') : [];
    mount(
      crumbBar,
      el('button.crumbbar__seg', { type: 'button', onclick: () => load('') }, el('span', { html: icon('hardDrive', { size: 13 }) }), 'server root'),
      ...parts.map((part, index) =>
        frag(
          el('span.dim', '/'),
          el(
            'button.crumbbar__seg',
            { type: 'button', class: index === parts.length - 1 ? 'crumbbar__seg--last' : '', onclick: () => load(parts.slice(0, index + 1).join('/')) },
            part,
          ),
        ),
      ),
    );
  }

  const parentOf = (path) => path.split('/').slice(0, -1).join('/');

  function fileIcon(entry) {
    if (entry.isDirectory) return 'folder';
    if (entry.extension === 'jar' || entry.extension === 'zip') return 'package';
    if (['json', 'yml', 'yaml', 'toml'].includes(entry.extension)) return 'code';
    if (['log', 'txt', 'md'].includes(entry.extension)) return 'fileText';
    if (['mca', 'dat', 'nbt'].includes(entry.extension)) return 'database';
    return 'file';
  }

  // -- Preview / editor --------------------------------------------------
  async function openFile(entry) {
    if (!entry.editable) {
      toast.info('Preview not available', `${entry.name} is a binary or oversized file. Use the download button instead.`);
      return;
    }
    mount(preview, el('div.stack--sm', el('div.skel.skel--title'), el('div.skel.skel--block'), el('div.skel.skel--block')));
    try {
      const file = await api.readFile(serverId, entry.path);
      currentFile = file;
      const area = el('textarea.editor__area', { spellcheck: 'false' }, file.content);
      let changed = false;
      area.addEventListener('input', () => {
        changed = true;
        saveBtn.disabled = false;
      });

      const saveBtn = el(
        'button.btn.btn--sm.btn--primary',
        {
          type: 'button',
          disabled: true,
          onclick: async () => {
            try {
              await api.writeFile(serverId, file.path, area.value);
              changed = false;
              saveBtn.disabled = true;
              toast.success('Saved', `${file.path} written to disk.`);
            } catch (error) {
              toast.fromError(error, 'Could not save');
            }
          },
        },
        el('span', { html: icon('save', { size: 14 }) }),
        'Save',
      );

      mount(
        preview,
        el(
          'div.card__head',
          { style: 'padding:0 0 0.7rem' },
          el('span.stat__icon', { html: icon('fileText', { size: 15 }) }),
          el('div.grow', el('div.card__title.truncate', file.path), el('div.card__sub', `${file.lines} lines · ${bytes(file.size)} · ${file.language}`)),
          saveBtn,
          el('button.btn.btn--sm', { type: 'button', onclick: () => window.open(api.fileDownloadUrl(serverId, file.path), '_blank') }, el('span', { html: icon('download', { size: 14 }) })),
        ),
        area,
        ['json', 'properties', 'yml', 'yaml', 'toml'].includes(file.language)
          ? el('div.field__hint', 'Tip: invalid syntax will make the server refuse to start. The manager keeps a .bak copy of the previous version for the important files.')
          : null,
      );
    } catch (error) {
      mount(
        preview,
        el(
          'div.callout.callout--warn',
          el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
          el('div', el('div.callout__title', 'Cannot preview this file'), el('div', error.message)),
        ),
      );
    }
  }

  // -- Upload ------------------------------------------------------------
  function uploadFlow() {
    const input = el('input', { type: 'file', multiple: true, style: 'display:none' });
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.remove();
      if (!files.length) return;
      const overlay = busyOverlay(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
      try {
        for (const file of files) {
          await api.uploadFile(serverId, cwd, file, {
            onProgress: ({ percent: pct }) => overlay.update(`Uploading ${file.name}`, `${pct.toFixed(0)}% of ${bytes(file.size)}`),
          });
        }
        overlay.close();
        toast.success('Upload complete', `${files.length} file${files.length === 1 ? '' : 's'} written into ${cwd || 'the server root'}.`);
        load(cwd);
      } catch (error) {
        overlay.close();
        toast.fromError(error, 'Upload failed');
      }
    });
    input.click();
  }

  async function newFolder() {
    const name = await promptDialog({
      title: 'New folder',
      label: `Create a folder inside ${cwd || 'the server root'}`,
      placeholder: 'plugins',
      confirmLabel: 'Create',
      hint: 'Avoid spaces and special characters — some plugins are picky.',
    });
    if (!name) return;
    try {
      await api.makeFolder(serverId, cwd ? `${cwd}/${name}` : name);
      toast.success(`Created ${name}`);
      load(cwd);
    } catch (error) {
      toast.fromError(error, 'Could not create the folder');
    }
  }

  mount(preview, emptyState({ icon: 'fileText', title: 'Select a file', text: 'Click any text file on the left to view and edit it. Configs are validated on save.', compact: true }));
  await load('');

  const offServer = subscribe('servers', () => {
    /* the file listing does not depend on server status */
  });

  return { el: host, destroy: () => offServer() };
}

// ===========================================================================
// Backups
// ===========================================================================

export async function createBackupsTab({ serverId }) {
  const listHost = el('div.stack--sm');
  const summaryHost = el('div.grid.grid--4');
  const keepSetting = { value: getServer(serverId)?.schedules?.backup?.keep ?? 7 };

  async function load() {
    try {
      const data = await api.listBackups(serverId);
      const newest = data.backups[0];

      mount(
        summaryHost,
        statTile({ label: 'Backups stored', value: count(data.backups.length), icon: 'archive', tone: 'accent', sub: data.totalFormatted }),
        statTile({ label: 'Most recent', value: newest ? relativeTime(newest.createdAt) : '—', icon: 'clock', tone: 'info', sub: newest ? bytes(newest.bytes) : 'none yet' }),
        statTile({
          label: 'Restore safety',
          value: newest?.hot ? 'Hot copy' : 'Cold copy',
          icon: 'shieldCheck',
          tone: newest?.hot ? 'warning' : 'success',
          sub: newest?.hot ? 'taken while the server was running' : 'taken while stopped',
        }),
        el(
          'div.stat',
          { style: '--stat-rgb:var(--violet-rgb)' },
          el('div.stat__top', el('span.stat__icon', { html: icon('settings', { size: 16 }) }), el('span.stat__label', 'Retention')),
          el(
            'div.row',
            { style: 'margin-top:0.2rem' },
            el('input.input.input--sm.input--mono', {
              type: 'number',
              min: '1',
              max: '100',
              value: String(keepSetting.value),
              style: 'max-width:80px',
              onchange: async (event) => {
                keepSetting.value = Number(event.target.value);
                try {
                  await api.updateServer(serverId, { schedules: { backup: { keep: keepSetting.value, mode: getServer(serverId)?.schedules?.backup?.mode ?? 'none' } } });
                  toast.success(`Keeping the newest ${keepSetting.value} backup(s)`, 'Older archives are pruned after each scheduled backup.');
                } catch (error) {
                  toast.fromError(error, 'Could not update retention');
                }
              },
            }),
            el('span.small.muted', 'newest kept'),
          ),
        ),
      );

      if (!data.backups.length) {
        mount(
          listHost,
          el(
            'div.card',
            emptyState({
              icon: 'archive',
              title: 'No backups yet',
              text: 'A backup flushes the world to disk first, then archives it — so the copy is always consistent, even while the server runs.',
              action: el('button.btn.btn--primary', { style: 'margin-top:0.5rem', type: 'button', onclick: () => create() }, el('span', { html: icon('plus', { size: 15 }) }), 'Create the first backup'),
            }),
          ),
        );
        return;
      }

      mount(
        listHost,
        ...data.backups.map((backup) =>
          el(
            'div.backuprow',
            el('span.backuprow__icon', { html: icon('archive', { size: 16 }) }),
            el(
              'div.backuprow__id',
              el('div.backuprow__name.truncate', { title: backup.file }, backup.file),
              el(
                'div.backuprow__meta',
                el('span', bytes(backup.bytes)),
                el('span', dateTime(backup.createdAt)),
                backup.label ? el('span.badge.badge--neutral', backup.label) : null,
                backup.hot ? el('span.badge.badge--warning', 'hot copy') : el('span.badge.badge--success', 'cold copy'),
                backup.version ? el('span.dim', backup.version) : null,
                !backup.hasMetadata ? el('span.dim', 'no metadata') : null,
              ),
            ),
            el(
              'div.backuprow__actions',
              el('button.iconbtn.iconbtn--xs', { type: 'button', 'data-tip': 'Download', onclick: () => window.open(api.backupDownloadUrl(serverId, backup.file), '_blank') }, el('span', { html: icon('download', { size: 13 }) })),
              el(
                'button.iconbtn.iconbtn--xs',
                {
                  type: 'button',
                  'data-tip': 'Restore',
                  onclick: () => restore(backup),
                },
                el('span', { html: icon('restart', { size: 13 }) }),
              ),
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
                      await api.deleteBackup(serverId, backup.file);
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
    } catch (error) {
      mount(listHost, el('div.callout.callout--error', el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }), el('div', error.message)));
    }
  }

  async function create() {
    const labelInput = el('input.input', { value: 'manual', maxlength: '40' });
    const includeLogs = el('input', { type: 'checkbox' });
    const modal = openModal({
      title: 'Create a backup',
      subtitle: 'The manager pauses autosave, flushes chunks, archives, then resumes',
      icon: 'archive',
      body: el(
        'div.stack--md',
        el('div.field', el('label.field__label', 'Label'), labelInput, el('div.field__hint', 'Added to the filename so you can tell archives apart.')),
        el('label.check', includeLogs, el('span.check__box'), el('div.check__body', el('div.check__title', 'Include the logs folder'), el('div.check__desc', 'Useful for diagnosing a crash, but it makes the archive much bigger.'))),
      ),
      footer: [
        el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el(
          'button.btn.btn--primary',
          {
            type: 'button',
            onclick: async () => {
              modal.close();
              const overlay = busyOverlay('Preparing the backup…');
              try {
                const result = await api.createBackup(serverId, { label: labelInput.value || 'manual', includeLogs: includeLogs.checked });
                overlay.close();
                toast.success('Backup created', `${result.file} · ${result.formatted}${result.hot ? ' — captured while the server was running.' : ''}`, { duration: 9000 });
                load();
              } catch (error) {
                overlay.close();
                toast.fromError(error, 'Backup failed');
              }
            },
          },
          el('span', { html: icon('archive', { size: 14 }) }),
          'Create backup',
        ),
      ],
    });
  }

  async function restore(backup) {
    const server = getServer(serverId);
    const live = ['running', 'starting'].includes(server?.status);

    const modal = openModal({
      title: `Restore ${backup.file}?`,
      subtitle: 'This replaces the current world files',
      icon: 'restart',
      tone: 'warning',
      body: el(
        'div.stack--md',
        el('div.kv',
          el('div.kv__row', el('span.kv__k', 'Backup size'), el('span.kv__v', bytes(backup.bytes))),
          el('div.kv__row', el('span.kv__k', 'Taken'), el('span.kv__v', dateTime(backup.createdAt))),
          el('div.kv__row', el('span.kv__k', 'Consistency'), el('span.kv__v', backup.hot ? 'Hot copy (server was running)' : 'Cold copy (server was stopped)')),
        ),
        el(
          'div.callout.callout--warn',
          el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
          el('div', el('div.callout__title', 'The current world will be replaced'), el('div', 'Before extracting, the manager copies the existing folder to a timestamped ".pre-restore" folder next to it. You can recover from that if you restore the wrong archive.')),
        ),
        live
          ? el('label.check', { id: 'stop-first' }, el('input', { type: 'checkbox', checked: true }), el('span.check__box'), el('div.check__body', el('div.check__title', 'Stop the server first'), el('div.check__desc', 'Required — extracting over a running world corrupts region files.')))
          : null,
      ),
      footer: [
        el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el(
          'button.btn.btn--danger',
          {
            type: 'button',
            onclick: async () => {
              const stopFirst = modal.root.querySelector('#stop-first')?.querySelector('input')?.checked ?? false;
              modal.close();
              const overlay = busyOverlay('Restoring the backup…', live ? 'Stopping the server, then extracting the archive.' : 'Extracting the archive.');
              try {
                const result = await api.restoreBackup(serverId, backup.file, { stopFirst });
                overlay.close();
                toast.success('Backup restored', `A safety copy of the previous state is at ${result.safetyCopy}`, { duration: 15_000 });
                load();
              } catch (error) {
                overlay.close();
                toast.fromError(error, 'Restore failed');
              }
            },
          },
          el('span', { html: icon('restart', { size: 14 }) }),
          'Restore this backup',
        ),
      ],
    });
  }

  await load();

  return { el: el('div.stack--lg', summaryHost, el('div.row.row--between', el('div.card__title', 'Archive history'), el('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => create() }, el('span', { html: icon('plus', { size: 14 }) }), 'Backup now')), listHost) };
}

// ===========================================================================
// Tunnel — the playit.gg agent
// ===========================================================================

/**
 * The escape hatch for connections that cannot accept inbound traffic.
 *
 * Makes an outbound connection to playit's network, which then proxies players
 * in — so it works behind carrier NAT, where port forwarding is impossible.
 *
 * @param {{ port: number, cgnat: boolean }} options
 */
export function createTunnelPanel({ port, cgnat = false }) {
  const host = el('div.stack--sm');
  let snapshot = null;
  let pollTimer = null;
  let logOpen = false;

  const offUpdates = [];

  const statusLine = (label, value, tone = '') =>
    el('div.kv__row', el('span.kv__k', label), el('span', { class: `kv__v ${tone}` }, value));

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function refresh() {
    try {
      snapshot = await api.getTunnel();
      paint();
    } catch (error) {
      mount(host, el('div.callout.callout--error', el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }), el('div', error.message)));
    }
  }

  async function act(label, fn) {
    const pending = toast.show({ id: 'tunnel-act', title: label, tone: 'info', duration: 0 });
    try {
      await fn();
      pending.dismiss();
      await refresh();
    } catch (error) {
      pending.dismiss();
      toast.fromError(error, label.replace(/…$/, ' failed'));
    }
  }

  function paint() {
    const s = snapshot ?? {};
    const claim = s.claim;

    // -- Claim in progress ------------------------------------------------
    if (claim) {
      mount(
        host,
        el(
          'div.callout.callout--info',
          el('span.callout__icon', { html: icon('link', { size: 16 }) }),
          el(
            'div',
            el('div.callout__title', 'Approve this agent in your browser'),
            el(
              'div',
              'playit.gg needs to link this agent to your account. Open the link below, sign in ' +
                '(a free account is fine), and approve it. This panel will update by itself.',
            ),
            el(
              'div.row',
              { style: 'margin-top:0.6rem;gap:0.4rem;flex-wrap:wrap' },
              el('code', { class: 'mono', style: 'font-size:0.8rem;color:var(--accent-300);word-break:break-all' }, claim.url),
            ),
            el(
              'div.row',
              { style: 'margin-top:0.6rem;gap:0.4rem;flex-wrap:wrap' },
              el(
                'button.btn.btn--sm.btn--primary',
                { type: 'button', onclick: () => desktop.openExternal(claim.url) },
                el('span', { html: icon('external', { size: 14 }) }),
                'Open the claim page',
              ),
              el(
                'button.btn.btn--sm',
                {
                  type: 'button',
                  onclick: async () => {
                    const ok = await copyText(claim.url);
                    toast[ok ? 'success' : 'error'](ok ? 'Link copied' : 'Clipboard unavailable');
                  },
                },
                el('span', { html: icon('copy', { size: 14 }) }),
                'Copy link',
              ),
              el(
                'button.btn.btn--sm.btn--ghost',
                { type: 'button', onclick: () => act('Cancelling…', () => api.cancelTunnelClaim()) },
                'Cancel',
              ),
            ),
          ),
        ),
        el('div.row', el('div.spinner.spinner--accent', { style: 'width:14px;height:14px' }), el('span.muted.small', 'Waiting for approval…')),
      );
      return;
    }

    // -- Normal states -----------------------------------------------------
    const children = [];

    if (!s.claimed) {
      children.push(
        el(
          'p.muted.small',
          cgnat
            ? 'This is the fix for your connection. Your ISP shares one public address between many customers, so nothing can reach you from outside — but this agent connects *outwards*, which always works.'
            : 'A tunnel lets players connect without opening any ports on your router. Useful if port forwarding is unavailable or you would rather not expose your home IP.',
        ),
        el(
          'div.row',
          { style: 'gap:0.4rem;flex-wrap:wrap' },
          el(
            'button.btn.btn--sm.btn--primary',
            {
              type: 'button',
              onclick: () =>
                act('Requesting a claim link…', async () => {
                  const result = await api.beginTunnelClaim(null);
                  desktop.openExternal(result.url);
                }),
            },
            el('span', { html: icon('link', { size: 14 }) }),
            'Set up a tunnel',
          ),
          el(
            'button.btn.btn--sm',
            {
              type: 'button',
              onclick: async () => {
                const secret = await promptDialog({
                  title: 'Paste your agent secret',
                  label: 'Secret key from playit.gg',
                  mono: true,
                  confirmLabel: 'Use this key',
                  hint: 'Generate one at playit.gg → Account → Setup → New agent. Use this if the claim link does not work for you.',
                });
                if (!secret) return;
                await act('Saving the key…', () => api.useTunnelSecret(secret));
              },
            },
            'Paste a key instead',
          ),
        ),
      );
    } else {
      children.push(
        el(
          'div.kv',
          statusLine('Agent', s.running ? 'connected' : 'stopped', s.running ? 'success' : 'dim'),
          statusLine('Public address', s.publicAddress ?? (s.running ? 'negotiating…' : '—'), s.publicAddress ? 'accent' : 'dim'),
          statusLine('Point your tunnel at', `127.0.0.1:${port}`, 'accent'),
          s.uptimeMs ? statusLine('Connected for', durationShort(s.uptimeMs)) : null,
        ),
      );

      if (s.publicAddress) {
        children.push(
          el(
            'div.callout.callout--ok',
            el('span.callout__icon', { html: icon('checkCircle', { size: 16 }) }),
            el(
              'div',
              el('div.callout__title', 'Players can join from anywhere'),
              el('div', `Give them: ${s.publicAddress}`),
              el(
                'button.btn.btn--sm',
                {
                  style: 'margin-top:0.5rem',
                  type: 'button',
                  onclick: async () => {
                    const ok = await copyText(s.publicAddress);
                    toast[ok ? 'success' : 'error'](ok ? `Copied ${s.publicAddress}` : 'Clipboard unavailable');
                  },
                },
                el('span', { html: icon('copy', { size: 14 }) }),
                'Copy address',
              ),
            ),
          ),
        );
      }

      children.push(
        el(
          'div.row',
          { style: 'gap:0.4rem;flex-wrap:wrap' },
          s.running
            ? el('button.btn.btn--sm.btn--warn', { type: 'button', onclick: () => act('Stopping the tunnel…', () => api.stopTunnel()) }, 'Disconnect')
            : el('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => act('Connecting the tunnel…', () => api.startTunnel()) }, el('span', { html: icon('play', { size: 14 }) }), 'Connect'),
          el(
            'button.btn.btn--sm.btn--ghost',
            {
              type: 'button',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: 'Unlink this agent?',
                  message: 'The stored secret is deleted and the agent must be claimed again.',
                  detail: 'Any tunnels you set up stay on your playit.gg account — this only removes the key from this PC.',
                  confirmLabel: 'Unlink',
                  tone: 'warning',
                  icon: 'key',
                });
                if (ok) await act('Unlinking…', () => api.forgetTunnel());
              },
            },
            'Unlink account',
          ),
        ),
      );

      if (s.lastError) {
        children.push(el('div.callout.callout--warn', el('span.callout__icon', { html: icon('alert', { size: 16 }) }), el('div', s.lastError)));
      }
    }

    // -- Log ---------------------------------------------------------------
    if (s.logTail?.length) {
      children.push(
        el(
          'details',
          { style: 'margin-top:0.3rem' },
          el('summary', { style: 'cursor:pointer;font-size:0.8rem;color:var(--text-muted)' }, 'Agent log'),
          el(
            'pre',
            {
              style:
                'margin-top:0.5rem;max-height:220px;overflow:auto;padding:0.6rem 0.7rem;background:rgba(0,0,0,.4);' +
                'border:1px solid var(--line);border-radius:8px;font-size:0.72rem;line-height:1.5;color:var(--text-muted);white-space:pre-wrap',
            },
            s.logTail.slice(-60).join('\n'),
          ),
        ),
      );
    }

    mount(
      host,
      el(
        'div.card.card--pad.stack--sm',
        el(
          'div.row',
          el('span.stat__icon', { html: icon('globe', { size: 15 }), style: '--stat-rgb:var(--violet-rgb)' }),
          el(
            'div.grow',
            el('div.card__title', 'playit.gg tunnel'),
            el('div.card__sub', 'Works without any port forwarding'),
          ),
          s.running
            ? el('span.badge.badge--success', 'connected')
            : s.claimed
              ? el('span.badge.badge--neutral', 'ready')
              : el('span.badge.badge--warning', 'not set up'),
        ),
        ...children,
      ),
    );
  }

  refresh();

  // Live updates: the claim exchange resolves in the background, and the agent
  // prints its address to its log rather than answering an API.
  offUpdates.push(
    ws.on('tunnel-status', (message) => {
      snapshot = message.tunnel;
      paint();
    }),
  );
  offUpdates.push(ws.on('tunnel-claimed', () => {
    toast.success('Agent linked to your playit.gg account', 'Starting the tunnel…');
    api.startTunnel().catch(() => {});
  }));

  // Belt and braces while a claim is pending.
  pollTimer = setInterval(() => {
    if (snapshot?.claim) refresh();
  }, 5000);

  void logOpen;

  return {
    el: host,
    destroy() {
      stopPolling();
      for (const off of offUpdates) off();
    },
  };
}

// ===========================================================================
// Connect — making the server reachable from outside
// ===========================================================================

export async function createConnectTab({ serverId }) {
  const host = el('div.stack--lg');
  const server = getServer(serverId);
  const port = server?.port ?? 25565;

  /*
   * The tunnel sits above the router guidance because it is the only option
   * that works when the connection cannot accept inbound traffic at all. It is
   * created after the router probe so it can say why it matters here.
   */
  const tunnelHost = el('div');
  let tunnelPanel = null;
  const mountTunnel = (cgnat) => {
    tunnelPanel?.destroy?.();
    tunnelPanel = createTunnelPanel({ port, cgnat });
    mount(tunnelHost, tunnelPanel.el);
  };
  mountTunnel(false);

  // -- Address cards -----------------------------------------------------
  const addressHost = el('div.stack--md');
  const checksHost = el('div.stack--xs');
  const forwardingHost = el('div.stack--sm');

  /**
   * A copyable address row.
   *
   * `badge` is a short label only — badge styling is `text-transform:
   * capitalize`, so anything longer than a word or two comes out Title Cased
   * and reads like a heading.
   */
  const addressRow = (label, value, hint, { badge = null, tone = '' } = {}) => {
    const copyBtn = el(
      'button.iconbtn',
      {
        type: 'button',
        'data-tip': 'Copy',
        onclick: async () => {
          const ok = await copyText(value);
          toast[ok ? 'success' : 'error'](ok ? `Copied ${value}` : 'Clipboard unavailable');
        },
      },
      el('span', { html: icon('copy', { size: 14 }) }),
    );

    return el(
      'div.list__item',
      el(
        'div.list__main',
        el(
          'div.row',
          { style: 'gap:0.5rem' },
          el('div.list__title', label),
          badge ? el('span.badge', { class: tone }, badge) : null,
        ),
        el('div', { class: 'mono', style: 'font-size:0.9rem;color:var(--accent-300);margin-top:0.15rem' }, value),
        hint ? el('div.list__sub', hint) : null,
      ),
      copyBtn,
    );
  };

  // -- Checklist ---------------------------------------------------------
  /**
   * Every row is one of the things that must be true for someone outside your
   * network to join. Showing them separately matters: "it works on my LAN but
   * not for my friend" is almost always the firewall or the router, and a
   * single green/red light would hide which.
   */
  const checkRow = ({ ok, unknown, label, detail, action }) =>
    el(
      'div.list__item',
      el('span.statusdot', {
        style: `--pulse-rgb:${unknown ? 'var(--neutral-rgb)' : ok ? 'var(--success-rgb)' : 'var(--warning-rgb)'}`,
      }),
      el('div.list__main', el('div.list__title', label), detail ? el('div.list__sub', detail) : null),
      action ?? (unknown ? el('span.badge', 'unknown') : ok ? el('span.badge.badge--success', 'ok') : el('span.badge.badge--warning', 'needs setup')),
    );

  async function loadSummary() {
    mount(addressHost, el('div.skel.skel--block'));
    try {
      const data = await api.getConnect(serverId);

      mount(
        addressHost,
        el('div.card.card--pad.stack--sm',
          el('div.card__title', { style: 'margin-bottom:0.5rem' }, 'Hand this to your players'),
          data.addresses.public
            ? addressRow('From anywhere', data.addresses.public, 'Works once the port is forwarded and your connection allows it.', {
                badge: 'public',
                tone: 'badge--accent',
              })
            : addressRow('From anywhere', 'detecting your public address…', data.addresses.publicError ?? 'Could not reach a public IP service.'),
          data.addresses.lan
            ? addressRow('On your home network', data.addresses.lan, `via ${data.addresses.lanInterface}`, { badge: 'LAN' })
            : null,
          addressRow('This computer only', data.addresses.localhost, 'For testing on the machine running the server.', { badge: 'local' }),
        ),
      );

      // -- Checks --------------------------------------------------------
      const c = data.checks;
      mount(
        checksHost,
        checkRow({
          ok: c.listening,
          label: 'The server is accepting connections',
          detail: c.listening ? `Something is listening on port ${port}.` : 'Start the server first.',
        }),
        checkRow({
          ok: c.reachableOnLan,
          unknown: c.reachableOnLan === null,
          label: 'Reachable on this machine’s network address',
          detail:
            c.reachableOnLan === true
              ? 'Other devices on your network can reach it.'
              : c.reachableOnLan === false
                ? 'Not answering on the network address — check that server-ip is empty.'
                : 'Start the server to test this.',
        }),
        c.firewallSupported
          ? checkRow({
              ok: c.firewallRule,
              label: 'Windows Firewall allows the port',
              detail: c.firewallRule
                ? 'An inbound rule exists.'
                : 'Inbound connections are blocked until a rule is added.',
              action: c.firewallRule
                ? el('button.btn.btn--sm.btn--ghost', { type: 'button', onclick: () => setFirewall('remove') }, 'Remove rule')
                : el('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => setFirewall('add') }, 'Allow port'),
            })
          : null,
      );

      // -- Forwarding ----------------------------------------------------
      mount(
        forwardingHost,
        el('div.row', el('div.spinner.spinner--accent', { style: 'width:14px;height:14px' }), el('span.muted.small', 'Asking your router…')),
      );
      loadForwarding();
    } catch (error) {
      mount(addressHost, el('div.callout.callout--error', el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }), el('div', error.message)));
    }
  }

  async function loadForwarding() {
    try {
      const data = await api.getForwarding(serverId);

      if (!data.available) {
        mount(
          forwardingHost,
          el(
            'div.callout.callout--warn',
            el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
            el(
              'div',
              el('div.callout__title', 'Your router did not answer a UPnP request'),
              el('div', data.message),
              el('div', { style: 'margin-top:0.5rem;font-size:0.8rem' }, 'Forward the port manually — see the steps below.'),
            ),
          ),
        );
        return;
      }

      const mapped = data.mapping?.exists;
      const reach = data.reachability ?? {};
      const blocked = reach.forwardingWorks === false;

      // Now that we know whether forwarding can work at all, rebuild the tunnel
      // panel so it can explain why it matters on this connection.
      mountTunnel(blocked);

      mount(
        forwardingHost,
        // If the connection itself cannot accept inbound traffic, say so before
        // offering a button that would appear to work and change nothing.
        blocked
          ? el(
              'div.callout.callout--error',
              el('span.callout__icon', { html: icon('alertCircle', { size: 17 }) }),
              el(
                'div',
                el('div.callout__title', reach.summary ?? 'Port forwarding cannot work on this connection'),
                el('div', reach.message ?? ''),
                reach.options?.length
                  ? el(
                      'ul',
                      { style: 'margin:0.6rem 0 0;padding-left:1.1rem;list-style:disc;display:flex;flex-direction:column;gap:0.3rem' },
                      ...reach.options.map((option) => el('li', option)),
                    )
                  : null,
              ),
            )
          : null,

        el(
          'div.card.card--pad.stack--sm',
          el(
            'div.row',
            el('span.stat__icon', { html: icon('network', { size: 15 }), style: '--stat-rgb:var(--info-rgb)' }),
            el(
              'div.grow',
              el('div.card__title', 'Router port forwarding'),
              el('div.card__sub', `Found ${data.gateway?.name ?? 'your router'}${data.gateway?.externalIp ? ` · WAN ${data.gateway.externalIp}` : ''}`),
            ),
            mapped
              ? el('button.btn.btn--sm.btn--ghost', { type: 'button', onclick: () => changeForwarding('remove') }, 'Remove')
              : el(
                  'button.btn.btn--sm.btn--primary',
                  { type: 'button', disabled: blocked, 'data-tip': blocked ? 'This connection cannot accept inbound traffic' : 'Ask the router to forward the port', onclick: () => changeForwarding('add') },
                  'Open the port',
                ),
          ),
          mapped
            ? el(
                'div.callout',
                { class: blocked ? 'callout--warn' : 'callout--ok' },
                el('span.callout__icon', { html: icon(blocked ? 'alert' : 'checkCircle', { size: 16 }) }),
                el(
                  'div',
                  el('div.callout__title', `The router forwards TCP ${port} to ${data.mapping.internalClient}`),
                  el(
                    'div',
                    blocked
                      ? 'The rule exists on the router, but it cannot help while your ISP is NATing you.'
                      : data.mapping.description ?? '',
                  ),
                ),
              )
            : el(
                'p.muted.small',
                blocked
                  ? 'Automatic forwarding is available on this router but disabled here, because a rule on it cannot make the server reachable while your ISP is NATing you. Fix the connection first — see above.'
                  : `Your router supports automatic forwarding. Press "Open the port" and it will send TCP ${port} to this machine — no router login needed.`,
              ),
          reach.kind === 'direct'
            ? el(
                'p.muted.small',
                `Checked: your router's address matches your public address (${data.publicIp}), so forwarding will work.`,
              )
            : null,
        ),
      );
    } catch (error) {
      mount(
        forwardingHost,
        el('div.callout.callout--warn', el('span.callout__icon', { html: icon('alert', { size: 16 }) }), el('div', el('div.callout__title', 'Could not check your router'), el('div', error.message))),
      );
    }
  }

  async function changeForwarding(action) {
    const pending = toast.show({
      id: `fwd-${serverId}`,
      title: action === 'add' ? 'Asking your router to forward the port…' : 'Removing the forwarding rule…',
      tone: 'info',
      duration: 0,
    });
    try {
      const result = action === 'add' ? await api.addForwarding(serverId) : await api.removeForwarding(serverId);
      pending.dismiss();
      toast[result.ok ? 'success' : 'warning'](result.ok ? 'Router updated' : 'Router did not confirm', result.message, { duration: 9000 });
      loadSummary();
    } catch (error) {
      pending.dismiss();
      toast.fromError(error, 'Router request failed');
    }
  }

  async function setFirewall(action) {
    const pending = toast.show({
      id: `fw-${serverId}`,
      title: action === 'add' ? 'Waiting for Windows to allow the port…' : 'Removing the firewall rule…',
      text: 'Approve the Windows prompt if it appears.',
      tone: 'info',
      duration: 0,
    });
    try {
      await api.setFirewall(serverId, action);
      pending.dismiss();
      toast.success('Firewall updated', `TCP ${port} is now ${action === 'add' ? 'allowed' : 'blocked'} for inbound connections.`);
      loadSummary();
    } catch (error) {
      pending.dismiss();
      if (error.code === 'cancelled') {
        toast.warning('Cancelled', 'The Windows permission prompt was declined — nothing was changed.');
      } else {
        toast.fromError(error, 'Could not change the firewall');
      }
    }
  }

  // -- Manual instructions ----------------------------------------------
  const manual = el(
    'details.card.card--flush',
    el(
      'summary',
      { style: 'cursor:pointer;padding:0.95rem 1.25rem;list-style:none' },
      el(
        'div.row',
        el('span.stat__icon', { html: icon('list', { size: 15 }), style: '--stat-rgb:var(--violet-rgb)' }),
        el('div.grow', el('div.card__title', 'Forward the port by hand'), el('div.card__sub', 'For routers without UPnP, or if you would rather do it yourself')),
        el('span', { html: icon('chevronDown', { size: 16 }) }),
      ),
    ),
    el(
      'div.card__body.stack--md',
      el(
        'div.callout.callout--warn',
        el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
        el(
          'div',
          el('div.callout__title', 'Never put your domain in server-ip'),
          el(
            'div',
            'server-ip is the local network interface the server binds to. A domain name there is not bindable and crashes the server on startup with UnknownHostException. Leave it empty — your domain is pointed at your router, not at the server.',
          ),
        ),
      ),
      el(
        'ol',
        { style: 'display:flex;flex-direction:column;gap:0.6rem;font-size:0.86rem;line-height:1.6;padding-left:1.2rem;list-style:decimal' },
        el('li', 'Find your router’s admin page — usually 192.168.1.1 or 192.168.0.1, printed on the router.'),
        el('li', `Look for "Port Forwarding", "Virtual Server" or "NAT".`),
        el('li', `Create a rule: external TCP ${port} → internal ${getConnectAddress()}:${port}, protocol TCP.`),
        el('li', 'Save and reboot the router if it asks.'),
        el('li', 'Give players your public address plus the port — the one shown above.'),
      ),
      el(
        'div.stack--xs',
        el('div.card__sub', 'Pointing a domain at your server'),
        el(
          'p.muted.small',
          'Your public IP can change. A dynamic-DNS hostname (DuckDNS, No-IP, Cloudflare) that tracks it — plus an SRV record if you want players to connect without typing the port — is the usual answer. The address players type stays the same; the router still does the forwarding.',
        ),
      ),
    ),
  );

  /** The LAN address this machine should be reachable at (filled in later). */
  function getConnectAddress() {
    const addresses = addressHost.querySelectorAll('.mono');
    for (const node of addresses) {
      if (node.textContent.includes(':') && !node.textContent.startsWith('127.0.0.1')) {
        return node.textContent.split(':')[0];
      }
    }
    return 'this-machine';
  }

  host.append(
    el(
      'div.callout',
      el('span.callout__icon', { html: icon('info', { size: 16 }) }),
      el(
        'div',
        el('div.callout__title', 'Three things have to line up'),
        el('div', 'The server must listen on the network (not just this PC), the router must forward the port, and the firewall must allow it. This panel checks each one.'),
      ),
    ),
    addressHost,
    el('div.card.card--pad', el('div.card__title', { style: 'margin-bottom:0.6rem' }, 'Readiness'), checksHost),
    forwardingHost,
    tunnelHost,
    manual,
  );

  await loadSummary();

  /*
   * The checklist is computed server-side from live state (is the JVM
   * listening? is it reachable on the LAN address?), so it has to be re-fetched
   * when the server changes state. Without this, starting the server while
   * looking at this tab leaves it insisting "Start the server first".
   */
  let lastStatus = getServer(serverId)?.status ?? null;
  const offStatus = subscribe('status', (payload) => {
    if (payload.serverId !== serverId) return;
    if (payload.status === lastStatus) return;
    lastStatus = payload.status;
    loadSummary();
  });

  return {
    el: host,
    destroy: () => {
      offStatus();
      tunnelPanel?.destroy?.();
    },
  };
}

// ===========================================================================
// Automation
// ===========================================================================

export async function createAutomationTab({ serverId, onSaved }) {
  const server = getServer(serverId) ?? (await api.getServer(serverId));
  const draft = {
    autoRestart: { ...(server.autoRestart ?? { enabled: false, delayMs: 5000, maxAttempts: 5 }) },
    options: { autoStart: false, backupBeforeRestart: true, backupBeforeStart: false, ...(server.options ?? {}) },
    restart: { enabled: false, mode: 'none', time: '04:00', intervalMinutes: 360, weekday: 0, ...(server.schedules?.restart ?? {}) },
    backupSchedule: { enabled: false, mode: 'none', time: '03:00', intervalMinutes: 1440, weekday: 0, keep: 7, ...(server.schedules?.backup ?? {}) },
  };

  const host = el('div.stack--lg');

  // -- Crash recovery ----------------------------------------------------
  const autoCard = el(
    'div.card.card--pad.stack--md',
    el('div.row', el('span.stat__icon', { html: icon('restart', { size: 15 }) }), el('div.grow', el('div.card__title', 'Crash recovery'), el('div.card__sub', 'What happens when the JVM dies unexpectedly'))),
    el(
      'label.switch',
      el('input', { type: 'checkbox', checked: draft.autoRestart.enabled, onchange: (e) => { draft.autoRestart.enabled = e.target.checked; } }),
      el('span.switch__track'),
      el('div', el('span.switch__label', 'Restart automatically'), el('div.switch__desc', 'Uses exponential backoff: 5s, 10s, 20s… up to two minutes.')),
    ),
    el(
      'div.grid.grid--2',
      el('div.field', el('label.field__label', 'Base delay (seconds)'), el('input.input.input--sm.input--mono', { type: 'number', min: '1', max: '600', value: String(Math.round(draft.autoRestart.delayMs / 1000)), oninput: (e) => { draft.autoRestart.delayMs = Number(e.target.value) * 1000; } })),
      el('div.field', el('label.field__label', 'Maximum attempts'), el('input.input.input--sm.input--mono', { type: 'number', min: '1', max: '50', value: String(draft.autoRestart.maxAttempts), oninput: (e) => { draft.autoRestart.maxAttempts = Number(e.target.value); } }), el('div.field__hint', 'Gives up after this many rapid failures so a broken jar cannot spin forever.')),
    ),
  );

  // -- Startup / shutdown ------------------------------------------------
  const bootCard = el(
    'div.card.card--pad.stack--md',
    el('div.row', el('span.stat__icon', { html: icon('power', { size: 15 }), style: '--stat-rgb:var(--info-rgb)' }), el('div.grow', el('div.card__title', 'Startup & shutdown'), el('div.card__sub', 'How the manager treats this server'))),
    el('label.switch', el('input', { type: 'checkbox', checked: draft.options.autoStart, onchange: (e) => { draft.options.autoStart = e.target.checked; } }), el('span.switch__track'), el('div', el('span.switch__label', 'Start when the manager launches'), el('div.switch__desc', 'Ignored if the machine boots without the dashboard running.'))),
    el('label.switch', el('input', { type: 'checkbox', checked: draft.options.backupBeforeRestart, onchange: (e) => { draft.options.backupBeforeRestart = e.target.checked; } }), el('span.switch__track'), el('div', el('span.switch__label', 'Back up before every scheduled restart'), el('div.switch__desc', 'A cheap insurance policy against a bad update.'))),
    el('label.switch', el('input', { type: 'checkbox', checked: draft.options.backupBeforeStart, onchange: (e) => { draft.options.backupBeforeStart = e.target.checked; } }), el('span.switch__track'), el('div', el('span.switch__label', 'Back up before the next start'), el('div.switch__desc', 'Useful after a crash, before you let it boot again.'))),
  );

  // -- Schedule editor ---------------------------------------------------
  function scheduleEditor(schedule, kind) {
    const isRestart = kind === 'restart';
    const summary = el('div.card__sub');

    const paintSummary = () => {
      if (!schedule.enabled || schedule.mode === 'none') {
        summary.textContent = 'No schedule — the server only restarts when you ask.';
        return;
      }
      if (schedule.mode === 'interval') {
        summary.textContent = `Every ${humanizeMinutes(schedule.intervalMinutes)}.`;
      } else if (schedule.mode === 'daily') {
        summary.textContent = `Every day at ${schedule.time} (local time).`;
      } else {
        summary.textContent = `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][schedule.weekday ?? 0]} at ${schedule.time} (local time).`;
      }
    };

    const body = el('div.stack--md');
    const paintBody = () => {
      if (!schedule.enabled || schedule.mode === 'none') {
        mount(body);
        return;
      }
      mount(
        body,
        schedule.mode === 'interval'
          ? el(
              'div.field',
              el('label.field__label', 'Interval'),
              el(
                'select.select.input--sm',
                { onchange: (event) => { schedule.intervalMinutes = Number(event.target.value); paintSummary(); } },
                ...[
                  [15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'],
                  [180, 'Every 3 hours'], [360, 'Every 6 hours'], [720, 'Every 12 hours'], [1440, 'Every 24 hours'],
                ].map(([value, label]) => el('option', { value: String(value), selected: schedule.intervalMinutes === value }, label)),
              ),
              el('div.field__hint', 'Minimum 15 minutes. The timer is anchored to the last run, so a restart of the manager does not trigger a burst.'),
            )
          : el(
              'div.grid.grid--2',
              el(
                'div.field',
                el('label.field__label', 'Time of day'),
                el('input.input.input--sm.input--mono', { type: 'time', value: schedule.time, onchange: (event) => { schedule.time = event.target.value; paintSummary(); } }),
              ),
              schedule.mode === 'weekly'
                ? el(
                    'div.field',
                    el('label.field__label', 'Day'),
                    el(
                      'select.select.input--sm',
                      { onchange: (event) => { schedule.weekday = Number(event.target.value); paintSummary(); } },
                      ...['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, index) =>
                        el('option', { value: String(index), selected: schedule.weekday === index }, label),
                      ),
                    ),
                  )
                : null,
            ),
        isRestart
          ? el('div.callout', el('span.callout__icon', { html: icon('info', { size: 15 }) }), el('div', 'If players are online the manager warns them in chat, waits 60 seconds, takes a backup, then restarts. You can cancel from the console tab.'))
          : el(
              'div.field',
              el('label.field__label', 'Archives to keep'),
              el('input.input.input--sm.input--mono', { type: 'number', min: '1', max: '100', value: String(schedule.keep ?? 7), style: 'max-width:100px', onchange: (event) => { schedule.keep = Number(event.target.value); } }),
              el('div.field__hint', 'Older archives are deleted after each scheduled backup.'),
            ),
        el('div', el('span.dim.tiny', 'Next run: '), el('strong.tiny', { class: 'accent' }, schedule.nextRun ? `${dateTime(schedule.nextRun)} (${relativeTime(schedule.nextRun)})` : 'not scheduled')),
      );
    };

    paintSummary();
    paintBody();

    return el(
      'div.card.card--pad.stack--md',
      el(
        'div.row',
        el('span.stat__icon', { html: icon(isRestart ? 'restart' : 'archive', { size: 15 }), style: `--stat-rgb:${isRestart ? 'var(--violet-rgb)' : 'var(--success-rgb)'}` }),
        el('div.grow', el('div.card__title', isRestart ? 'Scheduled restart' : 'Scheduled backup'), summary),
        el(
          'label.switch.switch--sm',
          el('input', {
            type: 'checkbox',
            checked: schedule.enabled,
            onchange: (event) => {
              schedule.enabled = event.target.checked;
              if (event.target.checked && schedule.mode === 'none') schedule.mode = isRestart ? 'daily' : 'daily';
              paintSummary();
              paintBody();
            },
          }),
          el('span.switch__track'),
        ),
      ),
      schedule.enabled
        ? el(
            'div.field',
            el('label.field__label', 'Frequency'),
            el(
              'div.segmented.segmented--block',
              ...[['daily', 'Daily'], ['weekly', 'Weekly'], ['interval', 'Interval'], ['none', 'Off']].map(([mode, label]) =>
                el(
                  'button.segmented__opt',
                  {
                    type: 'button',
                    class: schedule.mode === mode ? 'segmented__opt--active' : '',
                    onclick: (event) => {
                      schedule.mode = mode;
                      for (const sibling of event.target.parentElement.children) sibling.classList.remove('segmented__opt--active');
                      event.target.classList.add('segmented__opt--active');
                      paintSummary();
                      paintBody();
                    },
                  },
                  label,
                ),
              ),
            ),
          )
        : null,
      body,
    );
  }

  const restartCard = scheduleEditor(draft.restart, 'restart');
  const backupCard = scheduleEditor(draft.backupSchedule, 'backup');

  // -- Save --------------------------------------------------------------
  const saveBar = el(
    'div.row',
    { style: 'justify-content:flex-end;gap:0.5rem' },
    el('button.btn', { type: 'button', onclick: () => location.reload() }, 'Reset'),
    el(
      'button.btn.btn--primary',
      {
        type: 'button',
        onclick: async (event) => {
          const btn = event.currentTarget;
          btn.classList.add('is-loading');
          btn.replaceChildren(el('span.spinner'), ' Saving…');
          try {
            const result = await api.updateServer(serverId, {
              autoRestart: draft.autoRestart,
              options: draft.options,
              schedules: {
                restart: { ...draft.restart, enabled: draft.restart.enabled && draft.restart.mode !== 'none' },
                backup: { ...draft.backupSchedule, enabled: draft.backupSchedule.enabled && draft.backupSchedule.mode !== 'none' },
              },
            });
            upsertServer(result, { silent: true });
            toast.success('Automation saved', result.restartRequired ? 'Restart the server to apply the new JVM settings.' : 'Schedules update immediately.');
            onSaved?.();
          } catch (error) {
            toast.fromError(error, 'Could not save');
          } finally {
            btn.classList.remove('is-loading');
            btn.replaceChildren('Save automation');
          }
        },
      },
      el('span', { html: icon('save', { size: 14 }) }),
      'Save automation',
    ),
  );

  host.append(autoCard, bootCard, el('div.grid.grid--2', restartCard, backupCard), saveBar);

  return { el: host };
}

function humanizeMinutes(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return 'hour';
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes / 1440 > 1 ? 's' : ''}`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default { createPropertiesTab, createFilesTab, createBackupsTab, createAutomationTab, createConnectTab };
