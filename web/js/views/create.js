/**
 * Create-server wizard.
 *
 * Five steps: Platform → Version → Resources → World → Review.
 * The final step streams real provisioning progress (download %, Java
 * resolution, EULA, config generation) over the WebSocket before landing the
 * user straight in the new server's console.
 */

import { el, mount, frag, on, focusSoft, uuid } from '../dom.js';
import { icon } from '../icons.js';
import { toast, confirmDialog, openModal } from '../ui.js';
import api from '../api.js';
import ws from '../ws.js';
import { state, setServers, wireLive } from '../store.js';
import { getSettings, setSettings, shouldConfirmDestructive } from '../settings-cache.js';
import { mibFromMb, percent, bytes, platformMeta, stripMinecraftCodes } from '../format.js';

const STEPS = [
  { id: 'platform', label: 'Platform', summary: 'Vanilla, Paper or Fabric' },
  { id: 'version', label: 'Version', summary: 'Minecraft release' },
  { id: 'resources', label: 'Resources', summary: 'Memory, Java and port' },
  { id: 'world', label: 'World', summary: 'Gameplay and rules' },
  { id: 'review', label: 'Review & create', summary: 'Confirm and build' },
];

const PRESET_ICONS = { leaf: 'leaf', globe: 'globe', puzzle: 'puzzle', blocks: 'blocks', skull: 'skull' };

export async function renderCreate() {
  wireLive();

  const settings = getSettings();
  const platforms = state.platforms ?? (await api.platforms());
  state.platforms = platforms;

  // ---------------------------------------------------------------------
  // Wizard state
  // ---------------------------------------------------------------------
  const draft = {
    platform: settings.defaultPlatform ?? 'paper',
    version: null,
    build: 'latest',
    loader: null,
    // Resources
    maxHeapMb: platforms.recommendedHeapMb ?? 4096,
    gcProfile: 'aikar',
    javaPath: null,
    autoDownloadJava: Boolean(platforms.java?.autoDownloadJava ?? settings.autoDownloadJava),
    port: null,
    autoRestart: false,
    autoStart: false,
    // World
    name: '',
    motd: '',
    preset: null,
    gamemode: 'survival',
    difficulty: 'normal',
    maxPlayers: 20,
    viewDistance: 10,
    simulationDistance: 8,
    onlineMode: true,
    pvp: true,
    hardcore: false,
    whiteList: false,
    levelType: 'minecraft:normal',
    seed: '',
    // Meta
    startAfterCreate: true,
  };

  let stepIndex = 0;
  let versionsCache = null;
  let versionsLoading = false;
  let preflight = null;
  let javaInfo = platforms.java ?? { installations: [], majors: [] };
  let provisionJobId = null;
  let createdServerId = null;

  // ---------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------
  const stepsNav = el('nav.wizard__steps', { 'aria-label': 'Steps' });
  const panel = el('div.wizard__panel');
  const foot = el('div.wizard__foot');

  /*
   * `foot` carries Back / Continue / Create server, so it MUST be in the tree.
   * It lives inside the second grid column (next to the panel) so it lines up
   * with the panel rather than the step rail — hence the wrapper.
   */
  const page = el(
    'div.page.page--narrow',
    el(
      'div.page__head',
      el('div', el('h1.page__title', 'Create a server'), el('p.page__sub', 'Everything is downloaded and configured locally — nothing leaves this machine except the jar downloads.')),
      el(
        'div.page__actions',
        el(
          'a.btn',
          { href: '#/dashboard' },
          el('span', { html: icon('arrowLeft', { size: 14 }) }),
          'Cancel',
        ),
      ),
    ),
    el('div.wizard', stepsNav, el('div.wizard__main', panel, foot)),
  );

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  const platformList = platforms.platforms ?? [];

  function renderSteps() {
    mount(
      stepsNav,
      ...STEPS.map((step, index) =>
        el(
          'button.wstep',
          {
            type: 'button',
            disabled: index > furthestReachable(),
            class: index === stepIndex ? 'wstep--active' : index < stepIndex ? 'wstep--done' : '',
            onclick: () => goTo(index),
          },
          el('span.wstep__num', index < stepIndex ? el('span', { html: icon('check', { size: 12 }) }) : String(index + 1)),
          el('span.wstep__label', step.label),
        ),
      ),
    );
  }

  function furthestReachable() {
    if (!draft.platform) return 0;
    if (!draft.version) return 1;
    return STEPS.length - 1;
  }

  async function goTo(index) {
    if (index > furthestReachable()) return;
    stepIndex = index;
    renderSteps();
    await renderPanel();
    page.querySelector('.view')?.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function next() {
    return goTo(Math.min(STEPS.length - 1, stepIndex + 1));
  }
  function back() {
    return goTo(Math.max(0, stepIndex - 1));
  }

  function renderFoot({ nextLabel = 'Continue', nextEnabled = true, nextHandler = next, showBack = stepIndex > 0, extra = null } = {}) {
    mount(
      foot,
      showBack ? el('button.btn', { type: 'button', onclick: back }, el('span', { html: icon('arrowLeft', { size: 14 }) }), 'Back') : null,
      el('span.spacer'),
      extra ?? null,
      el(
        'button.btn.btn--primary',
        { type: 'button', disabled: !nextEnabled, onclick: nextHandler },
        nextLabel,
        el('span', { html: icon('arrowRight', { size: 14 }) }),
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Step: platform
  // ---------------------------------------------------------------------
  async function renderPlatformStep() {
    const cards = el('div.platformgrid');
    for (const platform of platformList) {
      const javaReady = platform.javaHintOk !== false;
      cards.appendChild(
        el(
          `button.optcard.optcard--${platform.accent}`,
          {
            type: 'button',
            class: draft.platform === platform.id ? 'optcard--selected' : '',
            onclick: async () => {
              draft.platform = platform.id;
              draft.build = 'latest';
              draft.loader = null;
              versionsCache = null;
              renderPlatformStep();
              await loadVersions();
            },
          },
          el('span.optcard__check', el('span', { html: icon('check', { size: 11 }) })),
          el('span.optcard__icon', { html: icon(platform.icon, { size: 20 }) }),
          el('div.optcard__title', platform.label),
          el('div.optcard__tag', platform.tagline),
          el(
            'div.optcard__features',
            platform.supportsPlugins ? el('span.chip', 'Plugins') : null,
            platform.supportsMods ? el('span.chip', 'Mods') : null,
            el('span.chip', `~${mibFromMb(platform.recommendedHeapMb, 0)} heap`),
          ),
          el('p', { style: 'font-size:0.77rem;color:var(--text-dim);line-height:1.5;margin-top:0.15rem' }, platform.description),
        ),
      );
    }

    const quickNames = ['Survival SMP', 'Creative Plot', 'Modded Server', 'Test Server'];
    const nameInput = el('input.input', {
      value: draft.name,
      placeholder: 'e.g. Friends SMP',
      maxlength: '60',
      oninput: (event) => {
        draft.name = event.target.value;
        nameInput.closest('.field')?.classList.remove('field--invalid');
      },
      onkeydown: (event) => {
        if (event.key === 'Enter') next();
      },
    });

    mount(
      panel,
      el('h2', { style: 'margin-bottom:0.3rem' }, 'Which server software?'),
      el('p.muted.small', { style: 'margin-bottom:1.1rem' }, 'Pick the flavour that matches what you want to run. You can change this later by reinstalling the server jar — your world is preserved.'),
      cards,

      el('hr'),

      el(
        'div.field',
        el('label.field__label', 'Server name', el('span.req', '*')),
        el('div.inputgroup', el('span.inputgroup__icon', { html: icon('tag', { size: 15 }) }), nameInput),
        el(
          'div.row.row--wrap',
          { style: 'gap:0.3rem;margin-top:0.15rem' },
          ...quickNames.map((name) =>
            el('button.chip.chip--clickable', { type: 'button', onclick: () => { draft.name = name; nameInput.value = name; } }, name),
          ),
        ),
        el('div.field__hint', 'Used for the folder name, the dashboard and the default MOTD.'),
      ),

      el(
        'div.field',
        { style: 'margin-top:1rem' },
        el('label.field__label', 'Or start from a preset'),
        el(
          'div.presetgrid',
          ...(platforms.presets ?? []).map((preset) =>
            el(
              `button.optcard.optcard--${platformMeta(draft.platform).accent}`,
              {
                type: 'button',
                class: draft.preset === preset.id ? 'optcard--selected' : '',
                style: 'padding:0.8rem 0.85rem;gap:0.4rem',
                onclick: () => {
                  // Applying a preset overwrites the world step's defaults.
                  draft.preset = preset.id;
                  Object.assign(draft, preset.settings);
                  if (preset.platformHint && !draft.name) draft.platform = preset.platformHint;
                  if (preset.settings.maxPlayers) draft.maxPlayers = preset.settings.maxPlayers;
                  renderPlatformStep();
                  toast.success(`Preset applied: ${preset.name}`, 'You can fine-tune every value on the World step.');
                },
              },
              el('span.optcard__check', el('span', { html: icon('check', { size: 11 }) })),
              el('span.optcard__icon', { html: icon(PRESET_ICONS[preset.icon] ?? 'sparkles', { size: 17 }) }),
              el('div.optcard__title', { style: 'font-size:0.88rem' }, preset.name),
              el('div.optcard__tag', { style: 'font-size:0.75rem' }, preset.tagline),
            ),
          ),
        ),
      ),
    );

    renderFoot({
      showBack: false,
      nextEnabled: Boolean(draft.platform),
      nextHandler: async () => {
        if (!draft.name.trim()) {
          nameInput.closest('.field')?.classList.add('field--invalid');
          nameInput.focus();
          toast.warning('Give your server a name', 'It only needs to be a couple of words.');
          return;
        }
        await next();
      },
    });
  }

  // ---------------------------------------------------------------------
  // Step: version
  // ---------------------------------------------------------------------
  async function loadVersions({ force = false } = {}) {
    if (versionsCache && !force) return versionsCache;
    versionsLoading = true;
    try {
      versionsCache = await api.versions(draft.platform, { snapshots: false });
      draft.version = draft.version && versionsCache.versions.some((v) => v.id === draft.version) ? draft.version : versionsCache.versions[0]?.id ?? null;
      return versionsCache;
    } catch (error) {
      versionsCache = null;
      toast.fromError(error, `Could not load ${draft.platform} versions`);
      throw error;
    } finally {
      versionsLoading = false;
    }
  }

  async function renderVersionStep() {
    mount(panel, el('div.stack--md', el('div.row', el('div.spinner.spinner--accent'), el('span.muted', 'Fetching available versions…'))));

    let data;
    try {
      data = await loadVersions();
    } catch {
      mount(
        panel,
        el('h2', 'Minecraft version'),
        el(
          'div.callout.callout--error',
          { style: 'margin-top:1rem' },
          el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
          el(
            'div',
            el('div.callout__title', 'Could not reach the version service'),
            el('div', 'Check your internet connection, then try again. The manager caches versions for ten minutes once they load.'),
            el('button.btn.btn--sm', { style: 'margin-top:0.6rem', onclick: () => renderVersionStep() }, 'Retry'),
          ),
        ),
        foot,
      );
      renderFoot({ nextEnabled: false });
      return;
    }

    const includeSnapshots = { value: false };
    const searchInput = el('input.input', { placeholder: 'Search versions…', oninput: (event) => paint(event.target.value) });
    const list = el('div.versionlist');

    const available = () => data.versions.filter((v) => includeSnapshots.value || !v.snapshot);

    function paint(term = '') {
      const needle = term.trim().toLowerCase();
      const rows = available().filter((v) => !needle || v.id.toLowerCase().includes(needle));
      if (!rows.length) {
        mount(list, el('div.empty', { style: 'padding:1.6rem' }, el('p.empty__title', 'No matching versions'), el('p.empty__text', 'Try a different search term or include snapshots.')));
        return;
      }
      mount(
        list,
        ...rows.slice(0, 200).map((version) =>
          el(
            'button.versionrow',
            {
              type: 'button',
              class: draft.version === version.id ? 'versionrow--selected' : '',
              onclick: () => {
                draft.version = version.id;
                paint(term);
                paintSelected();
              },
              ondblclick: () => next(),
            },
            el('span.versionrow__id', version.id),
            el('div.versionrow__meta',
              version.id === data.latest?.release ? el('span.badge.badge--accent', 'Latest') : null,
              version.snapshot ? el('span.badge.badge--neutral', 'Snapshot') : null,
              version.java ? el('span.chip.chip--mono', { 'data-tip': version.javaNote ?? '' }, `Java ${version.java}`) : null,
            ),
          ),
        ),
      );
    }

    // -- Selected version detail card -----------------------------------
    const detailCard = el('div.card.card--pad.stack--sm');

    async function paintSelected() {
      const version = data.versions.find((v) => v.id === draft.version);
      if (!version) {
        mount(detailCard, el('p.muted.small', 'Select a version from the list.'));
        renderFoot({ nextEnabled: false });
        return;
      }

      const requiredJava = version.java ?? 21;
      const installed = javaInfo.installations ?? [];
      const exact = installed.find((j) => j.major === requiredJava);
      const newer = installed.filter((j) => j.major > requiredJava).sort((a, b) => a.major - b.major)[0];
      const usable = exact ?? newer;
      draft.build = draft.build ?? 'latest';

      mount(
        detailCard,
        el('div.row', el('div.card__title', { style: 'font-size:0.95rem' }, `${platformMeta(draft.platform).label} ${draft.version}`)),
        el(
          'div.kv',
          el('div.kv__row', el('span.kv__k', 'Required Java'), el('span.kv__v', `Java ${requiredJava}${version.javaSource === 'manifest' ? ' (from Mojang)' : ''}`)),
          el('div.kv__row',
            el('span.kv__k', 'Detected runtime'),
            el('span.kv__v', { class: usable ? 'success' : 'danger' },
              usable ? `Java ${usable.major} — ${usable.vendor}` : 'none available'),
          ),
          version.releaseTime ? el('div.kv__row', el('span.kv__k', 'Released'), el('span.kv__v', new Date(version.releaseTime).toLocaleDateString())) : null,
        ),
        !usable
          ? el(
              'div.callout.callout--warn',
              el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
              el('div',
                el('div.callout__title', `Java ${requiredJava} is needed`),
                el('div', 'The manager can download a matching Temurin JDK from Adoptium during setup.'),
                el(
                  'label.switch.switch--sm',
                  { style: 'margin-top:0.5rem' },
                  el('input', { type: 'checkbox', checked: draft.autoDownloadJava, onchange: (e) => { draft.autoDownloadJava = e.target.checked; } }),
                  el('span.switch__track'),
                  el('span.switch__label', 'Download Java automatically'),
                ),
              ),
            )
          : newer && !exact
            ? el('div.callout.callout--warn', el('span.callout__icon', { html: icon('info', { size: 16 }) }), el('div', `Java ${requiredJava} is not installed — Java ${newer.major} will be used instead. That normally works, but an exact match is safest.`))
            : null,
      );

      renderFoot({ nextEnabled: true, nextLabel: 'Continue' });
    }

    const snapshotToggle = el(
      'label.switch.switch--sm',
      el('input', {
        type: 'checkbox',
        onchange: (event) => {
          includeSnapshots.value = event.target.checked;
          paint(searchInput.value);
        },
      }),
      el('span.switch__track'),
      el('span.switch__label', 'Include snapshots'),
    );

    mount(
      panel,
      el('h2', { style: 'margin-bottom:0.3rem' }, 'Pick a Minecraft version'),
      el('p.muted.small', { style: 'margin-bottom:1rem' }, `Showing ${available().length} ${platformMeta(draft.platform).label} releases. The required Java version comes straight from Mojang's metadata.`),
      el(
        'div.row.row--wrap',
        { style: 'justify-content:space-between;margin-bottom:0.7rem' },
        el('div.search.grow', { style: 'max-width:340px' }, el('span.search__icon', { html: icon('search', { size: 15 }) }), searchInput),
        snapshotToggle,
      ),
      list,
      el('div', { style: 'margin-top:1rem' }, detailCard),
    );

    paint();
    await paintSelected();
    focusSoft(searchInput);
  }

  // ---------------------------------------------------------------------
  // Step: resources
  // ---------------------------------------------------------------------
  async function renderResourcesStep() {
    const versionEntry = versionsCache?.versions?.find((v) => v.id === draft.version);
    const requiredJava = versionEntry?.java ?? 21;
    const installed = javaInfo.installations ?? [];
    const exact = installed.find((j) => j.major === requiredJava);
    const newer = installed.filter((j) => j.major > requiredJava).sort((a, b) => a.major - b.major)[0];
    const usable = exact ?? newer;

    if (!usable && !draft.autoDownloadJava) draft.autoDownloadJava = true;

    const budget = preflight?.plan?.heapCeilingMb ?? platforms.recommendedHeapMb ?? 4096;
    const recommended = preflight?.plan?.suggestedHeapMb ?? platforms.recommendedHeapMb ?? 4096;
    if (!draft.maxHeapMb || draft.maxHeapMb > budget) draft.maxHeapMb = Math.min(recommended, budget);
    if (!draft.port) draft.port = preflight?.port ?? 25565;

    const heapValue = el('span.range__value', mibFromMb(draft.maxHeapMb));
    const heapSlider = el('input', {
      type: 'range',
      min: '512',
      max: String(Math.max(1024, budget)),
      step: '512',
      value: String(draft.maxHeapMb),
      oninput: (event) => {
        draft.maxHeapMb = Number(event.target.value);
        heapValue.textContent = mibFromMb(draft.maxHeapMb);
        paintRange(event.target);
        updateHeapHint();
      },
    });
    const heapHint = el('div.field__hint');

    const paintRange = (input) => {
      const min = Number(input.min);
      const max = Number(input.max);
      input.style.setProperty('--fill', `${((Number(input.value) - min) / Math.max(1, max - min)) * 100}%`);
    };

    function updateHeapHint() {
      const pctOfBudget = (draft.maxHeapMb / budget) * 100;
      const serverWillUse = state.system?.system?.memory?.totalMb
        ? (draft.maxHeapMb / state.system.system.memory.totalMb) * 100
        : 0;
      heapHint.textContent =
        pctOfBudget > 92
          ? `That claims ${percent(serverWillUse, 0)} of this machine's RAM and leaves almost nothing for the OS. Expect swapping.`
          : pctOfBudget > 70
            ? `About ${percent(serverWillUse, 0)} of total RAM. Fine if nothing else heavy is running.`
            : `About ${percent(serverWillUse, 0)} of total RAM — comfortable, with room for plugins and several players.`;
    }
    paintRange(heapSlider);
    updateHeapHint();

    // -- Java picker -----------------------------------------------------
    const javaOptions = el('div.stack--xs');
    function paintJava() {
      const rows = [];
      if (draft.autoDownloadJava) {
        rows.push(
          el(
            'div.javacard.javacard--recommended',
            el('span.javacard__badge', 'AUTO'),
            el(
              'div.javacard__id',
              el('div.row', el('strong', `Java ${requiredJava} — downloaded during setup`), el('span.badge.badge--accent', 'Recommended')),
              el('div.javacard__path', 'Temurin JDK from Adoptium, installed into the manager\u2019s data folder'),
            ),
          ),
        );
      }
      for (const java of installed) {
        const isExact = java.major === requiredJava;
        const tooOld = java.major < requiredJava;
        rows.push(
          el(
            'button',
            {
              class: `javacard${isExact ? ' javacard--recommended' : ''}`,
              type: 'button',
              style: 'width:100%;text-align:left;cursor:pointer;opacity:' + (tooOld ? '.45' : '1'),
              disabled: tooOld,
              onclick: () => {
                draft.autoDownloadJava = false;
                draft.javaPath = java.path;
                paintJava();
              },
              onmouseenter: (event) => { event.currentTarget.style.borderColor = 'rgba(var(--accent-rgb),.45)'; },
              onmouseleave: (event) => { event.currentTarget.style.borderColor = ''; },
            },
            el('span.javacard__badge', String(java.major)),
            el(
              'div.javacard__id',
              el(
                'div.row.row--wrap',
                el('strong', java.vendor),
                java.isJdk ? el('span.badge.badge--success', 'JDK') : el('span.badge.badge--neutral', 'JRE'),
                isExact ? el('span.badge.badge--accent', 'Exact match') : null,
                tooOld ? el('span.badge.badge--danger', `needs ${requiredJava}+`) : null,
                java.managed ? el('span.chip.chip--accent', 'managed') : null,
              ),
              el('div.javacard__path', java.path),
            ),
            el('span.dim.tiny', java.version),
          ),
        );
      }
      if (!installed.length && !draft.autoDownloadJava) {
        rows.push(el('div.callout.callout--warn', el('span.callout__icon', { html: icon('alert', { size: 16 }) }), el('div', 'No Java runtime is installed. Enable the automatic download above, or install a JDK manually from Settings.')));
      }
      mount(javaOptions, ...rows);
    }
    paintJava();

    const autoToggle = el('input', {
      type: 'checkbox',
      checked: draft.autoDownloadJava,
      onchange: (event) => {
        draft.autoDownloadJava = event.target.checked;
        paintJava();
      },
    });

    // -- Port ------------------------------------------------------------
    const portInput = el('input.input.input--mono', {
      type: 'number',
      min: '1',
      max: '65535',
      value: String(draft.port),
      oninput: (event) => { draft.port = Number(event.target.value); },
    });
    const portStatus = el('div.field__hint');

    async function checkPort() {
      portStatus.textContent = 'Checking…';
      try {
        const result = await api.preflight({ platform: draft.platform, version: draft.version, port: draft.port });
        preflight = result;
        const busy = result.warnings?.find((w) => w.title.includes('Port'));
        portStatus.textContent = busy ? busy.detail : 'Nothing is listening on this port.';
        portStatus.className = `field__hint ${busy ? 'warning' : 'success'}`;
      } catch {
        portStatus.textContent = '';
      }
    }
    checkPort();

    mount(
      panel,
      el('h2', { style: 'margin-bottom:0.3rem' }, 'Resources & Java'),
      el('p.muted.small', { style: 'margin-bottom:1.1rem' }, 'Sensible defaults are applied automatically. Everything here can be changed later without touching your world.'),

      el(
        'div.card.card--pad.stack--md',
        el('div.row', el('span.stat__icon', { html: icon('memory', { size: 15 }) }), el('div.grow', el('div.card__title', 'Memory'), el('div.card__sub', `${mibFromMb(budget, 0)} can be safely allocated on this machine`))),
        el(
          'div.range',
          el('div.range__head', el('span.field__label', 'Maximum heap (-Xmx)'), heapValue),
          heapSlider,
          el('div.range__scale', el('span', '512 MiB'), el('span.accent', `recommended ${mibFromMb(recommended, 0)}`), el('span', mibFromMb(budget, 0))),
          heapHint,
        ),
        el(
          'div.row.row--wrap',
          { style: 'gap:0.35rem' },
          ...[2048, 4096, 6144, 8192].filter((v) => v <= budget).map((v) =>
            el('button.chip.chip--clickable', { type: 'button', onclick: () => { draft.maxHeapMb = v; heapSlider.value = String(v); heapValue.textContent = mibFromMb(v); paintRange(heapSlider); updateHeapHint(); } }, mibFromMb(v, 0)),
          ),
        ),
        el(
          'div.field',
          el('label.field__label', 'Garbage collector'),
          el(
            'div.segmented.segmented--block',
            ...[
              ['aikar', 'Aikar G1', 'The community standard. Best all-round choice for Vanilla and Paper.'],
              ['zgc', 'ZGC', 'Very low pause times. Needs Java 21+ and roughly 8 GiB of heap.'],
              ['none', 'Custom', 'No tuning flags. Use when a modpack supplies its own.'],
            ].map(([id, label, tip]) =>
              el(
                'button.segmented__opt',
                {
                  type: 'button',
                  class: draft.gcProfile === id ? 'segmented__opt--active' : '',
                  'data-tip': tip,
                  onclick: (event) => {
                    draft.gcProfile = id;
                    for (const sibling of event.target.parentElement.children) sibling.classList.remove('segmented__opt--active');
                    event.target.classList.add('segmented__opt--active');
                  },
                },
                label,
              ),
            ),
          ),
          el('div.field__hint', 'Applied as JVM flags on every start. The start scripts in the server folder use them too.'),
        ),
      ),

      el(
        'div.card.card--pad.stack--md',
        { style: 'margin-top:1rem' },
        el('div.row',
          el('span.stat__icon', { html: icon('coffee', { size: 15 }), style: '--stat-rgb:var(--warning-rgb)' }),
          el('div.grow', el('div.card__title', 'Java runtime'), el('div.card__sub', `Minecraft ${draft.version} requires Java ${requiredJava}`)),
        ),
        el('label.switch', autoToggle, el('span.switch__track'), el('div', el('span.switch__label', 'Download a matching JDK automatically'), el('div.switch__desc', 'Fetched once from Adoptium and reused by every server that needs it.'))),
        javaOptions,
      ),

      el(
        'div.card.card--pad.stack--md',
        { style: 'margin-top:1rem' },
        el('div.row', el('span.stat__icon', { html: icon('network', { size: 15 }), style: '--stat-rgb:var(--info-rgb)' }), el('div.grow', el('div.card__title', 'Network'), el('div.card__sub', 'The TCP port players connect to'))),
        el(
          'div.field',
          el('label.field__label', 'Server port'),
          el(
            'div.row',
            el('div.inputgroup.grow', el('span.inputgroup__icon', { html: icon('network', { size: 15 }) }), portInput),
            el(
              'button.btn',
              {
                type: 'button',
                onclick: async () => {
                  try {
                    const result = await api.availablePort(Math.max(25565, draft.port + 1));
                    draft.port = result.port;
                    portInput.value = String(result.port);
                    checkPort();
                    toast.success(`Found a free port: ${result.port}`);
                  } catch (error) {
                    toast.fromError(error, 'Could not find a free port');
                  }
                },
              },
              'Find free port',
            ),
          ),
          portStatus,
          el('div.field__hint', 'Players connect with your IP or hostname followed by this port. The default is 25565.'),
        ),
      ),

      el(
        'div.card.card--pad.stack--sm',
        { style: 'margin-top:1rem' },
        el('div.row', el('span.stat__icon', { html: icon('restart', { size: 15 }), style: '--stat-rgb:var(--violet-rgb)' }), el('div.grow', el('div.card__title', 'Automation'), el('div.card__sub', 'Hands-off behaviour for this server'))),
        el(
          'label.switch',
          el('input', { type: 'checkbox', checked: draft.autoRestart, onchange: (e) => { draft.autoRestart = e.target.checked; } }),
          el('span.switch__track'),
          el('div', el('span.switch__label', 'Restart automatically after a crash'), el('div.switch__desc', 'Uses exponential backoff and gives up after five rapid failures so a broken server cannot spin.')),
        ),
        el(
          'label.switch',
          el('input', { type: 'checkbox', checked: draft.autoStart, onchange: (e) => { draft.autoStart = e.target.checked; } }),
          el('span.switch__track'),
          el('div', el('span.switch__label', 'Start when the manager launches'), el('div.switch__desc', 'Convenient for an always-on machine.')),
        ),
        el(
          'label.switch',
          el('input', { type: 'checkbox', checked: draft.startAfterCreate, onchange: (e) => { draft.startAfterCreate = e.target.checked; } }),
          el('span.switch__track'),
          el('div', el('span.switch__label', 'Start it as soon as creation finishes'), el('div.switch__desc', 'The first boot generates the world — this can take a minute or two.')),
        ),
      ),
    );

    renderFoot();
  }

  // ---------------------------------------------------------------------
  // Step: world
  // ---------------------------------------------------------------------
  async function renderWorldStep() {
    const nameInput = el('input.input', {
      value: draft.name,
      maxlength: '60',
      oninput: (event) => { draft.name = event.target.value; },
    });

    const motdInput = el('input.input', {
      value: draft.motd || `${draft.name} — hosted locally`,
      maxlength: '120',
      oninput: (event) => {
        draft.motd = event.target.value;
        motdPreview.replaceChildren(document.createTextNode(stripMinecraftCodes(draft.motd)));
      },
    });
    const motdPreview = el('span.mono.small', { style: 'color:var(--text-soft)' }, stripMinecraftCodes(draft.motd || `${draft.name} — hosted locally`));

    const segments = (key, options) =>
      el(
        'div.segmented.segmented--block',
        ...options.map(([value, label]) =>
          el(
            'button.segmented__opt',
            {
              type: 'button',
              class: draft[key] === value ? 'segmented__opt--active' : '',
              onclick: (event) => {
                draft[key] = value;
                for (const sibling of event.target.parentElement.children) sibling.classList.remove('segmented__opt--active');
                event.target.classList.add('segmented__opt--active');
                if (key === 'onlineMode') paintOnlineWarning();
              },
            },
            label,
          ),
        ),
      );

    const onlineWarning = el('div');

    function paintOnlineWarning() {
      mount(
        onlineWarning,
        draft.onlineMode
          ? el('div.field__hint', 'Players are verified against Mojang. Skin and chat signatures all work correctly.')
          : el(
              'div.callout.callout--warn',
              { style: 'margin-top:0.4rem' },
              el('span.callout__icon', { html: icon('alert', { size: 16 }) }),
              el('div', el('div.callout__title', 'Offline mode has no authentication'), el('div', 'Anyone who can reach the port can join as any username, including yours. Use it only on a LAN or behind a proxy. The manager automatically disables enforced secure profiles to match.')),
            ),
      );
    }
    paintOnlineWarning();

    const numField = (key, { min, max, label, hint }) =>
      el(
        'div.field',
        el('label.field__label', label),
        el('input.input', {
          type: 'number',
          min: String(min),
          max: String(max),
          value: String(draft[key]),
          oninput: (event) => {
            const next = Number(event.target.value);
            draft[key] = Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : draft[key];
          },
        }),
        hint ? el('div.field__hint', hint) : null,
      );

    mount(
      panel,
      el('h2', { style: 'margin-bottom:0.3rem' }, 'World & gameplay'),
      el('p.muted.small', { style: 'margin-bottom:1.1rem' }, 'These write straight into server.properties. Nothing here is permanent — the Properties tab edits the same file later.'),

      el(
        'div.card.card--pad.stack--md',
        el('div.row', el('span.stat__icon', { html: icon('globe', { size: 15 }) }), el('div.grow', el('div.card__title', 'Identity'), el('div.card__sub', 'How the server appears to players'))),
        el('div.field', el('label.field__label', 'Server name'), nameInput),
        el(
          'div.field',
          el('label.field__label', 'Message of the day'),
          motdInput,
          el('div.row', { style: 'gap:0.5rem' }, el('span.dim.tiny', 'Preview:'), motdPreview),
          el('div.field__hint', 'Shown in the multiplayer server list. §-colour codes are supported, e.g. §a§lSMP.'),
        ),
      ),

      el(
        'div.card.card--pad.stack--md',
        { style: 'margin-top:1rem' },
        el('div.row', el('span.stat__icon', { html: icon('blocks', { size: 15 }), style: '--stat-rgb:var(--violet-rgb)' }), el('div.grow', el('div.card__title', 'Gameplay'), el('div.card__sub', 'Defaults applied to every player'))),
        el(
          'div.grid.grid--2',
          el('div.field', el('label.field__label', 'Game mode'), segments('gamemode', [['survival', 'Survival'], ['creative', 'Creative'], ['adventure', 'Adventure'], ['spectator', 'Spectator']])),
          el('div.field', el('label.field__label', 'Difficulty'), segments('difficulty', [['peaceful', 'Peaceful'], ['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']])),
        ),
        el(
          'div.grid.grid--2',
          numField('maxPlayers', { min: 1, max: 500, label: 'Max players', hint: 'A soft cap — the server accepts more if it can keep up.' }),
          el(
            'div.field',
            el('label.field__label', 'World type'),
            el(
              'select.select',
              { onchange: (event) => { draft.levelType = event.target.value; } },
              ...[
                ['minecraft:normal', 'Normal'],
                ['minecraft:flat', 'Superflat'],
                ['minecraft:large_biomes', 'Large biomes'],
                ['minecraft:amplified', 'Amplified'],
                ['minecraft:single_biome_surface', 'Single biome'],
              ].map(([value, label]) => el('option', { value, selected: draft.levelType === value }, label)),
            ),
            el('div.field__hint', 'Only used the first time the world is generated.'),
          ),
        ),
        el(
          'div.grid.grid--2',
          numField('viewDistance', { min: 3, max: 32, label: 'View distance (chunks)', hint: 'The single biggest CPU lever. 8–10 is plenty for most groups.' }),
          numField('simulationDistance', { min: 3, max: 32, label: 'Simulation distance (chunks)', hint: 'How far mobs and redstone keep ticking. The biggest RAM lever.' }),
        ),
        el(
          'div.field',
          el('label.field__label', 'World seed'),
          el('input.input.input--mono', { placeholder: 'Leave empty for a random seed', maxlength: '64', oninput: (event) => { draft.seed = event.target.value; } }),
          el('div.field__hint', 'Only applies when the world is created for the first time.'),
        ),
      ),

      el(
        'div.card.card--pad.stack--sm',
        { style: 'margin-top:1rem' },
        el('div.row', el('span.stat__icon', { html: icon('shield', { size: 15 }), style: '--stat-rgb:var(--info-rgb)' }), el('div.grow', el('div.card__title', 'Access & rules'), el('div.card__sub', 'Who can join and how they behave'))),
        el(
          'div.field',
          el('label.field__label', 'Authentication'),
          segments('onlineMode', [[true, 'Online mode'], [false, 'Offline mode']]),
          onlineWarning,
        ),
        el(
          'label.switch',
          el('input', { type: 'checkbox', checked: draft.pvp, onchange: (e) => { draft.pvp = e.target.checked; } }),
          el('span.switch__track'),
          el('div', el('span.switch__label', 'Allow player versus player combat')),
        ),
        el(
          'label.switch',
          el('input', { type: 'checkbox', checked: draft.whiteList, onchange: (e) => { draft.whiteList = e.target.checked; } }),
          el('span.switch__track'),
          el('div', el('span.switch__label', 'Enable the whitelist'), el('div.switch__desc', 'Only players you add under the Players tab can join.')),
        ),
        el(
          'label.switch',
          el('input', { type: 'checkbox', checked: draft.hardcore, onchange: (e) => { draft.hardcore = e.target.checked; } }),
          el('span.switch__track'),
          el('div', el('span.switch__label', 'Hardcore mode'), el('div.switch__desc', 'Players are banned permanently when they die.')),
        ),
      ),
    );

    renderFoot();
  }

  // ---------------------------------------------------------------------
  // Step: review + provision
  // ---------------------------------------------------------------------
  async function renderReviewStep() {
    const progressHost = el('div.provision');
    const warningsHost = el('div.stack--xs');
    const summaryHost = el('div.review');
    const actionsHost = el('div');

    mount(
      panel,
      el('h2', { style: 'margin-bottom:0.3rem' }, 'Ready to build'),
      el('p.muted.small', { style: 'margin-bottom:1.1rem' }, 'Review the plan below. Nothing is written to disk until you press Create.'),

      el(
        'div.card.card--pad',
        el('div.card__title', { style: 'margin-bottom:0.7rem' }, 'Plan'),
        summaryHost,
      ),
      el('div', { style: 'margin-top:1rem' }, warningsHost),
      el('div', { style: 'margin-top:1rem' }, progressHost),
      actionsHost,
    );

    // -- Summary ---------------------------------------------------------
    const heap = draft.maxHeapMb;
    const platform = platformMeta(draft.platform);
    mount(
      summaryHost,
      reviewRow('Name', draft.name || '(unnamed)'),
      reviewRow('Platform', `${platform.label} ${draft.version}${draft.build && draft.build !== 'latest' ? ` build ${draft.build}` : ''}`),
      reviewRow('Java', draft.autoDownloadJava ? `Java ${versionsCache?.versions?.find((v) => v.id === draft.version)?.java ?? 21} — downloaded automatically` : draft.javaPath ?? 'auto-detected'),
      reviewRow('Memory', `${mibFromMb(heap)} heap · ${draft.gcProfile === 'aikar' ? 'Aikar G1 flags' : draft.gcProfile === 'zgc' ? 'ZGC' : 'custom flags'}`),
      reviewRow('Port', `${draft.port}`),
      reviewRow('World', `${draft.gamemode} · ${draft.difficulty}${draft.hardcore ? ' · hardcore' : ''} · ${draft.maxPlayers} players`),
      reviewRow('Rendering', `view ${draft.viewDistance} · simulation ${draft.simulationDistance}`),
      reviewRow('Authentication', draft.onlineMode ? 'Online (Mojang verified)' : 'Offline (no authentication)'),
      reviewRow('Whitelist', draft.whiteList ? 'Enabled' : 'Disabled'),
      reviewRow('Folder', `servers/${draft.name ? draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'server'}`),
    );

    // -- Warnings / preflight -------------------------------------------
    let plan = null;
    try {
      plan = await api.preflight({
        platform: draft.platform,
        version: draft.version,
        port: draft.port,
        memory: { maxHeapMb: draft.maxHeapMb },
        name: draft.name,
      });
      preflight = plan;

      const warnings = [...(plan.warnings ?? [])];
      if (!draft.onlineMode) {
        warnings.push({ level: 'warn', title: 'Offline mode selected', detail: 'Anyone who can reach the port may join as any username.' });
      }
      if (draft.maxHeapMb > (plan.plan.heapCeilingMb ?? Infinity) * 0.9) {
        warnings.push({ level: 'warn', title: 'Heap is close to the limit', detail: `This machine can comfortably spare around ${mibFromMb(plan.plan.heapCeilingMb, 0)}.` });
      }

      mount(
        warningsHost,
        ...(warnings.length
          ? warnings.map((warning) =>
              el(
                `div.callout${warning.level === 'error' ? '.callout--error' : warning.level === 'warn' ? '.callout--warn' : ''}`,
                el('span.callout__icon', { html: icon(warning.level === 'error' ? 'alertCircle' : 'info', { size: 16 }) }),
                el('div', el('div.callout__title', warning.title), el('div', warning.detail)),
              ),
            )
          : [el('div.callout.callout--ok', el('span.callout__icon', { html: icon('checkCircle', { size: 16 }) }), el('div', el('div.callout__title', 'All checks passed'), el('div', 'Every prerequisite is satisfied — creation should run without interruption.')))])
      );

      if (plan.plan?.size) {
        summaryHost.appendChild(reviewRow('Download', `${bytes(plan.plan.size)} from ${new URL(plan.plan.url ?? 'https://x').host}`));
      }
    } catch (error) {
      mount(warningsHost, el('div.callout.callout--error', el('span.callout__icon', { html: icon('alertCircle', { size: 16 }) }), el('div', el('div.callout__title', 'Could not verify the plan'), el('div', error.message))));
    }

    renderFoot({
      nextLabel: 'Create server',
      nextEnabled: true,
      nextHandler: () => runProvision({ progressHost, actionsHost, warningsHost }),
    });
  }

  const reviewRow = (key, value) =>
    el('div.review__row', el('span.review__k', key), el('span.review__v', value ?? '—'));

  // ---------------------------------------------------------------------
  // Provisioning
  // ---------------------------------------------------------------------
  async function runProvision({ progressHost, actionsHost, warningsHost }) {
    mount(foot, el('span.spacer'), el('span.muted.small', 'Provisioning — this can take a few minutes…'));

    const steps = [
      ['resolve', 'Resolving version metadata'],
      ['download', 'Downloading the server jar'],
      ['java', 'Locating a matching Java runtime'],
      ['eula', 'Accepting the Minecraft EULA'],
      ['properties', 'Writing optimised server.properties'],
      ['memory', 'Sizing the JVM heap'],
      ['scripts', 'Generating startup scripts'],
      ['config', 'Preparing whitelist and ops files'],
      ['register', 'Registering the server'],
    ];
    const stepNodes = new Map();

    mount(
      progressHost,
      el(
        'div.card.card--pad',
        el('div.row', { style: 'margin-bottom:0.8rem' }, el('span.stat__icon', { html: icon('rocket', { size: 15 }) }), el('div.grow', el('div.card__title', 'Building your server'), el('div.card__sub', 'Progress streams live from the manager'))),
        el('div.progress.progress--lg', { style: 'margin-bottom:1rem' }, el('span.progress__fill', { style: 'width:0%', id: 'prov-bar' })),
        el(
          'div.provision',
          ...steps.map(([id, label]) => {
            const node = el('div.pstep', { 'data-step': id }, el('span.pstep__mark', ''), el('span.grow', label), el('span.pstep__detail', ''));
            stepNodes.set(id, node);
            return node;
          }),
        ),
      ),
    );

    const bar = progressHost.querySelector('#prov-bar');
    let currentStep = null;

    const off = ws.on('job', (message) => {
      if (!message.jobId || message.jobId !== provisionJobId) return;
      if (message.step && stepNodes.has(message.step)) {
        const node = stepNodes.get(message.step);
        const detail = node.querySelector('.pstep__detail');
        if (message.percentOverride !== undefined && message.step === 'download') {
          detail.textContent = `${percent(message.percentOverride, 0)}${message.detail ? ` · ${message.detail}` : ''}`;
          bar.style.width = `${Math.min(99, message.percentOverride)}%`;
        } else if (message.detail) {
          detail.textContent = message.detail;
        }
        if (currentStep !== message.step) {
          if (currentStep && stepNodes.has(currentStep)) {
            stepNodes.get(currentStep).classList.remove('pstep--active');
            stepNodes.get(currentStep).classList.add('pstep--done');
            stepNodes.get(currentStep).querySelector('.pstep__mark').innerHTML = '';
            stepNodes.get(currentStep).querySelector('.pstep__mark').appendChild(el('span', { html: icon('check', { size: 11 }) }));
          }
          currentStep = message.step;
          node.classList.add('pstep--active');
          node.querySelector('.pstep__mark').replaceChildren(el('span.spinner', { style: 'width:11px;height:11px;border-width:2px' }));
        }
      }
      if (message.totalSteps) {
        const done = message.stepIndex ?? 0;
        bar.style.width = `${Math.min(99, (done / message.totalSteps) * 100)}%`;
      }
      if (message.status === 'failed') {
        if (currentStep && stepNodes.has(currentStep)) {
          stepNodes.get(currentStep).classList.replace('pstep--active', 'pstep--failed');
          stepNodes.get(currentStep).querySelector('.pstep__mark').replaceChildren(el('span', { html: icon('x', { size: 11 }) }));
        }
      }
    });

    provisionJobId = uuid();

    try {
      const result = await api.createServer(
        {
          name: draft.name.trim(),
          platform: draft.platform,
          version: draft.version,
          build: draft.build && draft.build !== 'latest' ? draft.build : undefined,
          jarFile: 'server.jar',
          motd: draft.motd || `${draft.name} — hosted locally`,
          port: draft.port,
          maxPlayers: draft.maxPlayers,
          viewDistance: draft.viewDistance,
          simulationDistance: draft.simulationDistance,
          difficulty: draft.difficulty,
          gamemode: draft.gamemode,
          levelType: draft.levelType,
          seed: draft.seed,
          onlineMode: draft.onlineMode,
          whiteList: draft.whiteList,
          hardcore: draft.hardcore,
          pvp: draft.pvp,
          autoRestart: draft.autoRestart,
          autoStart: draft.autoStart,
          startAfterCreate: draft.startAfterCreate,
          autoDownloadJava: draft.autoDownloadJava,
          memory: { maxHeapMb: draft.maxHeapMb, gcProfile: draft.gcProfile, minHeapMb: draft.maxHeapMb, preTouch: true },
          notes: '',
        },
        { jobId: provisionJobId },
      );

      off();

      for (const node of stepNodes.values()) {
        node.classList.remove('pstep--active');
        node.classList.add('pstep--done');
        node.querySelector('.pstep__mark').replaceChildren(el('span', { html: icon('check', { size: 11 }) }));
      }
      bar.style.width = '100%';
      createdServerId = result.server.id;

      // Refresh the store so the new server is in the sidebar immediately.
      try {
        const list = await api.listServers();
        setServers(list.servers);
      } catch {
        /* the WebSocket will deliver it */
      }

      mount(
        actionsHost,
        el(
          'div.callout.callout--ok',
          { style: 'margin-top:1rem' },
          el('span.callout__icon', { html: icon('checkCircle', { size: 17 }) }),
          el(
            'div',
            el('div.callout__title', `${result.server.name} is ready`),
            el('div', `${result.server.platform} ${result.server.version} on Java ${result.java.major}, ${mibFromMb(result.server.memory.maxHeapMb)} heap.${draft.startAfterCreate ? ' It is booting now — the first start generates the world.' : ''}`),
            el(
              'div.row',
              { style: 'margin-top:0.7rem;gap:0.5rem' },
              el('a.btn.btn--primary.btn--sm', { href: `#/servers/${result.server.id}` }, el('span', { html: icon('terminal', { size: 14 }) }), 'Open console'),
              el('a.btn.btn--sm', { href: '#/dashboard' }, 'Back to dashboard'),
            ),
          ),
        ),
      );

      mount(foot, el('span.spacer'), el('a.btn.btn--primary', { href: `#/servers/${result.server.id}` }, el('span', { html: icon('terminal', { size: 14 }) }), 'Open console'));

      toast.success(
        `${result.server.name} created`,
        draft.startAfterCreate ? 'The server is starting — the console will stream as soon as it boots.' : 'Start it whenever you are ready.',
      );
    } catch (error) {
      off();
      toast.fromError(error, 'Server creation failed');
      mount(
        warningsHost,
        el(
          'div.callout.callout--error',
          { style: 'margin-top:1rem' },
          el('span.callout__icon', { html: icon('alertCircle', { size: 17 }) }),
          el(
            'div',
            el('div.callout__title', 'Creation did not finish'),
            el('div', error.message),
            error.hint ? el('div', { style: 'margin-top:0.3rem;color:var(--text-muted)' }, error.hint) : null,
            el(
              'div.row',
              { style: 'margin-top:0.7rem;gap:0.5rem' },
              el(
                'button.btn.btn--sm',
                {
                  type: 'button',
                  onclick: () => {
                    // Retry in place; the slug is derived from the name so a
                    // partially created folder gets a numeric suffix.
                    renderReviewStep();
                  },
                },
                'Try again',
              ),
              el('a.btn.btn--sm.btn--ghost', { href: '#/settings' }, 'Open settings'),
            ),
          ),
        ),
      );
      renderFoot({ nextLabel: 'Retry', nextHandler: () => renderReviewStep() });
    }
  }

  // ---------------------------------------------------------------------
  // Panel dispatch
  // ---------------------------------------------------------------------
  async function renderPanel() {
    switch (STEPS[stepIndex].id) {
      case 'platform': return renderPlatformStep();
      case 'version': return renderVersionStep();
      case 'resources': return renderResourcesStep();
      case 'world': return renderWorldStep();
      case 'review': return renderReviewStep();
      default: return undefined;
    }
  }

  renderSteps();
  await renderPanel();

  return {
    el: page,
    title: 'Create server',
    crumbs: [{ label: 'Servers', href: '#/servers' }, { label: 'Create' }],
    onEnter() {
      // Refresh the Java list once the view is on screen — it may have changed
      // since the page was loaded (a JDK could have been installed).
      api.java().then((result) => {
        javaInfo = result;
        if (platforms) platforms.java = result;
      }).catch(() => {});
    },
  };
}

export default renderCreate;
