/**
 * Display formatters. Every one is defensive: the dashboard renders numbers
 * that arrive from the server every couple of seconds, and a `null` must never
 * turn into "NaN MiB" on screen.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** `1536` → `"1.5 GB"` */
export function bytes(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const scaled = n / 1024 ** i;
  const decimals = i === 0 ? 0 : scaled >= 100 ? 0 : digits;
  return `${scaled.toFixed(decimals)} ${UNITS[i]}`;
}

/** `1073741824` → `"1024 MiB"` (memory is always shown in MiB for parity with -Xmx) */
export const mib = (value, digits = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n / 1024 / 1024).toFixed(digits)} MiB`;
};

/** `4096` → `"4 GiB"`, `1536` → `"1.5 GiB"` — used for -Xmx values in MiB */
export function mibFromMb(mb, digits = 1) {
  const n = Number(mb);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} MiB`;
  const gib = n / 1024;
  return `${gib.toFixed(gib >= 10 || Number.isInteger(gib) ? 0 : digits)} GiB`;
}

/**
 * Render a "used / allocated" memory pair in one consistent unit.
 *
 * The JVM's resident memory legitimately exceeds `-Xmx` (metaspace, thread
 * stacks, direct buffers, the GC's own structures), so mixing units made the
 * card read like `2382 / 2 GiB` — which looks like a bug even when it is not.
 * Picking the unit from the allocation keeps the two numbers comparable.
 */
export function memoryPair(usedBytes, heapMb) {
  const used = Number(usedBytes) || 0;
  const heap = Number(heapMb) || 0;
  if (heap >= 1024) {
    return { used: (used / 1024 ** 3).toFixed(1), total: (heap / 1024).toFixed(1), unit: 'GiB' };
  }
  return { used: String(Math.round(used / 1024 / 1024)), total: String(Math.round(heap)), unit: 'MiB' };
}

/** Human duration from milliseconds. `"3d 4h 12m"` */
export function duration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (total < 1) return '0s';
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Compact duration for tight spaces. `"3d4h"`, `"12m"` */
export function durationShort(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86400) return `${Math.floor(total / 3600)}h${Math.floor((total % 3600) / 60)}m`;
  return `${Math.floor(total / 86400)}d${Math.floor((total % 86400) / 3600)}h`;
}

/** "just now", "4 min ago", "3 days ago" */
export function relativeTime(timestamp) {
  const t = Number(timestamp);
  if (!Number.isFinite(t) || t <= 0) return 'never';
  const diff = Date.now() - t;
  if (diff < 0) {
    const ahead = Math.abs(diff);
    if (ahead < 60_000) return 'in a moment';
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)} min`;
    if (ahead < 86_400_000) return `in ${Math.round(ahead / 3_600_000)} h`;
    return `in ${Math.round(ahead / 86_400_000)} d`;
  }
  if (diff < 8_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(t).toLocaleDateString();
}

export function dateTime(timestamp, { seconds = false } = {}) {
  const t = Number(timestamp);
  if (!Number.isFinite(t) || t <= 0) return '—';
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
}

export const timeOnly = (timestamp) => {
  const t = Number(timestamp);
  if (!Number.isFinite(t)) return '--:--:--';
  return new Date(t).toLocaleTimeString(undefined, { hour12: false });
};

/** Console timestamp: always HH:MM:SS, zero-padded, 24-hour. */
export const clockTime = (timestamp) => {
  const t = Number(timestamp);
  if (!Number.isFinite(t)) return '00:00:00';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** `"1,204"` */
export const count = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString();
};

/** Percent with sensible rounding. `12.34` → `"12.3%"` */
export function percent(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  return `${n.toFixed(n >= 100 ? 0 : digits)}%`;
}

/** Keep percentages inside 0–100 for progress bars. */
export const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0));

/** Strip Minecraft §-formatting codes. */
export const stripMinecraftCodes = (text) => String(text ?? '').replace(/§[0-9a-fk-orA-FK-OR]/g, '');

/**
 * Translate a MOTD's § codes into spans. Returns an array of
 * `{ text, color, bold, italic, underline, strike }` runs.
 */
const MC_COLORS = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA', '4': '#AA0000', '5': '#AA00AA',
  '6': '#FFAA00', '7': '#AAAAAA', '8': '#555555', '9': '#5555FF', a: '#55FF55', b: '#55FFFF',
  c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};

export function parseMotd(text) {
  const runs = [];
  let style = { color: null, bold: false, italic: false, underline: false, strike: false };
  let buffer = '';
  const source = String(text ?? '');

  const flush = () => {
    if (buffer) runs.push({ text: buffer, ...style });
    buffer = '';
  };

  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '§' || i === source.length - 1) {
      buffer += source[i];
      continue;
    }
    const code = source[i + 1].toLowerCase();
    i += 1;
    if (code === 'r') {
      flush();
      style = { color: null, bold: false, italic: false, underline: false, strike: false };
      continue;
    }
    if (MC_COLORS[code]) {
      flush();
      style = { ...style, color: MC_COLORS[code] };
      continue;
    }
    const flags = { l: 'bold', o: 'italic', n: 'underline', m: 'strike' };
    if (flags[code]) {
      flush();
      style = { ...style, [flags[code]]: true };
    }
  }
  flush();
  return runs.length ? runs : [{ text: '', color: null, bold: false, italic: false, underline: false, strike: false }];
}

/** Map a server status to badge/copy metadata. */
export const STATUS_META = {
  running:  { label: 'Running',  tone: 'success', rgb: '16, 185, 129',  dot: true,  icon: 'activity',  verb: 'Online' },
  starting: { label: 'Starting', tone: 'warning', rgb: '245, 158, 11',  dot: true,  icon: 'clock',     verb: 'Booting' },
  stopping: { label: 'Stopping', tone: 'warning', rgb: '245, 158, 11',  dot: true,  icon: 'clock',     verb: 'Shutting down' },
  stopped:  { label: 'Stopped',  tone: 'neutral', rgb: '148, 163, 184', dot: false, icon: 'stop',      verb: 'Offline' },
  crashed:  { label: 'Crashed',  tone: 'danger',  rgb: '244, 63, 94',   dot: false, icon: 'alert',     verb: 'Crashed' },
  error:    { label: 'Error',    tone: 'danger',  rgb: '244, 63, 94',   dot: false, icon: 'alert',     verb: 'Error' },
};

export const statusMeta = (status) => STATUS_META[status] ?? STATUS_META.stopped;
export const isLiveStatus = (status) => ['running', 'starting', 'stopping'].includes(status);

/** Platform presentation metadata. */
export const PLATFORM_META = {
  vanilla: { label: 'Vanilla', icon: 'cube',  accent: 'emerald', rgb: '16, 185, 129' },
  paper:   { label: 'Paper',   icon: 'bolt',  accent: 'indigo',  rgb: '99, 102, 241' },
  fabric:  { label: 'Fabric',  icon: 'puzzle', accent: 'violet', rgb: '139, 92, 246' },
};
export const platformMeta = (platform) => PLATFORM_META[platform] ?? PLATFORM_META.vanilla;

/**
 * Pick a readable foreground for a coloured chip, based on luminance.
 */
export function readableOn(hex) {
  const clean = String(hex).replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#0b0d11' : '#f4f4f5';
}

/** `"paper 1.21.4 build 232"` */
export function describeVersion(server) {
  const meta = platformMeta(server.platform);
  const parts = [`${meta.label} ${server.version}`];
  if (server.build) parts.push(`build ${server.build}`);
  if (server.loader) parts.push(`loader ${server.loader}`);
  return parts.join(' · ');
}

/** Escape a string for use inside a RegExp. */
export const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Truncate with an ellipsis, preserving the tail when `fromEnd` is set. */
export function truncate(text, max = 60, fromEnd = false) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  if (fromEnd) return `…${s.slice(-(max - 1))}`;
  return `${s.slice(0, max - 1)}…`;
}

/** Shorten a filesystem path for display. */
export function prettyPath(fullPath, segments = 3) {
  const parts = String(fullPath ?? '').split(/[\\/]/).filter(Boolean);
  if (parts.length <= segments) return fullPath;
  return `…/${parts.slice(-segments).join('/')}`;
}
