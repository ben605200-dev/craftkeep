/**
 * Reusable presentational components shared across views.
 */

import { el, playerColor, copyText } from './dom.js';
import { icon } from './icons.js';
import {
  statusMeta,
  platformMeta,
  bytes,
  durationShort,
  mibFromMb,
  memoryPair,
  percent,
  clampPercent,
  count,
  parseMotd,
  relativeTime,
} from './format.js';
import api from './api.js';
import ws from './ws.js';
import { toast, confirmDialog } from './ui.js';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function statusBadge(status, { size = 'default', adopted = false } = {}) {
  const meta = statusMeta(status);
  const rgb =
    status === 'running' ? 'var(--success-rgb)'
    : status === 'starting' || status === 'stopping' ? 'var(--warning-rgb)'
    : status === 'crashed' || status === 'error' ? 'var(--danger-rgb)'
    : 'var(--neutral-rgb)';

  return el(
    `span.badge.badge--${meta.tone}${size === 'lg' ? '.badge--lg' : ''}`,
    { style: `--badge-rgb:${rgb}` },
    el('span.statusdot', {
      class: meta.dot ? 'statusdot--live' : '',
      style: `--pulse-rgb:${rgb};width:6px;height:6px`,
    }),
    meta.label,
    adopted ? el('span', { style: 'opacity:.65;margin-left:.2em' }, '· adopted') : null,
  );
}

export const statusDot = (status, { large = false, tooltip = null } = {}) => {
  const meta = statusMeta(status);
  return el('span', {
    class: `statusdot${meta.dot ? ' statusdot--live' : ''}${large ? ' statusdot--lg' : ''}`,
    style: `--pulse-rgb:${meta.rgb}`,
    ...(tooltip ? { 'data-tip': tooltip } : {}),
  });
};

export const platformChip = (platform, version = null, { build = null, loader = null } = {}) => {
  const meta = platformMeta(platform);
  return el(
    `span.chip.optcard--${meta.accent}`,
    { style: `color:rgb(${meta.rgb});border-color:rgba(${meta.rgb},.28);background:rgba(${meta.rgb},.1)` },
    el('span', { html: icon(meta.icon, { size: 12 }), style: 'display:flex' }),
    meta.label,
    version ? el('span', { style: 'opacity:.75' }, version) : null,
    build ? el('span', { style: 'opacity:.6' }, `#${build}`) : null,
    loader ? el('span', { style: 'opacity:.6' }, loader) : null,
  );
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Inline SVG sparkline. Accepts `[value]` or `[[ts, value]]`.
 * Uses a shared gradient definition injected once per document.
 */
export function sparkline(values, { height = 34, tone = 'accent', min = 0, max = null, fillId = 'sparkFill' } = {}) {
  ensureSparkGradient(fillId, tone);

  const points = (values ?? [])
    .map((v) => (Array.isArray(v) ? Number(v[1]) : Number(v)))
    .filter((n) => Number.isFinite(n));

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', `spark${tone === 'danger' ? ' spark--danger' : tone === 'warning' ? ' spark--warning' : ''}`);
  svg.setAttribute('viewBox', '0 0 100 34');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.height = `${height}px`;

  if (points.length < 2) {
    const placeholder = document.createElementNS(svgNS, 'line');
    placeholder.setAttribute('x1', '0');
    placeholder.setAttribute('y1', '17');
    placeholder.setAttribute('x2', '100');
    placeholder.setAttribute('y2', '17');
    placeholder.setAttribute('stroke', 'rgba(255,255,255,.09)');
    placeholder.setAttribute('stroke-width', '1.4');
    placeholder.setAttribute('stroke-dasharray', '2 3');
    svg.appendChild(placeholder);
    return svg;
  }

  const upper = max ?? Math.max(...points, 1);
  const lower = min;
  const span = Math.max(0.0001, upper - lower);
  const step = 100 / Math.max(1, points.length - 1);

  const coords = points.map((value, i) => {
    const clamped = Math.max(lower, Math.min(upper, value));
    const y = 33 - ((clamped - lower) / span) * 31;
    return [i * step, y];
  });

  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L100 34 L0 34 Z`;

  const area = document.createElementNS(svgNS, 'path');
  area.setAttribute('d', areaPath);
  area.setAttribute('class', 'spark__area');
  area.setAttribute('fill', `url(#${fillId})`);

  const line = document.createElementNS(svgNS, 'path');
  line.setAttribute('d', linePath);
  line.setAttribute('class', 'spark__line');

  svg.append(area, line);
  return svg;
}

let gradientSeq = 0;
function ensureSparkGradient(id, tone) {
  if (document.getElementById(id)) return;
  const svgNS = 'http://www.w3.org/2000/svg';
  const holder = document.createElementNS(svgNS, 'svg');
  holder.setAttribute('width', '0');
  holder.setAttribute('height', '0');
  holder.style.position = 'absolute';
  const defs = document.createElementNS(svgNS, 'defs');
  const gradient = document.createElementNS(svgNS, 'linearGradient');
  gradient.setAttribute('id', id);
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('x2', '0');
  gradient.setAttribute('y2', '1');
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warning)' : 'var(--accent)';
  for (const [offset, opacity] of [['0%', '0.85'], ['100%', '0']]) {
    const stop = document.createElementNS(svgNS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    stop.setAttribute('stop-opacity', opacity);
    gradient.appendChild(stop);
  }
  defs.appendChild(gradient);
  holder.appendChild(defs);
  document.body.appendChild(holder);
  gradientSeq += 1;
}

/**
 * Radial gauge for a 0–100 value.
 */
export function gauge(value, { size = 92, stroke = 8, label = '', unit = '%', tone = 'accent', decimals = 0 } = {}) {
  const pct = clampPercent(value);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;
  const svgNS = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('class', 'gauge__track');
  track.setAttribute('cx', size / 2);
  track.setAttribute('cy', size / 2);
  track.setAttribute('r', radius);
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke-width', stroke);

  const arc = document.createElementNS(svgNS, 'circle');
  arc.setAttribute('class', 'gauge__value');
  arc.setAttribute('cx', size / 2);
  arc.setAttribute('cy', size / 2);
  arc.setAttribute('r', radius);
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke-width', stroke);
  arc.setAttribute('stroke-dasharray', `${dash} ${circumference}`);
  if (tone === 'danger') arc.style.stroke = 'var(--danger)';
  else if (tone === 'warning') arc.style.stroke = 'var(--warning)';
  else if (tone === 'info') arc.style.stroke = 'var(--info)';

  svg.append(track, arc);

  return el(
    'div.gauge',
    { style: `width:${size}px;height:${size}px` },
    svg,
    el('div.gauge__label', el('span.gauge__num', `${pct.toFixed(decimals)}`), unit ? el('span.gauge__unit', `${unit}${label ? ` ${label}` : ''}`) : null),
  );
}

/** Labelled horizontal meter used in the server detail header. */
export function meter({ label, value, max, format = (v) => String(v), tone = null, hint = null }) {
  const pct = clampPercent(max > 0 ? (value / max) * 100 : value);
  const autoTone = tone ?? (pct > 90 ? 'danger' : pct > 75 ? 'warning' : null);
  return el(
    'div.meter',
    el('div.meter__head', el('span.meter__label', label), el('span.meter__value', format(value, max))),
    el('div.progress', { class: autoTone ? `progress--${autoTone}` : '' }, el('span.progress__fill', { style: `width:${pct}%` })),
    hint ? el('div.tiny.dim', hint) : null,
  );
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

export function statTile({ label, value, unit = '', icon: iconName = 'activity', tone = 'accent', foot = null, sub = null }) {
  const rgb = {
    accent: 'var(--accent-rgb)',
    success: 'var(--success-rgb)',
    info: 'var(--info-rgb)',
    violet: 'var(--violet-rgb)',
    warning: 'var(--warning-rgb)',
    danger: 'var(--danger-rgb)',
  }[tone] ?? 'var(--accent-rgb)';

  return el(
    'div.stat',
    { style: `--stat-rgb:${rgb}` },
    el(
      'div.stat__top',
      el('span.stat__icon', { html: icon(iconName, { size: 16 }) }),
      el('span.stat__label', label),
    ),
    el('div.stat__value', String(value), unit ? el('small', unit) : null),
    sub ? el('div.stat__foot', sub) : foot ? el('div.stat__foot', foot) : null,
  );
}

// ---------------------------------------------------------------------------
// Server card
// ---------------------------------------------------------------------------

/**
 * The "Memory" cell of a server card.
 *
 * While running: `2.3 / 2.0 GiB` in one consistent unit.
 * While stopped: just the allocation, never a dangling `— / 2 GiB`.
 */
function memoryCell(isLive, rssBytes, heapMb) {
  if (isLive) {
    const pair = memoryPair(rssBytes, heapMb);
    return el('dd', pair.used, el('small', `/ ${pair.total} ${pair.unit}`));
  }
  return heapMb
    ? el('dd', '—', el('small', mibFromMb(heapMb, 0)))
    : el('dd', '—');
}

export function serverCard(server, { onAction } = {}) {
  const meta = statusMeta(server.status);
  const platform = platformMeta(server.platform);
  const live = ['running', 'starting', 'stopping'].includes(server.status);
  const metrics = server.metrics ?? {};
  const heapMb = server.memory?.maxHeapMb ?? 0;
  const usedMb = Math.round((metrics.rssBytes ?? 0) / 1024 / 1024);

  const spark = el('div.scard__spark');
  // Sparkline is appended after mount so the live metric feed can refresh it.
  const sparkValues = (server.history ?? []).map((entry) => (Array.isArray(entry) ? entry[1] : entry));
  spark.appendChild(sparkline(sparkValues, { height: 30 }));

  const card = el(
    'article',
    {
      class: `scard scard--${server.status}`,
      role: 'button',
      tabindex: '0',
      'data-server-id': server.id,
      onclick: (event) => {
        if (event.target.closest('button, a')) return;
        location.hash = `#/servers/${server.id}`;
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          location.hash = `#/servers/${server.id}`;
        }
      },
    },
    el(
      'div.scard__head',
      el('span.scard__avatar', { html: icon(platform.icon, { size: 19 }) }),
      el(
        'div.scard__id',
        el('div.scard__name.truncate', { title: server.name }, server.name),
        el(
          'div.scard__meta',
          platformChip(server.platform, server.version, { build: server.build, loader: server.loader }),
          el('span.dim', `:${server.port}`),
        ),
      ),
      el('div.scard__badges', statusBadge(server.status, { adopted: server.adopted })),
    ),
    el(
      'dl.scard__stats',
      el('div.scard__stat', el('dt', 'Players'), el('dd', count(server.onlineCount ?? 0), el('small', `/ ${server.maxPlayers ?? '—'}`))),
      el('div.scard__stat', el('dt', 'CPU'), el('dd', live ? percent(metrics.cpuPercent ?? 0, 0) : '—')),
      el('div.scard__stat', el('dt', 'Memory'), memoryCell(live && usedMb, metrics.rssBytes, heapMb)),
    ),
    spark,
    el(
      'div.scard__foot',
      live
        ? el(
            'button.btn.btn--sm',
            { type: 'button', 'data-action': 'stop', onclick: (e) => onAction?.('stop', server, e) },
            el('span', { html: icon('stop', { size: 14 }) }),
            'Stop',
          )
        : el(
            'button.btn.btn--sm.btn--primary',
            { type: 'button', 'data-action': 'start', onclick: (e) => onAction?.('start', server, e) },
            el('span', { html: icon('play', { size: 14 }) }),
            'Start',
          ),
      el(
        'button.btn.btn--sm',
        { type: 'button', 'data-action': 'restart', disabled: !live, onclick: (e) => onAction?.('restart', server, e) },
        el('span', { html: icon('restart', { size: 14 }) }),
      ),
      el(
        'button.btn.btn--sm',
        {
          type: 'button',
          'data-action': 'console',
          'data-tip': 'Open console',
          onclick: () => {
            location.hash = `#/servers/${server.id}`;
          },
        },
        el('span', { html: icon('terminal', { size: 14 }) }),
      ),
      el('span.scard__uptime', { 'data-uptime': server.id }, live ? durationShort(server.uptimeMs) : meta.verb),
      server.crashCount ? el('span.badge.badge--danger', `${server.crashCount} crash${server.crashCount > 1 ? 'es' : ''}`) : null,
    ),
  );

  return card;
}

/** Update just the live bits of an existing card without re-rendering it. */
export function updateServerCard(card, server, metrics) {
  if (!card) return;
  const status = statusMeta(server.status);
  card.className = `scard scard--${server.status}`;

  const badgeHost = card.querySelector('.scard__badges');
  if (badgeHost) badgeHost.replaceChildren(statusBadge(server.status, { adopted: server.adopted }));

  const dds = card.querySelectorAll('.scard__stat dd');
  if (dds[0]) dds[0].replaceChildren(document.createTextNode(count(server.onlineCount ?? 0)), el('small', `/ ${server.maxPlayers ?? '—'}`));
  if (dds[1]) dds[1].textContent = status.dot ? percent(metrics?.cpuPercent ?? 0, 0) : '—';
  if (dds[2]) {
    const heapMb = server.memory?.maxHeapMb ?? 0;
    const usedMb = Math.round((metrics?.rssBytes ?? 0) / 1024 / 1024);
    const replacement = memoryCell(status.dot && usedMb, metrics?.rssBytes, heapMb);
    dds[2].replaceChildren(...replacement.childNodes);
  }

  const uptime = card.querySelector('[data-uptime]');
  if (uptime) uptime.textContent = ['running', 'starting', 'stopping'].includes(server.status) ? durationShort(server.uptimeMs) : status.verb;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function emptyState({ icon: iconName = 'box', title, text, action = null, compact = false }) {
  return el(
    'div.empty',
    { style: compact ? 'padding:2rem 1rem' : '' },
    el('span.empty__art', { html: icon(iconName, { size: 26 }) }),
    el('p.empty__title', title),
    text ? el('p.empty__text', text) : null,
    action,
  );
}

export function skeletonCard() {
  return el(
    'div.card.card--pad.stack--md',
    el('div.row', el('div.skel', { style: 'width:40px;height:40px;border-radius:12px' }), el('div.grow.stack--xs', el('div.skel.skel--title'), el('div.skel', { style: 'width:35%' }))),
    el('div.skel.skel--block'),
    el('div.row', el('div.skel', { style: 'width:80px;height:28px' }), el('div.skel', { style: 'width:60px;height:28px' })),
  );
}

export const skeletonGrid = (n = 3) => el('div.servercards', ...Array.from({ length: n }, skeletonCard));

/** RAM picker used by the create wizard and server settings. */
export function memoryPicker({ value, min = 512, max = 16384, step = 512, recommended = 4096, onChange, showGc = true, gcProfile = 'aikar', onGcChange }) {
  const slider = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    oninput: (event) => {
      const next = Number(event.target.value);
      readout.textContent = mibFromMb(next);
      hint.textContent = describeHeap(next, max, recommended);
      paintRange(event.target, next, min, max);
      onChange?.(next);
    },
  });

  const readout = el('span.range__value', mibFromMb(value));
  const hint = el('div.field__hint', describeHeap(value, max, recommended));
  paintRange(slider, value, min, max);

  const node = el(
    'div.stack--md',
    el(
      'div.range',
      el('div.range__head', el('span.field__label', 'Maximum heap (-Xmx)'), readout),
      slider,
      el('div.range__scale', el('span', mibFromMb(min, 0)), el('span', { class: 'accent' }, `recommended ${mibFromMb(recommended, 0)}`), el('span', mibFromMb(max, 0))),
      hint,
    ),
    showGc
      ? el(
          'div.field',
          el('label.field__label', 'Garbage collector'),
          el(
            'div.segmented.segmented--block',
            ...[
              ['aikar', 'Aikar G1', 'Best all-rounder for Vanilla, Paper and small modpacks'],
              ['zgc', 'ZGC', 'Low-pause. Requires Java 21+ and 8 GiB or more'],
              ['none', 'Custom', 'No tuning flags — let a modpack ship its own'],
            ].map(([id, label, tip]) =>
              el(
                'button.segmented__opt',
                {
                  type: 'button',
                  class: gcProfile === id ? 'segmented__opt--active' : '',
                  'data-gc': id,
                  'data-tip': tip,
                  onclick: (event) => {
                    for (const sib of event.target.parentElement.children) sib.classList.remove('segmented__opt--active');
                    event.target.classList.add('segmented__opt--active');
                    onGcChange?.(id);
                  },
                },
                label,
              ),
            ),
          ),
        )
      : null,
  );

  return node;
}

function describeHeap(heapMb, maxMb, recommendedMb) {
  if (heapMb >= maxMb) return 'At the ceiling this machine can spare — expect swapping under load.';
  if (heapMb < recommendedMb * 0.6) return 'Tight for a modern server. Fine for 2–4 players on a small view distance.';
  if (heapMb <= recommendedMb * 1.35) return 'Comfortable. This is the sweet spot for most worlds.';
  return 'Generous headroom — great for large modpacks and heavy world generation.';
}

function paintRange(input, value, min, max) {
  const pct = ((value - min) / Math.max(1, max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

/** Small inline copy button with feedback. */
export function copyButton(text, { label = null, tooltip = 'Copy' } = {}) {
  const btn = el(
    'button.iconbtn.iconbtn--xs',
    { type: 'button', 'data-tip': tooltip, onclick: async () => {
        const ok = await copyText(typeof text === 'function' ? text() : text);
        toast[ok ? 'success' : 'error'](ok ? 'Copied to clipboard' : 'Could not copy');
      } },
    el('span', { html: icon('copy', { size: 13 }) }),
  );
  if (!label) return btn;
  return el('button.btn.btn--sm.btn--ghost', { type: 'button', onclick: () => btn.click() }, el('span', { html: icon('copy', { size: 13 }) }), label);
}

/** Render a MOTD with its §-formatting preserved. */
export function motdText(text, { className = '' } = {}) {
  const runs = parseMotd(text);
  return el(
    'span',
    { class: className },
    ...runs.map((run) =>
      el(
        'span',
        {
          style: [
            run.color ? `color:${run.color}` : '',
            run.bold ? 'font-weight:700' : '',
            run.italic ? 'font-style:italic' : '',
            run.underline ? 'text-decoration:underline' : '',
            run.strike ? 'text-decoration:line-through' : '',
          ]
            .filter(Boolean)
            .join(';'),
        },
        run.text,
      ),
    ),
  );
}

/** Player name pill with a deterministic colour. */
export function playerChip(name, { online = true, removable = false, onRemove = null, extra = null } = {}) {
  const color = playerColor(name);
  return el(
    'span',
    { class: `playerchip${online ? '' : ' playerchip--offline'}` },
    el(
      'span.playerchip__head',
      { style: `background:${color}` },
      name.slice(0, 2).toUpperCase(),
      extra,
    ),
    el('span.playerchip__name', name),
    removable
      ? el(
          'button.iconbtn.iconbtn--xs',
          {
            type: 'button',
            'data-tip': 'Remove',
            onclick: (event) => {
              event.stopPropagation();
              onRemove?.(name);
            },
          },
          el('span', { html: icon('x', { size: 11 }) }),
        )
      : null,
  );
}

/**
 * Relative-time label that keeps itself fresh and tears its own timer down
 * once it leaves the DOM — no central registry needed.
 */
export function liveTime(getTimestamp, { className = 'dim tiny' } = {}) {
  const node = el('span', { class: className });
  const update = () => {
    node.textContent = relativeTime(getTimestamp());
  };
  update();
  const timer = setInterval(() => {
    if (!node.isConnected) {
      clearInterval(timer);
      return;
    }
    update();
  }, 15_000);
  return node;
}

/**
 * Action helpers shared by the dashboard and detail views.
 * Keeps the optimistic UI + toast + rollback logic in one place.
 */
export const serverActions = {
  async start(server, { onDone } = {}) {
    const pending = toast.show({ id: `start-${server.id}`, title: `Starting ${server.name}…`, text: 'Waiting for the server to report ready.', tone: 'info', duration: 0 });
    try {
      await api.startServer(server.id);
      pending.dismiss();
      onDone?.();
    } catch (error) {
      pending.dismiss();
      toast.fromError(error, `Could not start ${server.name}`);
    }
  },

  async stop(server, { force = false, onDone } = {}) {
    const needsConfirm = (server.onlineCount ?? 0) > 0;
    if (needsConfirm && !force) {
      const ok = await confirmDialog({
        title: `Stop ${server.name}?`,
        message: `${server.onlineCount} player${server.onlineCount === 1 ? ' is' : 's are'} online. They will be disconnected immediately.`,
        detail: 'The server runs /stop and saves all chunks before exiting, which usually takes a few seconds.',
        confirmLabel: 'Stop server',
        tone: 'warning',
        icon: 'stop',
      });
      if (!ok) return;
    }
    const pending = toast.show({ id: `stop-${server.id}`, title: `Stopping ${server.name}…`, text: 'Saving the world and shutting down cleanly.', tone: 'warning', duration: 0 });
    try {
      await api.stopServer(server.id, { force });
      pending.dismiss();
      onDone?.();
    } catch (error) {
      pending.dismiss();
      toast.fromError(error, `Could not stop ${server.name}`);
    }
  },

  async restart(server, { onDone } = {}) {
    const pending = toast.show({ id: `restart-${server.id}`, title: `Restarting ${server.name}…`, text: 'This can take a minute on large worlds.', tone: 'info', duration: 0 });
    try {
      await api.restartServer(server.id);
      pending.dismiss();
      onDone?.();
    } catch (error) {
      pending.dismiss();
      toast.fromError(error, `Could not restart ${server.name}`);
    }
  },

  /** Wire a click handler that dispatches `data-action` buttons. */
  dispatch(action, server, options = {}) {
    switch (action) {
      case 'start': return serverActions.start(server, options);
      case 'stop': return serverActions.stop(server, options);
      case 'restart': return serverActions.restart(server, options);
      default: return undefined;
    }
  },
};

/** Subscribe to live metric frames for a specific server. */
export function watchMetrics(serverId, handler) {
  const unsubscribe = ws.on('metrics', (message) => {
    const sample = (message.servers ?? []).find((s) => s.serverId === serverId);
    if (sample) handler(sample);
  });
  return unsubscribe;
}

export { bytes, durationShort, percent, statusMeta, platformMeta };
