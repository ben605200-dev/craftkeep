/**
 * JVM flag reconciliation.
 *
 * Preset flag sets (Aikar's G1 tuning, ZGC) are written for the JDK that was
 * current when they were published. Newer JVMs remove and deprecate options,
 * and a removed `-XX:` flag is noisy at best and fatal at worst:
 *
 *   Java 27: "Ignoring option ParallelRefProcEnabled; support was removed in 27.0"
 *   Java 27: "Option InitiatingHeapOccupancyPercent was deprecated in version 27.0"
 *            "…Use option G1IHOP instead."
 *   Windows: "-XX:+UseTransparentHugePages" is simply unknown.
 *
 * Rather than hard-code a compatibility table that rots on every JDK release,
 * we ask the JVM itself: launch it once with the candidate flags, read the
 * warnings, drop or rename what it rejects, and cache the answer per JDK.
 *
 * The probe is ~250 ms, runs once per Java installation, and never throws — on
 * any failure we return the original flags so startup is never blocked.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildJvmArgs } from './versionRules.js';
import createLogger from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('jvmflags');

/** `key -> string[]` resolved flag sets. Keyed by JDK path + requested set. */
const cache = new Map();

/** `"Ignoring option Foo; …"` / `"Unrecognized VM option 'Foo'"`. */
const REJECTED = [
  /Ignoring option\s+([A-Za-z0-9_.]+)/gi,
  /Unrecognized VM option\s+'?([A-Za-z0-9_.]+)'?/gi,
  /Unrecognized option:\s*-?([A-Za-z0-9_.]+)/gi,
  /Could not create the Java Virtual Machine/i,
];

/**
 * `"Option Foo was deprecated in version 27.0 … Use option Bar instead."`
 *
 * Note the shape: the deprecation sentence itself contains version numbers with
 * dots ("27.0"), so a `[^.]*` filler cannot span it. Scan a bounded amount of
 * text instead of trying to match sentences.
 */
const DEPRECATED =
  /Option\s+([A-Za-z0-9_]+)\s+was deprecated[\s\S]{0,400}?Use option\s+([A-Za-z0-9_]+)\s+instead/gi;

/** `-XX:+Foo` / `-XX:-Foo` / `-XX:Foo=1` → `Foo`. Returns null for non -XX flags. */
function optionName(flag) {
  const match = String(flag).match(/^-XX:[+\-]?([A-Za-z0-9_]+)/);
  return match ? match[1] : null;
}

function canonicalName(name) {
  return String(name).replace(/^\+|^-/, '');
}

/**
 * Run the JVM with the given flags and report what it complained about.
 * @returns {Promise<{ rejected: Set<string>, replacements: Map<string,string>, hardFailure: boolean }>}
 */
async function probeJvm(javaPath, flags) {
  let stderr = '';
  let hardFailure = false;

  try {
    // `-version` makes the JVM evaluate every option then exit immediately.
    const result = await execFileAsync(javaPath, [...flags, '-version'], {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    stderr = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  } catch (error) {
    stderr = `${error?.stderr ?? ''}${error?.stdout ?? ''}`;
    // A non-zero exit with no diagnostic is not our business to fix.
    hardFailure = !stderr;
  }

  const rejected = new Set();
  const replacements = new Map();

  for (const pattern of REJECTED.slice(0, 3)) {
    pattern.lastIndex = 0;
    for (const match of stderr.matchAll(pattern)) {
      if (match[1]) rejected.add(canonicalName(match[1]));
    }
  }
  if (/Could not create the Java Virtual Machine/i.test(stderr) && rejected.size === 0) {
    hardFailure = true;
  }

  DEPRECATED.lastIndex = 0;
  for (const match of stderr.matchAll(DEPRECATED)) {
    replacements.set(canonicalName(match[1]), canonicalName(match[2]));
  }

  return { rejected, replacements, hardFailure };
}

/** Rewrite `-XX:Old=…` / `-XX:+Old` to use the JVM's preferred option name. */
function renameFlag(flag, from, to) {
  if (!flag.includes(from)) return flag;
  // A `+`/`-` boolean flag has no value, so a rename keeps the sign.
  const booleanMatch = flag.match(/^-XX:([+-])([A-Za-z0-9_]+)$/);
  if (booleanMatch && canonicalName(booleanMatch[2]) === from) return `-XX:${booleanMatch[1]}${to}`;
  return flag.replace(new RegExp(`\\b${from}\\b`), to);
}

/**
 * Return a flag set this specific JVM accepts.
 *
 * @param {object} input
 * @param {string} input.javaPath
 * @param {number} input.javaMajor
 * @param {number} input.minHeapMb
 * @param {number} input.maxHeapMb
 * @param {string} [input.gcProfile]
 * @param {boolean} [input.preTouch]
 * @param {string[]} [input.extraArgs]
 * @returns {Promise<{ flags: string[], removed: string[], substituted: Array<[string,string]>, probed: boolean }>}
 */
export async function resolveJvmFlags(input) {
  const requested = buildJvmArgs({
    javaMajor: input.javaMajor,
    minHeapMb: input.minHeapMb,
    maxHeapMb: input.maxHeapMb,
    gcProfile: input.gcProfile,
    preTouch: input.preTouch,
    extraArgs: input.extraArgs,
  });

  const cacheKey = `${input.javaPath}::${requested.join(' ')}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const fallback = { flags: requested, removed: [], substituted: [], probed: false };

  if (!input.javaPath) return fallback;

  let working = [...requested];
  const removed = [];
  const substituted = [];
  let probed = false;

  // Two passes is enough: one to learn what is rejected, one to confirm.
  for (let pass = 0; pass < 2; pass += 1) {
    let outcome;
    try {
      outcome = await probeJvm(input.javaPath, working);
    } catch (error) {
      log.debug(`Flag probe failed for ${input.javaPath}: ${error.message}`);
      break;
    }
    probed = true;

    if (outcome.hardFailure) {
      // The JVM will not start at all with this set — keep the original and let
      // the actual launch surface a real error the user can act on.
      log.warn(`Java ${input.javaMajor} rejected the preset flag set outright; using it unchanged.`);
      break;
    }

    if (!outcome.rejected.size && !outcome.replacements.size) break;

    let changed = false;
    const next = [];
    for (const flag of working) {
      const name = optionName(flag);

      if (name && outcome.rejected.has(name)) {
        removed.push(flag);
        changed = true;
        continue;
      }
      if (name && outcome.replacements.has(name)) {
        const replacement = outcome.replacements.get(name);
        const rewritten = renameFlag(flag, name, replacement);
        substituted.push([flag, rewritten]);
        next.push(rewritten);
        changed = true;
        continue;
      }
      next.push(flag);
    }

    working = next;
    if (!changed) break;
  }

  if (removed.length) {
    log.info(
      `Java ${input.javaMajor} dropped ${removed.length} unsupported flag(s): ${removed.join(', ')}`,
    );
  }
  if (substituted.length) {
    log.info(
      `Java ${input.javaMajor} prefers: ${substituted.map(([a, b]) => `${a} -> ${b}`).join(', ')}`,
    );
  }

  const result = { flags: working, removed, substituted, probed };
  cache.set(cacheKey, result);
  return result;
}

/**
 * Cache the resolved flags on a server definition, computing them on first use.
 * Mutates and returns `definition`; the caller persists it.
 *
 * @param {object} definition a normalised server definition
 * @returns {Promise<object>} the same definition, with `jvmFlags` populated
 */
export async function ensureJvmFlags(definition) {
  if (Array.isArray(definition.jvmFlags) && definition.jvmFlags.length) return definition;

  const resolved = await resolveJvmFlags({
    javaPath: definition.java?.path,
    javaMajor: definition.java?.major ?? 21,
    minHeapMb: definition.memory?.minHeapMb ?? 1024,
    maxHeapMb: definition.memory?.maxHeapMb ?? 4096,
    gcProfile: definition.memory?.gcProfile ?? 'aikar',
    preTouch: definition.memory?.preTouch ?? true,
    extraArgs: definition.jvmArgs ?? [],
  });

  definition.jvmFlags = resolved.flags;
  definition.jvmFlagsInfo = {
    removed: resolved.removed,
    substituted: resolved.substituted,
    resolvedAt: Date.now(),
  };
  return definition;
}

/** Drop the cached resolution for a Java path (after a JDK is reinstalled). */
export function clearFlagCache(javaPath) {
  if (!javaPath) return cache.clear();
  for (const key of [...cache.keys()]) if (key.startsWith(javaPath)) cache.delete(key);
}

export default { resolveJvmFlags, ensureJvmFlags, clearFlagCache };
