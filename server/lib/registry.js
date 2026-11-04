/**
 * The server registry: the single owner of every `ManagedServer`.
 *
 * Responsibilities
 *   - load/persist `data/servers.json` (atomic writes, schema migration)
 *   - create, update and delete server definitions on disk
 *   - own the global resource-sampling loop (one batched probe per tick)
 *   - reconcile reality on boot (a JVM that survived a manager restart is
 *     adopted by PID; stale definitions are marked stopped)
 *   - expose aggregated stats for the dashboard
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config, ensureDirectories } from '../config.js';
import { ManagedServer, STATUS, isLive } from './processManager.js';
import { sampleProcesses, totalRamMb, systemCpuPercent, systemMemory } from './stats.js';
import { readJsonSync, writeJson, atomicWrite, removeDir, slugify, safeJoin, ensureDir } from './fsUtil.js';
import { detectJava, javaSummary } from './javaDetect.js';
import { download } from './httpClient.js';
import { pickJava, buildJvmArgs, defaultServerProperties, planResources } from './versionRules.js';
import { ensureJvmFlags } from './jvmFlags.js';
import { planDownload, PLATFORM_INFO } from '../providers/index.js';
import { stringifyProperties, parseProperties } from './properties.js';
import createLogger from '../logger.js';

const log = createLogger('registry');

const REGISTRY_VERSION = 2;

export class ServerRegistry extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    /** @type {Map<string, ManagedServer>} */
    this.servers = new Map();
    /** Raw persisted definitions, keyed by id. */
    this.definitions = new Map();
    this.sampler = null;
    this.ready = false;
    this.systemSample = { cpuPercent: 0, memory: null, sampledAt: null };
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async init() {
    ensureDirectories();
    await this.#load();
    await this.#reconcile();
    this.#startSampler();
    this.ready = true;
    log.info(`Registry ready — ${this.servers.size} server(s) tracked.`);
    return this;
  }

  async #load() {
    const raw = readJsonSync(config.registryFile, null);
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : [];

    for (const definition of list) {
      try {
        const normalised = this.#normaliseDefinition(definition);
        this.definitions.set(normalised.id, normalised);
        const managed = new ManagedServer(normalised);
        this.#wire(managed);
        this.servers.set(normalised.id, managed);
      } catch (error) {
        log.error(`Skipping malformed server entry: ${error.message}`);
      }
    }
  }

  #wire(managed) {
    managed.on('console', (records) => this.emit('console', { serverId: managed.id, records }));
    managed.on('status', (payload) => this.emit('status', payload));
    managed.on('update', (snapshot) => this.emit('update', snapshot));
    managed.on('players', (payload) => this.emit('players', payload));
    managed.on('console-event', (payload) => this.emit('console-event', payload));
    managed.on('started', (payload) => {
      this.touch(managed.id, { lastStartedAt: Date.now() });
      this.emit('lifecycle', { ...payload, phase: 'started' });
    });
    managed.on('stopped', (payload) => {
      this.touch(managed.id, { lastStoppedAt: Date.now(), lastExitCode: payload.code });
      this.emit('lifecycle', { ...payload, phase: 'stopped' });
    });
    managed.on('crashed', (payload) => {
      this.touch(managed.id, { lastExitCode: payload.code, lastFailure: payload.failure });
      this.emit('lifecycle', { ...payload, phase: 'crashed' });
    });
    managed.on('scheduled-restart', (payload) => this.emit('lifecycle', { ...payload, phase: 'scheduled-restart' }));
  }

  /**
   * Fill in anything a definition might be missing (older file, manual edit,
   * partial import) so the rest of the app can assume a complete object.
   */
  #normaliseDefinition(input) {
    const id = String(input.id ?? '').trim();
    if (!id) throw new Error('missing id');
    const dir = path.resolve(String(input.dir ?? path.join(config.serversDir, id)));

    return {
      id,
      name: String(input.name ?? id),
      slug: String(input.slug ?? slugify(input.name ?? id)),
      platform: ['vanilla', 'paper', 'fabric'].includes(input.platform) ? input.platform : 'paper',
      version: String(input.version ?? ''),
      build: input.build ?? null,
      loader: input.loader ?? null,
      installer: input.installer ?? null,
      jarFile: String(input.jarFile ?? 'server.jar'),
      dir,
      java: {
        path: String(input.java?.path ?? ''),
        major: Number(input.java?.major ?? 21),
        vendor: input.java?.vendor ?? null,
        version: input.java?.version ?? null,
        autoSelected: input.java?.autoSelected ?? true,
      },
      memory: {
        minHeapMb: Number(input.memory?.minHeapMb ?? 1024),
        maxHeapMb: Number(input.memory?.maxHeapMb ?? 4096),
        gcProfile: input.memory?.gcProfile ?? 'aikar',
        preTouch: input.memory?.preTouch ?? true,
      },
      port: Number(input.port ?? config.defaultMcPort),
      // Mirrored from server.properties so the dashboard can render a server
      // card without reading and parsing the file on every list call.
      motd: String(input.motd ?? ''),
      maxPlayers: Number(input.maxPlayers ?? 20),
      viewDistance: Number(input.viewDistance ?? 10),
      simulationDistance: Number(input.simulationDistance ?? 10),
      gamemode: input.gamemode ?? 'survival',
      difficulty: input.difficulty ?? 'normal',
      onlineMode: input.onlineMode !== false,
      whiteList: Boolean(input.whiteList),
      jvmArgs: Array.isArray(input.jvmArgs) ? input.jvmArgs : [],
      // Concrete `-XX:` flags validated against the selected JDK. Cleared
      // whenever memory, GC profile or the Java runtime changes.
      jvmFlags: Array.isArray(input.jvmFlags) ? input.jvmFlags : null,
      jvmFlagsInfo: input.jvmFlagsInfo ?? null,
      serverArgs: Array.isArray(input.serverArgs) && input.serverArgs.length ? input.serverArgs : ['nogui'],
      autoRestart: {
        enabled: Boolean(input.autoRestart?.enabled),
        delayMs: Number(input.autoRestart?.delayMs ?? 5000),
        maxAttempts: Number(input.autoRestart?.maxAttempts ?? 5),
      },
      schedules: {
        restart: input.schedules?.restart ?? { enabled: false, mode: 'none', time: '04:00', intervalMinutes: 360, lastRun: null, nextRun: null },
        backup: input.schedules?.backup ?? { enabled: false, mode: 'none', time: '03:00', intervalMinutes: 1440, keep: 7, lastRun: null, nextRun: null },
      },
      options: {
        autoStart: Boolean(input.options?.autoStart),
        stopOnExit: input.options?.stopOnExit ?? true,
        backupBeforeRestart: input.options?.backupBeforeRestart ?? true,
        backupBeforeStart: Boolean(input.options?.backupBeforeStart),
        ...input.options,
      },
      tags: Array.isArray(input.tags) ? input.tags : [],
      notes: String(input.notes ?? ''),
      color: input.color ?? null,
      createdAt: Number(input.createdAt ?? Date.now()),
      updatedAt: Number(input.updatedAt ?? Date.now()),
      lastStartedAt: input.lastStartedAt ?? null,
      lastStoppedAt: input.lastStoppedAt ?? null,
      lastExitCode: input.lastExitCode ?? null,
      lastFailure: input.lastFailure ?? null,
      totalUptimeMs: Number(input.totalUptimeMs ?? 0),
      provisioned: input.provisioned !== false,
      javaRequirement: input.javaRequirement ?? null,
    };
  }

  /**
   * Reconcile persisted state with the real machine.
   * A JVM started before the manager restarted is *adopted* rather than killed —
   * our world would otherwise be full of orphaned servers.
   */
  async #reconcile() {
    // Restore each console's scrollback from its on-disk log first, so a
    // manager restart does not present an empty console.
    await Promise.allSettled(
      [...this.servers.values()].map(async (managed) => {
        const restored = await managed.console.seedFromDisk();
        if (restored) log.debug(`Restored ${restored} console line(s) for "${managed.id}" from disk`);
      }),
    );

    for (const managed of this.servers.values()) {
      const wasRunning = managed.def.status === 'running' || managed.def.status === 'starting';
      const pid = managed.def.lastPid;

      const alive = pid && (await isProcessAlive(pid));
      if (wasRunning && alive) {
        managed.pid = pid;
        managed.child = null;
        managed.startedAt = managed.def.lastStartedAt ?? Date.now();
        managed.status = STATUS.RUNNING;
        managed.adopted = true;
        managed.console.push(
          `\n[manager] Adopted a running server from a previous session (pid ${pid}).\n` +
            `[manager] Console input and graceful stop are unavailable for adopted processes — use Restart to take full control.\n\n`,
          'stdout',
        );
        log.info(`Adopted "${managed.def.name}" (pid ${pid})`);
      } else if (wasRunning) {
        managed.status = STATUS.STOPPED;
        managed.console.push(`\n[manager] The server was not running when the manager started.\n\n`, 'stdout');
      }

      // A definition may reference a JDK the user has since removed.
      if (managed.def.java?.path && !fs.existsSync(managed.def.java.path)) {
        managed.console.push(`\n[manager] Configured Java is missing: ${managed.def.java.path}\n`, 'stderr');
      }

      await this.#syncFromProperties(managed);
    }
    await this.#persist();
  }

  /**
   * Mirror the handful of `server.properties` values the UI displays into the
   * definition, so the dashboard is correct even when someone edits the file by
   * hand (or upgrades from a version that did not store them).
   */
  async #syncFromProperties(managed) {
    try {
      const raw = await fsp.readFile(path.join(managed.def.dir, 'server.properties'), 'utf8');
      const props = parseProperties(raw);
      const patch = {};
      const asInt = (value, fallback) => {
        const n = Number.parseInt(String(value ?? ''), 10);
        return Number.isFinite(n) ? n : fallback;
      };

      if (props.motd !== undefined && props.motd !== managed.def.motd) patch.motd = props.motd;
      if (props['max-players'] !== undefined && asInt(props['max-players'], null) !== managed.def.maxPlayers) {
        patch.maxPlayers = asInt(props['max-players'], 20);
      }
      if (props['view-distance'] !== undefined && asInt(props['view-distance'], null) !== managed.def.viewDistance) {
        patch.viewDistance = asInt(props['view-distance'], 10);
      }
      if (
        props['simulation-distance'] !== undefined &&
        asInt(props['simulation-distance'], null) !== managed.def.simulationDistance
      ) {
        patch.simulationDistance = asInt(props['simulation-distance'], 10);
      }
      if (props.gamemode && props.gamemode !== managed.def.gamemode) patch.gamemode = props.gamemode;
      if (props.difficulty && props.difficulty !== managed.def.difficulty) patch.difficulty = props.difficulty;
      if (props['online-mode'] !== undefined) patch.onlineMode = props['online-mode'] !== 'false';
      if (props['white-list'] !== undefined) patch.whiteList = props['white-list'] === 'true';

      // The port is authoritative in the registry, but flag a drift.
      const filePort = asInt(props['server-port'], null);
      if (filePort && filePort !== managed.def.port) {
        log.warn(
          `"${managed.id}": server.properties says port ${filePort} but the manager has ${managed.def.port}. ` +
            'The manager will write its value on the next settings save.',
        );
      }

      if (Object.keys(patch).length) {
        managed.def = { ...managed.def, ...patch };
        this.definitions.set(managed.id, managed.def);
      }
    } catch {
      /* no server.properties yet — nothing to sync */
    }
  }

  // -------------------------------------------------------------------------
  // Sampling loop
  // -------------------------------------------------------------------------

  #startSampler() {
    if (this.sampler) return;
    const tick = async () => {
      try {
        const pids = [];
        for (const managed of this.servers.values()) {
          if (managed.pid) pids.push(managed.pid);
        }

        const [samples] = await Promise.all([pids.length ? sampleProcesses(pids) : Promise.resolve(new Map())]);

        for (const managed of this.servers.values()) {
          if (!managed.pid) {
            // Nothing to sample; report 0 so the sparkline decays cleanly.
            if (managed.status === STATUS.STOPPED && managed.history.length && managed.metrics.sampledAt) {
              managed.metrics = { ...managed.metrics, cpuPercent: 0, rssBytes: 0, sampledAt: Date.now() };
            }
            continue;
          }
          const sample = samples.get(managed.pid);
          managed.applySample(sample);
          // Adopted or otherwise unspawned processes can vanish without an exit event.
          if (!sample && managed.adopted && managed.status !== STATUS.STOPPED) {
            const stillAlive = await isProcessAlive(managed.pid);
            if (!stillAlive) {
              managed.status = STATUS.STOPPED;
              managed.pid = null;
              managed.console.push('\n[manager] The adopted process is no longer running.\n', 'stdout');
              this.emit('status', { serverId: managed.id, status: STATUS.STOPPED, from: STATUS.RUNNING });
            }
          }
        }

        this.systemSample = { cpuPercent: systemCpuPercent(), memory: systemMemory(), sampledAt: Date.now() };
        this.emit('metrics', {
          servers: [...this.servers.values()].map((s) => s.metricsSnapshot()),
          system: this.systemSample,
        });
      } catch (error) {
        log.debug(`Sampler tick failed: ${error.message}`);
      }
    };

    this.sampler = setInterval(tick, config.statsIntervalMs);
    this.sampler.unref?.();
    // Prime the CPU delta immediately so the first real reading isn't 0.
    setTimeout(tick, 250).unref?.();
  }

  stopSampler() {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get(id) {
    const managed = this.servers.get(String(id));
    if (!managed) {
      const error = new Error(`No server with id "${id}".`);
      error.status = 404;
      throw error;
    }
    return managed;
  }

  /** Like `get` but returns `null` instead of throwing. */
  find(id) {
    return this.servers.get(String(id)) ?? null;
  }

  list({ includeConsole = false } = {}) {
    return [...this.servers.values()]
      .map((s) => s.snapshot({ includeConsole }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  summary() {
    const servers = [...this.servers.values()];
    const running = servers.filter((s) => isLive(s.status));
    const crashed = servers.filter((s) => s.status === STATUS.CRASHED);
    const totalPlayers = running.reduce((sum, s) => sum + s.onlineCount, 0);
    const ramUsedMb = running.reduce((sum, s) => sum + Math.round(s.metrics.rssBytes / 1024 / 1024), 0);
    const ramAllocatedMb = running.reduce((sum, s) => sum + (s.def.memory?.maxHeapMb ?? 0), 0);
    const cpuPercent = running.reduce((sum, s) => sum + s.metrics.cpuPercent, 0);

    return {
      total: servers.length,
      running: running.length,
      crashed: crashed.length,
      stopped: servers.length - running.length - crashed.length,
      totalPlayers,
      ramUsedMb,
      ramAllocatedMb,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      system: { ...this.systemSample, totalRamMb: totalRamMb() },
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Register a freshly provisioned server. */
  async add(definition) {
    const normalised = this.#normaliseDefinition(definition);
    if (this.servers.has(normalised.id)) {
      const error = new Error(`A server with the id "${normalised.id}" already exists.`);
      error.status = 409;
      throw error;
    }
    this.definitions.set(normalised.id, normalised);
    const managed = new ManagedServer(normalised);
    this.#wire(managed);
    this.servers.set(normalised.id, managed);
    await this.#persist();
    this.emit('created', managed.snapshot());
    return managed;
  }

  /**
   * Patch a server definition. Needs a restart to take effect, so we say so.
   * @param {string} id
   * @param {object} patch
   * @param {{ silent?: boolean }} [opts]
   */
  async update(id, patch, { silent = false } = {}) {
    const managed = this.get(id);
    const before = managed.def;
    const merged = this.#normaliseDefinition(deepMerge(before, patch));
    merged.id = before.id;
    merged.dir = before.dir; // directory is immutable via the API
    merged.updatedAt = Date.now();

    // Anything that changes the JVM command line invalidates the flag set we
    // previously validated against the target JDK.
    const flagsStale =
      JSON.stringify(before.memory) !== JSON.stringify(merged.memory) ||
      JSON.stringify(before.java) !== JSON.stringify(merged.java) ||
      JSON.stringify(before.jvmArgs) !== JSON.stringify(merged.jvmArgs);
    if (flagsStale) {
      merged.jvmFlags = null;
      merged.jvmFlagsInfo = null;
    }

    this.definitions.set(merged.id, merged);
    managed.def = merged;
    await this.#persist();

    if (flagsStale) {
      // Resolve eagerly so the stored definition always matches what will run.
      await ensureJvmFlags(managed.def).catch((error) =>
        log.debug(`Flag re-resolution failed for ${managed.id}: ${error.message}`),
      );
      this.definitions.set(managed.id, managed.def);
      await this.#persist();
    }

    const restartRequired = [
      ['port', before.port, merged.port],
      ['memory', JSON.stringify(before.memory), JSON.stringify(merged.memory)],
      ['java', JSON.stringify(before.java), JSON.stringify(merged.java)],
      ['jvmArgs', JSON.stringify(before.jvmArgs), JSON.stringify(merged.jvmArgs)],
      ['version', before.version, merged.version],
      ['platform', before.platform, merged.platform],
    ].some(([, a, b]) => a !== b);

    if (!silent) this.emit('updated', { ...managed.snapshot(), restartRequired });
    return { ...managed.snapshot(), restartRequired };
  }

  /** Lightweight bookkeeping writes that must not spam change events. */
  async touch(id, patch) {
    const managed = this.servers.get(String(id));
    if (!managed) return;
    managed.def = { ...managed.def, ...patch };
    this.definitions.set(managed.id, managed.def);
    try {
      await this.#persist();
    } catch (error) {
      log.debug(`touch() persist failed: ${error.message}`);
    }
  }

  /**
   * Remove a server. `deleteFiles` decides whether the world is destroyed too.
   */
  async remove(id, { deleteFiles = false } = {}) {
    const managed = this.get(id);
    if (isLive(managed.status)) {
      await managed.stop({ force: true, reason: 'delete' });
    }
    const dir = managed.def.dir;
    managed.dispose();
    this.servers.delete(managed.id);
    this.definitions.delete(managed.id);
    await this.#persist();

    if (deleteFiles) {
      // Safety: only ever delete inside the configured servers root.
      const resolvedDir = path.resolve(dir);
      const root = path.resolve(config.serversDir);
      if (resolvedDir === root || !resolvedDir.startsWith(root + path.sep)) {
        log.warn(`Refusing to delete "${resolvedDir}" — outside ${root}.`);
      } else {
        await removeDir(resolvedDir).catch((error) => log.error(`Failed to delete ${resolvedDir}: ${error.message}`));
      }
    }

    this.emit('deleted', { serverId: managed.id, id: managed.id, dir });
    return { id: managed.id, deletedFiles: deleteFiles, dir };
  }

  async #persist() {
    const payload = {
      version: REGISTRY_VERSION,
      updatedAt: Date.now(),
      servers: [...this.servers.values()].map((managed) => ({
        ...managed.def,
        status: managed.status,
        lastPid: managed.pid,
      })),
    };
    await writeJson(config.registryFile, payload).catch((error) => {
      log.error(`Could not persist registry: ${error.message}`);
      throw error;
    });
  }

  /** Force a write (used after lifecycle events mutate `def`). */
  persist() {
    return this.#persist();
  }

  /** Shut every JVM down cleanly, then stop sampling. */
  async shutdown({ force = false } = {}) {
    this.stopSampler();
    const live = [...this.servers.values()].filter((s) => isLive(s.status) && !s.adopted);
    if (!live.length) {
      await this.#persist().catch(() => {});
      return;
    }
    log.info(`Stopping ${live.length} server(s)…`);
    await Promise.allSettled(
      live.map((s) => s.stop({ force, timeoutMs: force ? 3000 : 20_000, reason: 'manager-shutdown' })),
    );
    await this.#persist().catch(() => {});
  }

  /** Auto-start anything flagged for it (called once at boot). */
  async autoStart() {
    const targets = [...this.servers.values()].filter(
      (s) => s.def.options?.autoStart && s.status === STATUS.STOPPED && s.def.provisioned !== false,
    );
    for (const managed of targets) {
      log.info(`Auto-starting "${managed.def.name}"`);
      managed.start({ reason: 'auto-start' }).catch((error) => log.error(`Auto-start failed for ${managed.id}: ${error.message}`));
      // Stagger to avoid a thundering herd on a busy machine.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return targets.length;
  }
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export class Provisioner {
  /**
   * @param {ServerRegistry} registry
   * @param {{ onProgress?: (progress: object) => void }} [opts]
   */
  constructor(registry, { onProgress } = {}) {
    this.registry = registry;
    this.onProgress = onProgress;
  }

  #report(jobId, step, index, total, message, extra = {}) {
    this.onProgress?.({
      jobId,
      step,
      stepIndex: index,
      totalSteps: total,
      message,
      percent: Math.round(((index + (extra.stepComplete ? 1 : 0)) / total) * 100),
      ...extra,
    });
  }

  /**
   * Dry-run: resolve everything that *would* happen so the wizard can show it
   * before the user commits (download size, Java requirement, warnings).
   */
  async preflight(spec) {
    const [plan, java] = await Promise.all([planDownload(spec), javaSummary()]);
    const nonWindowsSlug = slugify(spec.name ?? `${spec.platform}-${spec.version}`);
    const existing = this.registry.list().find((s) => s.slug === nonWindowsSlug);

    const match = pickJava(java.installations, plan.javaMajor);
    const warnings = [];

    if (!match.java) {
      warnings.push({
        level: 'error',
        title: `Java ${plan.javaMajor} is required but not installed`,
        detail: 'Install a matching JDK, or let the manager download one from Adoptium during setup.',
      });
    } else if (match.reason === 'older') {
      warnings.push({
        level: 'error',
        title: `Java ${match.java.major} is too old for Minecraft ${plan.version}`,
        detail: `This server needs Java ${plan.javaMajor}. Install it before starting.`,
      });
    } else if (match.reason === 'newer') {
      warnings.push({
        level: 'warn',
        title: `Using Java ${match.java.major} instead of Java ${plan.javaMajor}`,
        detail: 'Newer JVMs normally work, but an exact match is safest for older versions.',
      });
    }

    if (existing) {
      warnings.push({ level: 'warn', title: `A server named "${existing.name}" already exists`, detail: 'A unique suffix will be appended to the folder name.' });
    }

    const port = Number(spec.port ?? config.defaultMcPort);
    if (!(await isPortFree(port))) {
      warnings.push({ level: 'warn', title: `Port ${port} looks busy`, detail: 'Pick another port or stop whatever is using it.' });
    }

    const plan2 = planResources({
      javaMajor: plan.javaMajor,
      systemRamMb: totalRamMb(),
      requestedHeapMb: spec.memory?.maxHeapMb,
      gcProfile: spec.memory?.gcProfile,
      reservedMb: config.reservedRamMb,
      maxOverrideMb: config.maxHeapMbOverride,
    });

    return {
      plan: {
        ...plan,
        suggestedHeapMb: plan2.maxHeapMb,
        heapCeilingMb: plan2.ceilingMb,
      },
      java: { installations: java.installations, match: match.java, reason: match.reason, requiredMajor: plan.javaMajor },
      warnings,
      slug: nonWindowsSlug,
      port,
      portFree: await isPortFree(port),
    };
  }

  /**
   * The full end-to-end creation pipeline.
   *
   * @param {object} spec
   * @param {{ jobId?: string, autoDownloadJava?: boolean }} [opts]
   */
  async provision(spec, { jobId = crypto.randomUUID(), autoDownloadJava = config.autoDownloadJava } = {}) {
    const total = 9;
    const report = (step, index, message, extra) => this.#report(jobId, step, index, total, message, extra);

    // -- 0. validate ------------------------------------------------------
    if (!spec?.platform || !spec?.version) {
      const error = new Error('A platform and a Minecraft version are required.');
      error.status = 400;
      throw error;
    }

    report('resolve', 0, 'Resolving version metadata…');
    const plan = await planDownload(spec);

    const slug = await this.#uniqueSlug(spec.name ?? `${spec.platform}-${plan.version}`);
    const dir = path.join(config.serversDir, slug);
    await ensureDir(dir);

    // -- 1. download the server jar ---------------------------------------
    report('download', 1, `Downloading ${plan.platformLabel} ${plan.version}…`);
    const jarFile = spec.jarFile?.trim() || 'server.jar';
    const jarPath = safeJoin(dir, jarFile);
    const dl = await download(plan.url, jarPath, {
      expectedSha256: plan.sha256,
      expectedSha1: plan.sha1,
      onProgress: ({ percent, received, total: bytes, speedBps }) =>
        report('download', 1, `Downloading ${path.basename(jarFile)}…`, {
          percentOverride: percent,
          detail: `${(received / 1024 / 1024).toFixed(1)} / ${bytes ? (bytes / 1024 / 1024).toFixed(1) : '?'} MiB · ${(speedBps / 1024 / 1024).toFixed(1)} MiB/s`,
        }),
    });
    log.info(`Downloaded ${jarFile} (${(dl.bytes / 1024 / 1024).toFixed(1)} MiB) for "${slug}"`);

    // -- 2. resolve Java ---------------------------------------------------
    report('java', 2, `Locating Java ${plan.javaMajor}…`);
    let installations = await detectJava();
    let match = pickJava(installations, plan.javaMajor);

    if ((!match.java || match.java.major < plan.javaMajor) && autoDownloadJava) {
      report('java', 2, `Java ${plan.javaMajor} is missing — downloading Temurin…`);
      const { installJdk } = await import('./javaDetect.js');
      await installJdk(plan.javaMajor, {
        onProgress: ({ percent, received, total: bytes }) =>
          report('java', 2, `Downloading Java ${plan.javaMajor}…`, {
            percentOverride: percent,
            detail: `${(received / 1024 / 1024).toFixed(0)} / ${bytes ? (bytes / 1024 / 1024).toFixed(0) : '?'} MiB`,
          }),
      });
      installations = await detectJava({ force: true });
      match = pickJava(installations, plan.javaMajor);
    }

    if (!match.java || match.java.major < plan.javaMajor) {
      const error = new Error(
        match.java
          ? `Java ${plan.javaMajor} is required for Minecraft ${plan.version}, but the newest JDK found is Java ${match.java.major}. ` +
            'Install a matching JDK (Settings › Java) or enable automatic downloads.'
          : `No Java runtime was found on this machine. Minecraft ${plan.version} needs Java ${plan.javaMajor}. ` +
            'Install a JDK, or enable automatic Java downloads in the create wizard.',
      );
      error.status = 412;
      error.detail = { requiredMajor: plan.javaMajor, found: installations.map((i) => i.major) };
      throw error;
    }

    const java = match.java;

    // -- 3. EULA -----------------------------------------------------------
    report('eula', 3, 'Accepting the Minecraft EULA…');
    await atomicWrite(
      path.join(dir, 'eula.txt'),
      `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#Accepted by Minecraft Server Manager on ${new Date().toUTCString()}\neula=true\n`,
    );

    // -- 4. server.properties ---------------------------------------------
    report('properties', 4, 'Writing optimised server.properties…');
    const port = Number(spec.port ?? config.defaultMcPort);
    const properties = defaultServerProperties({
      motd: spec.motd || `${spec.name ?? 'Minecraft Server'} — powered by Minecraft Server Manager`,
      port,
      maxPlayers: spec.maxPlayers ?? 20,
      viewDistance: spec.viewDistance ?? 10,
      simulationDistance: spec.simulationDistance ?? 8,
      difficulty: spec.difficulty ?? 'normal',
      gamemode: spec.gamemode ?? 'survival',
      onlineMode: spec.onlineMode !== false,
      seed: spec.seed ?? '',
      levelType: spec.levelType ?? 'minecraft:normal',
      whiteList: Boolean(spec.whiteList),
      hardcore: Boolean(spec.hardcore),
      pvp: spec.pvp !== false,
    });

    // Merge anything already present so re-provisioning never loses settings.
    let existing = {};
    try {
      existing = parseProperties(await fsp.readFile(path.join(dir, 'server.properties'), 'utf8'));
    } catch {
      /* first run */
    }

    await atomicWrite(
      path.join(dir, 'server.properties'),
      stringifyProperties({ ...properties, ...existing }, undefined, {
        header: `Minecraft server properties\nGenerated by Minecraft Server Manager for "${spec.name ?? slug}"\n${new Date().toUTCString()}`,
      }),
    );

    // -- 5. memory plan ----------------------------------------------------
    report('memory', 5, 'Sizing the JVM heap…');
    const resources = planResources({
      javaMajor: java.major,
      systemRamMb: totalRamMb(),
      requestedHeapMb: spec.memory?.maxHeapMb,
      gcProfile: spec.memory?.gcProfile,
      reservedMb: config.reservedRamMb,
      maxOverrideMb: config.maxHeapMbOverride,
    });

    // -- 6. startup scripts ------------------------------------------------
    report('scripts', 6, 'Generating startup scripts…');
    const definition = {
      id: slug,
      name: spec.name?.trim() || slug,
      slug,
      platform: plan.platform,
      version: plan.version,
      build: plan.build ?? null,
      loader: plan.loader ?? null,
      installer: plan.installer ?? null,
      jarFile,
      dir,
      java: { path: java.path, major: java.major, vendor: java.vendor, version: java.version, autoSelected: true },
      memory: { minHeapMb: resources.minHeapMb, maxHeapMb: resources.maxHeapMb, gcProfile: resources.gcProfile, preTouch: resources.preTouch },
      port,
      serverArgs: ['nogui'],
      jvmArgs: Array.isArray(spec.jvmArgs) ? spec.jvmArgs : [],
      autoRestart: { enabled: Boolean(spec.autoRestart), delayMs: 5000, maxAttempts: 5 },
      options: { autoStart: Boolean(spec.autoStart), stopOnExit: true, backupBeforeRestart: true },
      notes: spec.notes ?? '',
      color: spec.color ?? null,
      tags: Array.isArray(spec.tags) ? spec.tags : [],
      createdAt: Date.now(),
      javaRequirement: { major: plan.javaMajor, source: plan.javaSource, note: plan.javaNote },
      provisioned: true,
    };

    await writeStartScripts(definition);

    // -- 7. auxiliary JSON -------------------------------------------------
    report('config', 7, 'Preparing whitelist / ops files…');
    await Promise.all([
      writeIfMissing(path.join(dir, 'ops.json'), []),
      writeIfMissing(path.join(dir, 'whitelist.json'), []),
      writeIfMissing(path.join(dir, 'banned-players.json'), []),
      writeIfMissing(path.join(dir, 'banned-ips.json'), []),
      atomicWrite(
        path.join(dir, 'SERVER-README.txt'),
        buildReadme(definition, plan),
      ),
    ]);

    // -- 8. register -------------------------------------------------------
    report('register', 8, 'Registering the server…');
    const managed = await this.registry.add(definition);

    report('done', total, 'Server created.', { stepComplete: true, percentOverride: 100 });

    if (spec.startAfterCreate) {
      report('start', total, 'Starting the server…', { percentOverride: 100 });
      managed.start({ reason: 'created' }).catch((error) => log.error(`Initial start failed: ${error.message}`));
    }

    return { server: managed.snapshot(), plan: { ...plan, url: undefined }, java, resources, jobId };
  }

  async #uniqueSlug(name) {
    const base = slugify(name);
    let slug = base;
    let n = 2;
    while (await pathExists(path.join(config.serversDir, slug))) {
      slug = `${base}-${n}`;
      n += 1;
      if (n > 999) throw new Error('Could not find a free folder name.');
    }
    return slug;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(file, value) {
  if (await pathExists(file)) return;
  if (value === undefined) return;
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Markdown-ish README dropped into every server folder. */
function buildReadme(definition, plan) {
  return [
    `${definition.name}`,
    '='.repeat(definition.name.length),
    '',
    `Platform : ${plan.platformLabel}${plan.build ? ` (build ${plan.build})` : ''}${plan.loader ? ` (loader ${plan.loader})` : ''}`,
    `Version  : ${plan.version}`,
    `Created  : ${new Date().toISOString()}`,
    `Managed by: Minecraft Server Manager`,
    '',
    'Starting this server',
    '-------------------',
    '  Windows : double-click start.bat',
    '  Linux   : ./start.sh',
    '',
    'Or start it from the manager dashboard, which is recommended: the manager',
    'tracks uptime, resources, backups and scheduled restarts for you.',
    '',
    'Files worth knowing',
    '-------------------',
    '  server.properties  gameplay + network settings',
    '  eula.txt           you accepted Mojang\u2019s EULA when this server was created',
    '  ops.json           server operators',
    '  whitelist.json     allowed players (enable with white-list=true)',
    `  ${definition.jarFile}${' '.repeat(Math.max(1, 18 - definition.jarFile.length))}the server`,
    '',
    'Memory',
    '------',
    `  This server is configured for ${definition.memory.minHeapMb}–${definition.memory.maxHeapMb} MiB of heap`,
    `  using the "${definition.memory.gcProfile}" GC profile on Java ${definition.java.major}.`,
    '',
    `  To shrink the world before archiving, run:  save-off` + '\n' + '  then zip the world folder, then run: save-on',
    '',
  ].join('\n');
}

/** Write `start.bat` (Windows) and `start.sh` (POSIX) for manual launching. */
export async function writeStartScripts(definition) {
  // Use the flag set validated against this JDK so a hand-launched server gets
  // exactly the same JVM options as one started from the dashboard.
  const { ensureJvmFlags } = await import('./jvmFlags.js');
  await ensureJvmFlags(definition);

  const jvmArgs = definition.jvmFlags ?? buildJvmArgs({
    javaMajor: definition.java.major,
    minHeapMb: definition.memory.minHeapMb,
    maxHeapMb: definition.memory.maxHeapMb,
    gcProfile: definition.memory.gcProfile,
    preTouch: definition.memory.preTouch,
    extraArgs: definition.jvmArgs,
  });

  const jar = definition.jarFile;
  const serverArgs = (definition.serverArgs ?? ['nogui']).join(' ');
  const title = `${definition.name} — Minecraft ${definition.version}`;

  const bat = [
    '@echo off',
    'setlocal',
    `title ${title}`,
    'cd /d "%~dp0"',
    '',
    `set "JAVA=${definition.java.path}"`,
    'if not exist "%JAVA%" (',
    '  echo [ERROR] Java was not found at the configured path:',
    '  echo         %JAVA%',
    '  echo         Edit start.bat, or re-detect Java from the manager dashboard.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'echo Starting ' + definition.name + ' on Java ' + definition.java.major + '...',
    'echo.',
    '',
    ':loop',
    '"%JAVA%" ' + jvmArgs.map(quoteBat).join(' ') + ` -jar "${jar}" ${serverArgs}`.trim(),
    'set EXITCODE=%ERRORLEVEL%',
    'echo.',
    `echo Server stopped with exit code %EXITCODE%.`,
    'if "%EXITCODE%"=="0" goto :end',
    'if /i not "' + (definition.autoRestart?.enabled ? 'yes' : 'no') + '"=="yes" goto :end',
    'echo Restarting in 10 seconds... (press Ctrl+C to abort)',
    'timeout /t 10 /nobreak >nul',
    'goto :loop',
    '',
    ':end',
    'pause',
    'endlocal',
    '',
  ].join('\r\n');

  const sh = [
    '#!/usr/bin/env bash',
    '# ' + title,
    'set -u',
    'cd "$(dirname "$0")" || exit 1',
    '',
    `JAVA=${shellQuote(definition.java.path)}`,
    'if [ ! -x "$JAVA" ]; then',
    '  echo "[ERROR] Java was not found at: $JAVA" >&2',
    '  echo "        Edit start.sh or re-detect Java in the manager." >&2',
    '  exit 1',
    'fi',
    '',
    'echo "Starting ' + definition.name.replace(/"/g, '') + ' on Java ' + definition.java.major + '..."',
    '',
    'while true; do',
    `  "$JAVA" ${jvmArgs.map(shellQuote).join(' ')} -jar ${shellQuote(jar)} ${serverArgs}`,
    '  code=$?',
    '  echo',
    '  echo "Server stopped with exit code $code."',
    '  [ "$code" -eq 0 ] && break',
    (definition.autoRestart?.enabled
      ? '  echo "Restarting in 10 seconds... (Ctrl+C to abort)"\n  sleep 10'
      : '  break'),
    'done',
    '',
  ].join('\n');

  await Promise.all([
    atomicWrite(path.join(definition.dir, 'start.bat'), bat),
    atomicWrite(path.join(definition.dir, 'start.sh'), sh).then(() =>
      fsp.chmod(path.join(definition.dir, 'start.sh'), 0o755).catch(() => {}),
    ),
  ]);
}

const quoteBat = (arg) => (/[\s&|<>^"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
const shellQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;

function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? target : patch;
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof target?.[key] === 'object' && !Array.isArray(target[key])) {
      out[key] = deepMerge(target[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** TCP probe: is anything already listening on this port? */
export async function isPortFree(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    try {
      tester.listen({ port: Number(port), host: '0.0.0.0', exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

/** Is a PID alive right now? */
export async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs an existence + permission check without killing.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** First free port at or above `start`. */
export async function findFreePort(start = config.defaultMcPort, attempts = 60) {
  for (let port = start; port < start + attempts; port += 1) {
    if (await isPortFree(port)) return port;
  }
  const error = new Error(`No free port found between ${start} and ${start + attempts}.`);
  error.status = 409;
  throw error;
}

export { PLATFORM_INFO, STATUS };
export default ServerRegistry;
