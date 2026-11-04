/**
 * Settings — appearance, Java runtimes, storage, runtime preferences and a
 * diagnostics panel.
 */

import { el, mount, frag, downloadText, copyText, nextFrame } from '../dom.js';
import { icon } from '../icons.js';
import { emptyState, statTile } from '../components.js';
import { state, serverList, loadSettings, wireLive } from '../store.js';
import { getSettings, setSettings } from '../settings-cache.js';
import { bytes, count, dateTime, durationShort, mibFromMb, percent, relativeTime } from '../format.js';
import { toast, confirmDialog, promptDialog, openModal, busyOverlay } from '../ui.js';
import api from '../api.js';
import desktop from '../desktop.js';

const ACCENTS = [
  ['emerald', '#10b981'],
  ['indigo', '#6366f1'],
  ['violet', '#8b5cf6'],
  ['cyan', '#06b6d4'],
  ['amber', '#f59e0b'],
  ['rose', '#f43f5e'],
];

export async function renderSettings({ query }) {
  wireLive();

  const settings = { ...getSettings(), ...((await loadSettings()) ?? {}) };
  let java = await api.java().catch(() => ({ installations: [], majors: [] }));
  let system = null;
  try {
    system = await api.system();
    state.system = system;
  } catch {
    /* offline */
  }

  const host = el('div.page');

  // ---------------------------------------------------------------------
  // Save helper
  // ---------------------------------------------------------------------
  async function save(patch, { quiet = false } = {}) {
    Object.assign(settings, patch);
    setSettings(patch);
    try {
      const result = await api.saveSettings(patch);
      Object.assign(settings, result);
      setSettings(result);
      if (!quiet) toast.success('Settings saved');
      return true;
    } catch (error) {
      toast.fromError(error, 'Could not save your settings');
      return false;
    }
  }

  const settingRow = (title, desc, control, { wide = false } = {}) =>
    el(
      'div.settingrow',
      el('div.settingrow__main', el('div.settingrow__title', title), desc ? el('div.settingrow__desc', desc) : null),
      el('div.settingrow__control', { class: wide ? 'settingrow__control--wide' : '' }, control),
    );

  const toggle = (key, { onChange } = {}) =>
    el(
      'label.switch',
      el('input', {
        type: 'checkbox',
        checked: Boolean(settings[key]),
        onchange: (event) => {
          settings[key] = event.target.checked;
          save({ [key]: event.target.checked });
          onChange?.(event.target.checked);
        },
      }),
      el('span.switch__track'),
    );

  // ---------------------------------------------------------------------
  // Appearance
  // ---------------------------------------------------------------------
  const appearanceCard = el(
    'div.card.card--flush',
    el(
      'div.card__head',
      el('span.stat__icon', { html: icon('sparkles', { size: 15 }) }),
      el('div.grow', el('div.card__title', 'Appearance'), el('div.card__sub', 'Stored per browser and applied instantly')),
    ),
    el(
      'div.card__body',
      settingRow(
        'Accent colour',
        'Used for active states, charts and highlights across the dashboard.',
        el(
          'div.swatches',
          ...ACCENTS.map(([id, color]) =>
            el('button.swatch', {
              type: 'button',
              class: settings.accent === id ? 'swatch--active' : '',
              style: `background:${color}`,
              'data-tip': id,
              onclick: (event) => {
                settings.accent = id;
                save({ accent: id });
                for (const sibling of event.target.parentElement.children) sibling.classList.remove('swatch--active');
                event.target.classList.add('swatch--active');
              },
            }),
          ),
        ),
      ),
      settingRow(
        'Background theme',
        'Midnight is darker still; Dim lifts the greys for bright rooms.',
        el(
          'div.segmented',
          ...[['dark', 'Dark'], ['midnight', 'Midnight'], ['dim', 'Dim']].map(([id, label]) =>
            el(
              'button.segmented__opt',
              {
                type: 'button',
                class: settings.theme === id ? 'segmented__opt--active' : '',
                onclick: (event) => {
                  settings.theme = id;
                  save({ theme: id });
                  for (const sibling of event.target.parentElement.children) sibling.classList.remove('segmented__opt--active');
                  event.target.classList.add('segmented__opt--active');
                },
              },
              label,
            ),
          ),
        ),
      ),
    ),
  );

  // ---------------------------------------------------------------------
  // Console
  // ---------------------------------------------------------------------
  const fontValue = el('span.range__value', `${settings.consoleFontSize ?? 13}px`);
  const consoleCard = el(
    'div.card.card--flush',
    el(
      'div.card__head',
      el('span.stat__icon', { html: icon('terminal', { size: 15 }), style: '--stat-rgb:var(--info-rgb)' }),
      el('div.grow', el('div.card__title', 'Console'), el('div.card__sub', 'How server output is displayed')),
    ),
    el(
      'div.card__body',
      settingRow(
        'Font size',
        'Applies to every console in the app.',
        el(
          'div.row',
          el('input', {
            type: 'range',
            min: '10',
            max: '20',
            step: '1',
            value: String(settings.consoleFontSize ?? 13),
            style: 'width:150px',
            oninput: (event) => {
              fontValue.textContent = `${event.target.value}px`;
              document.body.style.setProperty('--console-size', `${event.target.value}px`);
            },
            onchange: (event) => save({ consoleFontSize: Number(event.target.value) }),
          }),
          fontValue,
        ),
      ),
      settingRow('Show timestamps', 'Prefixes each line with the local receive time.', toggle('consoleTimestamps')),
      settingRow('Word wrap', 'Wraps long lines instead of scrolling horizontally.', toggle('consoleWordWrap')),
      settingRow('Auto-scroll', 'Follow new output. Turning this off leaves the view where you put it.', toggle('consoleAutoScroll')),
      settingRow('Confirm destructive actions', 'Ask before force-killing, deleting a server or restoring a backup.', toggle('confirmDestructive')),
    ),
  );

  // ---------------------------------------------------------------------
  // Java
  // ---------------------------------------------------------------------
  const javaListHost = el('div.stack--sm');

  function paintJava() {
    if (!java.installations?.length) {
      mount(
        javaListHost,
        emptyState({
          icon: 'coffee',
          title: 'No Java runtime detected',
          text: 'Minecraft servers need a JDK to run. Download one below — the manager installs it into its own data folder and reuses it for every server that needs it.',
          compact: true,
        }),
      );
    } else {
      mount(
        javaListHost,
        ...java.installations.map((entry) =>
          el(
            'div.javacard',
            { class: entry.major === Math.max(...java.installations.map((j) => j.major)) ? 'javacard--recommended' : '' },
            el('span.javacard__badge', String(entry.major)),
            el(
              'div.javacard__id',
              el(
                'div.row.row--wrap',
                el('strong', entry.vendor),
                entry.isJdk ? el('span.badge.badge--success', 'JDK') : el('span.badge.badge--neutral', 'JRE'),
                entry.managed ? el('span.badge.badge--accent', 'managed by this app') : null,
                el('span.chip.chip--mono', entry.arch),
              ),
              el('div.javacard__path', { title: entry.path }, entry.path),
              el('div.dim.tiny', `version ${entry.version} · ${entry.vm}`),
            ),
            el(
              'div.row',
              { style: 'gap:0.25rem' },
              el('button.iconbtn', { type: 'button', 'data-tip': 'Copy the path', onclick: async () => { (await copyText(entry.path)) ? toast.success('Path copied') : toast.error('Clipboard unavailable'); } }, el('span', { html: icon('copy', { size: 13 }) })),
              el('button.iconbtn', { type: 'button', 'data-tip': 'Re-probe this runtime', onclick: async () => {
                try {
                  const fresh = await api.inspectJava(entry.path);
                  toast.success(`Java ${fresh.major}`, `${fresh.vendor} · ${fresh.version}`);
                } catch (error) {
                  toast.fromError(error, 'Could not read that runtime');
                }
              } }, el('span', { html: icon('refresh', { size: 13 }) })),
            ),
          ),
        ),
      );
    }
  }
  paintJava();

  const adoptiumCards = el('div.stack--sm');
  function paintAdoptiumTargets() {
    const installedMajors = new Set(java.installations?.map((j) => j.major) ?? []);
    const targets = [8, 17, 21, 25].map((feature) => ({ feature, installed: installedMajors.has(feature) }));
    mount(
      adoptiumCards,
      el(
        'div.row.row--wrap',
        { style: 'gap:0.5rem' },
        ...targets.map(({ feature, installed }) =>
          el(
            'button.btn.btn--sm',
            {
              type: 'button',
              disabled: installed,
              'data-tip': installed ? `Java ${feature} is already installed` : `Download Temurin ${feature} from Adoptium`,
              onclick: () => installJava(feature),
            },
            el('span', { html: icon(installed ? 'check' : 'download', { size: 14 }) }),
            installed ? `Java ${feature}` : `Get Java ${feature}`,
          ),
        ),
      ),
    );
  }
  paintAdoptiumTargets();

  const javaCard = el(
    'div.card.card--flush',
    el(
      'div.card__head',
      el('span.stat__icon', { html: icon('coffee', { size: 15 }), style: '--stat-rgb:var(--warning-rgb)' }),
      el('div.grow', el('div.card__title', 'Java runtimes'), el('div.card__sub', java.installations?.length ? `${java.installations.length} detected · ${java.managedDir ? '' : ''}scanned on demand` : 'none detected')),
      el('button.btn.btn--sm', { type: 'button', onclick: (event) => rescanJava(event.currentTarget) }, el('span', { html: icon('refresh', { size: 14 }) }), 'Rescan'),
    ),
    el(
      'div.card__body.stack--md',
      el('p.muted.small', `Minecraft 1.18–1.20.4 needs Java 17, 1.20.5–1.21.x needs Java 21, and the 26.x releases need Java 25. The manager reads the exact requirement from Mojang's metadata for each version you install and picks the closest matching runtime automatically.`),
      javaListHost,
      el('hr'),
      el(
        'div.stack--sm',
        el('div.card__sub', 'Download a JDK (Eclipse Temurin, unpacked into the manager\u2019s data folder)'),
        adoptiumCards,
        el('div.field__hint', `Installed to ${java.managedDir ?? 'the manager data folder'}. Nothing is added to your system PATH.`),
      ),
      el('hr'),
      settingRow(
        'Download missing JDKs automatically',
        'When a server needs a Java version you do not have, fetch it during setup instead of failing.',
        toggle('autoDownloadJava', { onChange: (value) => { java.autoDownload = value; } }),
      ),
      settingRow(
        'Add an existing installation',
        'Already have a JDK somewhere unusual? Point the manager at its bin/java executable.',
        el('button.btn.btn--sm', { type: 'button', onclick: () => addJavaPath() }, el('span', { html: icon('plus', { size: 14 }) }), 'Add path'),
      ),
    ),
  );

  async function rescanJava(button) {
    button?.classList.add('is-loading');
    try {
      java = await api.java({ refresh: true });
      paintJava();
      paintAdoptiumTargets();
      toast.success(`Found ${java.installations.length} runtime${java.installations.length === 1 ? '' : 's'}`);
    } catch (error) {
      toast.fromError(error, 'Could not scan for Java');
    } finally {
      button?.classList.remove('is-loading');
    }
  }

  async function installJava(feature) {
    let info = null;
    try {
      info = await api.adoptiumInfo(feature);
    } catch (error) {
      toast.fromError(error, `Adoptium has nothing for Java ${feature}`);
      return;
    }

    const jobId = `java-${feature}`;
    const bar = el('div.progress.progress--lg', el('span.progress__fill', { style: 'width:0%' }));
    const detail = el('div.field__hint', `${info.name} · ${bytes(info.size)}`);

    const modal = openModal({
      title: `Install Java ${feature}`,
      subtitle: 'Eclipse Temurin JDK from Adoptium',
      icon: 'download',
      size: 'slim',
      dismissable: false,
      body: el('div.stack--md', el('p.small.muted', 'Downloading and unpacking. This can take a minute on a slow connection.'), bar, detail),
      footer: [el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Run in the background')],
    });

    const offJob = (await import('../ws.js')).default.on('job', (message) => {
      if (message.jobId !== jobId) return;
      bar.querySelector('.progress__fill').style.width = `${Math.min(99, message.percent ?? 0)}%`;
      if (message.detail) detail.textContent = message.detail;
      if (message.status === 'complete') bar.querySelector('.progress__fill').style.width = '100%';
    });

    try {
      const result = await api.installJava(feature, { jobId });
      bar.querySelector('.progress__fill').style.width = '100%';
      modal.close();
      offJob();
      toast.success(`Java ${result.java.major} installed`, `${result.java.vendor} at ${result.java.path}`, { duration: 10_000 });
      await rescanJava();
    } catch (error) {
      modal.close();
      offJob();
      toast.fromError(error, `Could not install Java ${feature}`);
    }
  }

  async function addJavaPath() {
    // Ask the OS for the file — friendlier than typing a path, and it can only
    // ever return something that actually exists.
    const path = await desktop.pickFile({
      title: 'Select a Java executable',
      defaultPath: 'C:\\Program Files',
      buttonLabel: 'Use this Java',
    });
    if (!path) return; // cancelled, or no shell to ask

    try {
      const info = await api.inspectJava(path);
      toast.success(`Java ${info.major} works`, `${info.vendor} · ${info.version}. It is available to every server.`);
      await rescanJava();
    } catch (error) {
      toast.fromError(error, 'That path is not a usable Java runtime');
    }
  }

  // ---------------------------------------------------------------------
  // Runtime behaviour
  // ---------------------------------------------------------------------
  const behaviourCard = el(
    'div.card.card--flush',
    el(
      'div.card__head',
      el('span.stat__icon', { html: icon('sliders', { size: 15 }), style: '--stat-rgb:var(--violet-rgb)' }),
      el('div.grow', el('div.card__title', 'Behaviour'), el('div.card__sub', 'Defaults applied to new servers and the dashboard')),
    ),
    el(
      'div.card__body',
      settingRow(
        'Default platform',
        'Pre-selected in the create wizard.',
        el(
          'select.select.input--sm',
          { style: 'max-width:150px', onchange: (event) => save({ defaultPlatform: event.target.value }) },
          ...[['paper', 'Paper'], ['vanilla', 'Vanilla'], ['fabric', 'Fabric']].map(([value, label]) =>
            el('option', { value, selected: settings.defaultPlatform === value }, label),
          ),
        ),
      ),
      settingRow(
        'Start servers when the manager launches',
        'Equivalent to a per-server "start on launch" flag, but app-wide.',
        toggle('startServersOnLaunch'),
      ),
      settingRow(
        'Metrics refresh interval',
        'Lower is smoother but polls the OS more often. 2 seconds is a good default.',
        el(
          'select.select.input--sm',
          { style: 'max-width:130px', onchange: (event) => save({ refreshIntervalMs: Number(event.target.value) }) },
          ...[1000, 2000, 3000, 5000].map((value) =>
            el('option', { value: String(value), selected: settings.refreshIntervalMs === value }, `${value / 1000}s`),
          ),
        ),
      ),
      settingRow(
        'Long-running request timeout',
        'How long the dashboard waits for big operations like creating a server or restoring a backup.',
        el(
          'select.select.input--sm',
          { style: 'max-width:160px', onchange: (event) => save({ defaultTimeoutMs: Number(event.target.value) }) },
          ...[60_000, 120_000, 300_000, 900_000].map((value) =>
            el('option', { value: String(value), selected: settings.defaultTimeoutMs === value }, `${value / 60000} minutes`),
          ),
        ),
      ),
    ),
  );

  // ---------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------
  const storageCard = el(
    'div.card.card--flush',
    el(
      'div.card__head',
      el('span.stat__icon', { html: icon('hardDrive', { size: 15 }), style: '--stat-rgb:var(--success-rgb)' }),
      el('div.grow', el('div.card__title', 'Storage'), el('div.card__sub', 'Where the manager keeps everything')),
      el('button.btn.btn--sm', { type: 'button', onclick: (event) => refreshStorage(event.currentTarget) }, el('span', { html: icon('refresh', { size: 14 }) }), 'Recalculate'),
    ),
    el('div.card__body', el('div', { id: 'storage-body' }, el('div.skel.skel--block'))),
  );

  async function refreshStorage(button) {
    button?.classList.add('is-loading');
    const body = storageCard.querySelector('#storage-body');
    try {
      const storage = await api.storage();
      state.storage = storage;
      mount(
        body,
        el(
          'div.kv',
          kvRow('Server folders', `${bytes(storage.servers.bytes)} · ${count(storage.servers.files)} files`),
          kvRow('Backups', `${bytes(storage.backups.bytes)} · ${count(storage.backups.files)} archives`),
          kvRow('Downloads & JDKs', bytes(storage.downloads.bytes)),
          storage.disk ? kvRow('Free disk space', `${bytes(storage.disk.free)} of ${bytes(storage.disk.total)}`) : null,
          kvRow('Servers directory', system?.paths?.servers ?? '—', true),
          kvRow('Data directory', system?.paths?.data ?? '—', true),
          kvRow('Backups directory', system?.paths?.backups ?? '—', true),
        ),
        storage.perServer?.length
          ? frag(
              el('hr'),
              el('div.card__sub', { style: 'margin-bottom:0.5rem' }, 'Per server'),
              el('div.stack--xs', ...storage.perServer.map((entry) =>
                el('div.list__item',
                  el('span.filerow__icon', { html: icon('folder', { size: 14 }) }),
                  el('div.list__main', el('div.list__title', entry.name), el('div.list__sub', `${count(entry.files)} files`)),
                  el('span.tnum.small', entry.formatted),
                ),
              )),
            )
          : null,
      );
    } catch (error) {
      mount(body, el('div.callout.callout--error', el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }), el('div', error.message)));
    } finally {
      button?.classList.remove('is-loading');
    }
  }

  const kvRow = (key, value, mono = false) =>
    el('div.kv__row', el('span.kv__k', key), el('span', { class: `kv__v${mono ? ' kv__v--mono' : ''}` }, value));

  refreshStorage();

  // ---------------------------------------------------------------------
  // System health
  // ---------------------------------------------------------------------
  const healthHost = el('div.grid.grid--4');
  function paintHealth() {
    const sys = state.system ?? system;
    if (!sys) {
      mount(healthHost, el('div.card.card--pad', el('div.muted.small', 'System information is unavailable.')));
      return;
    }
    const summary = sys.servers ?? {};
    mount(
      healthHost,
      statTile({ label: 'Manager uptime', value: durationShort(sys.app.uptimeSec * 1000), icon: 'clock', tone: 'info', sub: `Node ${sys.app.node}` }),
      statTile({ label: 'CPU', value: percent(sys.system.cpuPercent ?? 0, 0), icon: 'cpu', tone: (sys.system.cpuPercent ?? 0) > 80 ? 'danger' : 'accent', sub: `${sys.system.cpuCount} threads · ${sys.system.cpuModel}` }),
      statTile({ label: 'Memory', value: `${(sys.system.memory.usedMb / 1024).toFixed(1)}`, unit: 'GiB', icon: 'memory', tone: 'violet', sub: `of ${(sys.system.memory.totalMb / 1024).toFixed(1)} GiB (${percent(sys.system.memory.usedPercent, 0)})` }),
      statTile({ label: 'Servers', value: summary.running ?? 0, unit: `/ ${summary.total ?? 0}`, icon: 'server', tone: 'success', sub: `${summary.totalPlayers ?? 0} players online` }),
    );
  }
  paintHealth();

  // ---------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------
  const logHost = el('div.stack--xs');
  const logFilter = el('select.select.input--sm', { style: 'max-width:130px' },
    ...[['', 'All levels'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info'], ['debug', 'Debug']].map(([value, label]) =>
      el('option', { value, selected: value === '' }, label),
    ),
  );

  async function loadLogs() {
    mount(logHost, el('div.skel', { style: 'height:120px' }));
    try {
      const data = await api.systemLogs({ limit: 200, level: logFilter.value || undefined });
      if (!data.records.length) {
        mount(logHost, el('p.muted.small', 'Nothing logged at that level.'));
        return;
      }
      mount(
        logHost,
        ...data.records.slice(-60).reverse().map((record) =>
          el(
            'div.list__item',
            { style: 'padding:0.32rem 0.5rem;align-items:flex-start' },
            el('span.badge', { class: record.level === 'error' || record.level === 'fatal' ? 'badge--danger' : record.level === 'warn' ? 'badge--warning' : 'badge--neutral', style: 'min-width:52px;justify-content:center' }, record.level),
            el('div.list__main', el('div.list__sub', { style: 'font-family:var(--font-mono);font-size:0.73rem;word-break:break-word' }, record.message)),
            el('span.dim.tiny.nowrap', `${record.scope} · ${relativeTime(Date.parse(record.ts))}`),
          ),
        ),
      );
    } catch (error) {
      mount(logHost, el('div.callout.callout--error', el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }), el('div', error.message)));
    }
  }
  logFilter.addEventListener('change', loadLogs);
  loadLogs();

  const diagnosticsCard = el(
    'div.card.card--flush',
    el(
      'div.card__head',
      el('span.stat__icon', { html: icon('wrench', { size: 15 }), style: '--stat-rgb:var(--info-rgb)' }),
      el('div.grow', el('div.card__title', 'Diagnostics'), el('div.card__sub', 'Recent manager activity and a one-click support bundle')),
      logFilter,
      el('button.btn.btn--sm', { type: 'button', onclick: () => exportDiagnostics() }, el('span', { html: icon('download', { size: 14 }) }), 'Export'),
    ),
    el('div.card__body', logHost),
  );

  async function exportDiagnostics() {
    const overlay = busyOverlay('Collecting diagnostics…');
    try {
      const data = await api.diagnostics();
      overlay.close();
      downloadText(`mcsm-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(data, null, 2), 'application/json');
      toast.success('Diagnostics exported', 'The file contains no secrets — tokens and RCON passwords are excluded.');
    } catch (error) {
      overlay.close();
      toast.fromError(error, 'Could not collect diagnostics');
    }
  }

  // ---------------------------------------------------------------------
  // Desktop app (only when running inside the Electron shell)
  // ---------------------------------------------------------------------

  /**
   * Built lazily: `desktop.getAppInfo()` and `getPrefs()` are IPC round-trips,
   * and a browser has neither.
   */
  async function buildDesktopCard() {
    const [appInfo, prefs] = await Promise.all([desktop.getAppInfo(), desktop.getPrefs()]);
    if (!appInfo) return null;

    let current = { closeAction: 'tray', notifications: true, ...(prefs ?? {}) };

    const savePrefs = async (patch) => {
      current = { ...current, ...patch };
      const result = await desktop.setPrefs(patch);
      if (result) current = { ...current, ...result };
    };

    const folderRow = (label, description, target) =>
      settingRow(
        label,
        description,
        el(
          'div.row',
          { style: 'gap:0.35rem' },
          el('button.btn.btn--sm', { type: 'button', onclick: () => desktop.revealPath(target) }, el('span', { html: icon('folder', { size: 14 }) }), 'Open'),
          el(
            'button.iconbtn',
            {
              type: 'button',
              'data-tip': 'Copy the path',
              onclick: async () => {
                const ok = await copyText(target);
                toast[ok ? 'success' : 'error'](ok ? 'Path copied' : 'Clipboard unavailable');
              },
            },
            el('span', { html: icon('copy', { size: 13 }) }),
          ),
        ),
      );

    return el(
      'div.card.card--flush',
      el(
        'div.card__head',
        el('span.stat__icon', { html: icon('rocket', { size: 15 }) }),
        el('div.grow', el('div.card__title', 'Desktop app'), el('div.card__sub', 'Window behaviour and where your files live')),
      ),
      el(
        'div.card__body',
        settingRow(
          'When I close the window',
          'Servers run in the background, so closing the window does not have to stop them.',
          el(
            'div.segmented',
            ...[
              ['tray', 'Keep running in the tray'],
              ['quit', 'Stop servers and quit'],
            ].map(([value, label]) =>
              el(
                'button.segmented__opt',
                {
                  type: 'button',
                  class: current.closeAction === value ? 'segmented__opt--active' : '',
                  onclick: (event) => {
                    savePrefs({ closeAction: value });
                    for (const sibling of event.target.parentElement.children) {
                      sibling.classList.remove('segmented__opt--active');
                    }
                    event.target.classList.add('segmented__opt--active');
                    toast.success(
                      value === 'tray' ? 'The window will hide to the tray' : 'Closing the window will quit the app',
                      value === 'tray' ? 'Use Quit in the tray menu to exit completely.' : 'Your servers will be stopped cleanly.',
                    );
                  },
                },
                label,
              ),
            ),
          ),
        ),
        settingRow(
          'Desktop notifications',
          'Tell me when a server finishes booting or crashes, even when the window is hidden.',
          el(
            'label.switch',
            el('input', {
              type: 'checkbox',
              checked: current.notifications !== false,
              onchange: (event) => {
                savePrefs({ notifications: event.target.checked });
                if (event.target.checked) {
                  desktop.notify({ title: 'Notifications enabled', body: 'You will hear about crashes and finished boots.' });
                }
              },
            }),
            el('span.switch__track'),
          ),
        ),
        folderRow('Servers folder', appInfo.paths?.servers ?? '—', appInfo.paths?.servers),
        folderRow('Backups folder', appInfo.paths?.backups ?? '—', appInfo.paths?.backups),
        folderRow('Logs folder', appInfo.paths?.logs ?? '—', appInfo.paths?.logs),
        settingRow(
          'Files stay on this machine',
          `${appInfo.isPackaged ? 'Installed app' : 'Running from source'} · Electron ${appInfo.versions?.electron ?? '?'} · Chromium ${appInfo.versions?.chrome ?? '?'} · Node ${appInfo.versions?.node ?? '?'}`,
          el(
            'button.btn.btn--sm',
            { type: 'button', onclick: () => desktop.revealPath(appInfo.configFile) },
            el('span', { html: icon('settings', { size: 14 }) }),
            'Window preferences',
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Danger zone
  // ---------------------------------------------------------------------
  const dangerCard = el(
    'div.card.card--flush',
    el(
      'div.card__head',
      el('span.stat__icon', { html: icon('alert', { size: 15 }), style: '--stat-rgb:var(--danger-rgb)' }),
      el('div.grow', el('div.card__title', 'Maintenance'), el('div.card__sub', 'Rarely needed — read carefully')),
    ),
    el(
      'div.card__body',
      settingRow(
        'Reset all settings',
        'Restores appearance and behaviour defaults. Servers, worlds and backups are untouched.',
        el(
          'button.btn.btn--sm.btn--warn',
          {
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Reset every setting?',
                message: 'Appearance, console and behaviour preferences go back to their defaults.',
                detail: 'Your servers, worlds, schedules and backups are not affected.',
                confirmLabel: 'Reset settings',
                tone: 'warning',
                icon: 'refresh',
              });
              if (!ok) return;
              try {
                const result = await api.resetSettings();
                setSettings(result);
                toast.success('Settings reset', 'Reloading the page to apply everything cleanly.');
                setTimeout(() => location.reload(), 1200);
              } catch (error) {
                toast.fromError(error, 'Could not reset settings');
              }
            },
          },
          'Reset settings',
        ),
      ),
      settingRow(
        'Clear the version cache',
        'Forces the next version list to come straight from Mojang, PaperMC and Fabric.',
        el(
          'button.btn.btn--sm',
          {
            type: 'button',
            onclick: async () => {
              try {
                await api.refreshVersions();
                toast.success('Version cache cleared', 'Reopen the create wizard to fetch fresh data.');
              } catch (error) {
                toast.fromError(error, 'Could not clear the cache');
              }
            },
          },
          'Clear cache',
        ),
      ),
      settingRow(
        'Quit the app',
        'Stops every running server cleanly, then closes the window, the tray icon and the backend.',
        el(
          'button.btn.btn--sm.btn--danger',
          {
            type: 'button',
            onclick: async () => {
              const running = serverList().filter((s) => ['running', 'starting'].includes(s.status));
              const ok = await confirmDialog({
                title: 'Quit Minecraft Server Manager?',
                message: running.length
                  ? `${running.length} running server${running.length === 1 ? '' : 's'} will be stopped first.`
                  : 'No servers are running.',
                detail: 'Each server is asked to stop and saves its world first. Players are disconnected.',
                confirmLabel: 'Quit app',
                tone: 'danger',
                icon: 'power',
              });
              if (!ok) return;
              // The shell shows its own progress window while servers stop.
              await desktop.quitApp();
            },
          },
          'Quit app',
        ),
      ),
    ),
  );

  // ---------------------------------------------------------------------
  // Assemble
  // ---------------------------------------------------------------------
  // The desktop card needs an IPC round-trip, so it is appended when ready
  // rather than blocking the whole page on it.
  const desktopSlot = el('div');
  buildDesktopCard()
    .then((card) => {
      if (card) mount(desktopSlot, card);
    })
    .catch(() => {
      /* a missing desktop bridge is not worth surfacing */
    });

  host.append(
    el(
      'div.page__head',
      el(
        'div',
        el('h1.page__title', 'Settings'),
        el(
          'p.page__sub',
          'Everything is stored locally and your servers keep running when the window is closed.',
        ),
      ),
      el(
        'div.page__actions',
        el('button.btn', { type: 'button', onclick: () => location.reload() }, el('span', { html: icon('refresh', { size: 14 }) }), 'Reload'),
      ),
    ),
    healthHost,
    appearanceCard,
    consoleCard,
    javaCard,
    behaviourCard,
    desktopSlot,
    el('div.pane__grid', storageCard, diagnosticsCard),
    dangerCard,
    el(
      'p.dim.tiny.center',
      `Minecraft Server Manager v${system?.app?.version ?? '1.0.0'} · ` +
        `Electron ${desktop.shellVersions?.electron ?? '?'} · ` +
        `running on ${system?.system?.platform ?? 'unknown'} · ` +
        `data in ${system?.paths?.data ?? 'the data folder'}`,
    ),
  );

  return {
    el: host,
    title: 'Settings',
    crumbs: [{ label: 'Settings' }],
    onEnter() {
      api.system().then((info) => {
        state.system = info;
        system = info;
        paintHealth();
      }).catch(() => {});
    },
  };
}

export default renderSettings;
