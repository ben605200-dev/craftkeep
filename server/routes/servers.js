/**
 * `/api/servers` — CRUD, lifecycle, console, players, properties, schedules.
 *
 * Every mutating route is safe to call from automation: they return the updated
 * server snapshot, so an external script never has to follow up with a GET.
 */

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { asyncHandler, validateBody } from './middleware.js';
import { isLive } from '../lib/processManager.js';
import {
  PROPERTY_SCHEMA,
  PROPERTY_GROUPS,
  parseProperties,
  stringifyProperties,
  normaliseProperties,
  validateProperties,
  SERVER_PROPERTIES_ORDER,
} from '../lib/properties.js';
import { normaliseSchedule, computeNextRun } from '../lib/scheduler.js';
import { safeJoin, atomicWrite, formatBytes, directorySize, formatDuration } from '../lib/fsUtil.js';
import { createBackup, listBackups, deleteBackup, restoreBackup, pruneBackups } from '../lib/backup.js';
import { pingServer } from '../lib/slp.js';
import { connectionSummary, applyFirewallRule, localAddress, publicAddress, classifyWanAddress } from '../lib/network.js';
import { discoverGateway, addMapping, removeMapping, portForwardingStatus } from '../lib/upnp.js';
import { findFreePort, isPortFree, writeStartScripts } from '../lib/registry.js';
import { inspectJava } from '../lib/javaDetect.js';
import { buildJvmArgs, planResources } from '../lib/versionRules.js';
import { totalRamMb } from '../lib/stats.js';
import createLogger from '../logger.js';

const log = createLogger('api:servers');

/**
 * @param {{ registry: import('../lib/registry.js').ServerRegistry, scheduler: object, gateway: object, provisioner: object }} deps
 */
export function serverRoutes({ registry, scheduler, gateway, provisioner }) {
  const router = express.Router();

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  router.get('/', (req, res) => {
    const servers = registry.list();
    res.json({
      servers,
      summary: registry.summary(),
      totalUptimeMs: servers.reduce((sum, s) => sum + (s.totalUptimeMs ?? 0), 0),
    });
  });

  router.get('/summary', (req, res) => res.json(registry.summary()));

  /** Free port discovery, used by the create wizard's "auto" button. */
  router.get('/available-port', asyncHandler(async (req, res) => {
    const start = Number.parseInt(req.query.start, 10) || config.defaultMcPort;
    const port = await findFreePort(start);
    res.json({ port, start });
  }));

  // -------------------------------------------------------------------------
  // Provisioning
  // -------------------------------------------------------------------------

  const createSchema = {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    platform: { type: 'string', enum: ['vanilla', 'paper', 'fabric'] },
    version: { type: 'string', minLength: 1, maxLength: 40 },
    build: {},
    loader: { type: 'string', maxLength: 40 },
    installer: { type: 'string', maxLength: 40 },
    jarFile: { type: 'string', maxLength: 80, pattern: /^[^\\/:*?"<>|]+\.jar$/i, message: 'The jar filename must end in .jar and contain no path separators.' },
    motd: { type: 'string', maxLength: 120 },
    port: { type: 'int', min: 1, max: 65535 },
    maxPlayers: { type: 'int', min: 1, max: 1000 },
    viewDistance: { type: 'int', min: 3, max: 32 },
    simulationDistance: { type: 'int', min: 3, max: 32 },
    difficulty: { type: 'string', enum: ['peaceful', 'easy', 'normal', 'hard'] },
    gamemode: { type: 'string', enum: ['survival', 'creative', 'adventure', 'spectator'] },
    levelType: { type: 'string', maxLength: 60 },
    seed: { type: 'string', maxLength: 64 },
    onlineMode: { type: 'bool' },
    whiteList: { type: 'bool' },
    hardcore: { type: 'bool' },
    pvp: { type: 'bool' },
    autoRestart: { type: 'bool' },
    autoStart: { type: 'bool' },
    startAfterCreate: { type: 'bool' },
    autoDownloadJava: { type: 'bool' },
    memory: { type: 'object' },
    jvmArgs: { type: 'array', maxItems: 40 },
    notes: { type: 'string', maxLength: 2000 },
    tags: { type: 'array', maxItems: 12 },
    color: { type: 'string', maxLength: 20 },
  };

  /** Dry run: what would happen, what is missing, what needs downloading. */
  router.post('/preflight', validateBody(createSchema), asyncHandler(async (req, res) => {
    const result = await provisioner.preflight({ ...req.validated, name: req.validated.name ?? `${req.validated.platform}-${req.validated.version}` });
    res.json(result);
  }));

  /** Create + provision a server. Progress streams over the WebSocket. */
  router.post('/', validateBody(createSchema), asyncHandler(async (req, res) => {
    const spec = req.validated;
    const jobId = req.get('x-job-id') || undefined;

    // Fail fast on the obvious stuff before we start writing to disk.
    const port = spec.port ?? (await findFreePort(config.defaultMcPort));
    if (spec.port && !(await isPortFree(spec.port))) {
      return res.status(409).json({
        error: `Port ${spec.port} is already in use.`,
        code: 'port-busy',
        hint: 'Pick another port — the wizard can suggest a free one automatically.',
      });
    }

    const result = await provisioner.provision({ ...spec, port }, { jobId, autoDownloadJava: spec.autoDownloadJava });
    gateway?.jobDone(jobId ?? result.jobId, { result: { serverId: result.server.id } });
    res.status(201).json(result);
  }));

  // -------------------------------------------------------------------------
  // Single server
  // -------------------------------------------------------------------------

  router.get('/:id', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const includeConsole = req.query.console === 'true';
    const withDisk = req.query.disk === 'true';

    const snapshot = managed.snapshot({
      includeConsole,
      consoleLimit: Math.min(Number(req.query.limit) || 400, config.consoleBufferSize),
    });

    if (withDisk) {
      const [size, backups] = await Promise.all([
        directorySize(managed.def.dir).catch(() => ({ bytes: 0, files: 0, dirs: 0 })),
        listBackups(managed.id).catch(() => []),
      ]);
      snapshot.disk = { ...size, formatted: formatBytes(size.bytes) };
      snapshot.backupCount = backups.length;
      snapshot.backupBytes = backups.reduce((sum, b) => sum + b.bytes, 0);
    }

    res.json(snapshot);
  }));

  router.patch('/:id', validateBody({
    name: { type: 'string', minLength: 1, maxLength: 60 },
    motd: { type: 'string', maxLength: 120 },
    notes: { type: 'string', maxLength: 2000 },
    tags: { type: 'array', maxItems: 12 },
    color: { type: 'string', maxLength: 20 },
    port: { type: 'int', min: 1, max: 65535 },
    memory: { type: 'object' },
    jvmArgs: { type: 'array', maxItems: 40 },
    serverArgs: { type: 'array', maxItems: 20 },
    autoRestart: { type: 'object' },
    options: { type: 'object' },
    schedules: { type: 'object' },
    java: { type: 'object' },
  }), asyncHandler(async (req, res) => {
    const patch = { ...req.validated };

    // Normalise nested structures so a partial patch cannot corrupt them.
    if (patch.schedules) {
      patch.schedules = {
        ...(patch.schedules.restart ? { restart: normaliseSchedule(patch.schedules.restart, 'restart') } : {}),
        ...(patch.schedules.backup ? { backup: normaliseSchedule(patch.schedules.backup, 'backup') } : {}),
      };
      for (const kind of ['restart', 'backup']) {
        if (patch.schedules[kind]) patch.schedules[kind].nextRun = computeNextRun(patch.schedules[kind]);
      }
    }
    if (patch.autoRestart) {
      patch.autoRestart = {
        enabled: Boolean(patch.autoRestart.enabled),
        delayMs: Math.max(1000, Math.min(600_000, Number(patch.autoRestart.delayMs) || 5000)),
        maxAttempts: Math.max(1, Math.min(50, Number(patch.autoRestart.maxAttempts) || 5)),
      };
    }
    if (patch.memory) {
      const managed = registry.get(req.params.id);
      patch.memory = {
        minHeapMb: Math.max(256, Math.min(65536, Number(patch.memory.minHeapMb) || managed.def.memory.minHeapMb)),
        maxHeapMb: Math.max(256, Math.min(65536, Number(patch.memory.maxHeapMb) || managed.def.memory.maxHeapMb)),
        gcProfile: ['aikar', 'zgc', 'none'].includes(patch.memory.gcProfile) ? patch.memory.gcProfile : managed.def.memory.gcProfile,
        preTouch: patch.memory.preTouch !== false,
      };
      if (patch.memory.minHeapMb > patch.memory.maxHeapMb) patch.memory.minHeapMb = patch.memory.maxHeapMb;
    }
    if (patch.java?.path) {
      const info = await inspectJava(patch.java.path);
      patch.java = { path: info.path, major: info.major, vendor: info.vendor, version: info.version, autoSelected: false };
    }

    const result = await registry.update(req.params.id, patch);

    // Startup scripts embed the heap/JVM settings, so keep them in sync.
    if (patch.memory || patch.jvmArgs || patch.java) {
      const managed = registry.get(req.params.id);
      await writeStartScripts(managed.def).catch((error) => log.warn(`Could not refresh start scripts: ${error.message}`));
    }

    res.json(result);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const deleteFiles = req.query.deleteFiles === 'true';
    if (deleteFiles && req.query.confirm !== 'yes') {
      return res.status(400).json({
        error: 'Deleting the world files requires ?confirm=yes.',
        code: 'confirmation-required',
        hint: 'This permanently removes the server directory and every world inside it.',
      });
    }
    const result = await registry.remove(req.params.id, { deleteFiles });
    res.json(result);
  }));

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  router.post('/:id/start', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    if (isLive(managed.status)) {
      return res.status(409).json({ error: 'Server is already running.', code: 'already-running' });
    }
    const wait = req.query.wait === 'true';
    const snapshot = await managed.start({ waitForReady: wait });
    res.json(snapshot);
  }));

  router.post('/:id/stop', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const force = req.query.force === 'true';
    const snapshot = await managed.stop({ force, reason: 'api' });
    res.json(snapshot);
  }));

  router.post('/:id/restart', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    // Answer immediately; a restart takes as long as a boot.
    managed.restart({ reason: 'api' }).catch((error) => log.error(`Restart failed for ${managed.id}: ${error.message}`));
    res.status(202).json({ ...managed.snapshot(), accepted: true });
  }));

  router.post('/:id/kill', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const snapshot = await managed.stop({ force: true, timeoutMs: 1500, reason: 'force-kill' });
    res.json(snapshot);
  }));

  router.post('/:id/cancel-schedule', asyncHandler(async (req, res) => {
    scheduler.cancel(req.params.id);
    res.json({ cancelled: true, serverId: req.params.id });
  }));

  /**
   * Clear `server-ip`.
   *
   * The single most common way to break a server: putting a domain name in
   * `server-ip` because it reads like "the address players use". It is actually
   * the local interface to bind, so a hostname there fails to resolve and the
   * server dies on startup with UnknownHostException. Empty is correct.
   */
  router.post('/:id/fix/bind-address', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const file = path.join(managed.def.dir, 'server.properties');

    let current = {};
    try {
      current = parseProperties(await fsp.readFile(file, 'utf8'));
    } catch {
      /* no properties file yet */
    }

    const previous = String(current['server-ip'] ?? '');
    current['server-ip'] = '';

    await atomicWrite(
      file,
      stringifyProperties(current, SERVER_PROPERTIES_ORDER, {
        header: `Minecraft server properties\nManaged by Minecraft Server Manager\nLast edited ${new Date().toUTCString()}`,
      }),
    );

    managed.console.push(
      `\n[manager] Cleared server-ip${previous ? ` (was "${previous}")` : ''}. ` +
        'The server now listens on every interface — players connect using your domain or IP, ' +
        'which is handled by your router, not by this setting.\n\n',
      'stdout',
    );
    managed.failure = null;

    res.json({ ok: true, previous, values: current, server: managed.snapshot() });
  }));

  router.post('/:id/accept-eula', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    await atomicWrite(
      path.join(managed.def.dir, 'eula.txt'),
      `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#Accepted via Minecraft Server Manager on ${new Date().toUTCString()}\neula=true\n`,
    );
    managed.console.push('\n[manager] eula.txt updated to eula=true.\n\n', 'stdout');
    managed.failure = null;
    res.json({ ok: true, server: managed.snapshot() });
  }));

  // -------------------------------------------------------------------------
  // Console
  // -------------------------------------------------------------------------

  router.get('/:id/console', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 500, config.consoleBufferSize);
    const search = req.query.search;
    const records = search ? managed.console.search(String(search), limit) : managed.console.tail(limit);
    res.json({
      records,
      lastSeq: managed.console.lastSeq,
      total: managed.console.records.length,
      status: managed.status,
      onlineCount: managed.onlineCount,
    });
  }));

  router.post('/:id/console', validateBody({
    command: { type: 'string', minLength: 1, maxLength: 1000 },
    silent: { type: 'bool' },
  }), asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    managed.send(req.validated.command, { silent: req.validated.silent });
    res.json({ ok: true, command: req.validated.command });
  }));

  router.get('/:id/console/export', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const format = req.query.format === 'json' ? 'json' : 'text';
    const body = managed.console.export({ format });
    const filename = `${managed.def.slug}-console-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'log'}`;
    res.setHeader('content-type', format === 'json' ? 'application/json' : 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }));

  // -------------------------------------------------------------------------
  // Players / ops / whitelist / bans
  // -------------------------------------------------------------------------

  const PLAYER_FILES = {
    ops: { file: 'ops.json', command: (name) => `op ${name}` },
    whitelist: { file: 'whitelist.json', command: (name) => `whitelist add ${name}` },
    banned: { file: 'banned-players.json', command: (name) => `ban ${name}` },
  };

  const readPlayerFile = async (dir, file) => {
    try {
      const raw = await fsp.readFile(path.join(dir, file), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  router.get('/:id/players', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const [ops, whitelist, banned, ips] = await Promise.all([
      readPlayerFile(managed.def.dir, 'ops.json'),
      readPlayerFile(managed.def.dir, 'whitelist.json'),
      readPlayerFile(managed.def.dir, 'banned-players.json'),
      readPlayerFile(managed.def.dir, 'banned-ips.json'),
    ]);
    res.json({
      ...managed.allPlayersSummary(),
      ops,
      whitelist,
      banned,
      bannedIps: ips,
      files: {
        ops: path.join(managed.def.dir, 'ops.json'),
        whitelist: path.join(managed.def.dir, 'whitelist.json'),
      },
    });
  }));

  /**
   * Prefer driving the live server through the console (instant + validated by
   * the server itself); fall back to editing the JSON file when it is offline.
   */
  router.post('/:id/players/:list', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const list = req.params.list;
    const spec = PLAYER_FILES[list];
    if (!spec) {
      return res.status(400).json({ error: `Unknown player list "${list}".`, code: 'bad-list' });
    }

    const action = String(req.body?.action ?? 'add');
    const name = String(req.body?.name ?? '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
      return res.status(400).json({
        error: 'That is not a valid Minecraft username.',
        code: 'bad-username',
        hint: 'Usernames are 1–16 characters: letters, numbers and underscores.',
      });
    }

    const removals = { ops: `deop ${name}`, whitelist: `whitelist remove ${name}`, banned: `pardon ${name}` };

    if (isLive(managed.status) && !managed.adopted) {
      const command = action === 'remove' ? removals[list] : spec.command(name);
      managed.send(command);
      return res.json({ ok: true, applied: 'console', command, player: name, list, action });
    }

    // Offline path — edit the file directly, preserving the shape the server expects.
    const filePath = path.join(managed.def.dir, spec.file);
    const entries = await readPlayerFile(managed.def.dir, spec.file);
    const filtered = entries.filter((e) => String(e.name ?? '').toLowerCase() !== name.toLowerCase());

    if (action === 'remove') {
      await atomicWrite(filePath, `${JSON.stringify(filtered, null, 2)}\n`);
      return res.json({ ok: true, applied: 'file', player: name, list, action, count: filtered.length });
    }

    const entry =
      list === 'ops'
        ? { uuid: '00000000-0000-0000-0000-000000000000', name, level: Number(req.body?.level) || 4, bypassesPlayerLimit: Boolean(req.body?.bypassesPlayerLimit) }
        : list === 'whitelist'
          ? { uuid: '00000000-0000-0000-0000-000000000000', name }
          : { uuid: '00000000-0000-0000-0000-000000000000', name, created: new Date().toISOString(), source: 'Minecraft Server Manager', expires: 'forever', reason: String(req.body?.reason ?? 'Banned by an operator.') };

    filtered.push(entry);
    await atomicWrite(filePath, `${JSON.stringify(filtered, null, 2)}\n`);
    res.json({ ok: true, applied: 'file', player: name, list, action, count: filtered.length });
  }));

  // -------------------------------------------------------------------------
  // server.properties
  // -------------------------------------------------------------------------

  router.get('/:id/properties', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const file = path.join(managed.def.dir, 'server.properties');
    let values = {};
    try {
      values = parseProperties(await fsp.readFile(file, 'utf8'));
    } catch {
      /* not generated yet */
    }
    res.json({
      values,
      schema: PROPERTY_SCHEMA,
      groups: PROPERTY_GROUPS,
      order: SERVER_PROPERTIES_ORDER,
      path: file,
      restartRequiredKeys: ['server-port', 'level-name', 'level-type', 'level-seed', 'online-mode', 'enable-rcon', 'rcon.port', 'query.port', 'enable-query', 'max-tick-time'],
    });
  }));

  router.put('/:id/properties', validateBody({
    values: { type: 'object', optional: false },
    restart: { type: 'bool' },
  }), asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const incoming = normaliseProperties(req.validated.values);

    // Refuse to write a value the server cannot start with. `server-ip` is the
    // one that bites people: a domain name there crashes startup with
    // UnknownHostException, and the failure surfaces minutes later in the
    // console rather than at the point of the mistake.
    const validation = validateProperties(incoming);
    if (!validation.ok) {
      return res.status(400).json({
        error: validation.message,
        code: 'invalid-property',
        details: validation.errors,
      });
    }

    const file = path.join(managed.def.dir, 'server.properties');
    let current = {};
    try {
      current = parseProperties(await fsp.readFile(file, 'utf8'));
    } catch {
      /* first write */
    }

    const merged = { ...current, ...incoming };

    // Never allow the managed port to drift from the registry definition.
    if (merged['server-port'] !== undefined) merged['server-port'] = String(managed.def.port);

    await atomicWrite(
      file,
      stringifyProperties(merged, SERVER_PROPERTIES_ORDER, {
        header: `Minecraft server properties\nManaged by Minecraft Server Manager\nLast edited ${new Date().toUTCString()}`,
      }),
    );

    if (incoming.motd !== undefined) {
      await registry.touch(managed.id, { motd: incoming.motd });
    }
    if (incoming['max-players'] !== undefined) {
      await registry.touch(managed.id, { maxPlayers: Number(incoming['max-players']) });
    }

    // A handful of settings can only be applied by restarting.
    let restarted = false;
    const restartRequired = ['server-port', 'level-name', 'level-type', 'level-seed', 'online-mode', 'enable-rcon', 'rcon.port', 'query.port', 'enable-query'];
    const touchedRestartKeys = Object.keys(incoming).filter((k) => restartRequired.includes(k));

    if (req.validated.restart && touchedRestartKeys.length && isLive(managed.status)) {
      managed.console.push(`\n[manager] Applying: ${touchedRestartKeys.join(', ')} — restarting.\n`, 'stdout');
      managed.restart({ reason: 'properties-change' }).catch(() => {});
      restarted = true;
    }

    res.json({
      ok: true,
      values: merged,
      restartRequired: touchedRestartKeys,
      restarting: restarted,
      hint: touchedRestartKeys.length && !restarted ? 'These settings take effect the next time the server starts.' : null,
    });
  }));

  // -------------------------------------------------------------------------
  // Memory / JVM preview
  // -------------------------------------------------------------------------

  router.get('/:id/jvm', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const args = buildJvmArgs({
      javaMajor: managed.def.java.major,
      minHeapMb: managed.def.memory.minHeapMb,
      maxHeapMb: managed.def.memory.maxHeapMb,
      gcProfile: managed.def.memory.gcProfile,
      preTouch: managed.def.memory.preTouch,
      extraArgs: managed.def.jvmArgs,
    });
    res.json({
      args,
      command: `"${managed.def.java.path}" ${args.join(' ')} -jar "${managed.def.jarFile}" ${(managed.def.serverArgs ?? []).join(' ')}`,
      memory: managed.def.memory,
      java: managed.def.java,
      recommendation: planResources({
        javaMajor: managed.def.java.major,
        systemRamMb: totalRamMb(),
        reservedMb: config.reservedRamMb,
        maxOverrideMb: config.maxHeapMbOverride,
      }),
    });
  }));

  router.get('/:id/resources', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    res.json({
      memory: managed.def.memory,
      java: managed.def.java,
      recommendation: planResources({
        javaMajor: managed.def.java.major,
        systemRamMb: totalRamMb(),
        reservedMb: config.reservedRamMb,
        maxOverrideMb: config.maxHeapMbOverride,
      }),
      system: { totalRamMb: totalRamMb(), reservedMb: config.reservedRamMb },
    });
  }));

  // -------------------------------------------------------------------------
  // Ping / diagnostics
  // -------------------------------------------------------------------------

  router.get('/:id/ping', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const result = await pingServer({ port: managed.def.port, timeoutMs: 4000 });
    if (result.online && result.players) {
      // Cross-check the log-derived roster against what the server reports.
      result.rosterMismatch = result.players.online !== managed.onlineCount;
    }
    res.json(result);
  }));

  router.get('/:id/diagnostics', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const dir = managed.def.dir;
    const [eula, props, jarExists, dirExists, portFree] = await Promise.all([
      fsp.readFile(path.join(dir, 'eula.txt'), 'utf8').then((t) => /eula\s*=\s*true/i.test(t)).catch(() => false),
      fsp.readFile(path.join(dir, 'server.properties'), 'utf8').then(parseProperties).catch(() => ({})),
      fsp.access(safeJoin(dir, managed.def.jarFile)).then(() => true).catch(() => false),
      fsp.access(dir).then(() => true).catch(() => false),
      isPortFree(managed.def.port),
    ]);

    const checks = [
      { id: 'directory', ok: dirExists, label: 'Server directory exists', detail: dir, severity: 'error' },
      { id: 'jar', ok: jarExists, label: `Server jar present (${managed.def.jarFile})`, detail: safeJoin(dir, managed.def.jarFile), severity: 'error' },
      { id: 'eula', ok: eula, label: 'EULA accepted', detail: eula ? 'eula=true' : 'eula.txt is missing or false', severity: 'error', fix: 'accept-eula' },
      {
        id: 'java',
        ok: Boolean(managed.def.java?.path) && fs.existsSync(managed.def.java?.path ?? ''),
        label: `Java ${managed.def.java?.major} available`,
        detail: managed.def.java?.path ?? 'not configured',
        severity: 'error',
        fix: 'fix-java',
      },
      {
        id: 'port',
        ok: portFree || isLive(managed.status),
        label: `Port ${managed.def.port} is free`,
        detail: portFree ? 'nothing is listening' : 'another process holds this port',
        severity: 'warn',
        fix: 'change-port',
      },
      {
        id: 'heap',
        ok: managed.def.memory.maxHeapMb <= totalRamMb() - 512,
        label: 'Heap fits in physical RAM',
        detail: `${managed.def.memory.maxHeapMb} MiB requested, ${totalRamMb()} MiB installed`,
        severity: 'warn',
        fix: 'raise-memory',
      },
      {
        id: 'secureProfile',
        ok: !(props['online-mode'] === 'false' && props['enforce-secure-profile'] === 'true'),
        label: 'Secure profile matches online-mode',
        detail: props['online-mode'] === 'false' ? 'online-mode=false requires enforce-secure-profile=false' : 'consistent',
        severity: 'warn',
        fix: 'properties',
      },
    ];

    res.json({
      checks,
      passed: checks.filter((c) => c.ok).length,
      total: checks.length,
      properties: props,
      startupCommand: `"${managed.def.java?.path}" ${buildJvmArgs({ javaMajor: managed.def.java.major, minHeapMb: managed.def.memory.minHeapMb, maxHeapMb: managed.def.memory.maxHeapMb, gcProfile: managed.def.memory.gcProfile, extraArgs: managed.def.jvmArgs }).join(' ')} -jar ${managed.def.jarFile} nogui`,
    });
  }));

  /** Re-download the jar / regenerate scripts — a repair button for broken servers. */
  router.post('/:id/reinstall', validateBody({
    version: { type: 'string', maxLength: 40 },
    build: {},
    loader: { type: 'string', maxLength: 40 },
    force: { type: 'bool' },
  }), asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    if (isLive(managed.status)) {
      return res.status(409).json({ error: 'Stop the server before reinstalling.', code: 'running' });
    }
    if (!req.validated.force) {
      return res.status(400).json({
        error: 'Reinstalling replaces the server jar. Pass force=true to confirm.',
        code: 'confirmation-required',
        hint: 'Your world, configs and plugins are not touched — only the jar is replaced.',
      });
    }

    const { planDownload } = await import('../providers/index.js');
    const plan = await planDownload({
      platform: managed.def.platform,
      version: req.validated.version ?? managed.def.version,
      build: req.validated.build ?? managed.def.build,
      loader: req.validated.loader ?? managed.def.loader,
    });

    const jarPath = safeJoin(managed.def.dir, managed.def.jarFile);
    const { download } = await import('../lib/httpClient.js');
    const result = await download(plan.url, jarPath, { expectedSha256: plan.sha256, expectedSha1: plan.sha1 });

    await registry.update(managed.id, {
      version: plan.version,
      build: plan.build ?? null,
      loader: plan.loader ?? null,
      installer: plan.installer ?? null,
    }, { silent: true });
    managed.console.push(`\n[manager] Server jar replaced with ${plan.platformLabel} ${plan.version}${plan.build ? ` build ${plan.build}` : ''} (${formatBytes(result.bytes)}).\n\n`, 'stdout');
    await writeStartScripts(managed.def);

    res.json({ ok: true, plan: { ...plan, url: undefined }, bytes: result.bytes, server: managed.snapshot() });
  }));

  // -------------------------------------------------------------------------
  // Connect — getting players in from outside
  // -------------------------------------------------------------------------

  /** Addresses + local checks. Fast; UPnP is a separate call. */
  router.get('/:id/connect', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const running = isLive(managed.status);
    res.json(await connectionSummary({ port: managed.def.port, running }));
  }));

  /**
   * UPnP probe. Separated because SSDP discovery waits ~3s for router replies —
   * too slow to hold up the panel.
   */
  router.get('/:id/connect/forwarding', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const status = await portForwardingStatus({ port: managed.def.port });

    /*
     * Cross-check the router's own WAN address against what the internet sees.
     * A router will accept a port mapping regardless — the only way to know
     * whether forwarding can possibly work is to compare the two, and a
     * mismatch (usually carrier-grade NAT on LTE/5G lines) is the difference
     * between "one more setting" and "impossible on this connection".
     */
    const publicIp = await publicAddress();
    const reachability = status.available
      ? classifyWanAddress(status.gateway?.externalIp, publicIp.value)
      : { kind: 'unknown', forwardingWorks: null, summary: null, message: null, options: [] };

    res.json({ ...status, publicIp: publicIp.value, reachability });
  }));

  router.post('/:id/connect/forward', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const port = managed.def.port;

    const discovery = await discoverGateway();
    if (!discovery.ok) {
      return res.status(503).json({
        error: discovery.message,
        code: discovery.reason,
        hint: 'Open your router’s admin page and forward the TCP port yourself — the manual steps are in this panel.',
      });
    }

    const result = await addMapping(discovery.gateway, {
      port,
      internalPort: port,
      internalClient: localAddress(),
    });

    if (!result.ok) {
      return res.status(502).json({ error: result.message, code: result.reason ?? 'mapping-failed' });
    }

    managed.console.push(
      `\n[manager] Asked the router to forward TCP ${port} to ${localAddress()}. ` +
        'Players can now connect from outside using your public address.\n\n',
      'stdout',
    );

    res.json({ ok: true, ...result, gateway: discovery.gateway.device ?? 'router' });
  }));

  router.delete('/:id/connect/forward', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const discovery = await discoverGateway();
    if (!discovery.ok) {
      return res.status(503).json({ error: discovery.message, code: discovery.reason });
    }
    res.json(await removeMapping(discovery.gateway, { port: managed.def.port }));
  }));

  /** Open the OS firewall for this port (Windows; raises a UAC prompt). */
  router.post('/:id/connect/firewall', validateBody({
    action: { type: 'string', enum: ['add', 'remove'] },
  }), asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const action = req.validated.action ?? 'add';
    const result = await applyFirewallRule(managed.def.port, { action });

    if (!result.ok) {
      return res.status(result.cancelled ? 409 : 500).json({
        error: result.error,
        code: result.cancelled ? 'cancelled' : 'firewall-failed',
        command: result.command,
        hint: 'You can run the command yourself in an Administrator terminal.',
      });
    }

    res.json({ ok: true, action, command: result.command });
  }));

  // -------------------------------------------------------------------------
  // Backups
  // -------------------------------------------------------------------------

  router.get('/:id/backups', asyncHandler(async (req, res) => {
    const backups = await listBackups(req.params.id);
    const totalBytes = backups.reduce((sum, b) => sum + b.bytes, 0);
    res.json({
      backups: backups.map((b) => ({ ...b, path: undefined, formatted: formatBytes(b.bytes) })),
      totalBytes,
      totalFormatted: formatBytes(totalBytes),
      dir: path.join(config.backupsDir, req.params.id),
    });
  }));

  router.post('/:id/backups', validateBody({
    label: { type: 'string', maxLength: 40 },
    includeLogs: { type: 'bool' },
  }), asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const manifest = await createBackup(managed, {
      label: req.validated.label ?? 'manual',
      includeLogs: Boolean(req.validated.includeLogs),
    });
    await pruneBackups(managed.id, managed.def.schedules?.backup?.keep ?? 7);
    res.status(201).json({ ...manifest, path: undefined, formatted: formatBytes(manifest.bytes), hot: manifest.hot });
  }));

  router.delete('/:id/backups/:file', asyncHandler(async (req, res) => {
    res.json(await deleteBackup(req.params.id, req.params.file));
  }));

  router.get('/:id/backups/:file/download', asyncHandler(async (req, res) => {
    const backups = await listBackups(req.params.id);
    const match = backups.find((b) => b.file === path.basename(req.params.file));
    if (!match) return res.status(404).json({ error: 'Backup not found.', code: 'not-found' });
    res.download(match.path, match.file);
  }));

  router.post('/:id/backups/:file/restore', asyncHandler(async (req, res) => {
    const managed = registry.get(req.params.id);
    const backups = await listBackups(req.params.id);
    const match = backups.find((b) => b.file === path.basename(req.params.file));
    if (!match) return res.status(404).json({ error: 'Backup not found.', code: 'not-found' });

    // Restoring over a live world corrupts it — refuse rather than guess.
    if (isLive(managed.status)) {
      const stopFirst = req.query.stopFirst === 'true';
      if (!stopFirst) {
        return res.status(409).json({
          error: 'Stop the server before restoring a backup.',
          code: 'running',
          hint: 'Retry with ?stopFirst=true to let the manager stop it for you.',
        });
      }
      await managed.stop({ reason: 'restore' });
    }

    const result = await restoreBackup(managed, match.path);
    managed.console.push(`\n[manager] Restored backup ${match.file}. A safety copy of the previous state was saved to ${result.safetyCopy}.\n\n`, 'stdout');
    res.json({ ok: true, ...result, safetyCopy: result.safetyCopy });
  }));

  router.post('/:id/backups/prune', validateBody({ keep: { type: 'int', min: 1, max: 100 } }), asyncHandler(async (req, res) => {
    res.json(await pruneBackups(req.params.id, req.validated.keep ?? 7));
  }));

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  router.post('/bulk/:action', validateBody({
    ids: { type: 'array', maxItems: 100, optional: false },
  }), asyncHandler(async (req, res) => {
    const action = req.params.action;
    if (!['start', 'stop', 'restart', 'backup', 'kill'].includes(action)) {
      return res.status(400).json({ error: `Unknown bulk action "${action}".`, code: 'bad-action' });
    }

    const results = [];
    for (const id of req.validated.ids) {
      const managed = registry.find(String(id));
      if (!managed) {
        results.push({ id, ok: false, error: 'not found' });
        continue;
      }
      try {
        switch (action) {
          case 'start':
            if (!isLive(managed.status)) await managed.start({ reason: 'bulk' });
            results.push({ id, ok: true, status: managed.status });
            break;
          case 'stop':
            await managed.stop({ reason: 'bulk' });
            results.push({ id, ok: true, status: managed.status });
            break;
          case 'kill':
            await managed.stop({ force: true, timeoutMs: 2000, reason: 'bulk-kill' });
            results.push({ id, ok: true, status: managed.status });
            break;
          case 'restart':
            managed.restart({ reason: 'bulk' }).catch(() => {});
            results.push({ id, ok: true, status: 'restarting' });
            break;
          case 'backup': {
            const manifest = await createBackup(managed, { label: 'bulk' });
            results.push({ id, ok: true, file: manifest.file });
            break;
          }
        }
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      }
    }

    res.json({ action, results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  }));

  return router;
}

export default serverRoutes;
