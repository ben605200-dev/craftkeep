/**
 * Reader/writer for Java `.properties` files.
 *
 * Minecraft's `server.properties` is *very* picky: it is rewritten by the server
 * on every boot, comments are dropped, and keys are sorted. We therefore:
 *   - preserve unknown keys that the server added (so we never lose settings),
 *   - only rewrite the keys we actually manage,
 *   - keep ordering stable and deterministic.
 */

/** Keys Minecraft expects, in the order the vanilla server writes them. */
export const SERVER_PROPERTIES_ORDER = [
  'enable-jmx-monitoring',
  'rcon.port',
  'level-seed',
  'gamemode',
  'enable-command-block',
  'enable-query',
  'generator-settings',
  'enforce-secure-profile',
  'level-name',
  'motd',
  'query.port',
  'pvp',
  'generate-structures',
  'max-chained-neighbor-updates',
  'difficulty',
  'network-compression-threshold',
  'max-tick-time',
  'require-resource-pack',
  'use-native-transport',
  'max-players',
  'online-mode',
  'enable-status',
  'allow-flight',
  'broadcast-rcon-to-ops',
  'view-distance',
  'server-ip',
  'resource-pack-prompt',
  'allow-nether',
  'server-port',
  'enable-rcon',
  'sync-chunk-writes',
  'op-permission-level',
  'prevent-proxy-connections',
  'hide-online-players',
  'resource-pack',
  'entity-broadcast-range-percentage',
  'simulation-distance',
  'rcon.password',
  'player-idle-timeout',
  'force-gamemode',
  'rate-limit',
  'hardcore',
  'white-list',
  'broadcast-console-to-ops',
  'spawn-npcs',
  'spawn-animals',
  'log-ips',
  'function-permission-level',
  'initial-disabled-packs',
  'level-type',
  'text-filtering-config',
  'spawn-monsters',
  'enforce-whitelist',
  'spawn-protection',
  'resource-pack-sha1',
  'max-world-size',
  'accepts-transfers',
  'pause-when-empty-seconds',
];

/**
 * Rich metadata used to auto-generate the settings UI. Grouping + validation
 * live here so the frontend stays declarative.
 */
export const PROPERTY_SCHEMA = [
  { key: 'motd', label: 'MOTD', type: 'string', group: 'General', maxLength: 120, help: 'Line shown in the multiplayer server list. §-codes allowed.' },
  { key: 'server-port', label: 'Server port', type: 'int', group: 'Network', min: 1, max: 65535, help: 'TCP port clients connect to.' },
  {
    key: 'server-ip',
    label: 'Bind address',
    type: 'string',
    group: 'Network',
    accepts: 'bindAddress',
    help:
      'Leave empty — the server then listens on every interface, which is what you want. ' +
      'This is NOT the address players connect to: it cannot be a domain name, and setting one makes the server crash on startup.',
  },
  { key: 'max-players', label: 'Max players', type: 'int', group: 'General', min: 1, max: 1000 },
  { key: 'online-mode', label: 'Online mode', type: 'bool', group: 'Network', help: 'Verify players against Mojang. Disable only for LAN/proxy setups.' },
  { key: 'enforce-secure-profile', label: 'Enforce secure profile', type: 'bool', group: 'Network', help: 'Requires signed chat. Turn off when online-mode is false.' },
  { key: 'white-list', label: 'Whitelist', type: 'bool', group: 'Players', help: 'Only allow players listed in whitelist.json.' },
  { key: 'enforce-whitelist', label: 'Enforce whitelist on rejoin', type: 'bool', group: 'Players' },
  { key: 'gamemode', label: 'Game mode', type: 'enum', group: 'Gameplay', values: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', label: 'Difficulty', type: 'enum', group: 'Gameplay', values: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'hardcore', label: 'Hardcore', type: 'bool', group: 'Gameplay', help: 'Ban players on death (1.20+).' },
  { key: 'pvp', label: 'PvP', type: 'bool', group: 'Gameplay' },
  { key: 'force-gamemode', label: 'Force game mode', type: 'bool', group: 'Gameplay', help: 'Reset players to the default mode on join.' },
  { key: 'allow-flight', label: 'Allow flight', type: 'bool', group: 'Gameplay' },
  { key: 'allow-nether', label: 'Allow Nether', type: 'bool', group: 'World' },
  { key: 'spawn-monsters', label: 'Spawn monsters', type: 'bool', group: 'World' },
  { key: 'spawn-animals', label: 'Spawn animals', type: 'bool', group: 'World' },
  { key: 'spawn-npcs', label: 'Spawn villagers', type: 'bool', group: 'World' },
  { key: 'generate-structures', label: 'Generate structures', type: 'bool', group: 'World' },
  { key: 'level-name', label: 'World folder', type: 'string', group: 'World', help: 'Renaming does not move existing world data.' },
  { key: 'level-seed', label: 'Seed', type: 'string', group: 'World', help: 'Empty = random. Only used when the world is first generated.' },
  { key: 'level-type', label: 'World type', type: 'string', group: 'World', help: 'e.g. minecraft:normal, minecraft:flat, minecraft:large_biomes, minecraft:amplified' },
  { key: 'view-distance', label: 'View distance', type: 'int', group: 'Performance', min: 3, max: 32, help: 'Chunks sent to clients. The single biggest CPU lever.' },
  { key: 'simulation-distance', label: 'Simulation distance', type: 'int', group: 'Performance', min: 3, max: 32, help: 'Chunks that keep ticking. The biggest RAM lever.' },
  { key: 'entity-broadcast-range-percentage', label: 'Entity broadcast range %', type: 'int', group: 'Performance', min: 10, max: 500 },
  { key: 'max-tick-time', label: 'Max tick time (ms)', type: 'int', group: 'Performance', min: -1, help: '-1 disables the watchdog entirely.' },
  { key: 'network-compression-threshold', label: 'Compression threshold', type: 'int', group: 'Performance', help: '-1 disables compression, 256 is the default.' },
  { key: 'sync-chunk-writes', label: 'Sync chunk writes', type: 'bool', group: 'Performance', help: 'Keep disabled for better disk throughput on SSDs.' },
  { key: 'player-idle-timeout', label: 'Idle kick (minutes)', type: 'int', group: 'Players', min: 0, help: '0 disables the idle kick.' },
  { key: 'spawn-protection', label: 'Spawn protection radius', type: 'int', group: 'Players', min: 0 },
  { key: 'op-permission-level', label: 'Op permission level', type: 'int', group: 'Players', min: 1, max: 4 },
  { key: 'function-permission-level', label: 'Function permission level', type: 'int', group: 'Players', min: 1, max: 4 },
  { key: 'enable-command-block', label: 'Enable command blocks', type: 'bool', group: 'Gameplay' },
  { key: 'enable-status', label: 'Answer server list pings', type: 'bool', group: 'Network' },
  { key: 'hide-online-players', label: 'Hide online players', type: 'bool', group: 'Network' },
  { key: 'prevent-proxy-connections', label: 'Prevent proxy connections', type: 'bool', group: 'Network' },
  { key: 'log-ips', label: 'Log player IPs', type: 'bool', group: 'Network' },
  { key: 'enable-query', label: 'Enable GameSpy4 query', type: 'bool', group: 'Network' },
  { key: 'query.port', label: 'Query port', type: 'int', group: 'Network', min: 1, max: 65535 },
  { key: 'enable-rcon', label: 'Enable RCON', type: 'bool', group: 'RCON' },
  { key: 'rcon.port', label: 'RCON port', type: 'int', group: 'RCON', min: 1, max: 65535 },
  { key: 'rcon.password', label: 'RCON password', type: 'password', group: 'RCON' },
  { key: 'broadcast-console-to-ops', label: 'Broadcast console to ops', type: 'bool', group: 'RCON' },
  { key: 'broadcast-rcon-to-ops', label: 'Broadcast RCON to ops', type: 'bool', group: 'RCON' },
  { key: 'resource-pack', label: 'Resource pack URL', type: 'string', group: 'Resources' },
  { key: 'resource-pack-sha1', label: 'Resource pack SHA-1', type: 'string', group: 'Resources' },
  { key: 'resource-pack-prompt', label: 'Resource pack prompt', type: 'string', group: 'Resources' },
  { key: 'require-resource-pack', label: 'Require resource pack', type: 'bool', group: 'Resources' },
  { key: 'max-world-size', label: 'Max world size (blocks)', type: 'int', group: 'World', min: 1 },
  { key: 'pause-when-empty-seconds', label: 'Pause when empty (s)', type: 'int', group: 'Performance', min: 0, help: '1.21.2+: freeze the server once everyone leaves. 0 = never.' },
  { key: 'accepts-transfers', label: 'Accept transfers', type: 'bool', group: 'Network', help: '1.20.5+: allow players to be transferred here from another server.' },
];

export const PROPERTY_GROUPS = ['General', 'Gameplay', 'World', 'Players', 'Performance', 'Network', 'RCON', 'Resources'];

/** Parse `.properties` text into a plain object. Handles `\:`/`\=`, comments, continuations. */
export function parseProperties(text) {
  const result = {};
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

  let pending = '';
  for (const rawLine of lines) {
    const line = pending + rawLine;
    // Line continuation (odd number of trailing backslashes).
    if (/(^|[^\\])(\\\\)*\\$/.test(line)) {
      pending = `${line.slice(0, -1)}`;
      continue;
    }
    pending = '';

    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;

    // Key ends at the first unescaped '=' or ':' or whitespace.
    let key = '';
    let index = 0;
    while (index < trimmed.length) {
      const ch = trimmed[index];
      if (ch === '\\') {
        key += trimmed[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (ch === '=' || ch === ':') break;
      if (ch === ' ' || ch === '\t') {
        // Whitespace only terminates the key if an '='/':' follows.
        const rest = trimmed.slice(index).trimStart();
        if (rest.startsWith('=') || rest.startsWith(':')) break;
        key += ch;
        index += 1;
        continue;
      }
      key += ch;
      index += 1;
    }

    const rest = trimmed.slice(index).replace(/^\s*[=:]?\s*/, '');
    const value = rest
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\([\\:=#! ])/g, '$1');

    if (key) result[key] = value;
  }

  return result;
}

const escapeValue = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

/**
 * Serialise a properties object. `order` controls key ordering; keys not listed
 * are appended alphabetically so server-added options survive a round-trip.
 */
export function stringifyProperties(props, order = SERVER_PROPERTIES_ORDER, { header } = {}) {
  const keys = Object.keys(props ?? {});
  const known = order.filter((k) => keys.includes(k));
  const knownSet = new Set(order);
  const extra = keys.filter((k) => !knownSet.has(k)).sort();

  const lines = [];
  if (header) {
    for (const line of header.split('\n')) lines.push(line ? `#${line}` : '#');
  } else {
    lines.push('#Minecraft server properties');
  }
  for (const key of [...known, ...extra]) {
    lines.push(`${key}=${escapeValue(props[key])}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Is `text` an IPv4 or IPv6 literal (as opposed to a hostname)? */
export function isIpLiteral(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255);
  }
  // Loose IPv6 check — enough to tell an address from a domain name.
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':');
}

/**
 * Extra validators for string properties where a free-text value is not
 * acceptable. Keyed by the schema's `accepts` field.
 */
const STRING_VALIDATORS = {
  /**
   * `server-ip` is the local interface to bind to — not the address players
   * use. A hostname here makes Minecraft try to resolve and bind it, which
   * crashes startup with UnknownHostException. Empty is the correct default.
   */
  bindAddress(value) {
    const text = String(value ?? '').trim();
    if (text === '') return null;
    if (isIpLiteral(text)) return null;
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) {
      return (
        `"${text}" looks like a domain name. Bind address must be empty or a local IP address — ` +
        'a domain name is not bindable and will crash the server on startup.'
      );
    }
    return 'Bind address must be empty or a valid IP address.';
  },
};

/** Coerce a raw string into the JS type the schema declares. */
export function coerceProperty(schema, raw) {
  switch (schema?.type) {
    case 'bool':
      return String(raw).trim().toLowerCase() === 'true';
    case 'int': {
      const n = Number.parseInt(String(raw).trim(), 10);
      return Number.isFinite(n) ? n : 0;
    }
    default:
      return String(raw ?? '');
  }
}

/** Validate a single property against its schema. Returns an error string or null. */
export function validateProperty(schema, value) {
  if (!schema) return null;
  if (schema.type === 'bool') {
    if (typeof value !== 'boolean') return `${schema.label} must be true or false.`;
    return null;
  }
  if (schema.type === 'int') {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(n)) return `${schema.label} must be a whole number.`;
    if (schema.min !== undefined && n < schema.min) return `${schema.label} must be at least ${schema.min}.`;
    if (schema.max !== undefined && n > schema.max) return `${schema.label} must be at most ${schema.max}.`;
    return null;
  }
  if (schema.type === 'enum') {
    if (!schema.values.includes(String(value))) {
      return `${schema.label} must be one of: ${schema.values.join(', ')}.`;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (schema.accepts && STRING_VALIDATORS[schema.accepts]) {
      const error = STRING_VALIDATORS[schema.accepts](value);
      if (error) return error;
    }
    if (schema.maxLength && String(value).length > schema.maxLength) {
      return `${schema.label} must be ${schema.maxLength} characters or fewer.`;
    }
  }
  return null;
}

/**
 * Validate a whole `{ key: value }` map against the schema.
 *
 * Returns `{ ok: true }` or `{ ok: false, errors: [...] }`. Keys with no schema
 * entry are passed through untouched — the server writes its own options and we
 * must not reject them.
 *
 * @param {Record<string, unknown>} values
 */
export function validateProperties(values) {
  const errors = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    const schema = PROPERTY_SCHEMA.find((s) => s.key === key);
    if (!schema) continue;
    const error = validateProperty(schema, value);
    if (error) errors.push({ key, message: error });
  }
  return errors.length ? { ok: false, errors, message: errors[0].message } : { ok: true };
}

/** Apply schema coercions to a whole object (used on the incoming REST payload). */
export function normaliseProperties(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const schema = PROPERTY_SCHEMA.find((s) => s.key === key);
    out[key] = schema ? coerceProperty(schema, value) : value;
  }
  return out;
}
