/**
 * Minecraft version parsing + the Java requirement table.
 *
 * The authoritative source is Mojang's own per-version metadata
 * (`javaVersion.majorVersion`), which every provider tries to use first.
 * This module supplies the fallback table used by Paper/Fabric (whose APIs do
 * not publish a Java requirement) and by the offline mode of the app.
 */

/**
 * Ordered, newest-last. `min` is inclusive.
 * Derived from https://minecraft.wiki/w/Java_Edition#Java_version_requirements
 */
export const JAVA_REQUIREMENTS = [
  { min: [1, 0, 0], java: 8, note: 'Java 8 era (1.0 – 1.16.5)' },
  { min: [1, 17, 0], java: 16, note: 'Caves & Cliffs Part I (1.17 – 1.17.1) required Java 16' },
  { min: [1, 18, 0], java: 17, note: 'Caves & Cliffs Part II (1.18) moved to Java 17' },
  { min: [1, 20, 5], java: 21, note: '1.20.5 moved to Java 21' },
  { min: [1, 21, 9], java: 21, note: '1.21.9 – 1.21.11 still target Java 21' },
  // Minecraft switched to calendar versioning (26.1 = 2026 release 1) and moved
  // to Java 25 in the same release train.
  { min: [26, 0, 0], java: 25, note: 'Calendar versioning (26.x) targets Java 25' },
];

/**
 * Is this a "calendar" version (`26.3`) rather than the legacy `1.x.y` scheme?
 * Anything whose major is not 1 is the new scheme — the 1.x line ran for over a
 * decade, so the distinction is unambiguous.
 */
export function isCalendarVersioning(version) {
  const parsed = parseVersion(version);
  return Boolean(parsed) && parsed[0] !== 1;
}

/**
 * "Modern" = a version that current server software still supports
 * (1.14+ for the old scheme, everything for the new one). Used only to filter
 * ancient versions out of the wizard's dropdown.
 */
export function isModernVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed) return isSnapshot(version);
  if (parsed[0] !== 1) return true;
  return parsed[1] >= 14;
}

const RELEASE_RE = /^(\d+)\.(\d+)(?:\.(\d+))?$/;
const SNAPSHOT_RE = /^(\d{2}w\d{2}[a-z])$/i;

/** Parse `"1.20.5"` → `[1,20,5]`. Returns null for snapshots/unknown formats. */
export function parseVersion(version) {
  const match = String(version ?? '').trim().match(RELEASE_RE);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export const isSnapshot = (version) => SNAPSHOT_RE.test(String(version ?? '').trim());
export const isPreRelease = (version) => /-(pre|rc)\d+$/i.test(String(version ?? '').trim());

/** Compare two dotted version strings. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    // Fall back to lexical comparison for snapshots ("24w45a" sorts fine).
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

const gte = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
};

/**
 * Java major version required to run a given Minecraft version.
 *
 * @param {string} version e.g. "1.20.4"
 * @param {{ manifestJava?: number }} [opts] value pulled from Mojang metadata
 * @returns {{ java: number, source: 'manifest'|'table'|'default', note: string }}
 */
export function requiredJavaFor(version, opts = {}) {
  if (Number.isFinite(opts.manifestJava) && opts.manifestJava > 0) {
    return {
      java: opts.manifestJava,
      source: 'manifest',
      note: `Mojang metadata declares Java ${opts.manifestJava} for ${version}.`,
    };
  }

  const parsed = parseVersion(version);
  if (!parsed) {
    // Snapshots ("26.4-snapshot-6", "24w45a") always track the newest JVM.
    return {
      java: isSnapshot(version) || isCalendarVersioning(version) ? 25 : 21,
      source: 'default',
      note: 'Snapshots and pre-releases target the newest LTS Java.',
    };
  }

  let chosen = JAVA_REQUIREMENTS[0];
  for (const rule of JAVA_REQUIREMENTS) {
    if (gte(parsed, rule.min)) chosen = rule;
    else break;
  }
  return { java: chosen.java, source: 'table', note: chosen.note };
}

/**
 * Version strings on which a *newer* JVM can misbehave (removed APIs, changed
 * GC defaults, `--illegal-access` removal). Used to bias auto-selection toward
 * an exact match rather than "any newer JVM".
 */
export function isStrictJavaMatch(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  // <= 1.12.2 will not start on Java 17+ because of removed Nashorn/CORBA APIs.
  return !gte(parsed, [1, 13, 0]);
}

/**
 * Pick the best installed JDK for the required major version.
 *
 * Preference order:
 *   1. exact major match (and a JDK rather than a JRE when possible)
 *   2. the lowest major that is still >= required (least surprise)
 *   3. the highest major available (last resort — warned about upstream)
 *
 * @param {Array<{major:number,isJdk:boolean,path:string}>} candidates
 */
export function pickJava(candidates, requiredMajor) {
  const usable = (candidates ?? []).filter((c) => c && Number.isFinite(c.major));
  if (!usable.length) return { java: null, reason: 'no-java-installed' };

  const exact = usable.filter((c) => c.major === requiredMajor);
  if (exact.length) {
    exact.sort((a, b) => Number(b.isJdk) - Number(a.isJdk) || (a.vendorRank ?? 0) - (b.vendorRank ?? 0));
    return { java: exact[0], reason: 'exact' };
  }

  const newer = usable.filter((c) => c.major > requiredMajor).sort((a, b) => a.major - b.major);
  if (newer.length) {
    const chosen = newer.find((c) => c.isJdk) ?? newer[0];
    return { java: chosen, reason: 'newer' };
  }

  const older = usable.filter((c) => c.major < requiredMajor).sort((a, b) => b.major - a.major);
  return { java: older[0] ?? null, reason: older.length ? 'older' : 'no-java-installed' };
}

/**
 * Suggest a JVM argument profile and heap sizing for a server.
 *
 * @param {{ javaMajor:number, systemRamMb:number, requestedHeapMb?:number, gcProfile?:string, players?:number }} input
 */
export function planResources({ javaMajor = 21, systemRamMb = 8192, requestedHeapMb, gcProfile = 'aikar', reservedMb = 2048, maxOverrideMb = 0 } = {}) {
  let ceiling = Math.floor(systemRamMb - reservedMb);
  if (maxOverrideMb > 0) ceiling = Math.min(ceiling, maxOverrideMb);
  ceiling = Math.max(512, Math.min(ceiling, 65536));

  let heap = Number.isFinite(requestedHeapMb) && requestedHeapMb > 0 ? Math.floor(requestedHeapMb) : Math.round(ceiling * 0.6);
  heap = Math.max(512, Math.min(heap, ceiling));

  // AlwaysPreTouch + a fixed initial heap stops mid-session GC spikes, but it
  // needs headroom — only use it when we are not squeezing the machine.
  const min = heap >= 2048 ? heap : Math.min(heap, 1024);
  const preTouch = heap <= ceiling - 512;

  return { minHeapMb: min, maxHeapMb: heap, ceilingMb: ceiling, gcProfile, preTouch, javaMajor };
}

/**
 * JVM flags. Aikar's G1 tuning is the community standard for modern Vanilla /
 * Paper; ZGC wins on big heaps with Java 21+.
 */
export function buildJvmArgs({ javaMajor = 21, minHeapMb = 1024, maxHeapMb = 4096, gcProfile = 'aikar', preTouch = true, extraArgs = [] } = {}) {
  const args = [`-Xms${minHeapMb}M`, `-Xmx${maxHeapMb}M`];

  if (gcProfile === 'zgc' && javaMajor >= 21) {
    args.push('-XX:+UseZGC');
    // Generational ZGC became the default (and the flag obsolete) in Java 24.
    if (javaMajor < 24) args.push('-XX:+ZGenerational');
    args.push(`-XX:SoftMaxHeapSize=${Math.max(512, Math.round(maxHeapMb * 0.85))}M`);
    args.push('-XX:+AlwaysPreTouch');
    args.push('-XX:+UseTransparentHugePages');
  } else if (gcProfile === 'none') {
    // Bare bones — useful when a modpack ships its own flags.
    if (preTouch) args.push('-XX:+AlwaysPreTouch');
  } else {
    args.push(
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:MaxTenuringThreshold=1',
    );
    if (preTouch) args.push('-XX:+AlwaysPreTouch');
    args.push('-XX:+PerfDisableSharedMem', '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true');
  }

  // Reasonable, safe defaults that keep crashes debuggable.
  args.push(
    '-Dfile.encoding=UTF-8',
    '-Dcom.mojang.eula.agree=true',
    `-Dterminal.jline=false`,
    `-Dlog4j2.formatMsgNoLookups=true`,
    '-Djava.net.preferIPv4Stack=false',
  );

  if (Array.isArray(extraArgs)) args.push(...extraArgs.filter((a) => typeof a === 'string' && a.trim()));
  return args;
}

/**
 * Sensible `server.properties` defaults. Callers merge user selections on top.
 */
export function defaultServerProperties({ motd = 'A Minecraft Server', port = 25565, maxPlayers = 20, viewDistance = 10, simulationDistance = 10, difficulty = 'easy', gamemode = 'survival', onlineMode = true, seed = '', levelType = 'minecraft:normal', levelName = 'world', pvp = true, hardcore = false, whiteList = false, spawnProtection = 16 } = {}) {
  return {
    'enable-jmx-monitoring': 'false',
    'rcon.port': String(port + 10 <= 65535 ? port + 10 : 25575),
    'level-seed': seed || '',
    gamemode,
    'enable-command-block': 'false',
    'enable-query': 'false',
    'generator-settings': '{}',
    // Secure profiles require Mojang-signed chat, which offline mode cannot provide.
    'enforce-secure-profile': onlineMode ? 'true' : 'false',
    'level-name': levelName,
    motd,
    'query.port': String(port),
    pvp: pvp ? 'true' : 'false',
    'generate-structures': 'true',
    'max-chained-neighbor-updates': '1000000',
    difficulty,
    'network-compression-threshold': '256',
    'max-tick-time': '60000',
    'require-resource-pack': 'false',
    'use-native-transport': 'true',
    'max-players': String(maxPlayers),
    'online-mode': onlineMode ? 'true' : 'false',
    'enable-status': 'true',
    'allow-flight': 'false',
    'broadcast-rcon-to-ops': 'true',
    'view-distance': String(viewDistance),
    'server-ip': '',
    'resource-pack-prompt': '',
    'allow-nether': 'true',
    'server-port': String(port),
    'enable-rcon': 'false',
    'sync-chunk-writes': 'false',
    'op-permission-level': '4',
    'prevent-proxy-connections': 'false',
    'hide-online-players': 'false',
    'resource-pack': '',
    'entity-broadcast-range-percentage': '100',
    'simulation-distance': String(simulationDistance),
    'rcon.password': '',
    'player-idle-timeout': '0',
    'force-gamemode': 'false',
    'rate-limit': '0',
    hardcore: hardcore ? 'true' : 'false',
    'white-list': whiteList ? 'true' : 'false',
    'broadcast-console-to-ops': 'true',
    'spawn-npcs': 'true',
    'spawn-animals': 'true',
    'log-ips': 'true',
    'function-permission-level': '2',
    'initial-disabled-packs': '',
    'level-type': levelType,
    'text-filtering-config': '',
    'spawn-monsters': 'true',
    'enforce-whitelist': 'false',
    'spawn-protection': String(spawnProtection),
    'resource-pack-sha1': '',
    'max-world-size': '29999984',
  };
}

/**
 * Preset bundles shown as one-click cards in the create wizard.
 */
export const RESOURCE_PRESETS = [
  {
    id: 'survival-vanilla',
    name: 'Cozy Vanilla',
    tagline: 'Friends-only survival. Vanilla rules, zero plugins.',
    icon: 'leaf',
    settings: { gamemode: 'survival', difficulty: 'normal', pvp: true, maxPlayers: 10, viewDistance: 8, simulationDistance: 8, onlineMode: true, spawnProtection: 0, whiteList: false },
  },
  {
    id: 'public-paper',
    name: 'Public Paper',
    tagline: 'Built for a busy public server with plugins.',
    icon: 'globe',
    settings: { gamemode: 'survival', difficulty: 'hard', pvp: true, maxPlayers: 60, viewDistance: 10, simulationDistance: 8, onlineMode: true, spawnProtection: 16, whiteList: false },
    platformHint: 'paper',
  },
  {
    id: 'fabric-modded',
    name: 'Fabric Modded',
    tagline: 'Performance + content mods. Moderate RAM headroom.',
    icon: 'puzzle',
    settings: { gamemode: 'survival', difficulty: 'normal', pvp: true, maxPlayers: 20, viewDistance: 8, simulationDistance: 6, onlineMode: true, spawnProtection: 0, whiteList: false },
    platformHint: 'fabric',
  },
  {
    id: 'creative-builder',
    name: 'Creative Builder',
    tagline: 'Creative, flight allowed, huge render distance.',
    icon: 'blocks',
    settings: { gamemode: 'creative', difficulty: 'peaceful', pvp: false, maxPlayers: 12, viewDistance: 16, simulationDistance: 12, onlineMode: true, spawnProtection: 0, whiteList: false },
  },
  {
    id: 'hardcore',
    name: 'Hardcore Run',
    tagline: 'One life each. Hard difficulty, no mercy.',
    icon: 'skull',
    settings: { gamemode: 'survival', difficulty: 'hard', pvp: true, maxPlayers: 8, viewDistance: 10, simulationDistance: 10, onlineMode: true, hardcore: true, spawnProtection: 0, whiteList: false },
  },
];
