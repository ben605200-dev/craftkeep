/**
 * Cross-platform process resource sampling — no npm dependencies.
 *
 *  - Linux   : direct `/proc/<pid>/{stat,status}` reads (essentially free).
 *  - Windows : a single batched `Get-Process` PowerShell call for *all* PIDs,
 *              so N servers cost one subprocess per tick instead of N.
 *  - macOS   : one batched `ps -o pid=,rss=,time=` call.
 *
 * CPU percentage is derived from the delta of cumulative CPU time between
 * samples, normalised by the number of logical cores (matching `top`/Task
 * Manager's process-level convention).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import createLogger from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('stats');

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
export const CPU_COUNT = Math.max(1, (os.cpus() || []).length);

/** `pid -> { cpuTimeMs, wallMs, cpuPercent, rssBytes, sampledAt }` */
const previous = new Map();

/** Total physical RAM in MiB. */
export const totalRamMb = () => Math.round(os.totalmem() / 1024 / 1024);

/**
 * Live system-wide CPU load (0–100), averaged over the interval since the last
 * call. Uses `os.cpus()` tick deltas — free and accurate enough for a widget.
 */
let lastCpuSnapshot = null;
export function systemCpuPercent() {
  const cpus = os.cpus() || [];
  if (!cpus.length) return 0;

  const snapshot = cpus.map((c) => ({ ...c.times }));
  if (!lastCpuSnapshot || lastCpuSnapshot.length !== snapshot.length) {
    lastCpuSnapshot = snapshot;
    return 0;
  }

  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < snapshot.length; i += 1) {
    const now = snapshot[i];
    const before = lastCpuSnapshot[i];
    const total = now.user + now.nice + now.sys + now.idle + now.irq;
    const beforeTotal = before.user + before.nice + before.sys + before.idle + before.irq;
    idleDelta += now.idle - before.idle;
    totalDelta += total - beforeTotal;
  }
  lastCpuSnapshot = snapshot;

  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

export const systemMemory = () => {
  const total = os.totalmem();
  const free = os.freemem();
  return { totalBytes: total, freeBytes: free, usedBytes: total - free, usedPercent: total ? ((total - free) / total) * 100 : 0 };
};

// ---------------------------------------------------------------------------
// Per-platform raw readers → Map<pid, { rssBytes, cpuTimeMs }>
// ---------------------------------------------------------------------------

async function readLinux(pids) {
  const out = new Map();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const [stat, status] = await Promise.all([
          fs.readFile(`/proc/${pid}/stat`, 'utf8'),
          fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
        ]);

        // Field 2 (comm) may contain spaces/parentheses — split after the last ')'.
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(' ');
        // After comm: state(0) ppid(1) ... utime at index 11, stime at 12.
        const utime = Number(fields[11] ?? 0);
        const stime = Number(fields[12] ?? 0);
        const ticks = 100; // CLK_TCK is 100 on every mainstream Linux config.
        const cpuTimeMs = ((utime + stime) / ticks) * 1000;

        const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
        const rssBytes = rssMatch ? Number(rssMatch[1]) * 1024 : 0;

        out.set(pid, { rssBytes, cpuTimeMs });
      } catch {
        /* process is gone */
      }
    }),
  );
  return out;
}

async function readMac(pids) {
  const out = new Map();
  try {
    const list = pids.join(',');
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,rss=,time=', '-p', list], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // "<pid> <rssKiB> <[[hh:]mm:]ss.cs>"
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(?:(\d+):)?(?:(\d+):)?(\d+)\.(\d+)$/);
      if (!match) continue;
      const [, pid, rss, a, b, c, cs] = match;
      const seconds = (Number(a ?? 0) * 3600 + Number(b ?? 0) * 60 + Number(c ?? 0)) + Number(cs) / 100;
      out.set(Number(pid), { rssBytes: Number(rss) * 1024, cpuTimeMs: seconds * 1000 });
    }
  } catch {
    /* no matching processes */
  }
  return out;
}

/**
 * Windows PowerShell hosts to try, in order. `pwsh` (PowerShell 7+) is much
 * faster to start, but it is not installed by default, so Windows PowerShell
 * 5.1 remains the guaranteed fallback.
 */
const POWERSHELL_HOSTS = ['pwsh.exe', 'powershell.exe'];
let powershellHost = null;

async function readWindows(pids) {
  const out = new Map();
  const filter = pids.join(',');

  // `Select-Object` with calculated properties renames the fields to the short
  // names we parse below. Notes on 5.1 compatibility, which bit us once:
  //   * `ConvertTo-Json -AsArray` does NOT exist before PowerShell 6 — using it
  //     makes the whole call fail silently with exit code 1.
  //   * `ConvertTo-Json` defaults to `-Depth 2`, which is fine for a flat object.
  const script = [
    `$ErrorActionPreference='SilentlyContinue';`,
    `$p = Get-Process -Id ${filter} -ErrorAction SilentlyContinue;`,
    `if ($p) {`,
    `  $p | Select-Object`,
    `    @{n='id';e={$_.Id}},`,
    `    @{n='ws';e={$_.WorkingSet64}},`,
    `    @{n='pm';e={$_.PrivateMemorySize64}},`,
    `    @{n='ct';e={$_.TotalProcessorTime.TotalMilliseconds}}`,
    `  | ConvertTo-Json -Compress -Depth 3`,
    `}`,
  ].join(' ');

  const args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const hosts = powershellHost ? [powershellHost] : POWERSHELL_HOSTS;

  for (const host of hosts) {
    try {
      const { stdout } = await execFileAsync(host, args, {
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      powershellHost = host;

      const text = stdout.trim();
      if (!text) return out;

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return out;
      }
      // A single process serialises to an object, several to an array.
      const rows = Array.isArray(parsed) ? parsed : [parsed];

      for (const row of rows) {
        const pid = Number(row.id);
        if (!Number.isFinite(pid)) continue;
        const cpuTimeMs = Number(row.ct);
        out.set(pid, {
          // WorkingSet is what Task Manager shows; PrivateMemory tracks the
          // committed heap more closely, so fall back to it.
          rssBytes: Number(row.ws ?? 0) || Number(row.pm ?? 0) || 0,
          privateBytes: Number(row.pm ?? 0) || 0,
          cpuTimeMs: Number.isFinite(cpuTimeMs) ? cpuTimeMs : 0,
        });
      }
      return out;
    } catch (error) {
      if (error?.code === 'ENOENT') continue; // try the next host
      log.debug(`Windows sampler via ${host} failed: ${error?.message ?? error}`);
      return out;
    }
  }

  log.warn('Neither pwsh.exe nor powershell.exe could be launched — CPU/RAM widgets will read zero.');
  return out;
}

const readRaw = (pids) => (IS_WINDOWS ? readWindows(pids) : IS_MAC ? readMac(pids) : readLinux(pids));

/**
 * Sample one or more PIDs. Always resolves — dead PIDs are simply omitted.
 *
 * @param {number[]} pids
 * @returns {Promise<Map<number, { cpuPercent:number, rssBytes:number, cpuTimeMs:number }>>}
 */
export async function sampleProcesses(pids) {
  const wanted = [...new Set((pids ?? []).filter((p) => Number.isInteger(p) && p > 0))];
  const results = new Map();
  if (!wanted.length) return results;

  const raw = await readRaw(wanted);
  const now = Date.now();

  for (const pid of wanted) {
    const current = raw.get(pid);
    if (!current) {
      previous.delete(pid);
      continue;
    }

    const before = previous.get(pid);
    let cpuPercent = 0;

    if (before && now > before.wallMs) {
      const cpuDeltaMs = Math.max(0, current.cpuTimeMs - before.cpuTimeMs);
      const wallDeltaMs = now - before.wallMs;
      // Normalise by core count so 100% == one fully-utilised core, like `ps`.
      cpuPercent = Math.min(100 * CPU_COUNT, (cpuDeltaMs / wallDeltaMs) * 100);
    }

    previous.set(pid, { cpuTimeMs: current.cpuTimeMs, wallMs: now, rssBytes: current.rssBytes });

    results.set(pid, {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      rssBytes: current.rssBytes,
      privateBytes: current.privateBytes ?? current.rssBytes,
      cpuTimeMs: current.cpuTimeMs,
      // First sample has no delta to compare against; report the raw reading so
      // the UI shows *something* immediately instead of a misleading 0%.
      warmingUp: !before,
    });
  }

  return results;
}

/** Forget cached counters (call when a server stops). */
export const forgetProcess = (pid) => previous.delete(pid);
export const forgetAll = () => previous.clear();

/** Environment probe used by the Settings › System panel. */
export function systemInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: (os.cpus()?.[0]?.model ?? 'Unknown').trim(),
    cpuCount: CPU_COUNT,
    totalRamMb: totalRamMb(),
    freeRamMb: Math.round(os.freemem() / 1024 / 1024),
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
    hostname: os.hostname(),
    release: os.release(),
  };
}
