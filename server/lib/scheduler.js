/**
 * Scheduled restarts + backups.
 *
 * Deliberately a plain 30-second tick loop rather than a cron library: the
 * schedule vocabulary is tiny (`none`, `interval`, `daily`, `weekly`), it must
 * survive daylight-saving shifts, and `nextRun` has to be computable for the UI
 * without pulling in a dependency.
 */

import { createBackup, pruneBackups } from './backup.js';
import { isLive } from './processManager.js';
import { formatDuration } from './fsUtil.js';
import createLogger from '../logger.js';

const log = createLogger('scheduler');

const TICK_MS = 30_000;
export const MIN_INTERVAL_MINUTES = 15;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Normalise a schedule object.
 * @param {object} input
 */
export function normaliseSchedule(input = {}, kind = 'restart') {
  const defaults =
    kind === 'backup'
      ? { enabled: false, mode: 'none', time: '03:00', intervalMinutes: 1440, weekday: null, keep: 7, lastRun: null, nextRun: null }
      : { enabled: false, mode: 'none', time: '04:00', intervalMinutes: 360, weekday: null, lastRun: null, nextRun: null };

  const mode = ['none', 'interval', 'daily', 'weekly'].includes(input.mode) ? input.mode : defaults.mode;
  const time = /^\d{2}:\d{2}$/.test(input.time ?? '') ? input.time : defaults.time;

  return {
    ...defaults,
    ...input,
    mode,
    time,
    weekday:
      typeof input.weekday === 'number' && input.weekday >= 0 && input.weekday <= 6
        ? input.weekday
        : typeof input.weekday === 'string'
          ? WEEKDAYS.indexOf(input.weekday.toLowerCase())
          : defaults.weekday,
    intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Number(input.intervalMinutes) || defaults.intervalMinutes),
    keep: kind === 'backup' ? Math.max(1, Math.min(100, Number(input.keep) || defaults.keep)) : undefined,
    enabled: Boolean(input.enabled) && mode !== 'none',
  };
}

/**
 * When does this schedule next fire, after `from`?
 * @returns {number|null} epoch millis
 */
export function computeNextRun(schedule, from = Date.now()) {
  if (!schedule?.enabled || schedule.mode === 'none') return null;

  if (schedule.mode === 'interval') {
    const period = Math.max(MIN_INTERVAL_MINUTES, schedule.intervalMinutes) * 60_000;
    const anchor = schedule.lastRun ?? from;
    let next = anchor + period;
    // If the manager was off for a while, don't fire a burst of catch-ups.
    if (next <= from) next = from + period;
    return next;
  }

  const [hour, minute] = schedule.time.split(':').map(Number);
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);

  if (schedule.mode === 'daily') {
    if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  if (schedule.mode === 'weekly') {
    const target = schedule.weekday ?? 0;
    let delta = (target - candidate.getDay() + 7) % 7;
    if (delta === 0 && candidate.getTime() <= from) delta = 7;
    candidate.setDate(candidate.getDate() + delta);
    return candidate.getTime();
  }

  return null;
}

export class Scheduler {
  /**
   * @param {import('./registry.js').ServerRegistry} registry
   * @param {{ onEvent?: (event: object) => void }} [opts]
   */
  constructor(registry, { onEvent } = {}) {
    this.registry = registry;
    this.onEvent = onEvent;
    this.timer = null;
    this.running = new Set();
  }

  start() {
    if (this.timer) return;
    this.#recomputeAll();
    this.timer = setInterval(() => this.tick().catch((error) => log.error(`Scheduler tick failed: ${error.message}`)), TICK_MS);
    this.timer.unref?.();
    log.info('Scheduler online — checking every 30s.');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Recompute `nextRun` for every schedule (call after any settings change). */
  #recomputeAll() {
    for (const managed of this.registry.servers.values()) {
      for (const kind of ['restart', 'backup']) {
        const schedule = managed.def.schedules?.[kind];
        if (!schedule) continue;
        schedule.nextRun = computeNextRun(schedule);
      }
    }
  }

  async tick() {
    const now = Date.now();
    for (const managed of this.registry.servers.values()) {
      for (const kind of ['restart', 'backup']) {
        const schedule = managed.def.schedules?.[kind];
        if (!schedule?.enabled || schedule.mode === 'none') continue;

        // Lazily (re)compute so config edits are picked up immediately.
        if (!schedule.nextRun) {
          schedule.nextRun = computeNextRun(schedule);
          continue;
        }
        if (schedule.nextRun > now) continue;

        const lock = `${managed.id}:${kind}`;
        if (this.running.has(lock)) continue;
        this.running.add(lock);

        schedule.lastRun = now;
        schedule.nextRun = computeNextRun(schedule, now);

        // Run out-of-band so a slow backup never stalls the tick.
        this.#run(managed, kind, schedule).finally(() => this.running.delete(lock));
      }
    }
  }

  async #run(managed, kind, schedule) {
    const label = `${kind} of "${managed.def.name}"`;
    log.info(`Running scheduled ${label}`);
    this.onEvent?.({ type: 'schedule-start', serverId: managed.id, kind, nextRun: schedule.nextRun });

    try {
      if (kind === 'backup') {
        if (!managed.def.dir) return;
        const manifest = await createBackup(managed, { label: 'scheduled' });
        await pruneBackups(managed.id, schedule.keep ?? 7);
        this.onEvent?.({ type: 'schedule-done', serverId: managed.id, kind, detail: manifest.file, bytes: manifest.bytes });
      } else {
        if (!isLive(managed.status)) {
          log.info(`Skipping scheduled restart of "${managed.def.name}" — it is not running.`);
          this.onEvent?.({ type: 'schedule-skip', serverId: managed.id, kind, reason: 'not-running' });
          return;
        }

        const players = managed.onlineCount;
        if (players > 0) {
          managed.sendMany([
            'say §e[Server] Scheduled restart in 60 seconds.',
            'say §e[Server] You will be reconnected automatically.',
          ], { silent: true });
          managed.console.push(`\n[manager] Scheduled restart — warning ${players} online player(s), 60s grace period. ` +
            `If you need to postpone, use "Cancel restart" in the dashboard.\n\n`, 'stdout');
          this.onEvent?.({ type: 'schedule-notice', serverId: managed.id, kind, players, graceMs: 60_000 });

          // Wait the grace period, but abort if an operator cancels.
          const cancelled = await this.#gracePeriod(managed, 60_000);
          if (cancelled) {
            this.onEvent?.({ type: 'schedule-cancelled', serverId: managed.id, kind });
            return;
          }
        }

        if (managed.def.options?.backupBeforeRestart !== false) {
          managed.console.push('\n[manager] Taking a pre-restart backup…\n', 'stdout');
          await createBackup(managed, { label: 'pre-restart' }).catch((error) =>
            log.warn(`Pre-restart backup failed: ${error.message}`),
          );
          await pruneBackups(managed.id, managed.def.schedules?.backup?.keep ?? 7);
        }

        managed.console.push(`\n[manager] Restarting on schedule (${schedule.mode}${schedule.mode === 'interval' ? ` every ${formatDuration(schedule.intervalMinutes * 60_000)}` : ` at ${schedule.time}`}).\n`, 'stdout');
        await managed.restart({ reason: 'schedule' });
        this.onEvent?.({ type: 'schedule-done', serverId: managed.id, kind, detail: 'restarted' });
      }
    } catch (error) {
      log.error(`Scheduled ${label} failed: ${error.message}`);
      this.onEvent?.({ type: 'schedule-failed', serverId: managed.id, kind, error: error.message });
    }
  }

  /** Wait `ms`, returning true if `managed.cancelRestart` was raised. */
  #gracePeriod(managed, ms) {
    managed.cancelRestart = false;
    return new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const check = () => {
        if (managed.cancelRestart) {
          managed.cancelRestart = false;
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 1000).unref?.();
      };
      setTimeout(check, 1000).unref?.();
    });
  }

  /** Request cancellation of an in-flight scheduled restart. */
  cancel(serverId) {
    const managed = this.registry.find(serverId);
    if (!managed) return false;
    managed.cancelRestart = true;
    return true;
  }
}

export { WEEKDAYS };
export default Scheduler;
