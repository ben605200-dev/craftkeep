/**
 * Minecraft console parsing.
 *
 * Turns the raw stream from a server's stdout/stderr into structured records the
 * UI can colour, filter and act on — and detects the lifecycle events we need
 * for accurate status reporting (started, crashing, EULA, port conflicts,
 * player join/leave, chat, advancements...).
 *
 * Handles all three common log shapes:
 *   Vanilla  [12:34:56] [Server thread/INFO]: Done (5.113s)! For help, type "help"
 *   Paper    [12:34:56 INFO]: Done (5.113s)!  /  [12:34:56] [Server thread/INFO]: ...
 *   Raw      Exception in thread "main" java.lang.NullPointerException
 */

// CSI (colours, cursor movement) + OSC (window title) escape sequences.
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_OTHER = /\u001b[@-Z\\-_]|\u001b\([AB0-2]/g;

export function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OTHER, '')
    .replace(/\u0000/g, '');
}

const LEVEL_MAP = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  WARNING: 'warn',
  ERROR: 'error',
  SEVERE: 'error',
  FATAL: 'fatal',
};

// [12:34:56] [Server thread/INFO]: msg   |   [12:34:56 INFO]: msg
const STRUCTURED = /^\s*\[(?<time>\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)(?:\s+(?<level1>[A-Z]+))?\]\s*(?:\[(?<thread>[^\]]+?)(?:\/(?<level2>[A-Z]+))?\]\s*)?:?\s?(?<message>.*)$/s;

// Raw Java stack frames / exception headers.
const JAVA_STACK = /^\s*(at\s+[\w$.]+\(|Caused by:|\s*\.{3}\s+\d+\s+more|Exception in thread|java\.[\w.]*Exception|java\.lang\.\w+Error)/;

/** Parse one console line. Never throws. */
export function parseLine(rawText, stream = 'stdout') {
  const text = stripAnsi(rawText).replace(/\r$/, '');
  const record = {
    text,
    stream,
    level: stream === 'stderr' ? 'error' : 'info',
    time: null,
    thread: null,
    message: text,
    kind: 'log',
    event: null,
  };

  if (!text.trim()) {
    record.kind = 'blank';
    return record;
  }

  const match = text.match(STRUCTURED);
  if (match?.groups) {
    const { time, level1, level2, thread, message } = match.groups;
    const level = (level2 || level1 || '').toUpperCase();
    record.time = time.replace(',', '.');
    record.thread = thread ? thread.trim() : null;
    record.level = LEVEL_MAP[level] ?? (stream === 'stderr' ? 'error' : 'info');
    record.message = message ?? '';
    record.kind = 'log';
    return classify(record);
  }

  if (JAVA_STACK.test(text)) {
    record.kind = 'stack';
    record.level = 'error';
    return classify(record);
  }

  return classify(record);
}

// ---------------------------------------------------------------------------
// Event detection
// ---------------------------------------------------------------------------

const RE = {
  done: /Done\s*\((?<seconds>[\d.]+)s\)!\s*For help, type "help"/i,
  loadingComplete: /Time elapsed:\s*(?<ms>\d+)\s*ms/i,
  startingVersion: /Starting minecraft server version\s*(?<version>\S+)/i,
  loadingProperties: /Loading properties/i,
  preparingLevel: /Preparing (?:start region|spawn area|level)/i,
  stopping: /Stopping (?:the )?server|Stopping server/i,
  stopped: /ThreadedAnvilChunkStorage.*closed|Server stopped|All chunks are saved/i,
  savingChunks: /Saving (?:the )?(?:world|chunks|players)/i,
  eula: /You need to agree to the EULA|Failed to load eula\.txt|agree to the EULA in order to run the server/i,
  portInUse: /FAILED TO BIND TO PORT|Perhaps a server is already running on that port|Address already in use/i,
  portChanged: /The exception was:.*BindException/i,
  /*
   * `server-ip` is the *local interface* to bind, not the address players use.
   * Setting it to a domain name (a very common mix-up) makes the server try to
   * resolve and bind that hostname and crash with UnknownHostException.
   */
  badBindAddress: /java\.net\.UnknownHostException|No such host is known/i,
  worldUpgrade: /(?:Converting|Upgrading) (?:world|map|level)/i,
  // Chat: "<Steve> hello" or "[Not Secure] <Steve> hi"
  chat: /^(?:\[Not Secure\]\s*)?<(?<player>[A-Za-z0-9_.]{1,16})>\s?(?<text>.*)$/,
  // Emote: "* Steve waves"
  emote: /^\*(?:\s+)?(?<player>[A-Za-z0-9_.]{1,16})\s+(?<text>.+)$/,
  join: /^(?<player>[A-Za-z0-9_.]{1,16})\s+joined the game$/,
  leave: /^(?<player>[A-Za-z0-9_.]{1,16})\s+left the game$/,
  lostConnection: /^(?<player>[A-Za-z0-9_.]{1,16})\s+lost connection:\s*(?<reason>.+)$/,
  loggedIn: /Player\s+(?<player>[A-Za-z0-9_.]{1,16})\[\/(?<ip>[^\]]+)\] logged in with entity id/i,
  kicked: /Kicked\s+(?<player>[A-Za-z0-9_.]{1,16}):\s*(?<reason>.+)$/i,
  op: /(?:Made\s+(?<target>[A-Za-z0-9_.]{1,16}) a server operator|Opped\s+(?<target2>[A-Za-z0-9_.]{1,16}))/i,
  deop: /(?:Made\s+(?<target>[A-Za-z0-9_.]{1,16}) no longer a server operator|De-opped\s+(?<target2>[A-Za-z0-9_.]{1,16}))/i,
  advancement: /(?<player>[A-Za-z0-9_.]{1,16}) has (?:made the advancement|reached the goal|completed the challenge)\s*\[?(?<advancement>[^\]]+)\]?/,
  death: /(?<player>[A-Za-z0-9_.]{1,16}) (?:was slain|was shot|drowned|blew up|was blown up|fell|hit the ground|burned|tried to swim|withered|starved|suffocated|died|was killed|froze|was impaled|went off with a bang|walked into)/,
  serverEmpty: /Server is empty|All players have left/i,
  // Plugin / mod summaries
  plugins: /(?:Loading|Enabling) (?:server )?plugins|\[Server thread\/INFO\]: .* plugins? loaded/i,
  modCount: /Loading\s+(?<count>\d+)\s+mods:/i,
  opsLoaded: /Loaded (?<count>\d+) (?:ops|whitelisted players|banned)/i,
  worldSeed: /Preparing level "(?<level>[^"]+)"|Loaded "(?<level2>[^"]+)" in .*ms/i,
  // Crash signatures
  crash: /Caused by:|A fatal error has been detected by the Java Runtime|# A fatal error|java\.lang\.OutOfMemoryError|Watchdog Thread.*server has not responded/i,
  watchdog: /(?:The server has not responded for|Watchdog) .*seconds?/i,
  memory: /java\.lang\.OutOfMemoryError:\s*(?<detail>.+)?/i,
  illegalState: /java\.lang\.IllegalStateException:.*(?:Unsupported class file major version|compiled for a newer version of Java)/i,
  javaVersionMismatch: /class file version (?<fileVersion>[\d.]+).*up to (?<supportedVersion>[\d.]+)|UnsupportedClassVersionError|compiled for the newer version/i,
  modLoaderError: /(?:A potential solution has been determined|Incompatible mod set|net\.fabricmc\.loader\.discovery)/i,
  backfill: /Increasing the amount of available memory|max memory|Consider using|\-Xmx/i,
  worldCorrupt: /(?:Failed to load|Corrupt) (?:level|world|chunk)/i,
};

/**
 * Attach a semantic `event` to a parsed record.
 * The shapes are deliberately UI-friendly (`{ type, ...payload }`).
 */
function classify(record) {
  const message = record.message ?? '';
  const test = (re) => message.match(re) || record.text.match(re);

  let m;

  if ((m = test(RE.done))) {
    return { ...record, kind: 'event', level: 'success', event: { type: 'ready', seconds: Number(m.groups.seconds) } };
  }
  if ((m = test(RE.startingVersion))) {
    return { ...record, kind: 'event', event: { type: 'version', version: m.groups.version } };
  }
  if (RE.eula.test(message) || RE.eula.test(record.text)) {
    return { ...record, kind: 'event', level: 'warn', event: { type: 'eula-required' } };
  }
  if (RE.portInUse.test(message) || RE.portInUse.test(record.text)) {
    return { ...record, kind: 'event', level: 'error', event: { type: 'port-conflict' } };
  }
  if (RE.badBindAddress.test(message) || RE.badBindAddress.test(record.text)) {
    // `No such host is known (heeheesmp.net)` — pull out the offending name so
    // the UI can name it in the fix.
    const match = (message || record.text).match(/\(([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\)/i);
    return {
      ...record,
      kind: 'event',
      level: 'error',
      event: { type: 'bad-bind-address', host: match?.[1]?.toLowerCase() ?? null },
    };
  }
  if ((m = test(RE.chat))) {
    return { ...record, kind: 'chat', event: { type: 'chat', player: m.groups.player, text: m.groups.text } };
  }
  if ((m = test(RE.emote))) {
    return { ...record, kind: 'chat', event: { type: 'emote', player: m.groups.player, text: m.groups.text } };
  }
  if ((m = test(RE.join))) {
    return { ...record, kind: 'event', level: 'success', event: { type: 'join', player: m.groups.player } };
  }
  if ((m = test(RE.leave))) {
    return { ...record, kind: 'event', event: { type: 'leave', player: m.groups.player } };
  }
  if ((m = test(RE.lostConnection))) {
    return { ...record, kind: 'event', level: 'warn', event: { type: 'leave', player: m.groups.player, reason: m.groups.reason } };
  }
  if ((m = test(RE.loggedIn))) {
    return { ...record, kind: 'event', event: { type: 'login', player: m.groups.player, ip: m.groups.ip } };
  }
  if ((m = test(RE.kicked))) {
    return { ...record, kind: 'event', level: 'warn', event: { type: 'kicked', player: m.groups.player, reason: m.groups.reason } };
  }
  if ((m = test(RE.advancement))) {
    return { ...record, kind: 'event', level: 'success', event: { type: 'advancement', player: m.groups.player, advancement: m.groups.advancement?.trim() } };
  }
  if ((m = test(RE.op))) {
    return { ...record, kind: 'event', event: { type: 'op', player: m.groups.target ?? m.groups.target2 } };
  }
  if ((m = test(RE.deop))) {
    return { ...record, kind: 'event', event: { type: 'deop', player: m.groups.target ?? m.groups.target2 } };
  }
  if ((m = test(RE.death))) {
    return { ...record, kind: 'event', level: 'warn', event: { type: 'death', player: m.groups.player } };
  }
  if (RE.memory.test(message)) {
    return { ...record, kind: 'event', level: 'fatal', event: { type: 'out-of-memory' } };
  }
  if (RE.javaVersionMismatch.test(message) || RE.illegalState.test(message)) {
    return { ...record, kind: 'event', level: 'error', event: { type: 'java-mismatch' } };
  }
  if (RE.crash.test(message) || RE.crash.test(record.text)) {
    return { ...record, level: 'error', kind: record.kind === 'log' ? 'log' : record.kind, event: record.event };
  }
  if (RE.stopping.test(message)) {
    return { ...record, kind: 'event', level: 'warn', event: { type: 'stopping' } };
  }
  if ((m = test(RE.modCount))) {
    return { ...record, kind: 'event', event: { type: 'mods', count: Number(m.groups.count) } };
  }
  if ((m = test(RE.opsLoaded))) {
    return { ...record, kind: 'event', event: { type: 'loaded', count: Number(m.groups.count) } };
  }
  if ((m = test(RE.worldSeed))) {
    return { ...record, kind: 'event', event: { type: 'level', level: m.groups.level ?? m.groups.level2 } };
  }

  return record;
}

/**
 * Split a raw stdout/stderr chunk into complete lines, carrying the tail over
 * for the next chunk. Minecraft occasionally emits `\r`-only progress rewrites;
 * we treat those as replacing the previous line.
 *
 * @param {string} carry   unfinished text from the previous chunk
 * @param {string} chunk   newly decoded text
 * @returns {{ lines: {text:string, carriage:boolean}[], carry: string }}
 */
export function splitLines(carry, chunk) {
  const combined = carry + chunk;
  const parts = combined.split('\n');
  const nextCarry = parts.pop() ?? '';

  const lines = [];
  for (const part of parts) {
    // A trailing `\r` is just the line terminator on Windows (CRLF) — it must be
    // stripped *before* looking for in-line rewrites, otherwise every single
    // line on a Windows host looks like a carriage-return rewrite and gets
    // thrown away.
    let text = part.endsWith('\r') ? part.slice(0, -1) : part;

    if (text.includes('\r')) {
      // A genuine in-line `\r` means the server is rewriting the current line
      // (progress bars, "Preparing spawn area: 42%"). Keep the newest segment.
      const segments = text.split('\r');
      text = segments[segments.length - 1] ?? '';
      lines.push({ text, carriage: true });
    } else {
      lines.push({ text, carriage: false });
    }
  }
  return { lines, carry: nextCarry };
}

/**
 * Rough progress hint for the "starting" phase, derived from log milestones.
 * Returns 0–1 so the UI can render a meaningful progress bar.
 */
export const START_MILESTONES = [
  [RE.startingVersion, 0.1],
  [RE.loadingProperties, 0.25],
  [RE.worldSeed, 0.5],
  [RE.preparingLevel, 0.7],
  [RE.done, 1],
];

export function startProgressFor(text) {
  let progress = 0.05;
  for (const [re, value] of START_MILESTONES) {
    if (re.test(text)) progress = Math.max(progress, value);
  }
  return progress;
}

/**
 * Aggregate parsed records into a player roster update.
 * Returns `null` when the line does not affect the roster.
 */
export function applyPlayerEvent(roster, record) {
  const event = record.event;
  if (!event) return null;
  const now = Date.now();

  switch (event.type) {
    case 'join':
      roster.set(event.player, { name: event.player, online: true, joinedAt: now, ip: null });
      return { action: 'join', player: event.player };
    case 'login': {
      const existing = roster.get(event.player) ?? { name: event.player, joinedAt: now };
      roster.set(event.player, { ...existing, online: true, ip: event.ip, joinedAt: existing.joinedAt ?? now });
      return { action: 'login', player: event.player };
    }
    case 'leave': {
      const existing = roster.get(event.player);
      if (!existing) return null;
      roster.set(event.player, { ...existing, online: false, leftAt: now, reason: event.reason ?? null });
      return { action: 'leave', player: event.player };
    }
    default:
      return null;
  }
}
