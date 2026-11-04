/**
 * Live console terminal.
 *
 * Performance contract: a busy Paper server can emit a few hundred lines per
 * second. This component therefore:
 *
 *   - appends through a DocumentFragment in one layout pass per frame batch,
 *   - caps the DOM at `maxNodes` and evicts from the top (the full scrollback
 *     stays available via the REST endpoint and the disk log),
 *   - only auto-scrolls when the user is pinned to the bottom,
 *   - never uses innerHTML for server output, so a plugin echoing
 *     `<img onerror=...>` cannot execute anything.
 */

import { el, frag, mount, on, isNearBottom, scrollToBottom, focusSoft, debounce, copyText } from './dom.js';
import { icon } from './icons.js';
import { clockTime, escapeRegExp } from './format.js';
import { toast, confirmDialog } from './ui.js';
import ws from './ws.js';
import api from './api.js';
import { getSettings } from './settings-cache.js';

const MAX_DOM_NODES = 2500;

/** Compact gutter labels — the full words do not fit in 4 columns. */
const LEVEL_LABELS = {
  trace: 'TRC',
  debug: 'DBG',
  warn: 'WARN',
  error: 'ERR',
  fatal: 'FATAL',
};

/** Tab-completable commands, ordered by how often people reach for them. */
const COMMANDS = [
  ['say', '<message>', 'Broadcast a message'],
  ['op', '<player>', 'Grant operator status'],
  ['deop', '<player>', 'Revoke operator status'],
  ['whitelist add', '<player>', 'Allow a player to join'],
  ['whitelist remove', '<player>', 'Revoke a player'],
  ['whitelist list', '', 'Show the whitelist'],
  ['whitelist on', '', 'Enable the whitelist'],
  ['whitelist off', '', 'Disable the whitelist'],
  ['ban', '<player> [reason]', 'Ban a player'],
  ['pardon', '<player>', 'Unban a player'],
  ['ban-ip', '<ip>', 'Ban an IP address'],
  ['kick', '<player> [reason]', 'Disconnect a player'],
  ['gamemode', '<mode> [player]', 'Change game mode'],
  ['time set', 'day|night|<ticks>', 'Set the world time'],
  ['weather', 'clear|rain|thunder', 'Set the weather'],
  ['difficulty', 'peaceful|easy|normal|hard', 'Set difficulty'],
  ['gamerule', '<rule> <value>', 'Change a gamerule'],
  ['save-all', 'flush', 'Force a world save'],
  ['save-off', '', 'Pause chunk autosave'],
  ['save-on', '', 'Resume chunk autosave'],
  ['stop', '', 'Shut the server down'],
  ['list', '', 'List online players'],
  ['tps', '', 'Paper: server tick rate'],
  ['mspt', '', 'Paper: milliseconds per tick'],
  ['reload', 'confirm', 'Reload datapacks and plugins'],
  ['seed', '', 'Show the world seed'],
  ['tp', '<target> <destination>', 'Teleport'],
  ['give', '<player> <item> [count]', 'Give an item'],
  ['effect give', '<player> <effect> [seconds]', 'Apply a status effect'],
  ['advancement grant', '<player> everything', 'Grant all advancements'],
];

/**
 * @param {{ serverId: string, getServer: () => object|null }} options
 */
export function createConsole({ serverId, getServer }) {
  const settings = getSettings();

  // -- DOM ------------------------------------------------------------------
  const out = el('div.console__out', {
    role: 'log',
    'aria-live': 'polite',
    'aria-relevant': 'additions',
  });

  const searchInput = el('input.input.input--sm', {
    type: 'search',
    placeholder: 'Filter…',
    style: 'width:150px',
    oninput: debounce((event) => applyFilter(event.target.value), 180),
  });

  const statusPill = el('span.console__title');
  const pauseBtn = el(
    'button.iconbtn.iconbtn--xs',
    { type: 'button', 'data-tip': 'Pause display', onclick: () => togglePause() },
    el('span', { html: icon('clock', { size: 13 }) }),
  );
  const wrapBtn = el(
    'button.iconbtn.iconbtn--xs',
    { type: 'button', 'data-tip': 'Toggle word wrap', onclick: () => toggleWrap() },
    el('span', { html: icon('list', { size: 13 }) }),
  );
  const copyBtn = el(
    'button.iconbtn.iconbtn--xs',
    { type: 'button', 'data-tip': 'Copy visible lines', onclick: () => copyVisible() },
    el('span', { html: icon('copy', { size: 13 }) }),
  );
  const exportBtn = el(
    'button.iconbtn.iconbtn--xs',
    { type: 'button', 'data-tip': 'Download the full log', onclick: () => window.open(api.consoleExportUrl(serverId), '_blank') },
    el('span', { html: icon('download', { size: 13 }) }),
  );
  const clearBtn = el(
    'button.iconbtn.iconbtn--xs',
    { type: 'button', 'data-tip': 'Clear the display', onclick: () => clearView() },
    el('span', { html: icon('trash', { size: 13 }) }),
  );

  const bar = el(
    'div.console__bar',
    el('div.console__dots', el('i'), el('i'), el('i')),
    statusPill,
    searchInput,
    pauseBtn,
    wrapBtn,
    copyBtn,
    exportBtn,
    clearBtn,
  );

  const autocomplete = el('div.console__autocomplete', { hidden: true });

  const prompt = el('span.console__prompt', '>');
  const field = el('input.console__field', {
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Type a command and press Enter — try "list" or "say hello"',
    onkeydown: (event) => onFieldKey(event),
    oninput: () => updateAutocomplete(),
    onblur: () => setTimeout(() => hideAutocomplete(), 160),
  });

  // History navigation with the arrow keys, like a real shell.
  let historyIndex = -1;
  let draft = '';

  const jumpBtn = el(
    'button.console__jump',
    { type: 'button', hidden: true, onclick: () => { scrollToBottom(out); jumpBtn.hidden = true; autoScroll = true; } },
    el('span', { html: icon('arrowDown', { size: 13 }) }),
    'Jump to latest',
  );

  const wrap = el('div.console__wrap', field, autocomplete);
  const inputRow = el('div.console__input', prompt, wrap);
  const root = el('div.console', { class: settings.consoleWordWrap !== false ? 'console--wrap' : '' }, bar, out, inputRow);
  root.style.position = 'relative';
  root.appendChild(jumpBtn);
  out.style.fontSize = `${settings.consoleFontSize ?? 13}px`;

  // -- State ----------------------------------------------------------------
  let autoScroll = settings.consoleAutoScroll !== false;
  let paused = false;
  let filter = '';
  let nodeCount = 0;
  /**
   * Highest sequence number already reflected on screen.
   *
   * Duplicate suppression happens at *render* time, not on receipt. Filtering
   * when frames arrive looks equivalent but is not: rendering is deferred by up
   * to 60 ms, so the initial REST replay can render a line that a queued
   * WebSocket batch is still holding — producing exactly the doubled boot lines
   * this used to show.
   */
  let renderedSeq = 0;
  const pendingQueue = [];
  let flushScheduled = false;
  const history = [];
  let acIndex = -1;
  let acMatches = [];

  mount(out, el('div.cline.cline--debug', 'Waiting for console output…'));

  // -- Rendering ------------------------------------------------------------

  function recordToNode(record) {
    const classes = ['cline', `cline--${record.level ?? 'info'}`];
    if (record.kind === 'chat') classes.push('cline--chat');
    if (record.stream === 'stdin') classes.push('cline--stdin');
    if (record.kind === 'stack') classes.push('cline--stack');
    if (record.kind === 'event') classes.push('cline--event');

    const node = el('span', { class: classes.join(' '), 'data-seq': String(record.seq ?? '') });

    if (settings.consoleTimestamps !== false) {
      node.appendChild(el('span.cline__ts', clockTime(record.ts)));
    }
    // Only emit a level gutter for levels that actually carry information.
    // `info` is the default and `success` is a synthetic level we assign to
    // milestones — printing "SUCC" there looked like a bug.
    if (record.level && record.level !== 'info' && record.level !== 'success') {
      node.appendChild(el('span.cline__level', LEVEL_LABELS[record.level] ?? record.level.toUpperCase().slice(0, 4)));
    }
    if (record.thread && record.kind === 'log') {
      node.appendChild(el('span.cline__thread', `[${record.thread}] `));
    }
    if (record.kind === 'event' && record.event) {
      node.appendChild(el('span.cline__mark', markerFor(record.event)));
    }

    // Text always goes through textContent — never innerHTML.
    node.appendChild(document.createTextNode(record.text ?? record.message ?? ''));
    return node;
  }

  function markerFor(event) {
    const map = {
      ready: 'READY', join: 'JOIN', leave: 'LEAVE', login: 'AUTH', kicked: 'KICK',
      advancement: 'ADV', death: 'DEATH', 'eula-required': 'EULA', 'port-conflict': 'PORT',
      'out-of-memory': 'OOM', 'java-mismatch': 'JAVA', stopping: 'STOP', mods: 'MODS', level: 'WORLD',
    };
    return map[event.type] ?? 'EVENT';
  }

  /**
   * Coalesce incoming lines into ~10 batches/second.
   *
   * A timer rather than `requestAnimationFrame`: rAF is suspended entirely in a
   * background tab or a hidden window, so lines would silently stop appearing
   * until the user came back.
   */
  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(flush, 60);
  }

  function flush() {
    flushScheduled = false;

    if (paused || !pendingQueue.length) {
      pendingQueue.length = 0;
      return;
    }

    const wasAtBottom = isNearBottom(out);
    const batch = pendingQueue.splice(0, pendingQueue.length);

    // First real output replaces the placeholder.
    const placeholder = out.querySelector('.cline--debug');
    if (placeholder && out.childElementCount === 1) placeholder.remove();

    const fragment = frag();
    for (const record of batch) {
      const seq = Number(record.seq) || 0;
      // Already on screen (or cleared) — skip rather than draw it twice.
      if (seq && seq <= renderedSeq) continue;
      const node = recordToNode(record);
      if (filter && !(record.text ?? '').toLowerCase().includes(filter)) node.hidden = true;
      fragment.appendChild(node);
      nodeCount += 1;
      if (seq > renderedSeq) renderedSeq = seq;
    }
    out.appendChild(fragment);

    // Evict from the top once we exceed the DOM budget.
    while (nodeCount > MAX_DOM_NODES && out.firstChild) {
      out.removeChild(out.firstChild);
      nodeCount -= 1;
    }

    if (autoScroll && wasAtBottom) scrollToBottom(out);
    else if (autoScroll) scrollToBottom(out);
    else jumpBtn.hidden = isNearBottom(out);
  }

  function appendRecords(records) {
    if (!records?.length) return;
    pendingQueue.push(...records);
    scheduleFlush();
  }

  function applyFilter(term) {
    filter = String(term ?? '').trim().toLowerCase();
    for (const node of out.children) {
      if (node.hidden !== undefined) node.hidden = filter ? !node.textContent.toLowerCase().includes(filter) : false;
    }
    if (filter) {
      // Highlight matches in the visible set.
      for (const node of out.children) {
        if (node.dataset.highlighted === filter) continue;
        const raw = node.dataset.rawText ?? node.textContent;
        node.dataset.rawText = raw;
        node.replaceChildren();
        const index = raw.toLowerCase().indexOf(filter);
        if (index === -1) {
          node.appendChild(document.createTextNode(raw));
        } else {
          const regex = new RegExp(escapeRegExp(filter), 'gi');
          let cursor = 0;
          for (const match of raw.matchAll(regex)) {
            node.appendChild(document.createTextNode(raw.slice(cursor, match.index)));
            node.appendChild(el('mark', match[0]));
            cursor = match.index + match[0].length;
          }
          node.appendChild(document.createTextNode(raw.slice(cursor)));
        }
        node.dataset.highlighted = filter;
      }
    } else {
      // Filter cleared — the raw text is cached so nothing is lost.
      for (const node of out.children) {
        if (node.dataset.rawText) {
          node.textContent = node.dataset.rawText;
          delete node.dataset.rawText;
          delete node.dataset.highlighted;
        }
      }
    }
  }

  // -- Controls -------------------------------------------------------------

  function togglePause() {
    paused = !paused;
    pauseBtn.classList.toggle('iconbtn--on', paused);
    pauseBtn.setAttribute('data-tip', paused ? 'Resume display' : 'Pause display');
    if (!paused) {
      // Pull the backlog we skipped so nothing is lost.
      replaySince(renderedSeq, { replace: false });
      scheduleFlush();
    } else {
      toast.info('Console paused', 'Output is still being recorded — it will appear when you resume.', { duration: 3000 });
    }
    renderStatus();
  }

  function toggleWrap() {
    root.classList.toggle('console--wrap');
    wrapBtn.classList.toggle('iconbtn--on', root.classList.contains('console--wrap'));
  }

  function clearView() {
    // Everything already drawn (or queued) stays hidden; only genuinely new
    // lines appear afterwards. The full log is still on disk.
    pendingQueue.length = 0;
    mount(out, el('div.cline.cline--debug', 'Display cleared. New output will appear below — the full log is still on disk.'));
    nodeCount = 0;
  }

  async function copyVisible() {
    const text = [...out.children]
      .filter((node) => !node.hidden)
      .map((node) => node.dataset.rawText ?? node.textContent)
      .join('\n');
    const ok = await copyText(text);
    toast[ok ? 'success' : 'error'](ok ? `Copied ${text.split('\n').length} lines` : 'Clipboard is unavailable');
  }

  // -- Command input --------------------------------------------------------

  function hideAutocomplete() {
    autocomplete.hidden = true;
    acMatches = [];
    acIndex = -1;
  }

  function updateAutocomplete() {
    const value = field.value;
    if (!value || value.startsWith('/')) {
      hideAutocomplete();
      return;
    }
    const needle = value.toLowerCase();
    acMatches = COMMANDS.filter(([name]) => name.startsWith(needle) && name !== needle).slice(0, 8);
    if (!acMatches.length) {
      hideAutocomplete();
      return;
    }
    acIndex = -1;
    mount(
      autocomplete,
      ...acMatches.map(([name, args, desc], index) =>
        el(
          'div.acitem',
          {
            class: index === acIndex ? 'acitem--active' : '',
            onmousedown: (event) => {
              event.preventDefault();
              acceptCompletion(index);
            },
          },
          el('span.acitem__name', name),
          args ? el('span.dim', ` ${args}`) : null,
          el('span.acitem__desc', desc),
        ),
      ),
    );
    autocomplete.hidden = false;
  }

  function acceptCompletion(index = acIndex) {
    if (index < 0 || !acMatches[index]) return;
    field.value = acMatches[index][0];
    hideAutocomplete();
    focusSoft(field);
  }

  function moveAutocomplete(delta) {
    if (autocomplete.hidden) return false;
    acIndex = (acIndex + delta + acMatches.length) % acMatches.length;
    [...autocomplete.children].forEach((node, i) => node.classList.toggle('acitem--active', i === acIndex));
    return true;
  }

  function onFieldKey(event) {
    if (!autocomplete.hidden) {
      if (event.key === 'ArrowDown' && moveAutocomplete(1)) return event.preventDefault();
      if (event.key === 'ArrowUp' && moveAutocomplete(-1)) return event.preventDefault();
      if (event.key === 'Tab') return event.preventDefault(), acceptCompletion();
      if (event.key === 'Escape') {
        hideAutocomplete();
        return event.preventDefault();
      }
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const command = field.value.trim();
      if (!command) return;
      sendCommand(command);
      field.value = '';
      hideAutocomplete();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!history.length) return;
      if (historyIndex === -1) draft = field.value;
      historyIndex = Math.min(history.length - 1, historyIndex + 1);
      field.value = history[history.length - 1 - historyIndex] ?? '';
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex <= 0) {
        historyIndex = -1;
        field.value = draft;
        return;
      }
      historyIndex -= 1;
      field.value = history[history.length - 1 - historyIndex] ?? '';
      return;
    }

    if (event.key === 'Tab') {
      // Fill in the only matching command, or a player name after a keyword.
      event.preventDefault();
      const value = field.value;
      const parts = value.split(' ');
      if (parts.length === 1) {
        const matches = COMMANDS.filter(([name]) => name.startsWith(value.toLowerCase()));
        if (matches.length === 1) field.value = matches[0][0];
        return;
      }
      const players = (getServer()?.onlinePlayers ?? []).map((p) => p.name);
      const partial = parts[parts.length - 1].toLowerCase();
      const hit = players.find((name) => name.toLowerCase().startsWith(partial));
      if (hit) {
        parts[parts.length - 1] = hit;
        field.value = parts.join(' ');
      }
      return;
    }

    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault();
      clearView();
    }
  }

  function sendCommand(command) {
    if (!ws.connected) {
      toast.error('Not connected', 'The dashboard is reconnecting — try again in a moment.');
      return;
    }
    history.push(command);
    if (history.length > 200) history.shift();
    historyIndex = -1;
    const ok = ws.command(serverId, command);
    if (!ok) toast.warning('Command queued', 'It will be sent as soon as the connection is restored.');
  }

  // -- Status line ----------------------------------------------------------

  function renderStatus() {
    const server = getServer();
    const status = server?.status ?? 'stopped';
    const live = ['running', 'starting', 'stopping'].includes(status);
    const pieces = [];
    if (paused) pieces.push(el('span.warning', 'PAUSED'));
    pieces.push(el('b', status));
    if (server?.onlineCount) pieces.push(`${server.onlineCount} online`);
    pieces.push(`${nodeCount} lines`);
    mount(statusPill, ...interleave(pieces, el('span.dim', ' · ')));
  }

  const interleave = (items, separator) => {
    const out2 = [];
    items.forEach((item, index) => {
      if (index) out2.push(separator.cloneNode(true));
      out2.push(typeof item === 'string' ? document.createTextNode(item) : item);
    });
    return out2;
  };

  // -- Feed -----------------------------------------------------------------

  const unsubscribeConsole = ws.on('console', (message) => {
    if (message.serverId !== serverId) return;
    // No filtering here — `flush()` owns duplicate suppression. Queueing
    // everything means a line can never be dropped by an ordering race.
    if (message.records?.length) appendRecords(message.records);
    renderStatus();
  });

  const unsubscribeStatus = ws.on('status', (message) => {
    if (message.serverId !== serverId) return;
    syncInputState();
    renderStatus();
  });

  /**
   * Seed the scrollback over REST rather than relying on the `subscribed`
   * frame. The view owns the WebSocket subscription (so status and metrics work
   * on every tab), which means the `subscribed` reply usually arrives before
   * this component exists — a REST fetch is the only reliable way to get the
   * tail no matter when the tab is opened.
   */
  async function replaySince(sinceSeq, { replace = false } = {}) {
    try {
      const result = await api.getConsole(serverId, { limit: 500 });
      const records = sinceSeq > 0 ? result.records.filter((r) => r.seq > sinceSeq) : result.records;
      const highest = Math.max(result.lastSeq ?? 0, records.at(-1)?.seq ?? 0);

      if (replace) {
        if (records.length) {
          mount(out, ...records.map(recordToNode));
          nodeCount = records.length;
          scrollToBottom(out);
        } else {
          mount(out, el('div.cline.cline--debug', 'No console output yet. Anything the server prints will appear here.'));
          nodeCount = 0;
        }
        // Mark the whole replayed tail as shown. Anything still sitting in the
        // pending queue with a lower sequence number is now a duplicate.
        renderedSeq = Math.max(renderedSeq, highest);
      } else {
        if (records.length) appendRecords(records);
        else renderedSeq = Math.max(renderedSeq, highest);
      }

      renderStatus();
    } catch (error) {
      if (replace) {
        mount(
          out,
          el('div.cline.cline--error', `Could not load the console: ${error.message}`),
        );
      }
    }
  }

  function syncInputState() {
    const server = getServer();
    const canType = ['running', 'starting'].includes(server?.status) && !server?.adopted;
    field.disabled = !canType;
    if (server?.adopted) {
      field.placeholder = 'Console input is unavailable for adopted servers — use Restart to take control';
    } else if (!canType) {
      field.placeholder = server?.status === 'stopped' ? 'Server is stopped — start it to send commands' : 'Server is stopping…';
    } else {
      field.placeholder = 'Type a command and press Enter — try "list" or "say hello"';
    }
  }

  on(out, 'scroll', () => {
    const atBottom = isNearBottom(out);
    if (atBottom) autoScroll = true;
    else if (autoScroll && out.scrollHeight - out.scrollTop - out.clientHeight > 200) autoScroll = false;
    jumpBtn.hidden = atBottom;
  });

  // Drag-and-drop a file onto the console to upload it into the server root.
  on(root, 'dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    root.style.outline = '2px dashed rgba(var(--accent-rgb), .6)';
    root.style.outlineOffset = '-6px';
  });
  on(root, 'dragleave', () => {
    root.style.outline = '';
  });
  on(root, 'drop', async (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    root.style.outline = '';
    const ok = await confirmDialog({
      title: `Upload ${files.length} file${files.length > 1 ? 's' : ''}?`,
      message: `${files.map((f) => f.name).join(', ')} will be written into the server directory.`,
      confirmLabel: 'Upload',
      tone: 'accent',
      icon: 'upload',
    });
    if (!ok) return;
    for (const file of files) {
      try {
        const result = await api.uploadFile(serverId, '', file);
        toast.success('Uploaded', `${result.file} (${result.formatted})`);
      } catch (error) {
        toast.fromError(error, `Could not upload ${file.name}`);
      }
    }
  });

  // -- Lifecycle ------------------------------------------------------------

  syncInputState();
  renderStatus();
  wrapBtn.classList.toggle('iconbtn--on', root.classList.contains('console--wrap'));

  // Pull the existing scrollback immediately; live frames append from here on.
  replaySince(0, { replace: true });

  return {
    el: root,
    focus: () => focusSoft(field),
    appendRecords,
    /** Called by the view when the server snapshot changes. */
    refresh: () => {
      syncInputState();
      renderStatus();
    },
    scrollToBottom: () => scrollToBottom(out),
    destroy() {
      unsubscribeConsole();
      unsubscribeStatus();
      pendingQueue.length = 0;
    },
  };
}

export default createConsole;
