/**
 * `/api/system` — machine health, storage, runtime settings, diagnostics.
 */

import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, ensureDirectories } from '../config.js';
import { asyncHandler, validateBody } from './middleware.js';
import { systemInfo, systemMemory, systemCpuPercent, totalRamMb, CPU_COUNT } from '../lib/stats.js';
import { javaSummary, detectJava } from '../lib/javaDetect.js';
import { directorySize, formatBytes, freeSpace, readJson, writeJson } from '../lib/fsUtil.js';
import { backupStats } from '../lib/backup.js';
import { recentLogs } from '../logger.js';
import { RESOURCE_PRESETS } from '../lib/versionRules.js';
import { PLATFORM_INFO } from '../providers/index.js';

/** Runtime-mutable settings, persisted to `data/settings.json`. */
const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: 'emerald',
  consoleFontSize: 13,
  consoleAutoScroll: true,
  consoleTimestamps: true,
  consoleWordWrap: true,
  confirmDestructive: true,
  autoDownloadJava: false,
  defaultPlatform: 'paper',
  defaultTimeoutMs: 120000,
  refreshIntervalMs: 2000,
  startServersOnLaunch: false,
  telemetry: false,
};

/**
 * Runtime settings, mounted at `/api/settings` (and under `/api/system` for
 * tooling). Kept separate so the main router is not rebuilt per request.
 */
export function settingsRoutes({ settings }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ ...settings.get(), defaults: DEFAULT_SETTINGS });
  });

  router.patch('/', validateBody({
    theme: { type: 'string', enum: ['dark', 'midnight', 'dim'] },
    accent: { type: 'string', enum: ['emerald', 'indigo', 'violet', 'amber', 'rose', 'cyan'] },
    consoleFontSize: { type: 'int', min: 10, max: 22 },
    consoleAutoScroll: { type: 'bool' },
    consoleTimestamps: { type: 'bool' },
    consoleWordWrap: { type: 'bool' },
    confirmDestructive: { type: 'bool' },
    autoDownloadJava: { type: 'bool' },
    defaultPlatform: { type: 'string', enum: ['vanilla', 'paper', 'fabric'] },
    defaultTimeoutMs: { type: 'int', min: 10000, max: 900000 },
    refreshIntervalMs: { type: 'int', min: 1000, max: 15000 },
    startServersOnLaunch: { type: 'bool' },
    telemetry: { type: 'bool' },
  }), asyncHandler(async (req, res) => {
    const updated = await settings.patch(req.validated);
    if (req.validated.autoDownloadJava !== undefined) config.autoDownloadJava = req.validated.autoDownloadJava;
    res.json(updated);
  }));

  router.post('/reset', asyncHandler(async (req, res) => {
    res.json(await settings.reset());
  }));

  return router;
}

export function systemRoutes({ registry, gateway, settings }) {
  const router = express.Router();

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  router.get('/', asyncHandler(async (req, res) => {
    const memory = systemMemory();
    // Use the full summary — it carries `canRun`, which the dashboard uses to
    // answer "can this machine run 1.21.x / the latest release?".
    const java = await javaSummary().catch(() => ({ installations: [], majors: [], canRun: {}, readyFor: {} }));
    const summary = registry.summary();

    res.json({
      app: {
        version: config.uiVersion,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        pid: process.pid,
        startedAt: Date.now() - Math.round(process.uptime() * 1000),
        publicUrl: config.publicUrl,
        localOnly: config.isLocalOnly,
      },
      system: {
        ...systemInfo(),
        memory: {
          totalBytes: memory.totalBytes,
          usedBytes: memory.usedBytes,
          freeBytes: memory.freeBytes,
          usedPercent: memory.usedPercent,
          totalMb: Math.round(memory.totalBytes / 1024 / 1024),
          usedMb: Math.round(memory.usedBytes / 1024 / 1024),
        },
        cpuPercent: systemCpuPercent(),
        loadAverage: os.loadavg?.() ?? null,
      },
      servers: summary,
      java: {
        installations: java.installations ?? [],
        majors: java.majors ?? [],
        canRun: java.canRun ?? {},
        readyFor: java.readyFor ?? {},
        highest: java.highest ?? null,
        managedDir: config.jdkDir,
        autoDownload: settings.get().autoDownloadJava,
      },
      websocket: gateway?.stats ?? null,
      paths: {
        root: config.rootDir,
        servers: config.serversDir,
        data: config.dataDir,
        backups: config.backupsDir,
        logs: config.logsDir,
        jdks: config.jdkDir,
      },
      intervals: { metrics: config.statsIntervalMs, reservedRamMb: config.reservedRamMb },
    });
  }));

  router.get('/storage', asyncHandler(async (req, res) => {
    const [serversSize, backups, disk, downloads] = await Promise.all([
      directorySize(config.serversDir).catch(() => ({ bytes: 0, files: 0 })),
      backupStats(),
      freeSpace(config.dataDir),
      directorySize(config.downloadsDir).catch(() => ({ bytes: 0, files: 0 })),
    ]);

    const perServer = await Promise.all(
      registry.list().map(async (server) => {
        const size = await directorySize(server.dir).catch(() => ({ bytes: 0, files: 0 }));
        return { id: server.id, name: server.name, bytes: size.bytes, files: size.files, formatted: formatBytes(size.bytes) };
      }),
    );

    res.json({
      servers: { ...serversSize, formatted: formatBytes(serversSize.bytes) },
      backups: { ...backups, formatted: formatBytes(backups.bytes) },
      downloads: { ...downloads, formatted: formatBytes(downloads.bytes) },
      perServer: perServer.sort((a, b) => b.bytes - a.bytes),
      disk: disk ? { ...disk, totalFormatted: formatBytes(disk.total), freeFormatted: formatBytes(disk.free), usedPercent: ((disk.total - disk.free) / disk.total) * 100 } : null,
    });
  }));

  router.get('/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const level = String(req.query.level ?? '').toLowerCase();
    let records = recentLogs(limit);
    if (level) records = records.filter((r) => r.level === level);
    if (req.query.search) {
      const needle = String(req.query.search).toLowerCase();
      records = records.filter((r) => r.message.toLowerCase().includes(needle) || r.scope.toLowerCase().includes(needle));
    }
    res.json({ records, total: records.length, file: path.join(config.logsDir, `manager-${new Date().toISOString().slice(0, 10)}.log`) });
  });

  router.get('/presets', (req, res) => {
    res.json({ presets: RESOURCE_PRESETS, platforms: PLATFORM_INFO });
  });

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** One call the "Export diagnostics" button uses to produce a support bundle. */
  router.get('/diagnostics', asyncHandler(async (req, res) => {
    const java = await detectJava().catch(() => []);
    const summary = registry.summary();

    const servers = await Promise.all(
      registry.list().map(async (server) => {
        const managed = registry.find(server.id);
        const size = await directorySize(server.dir).catch(() => ({ bytes: 0 }));
        const portCheck = await checkPort(server.port);
        return {
          id: server.id,
          name: server.name,
          platform: server.platform,
          version: server.version,
          status: server.status,
          pid: server.pid,
          uptimeMs: server.uptimeMs,
          memory: server.memory,
          java: server.java,
          port: server.port,
          portListening: portCheck,
          diskBytes: size.bytes,
          consoleLines: managed?.console.records.length ?? 0,
          lastFailure: server.lastFailure,
          lastExitCode: server.lastExitCode,
          checks: {
            eula: await fsp.access(path.join(server.dir, 'eula.txt')).then(() => true).catch(() => false),
            jar: await fsp.access(path.join(server.dir, server.jarFile)).then(() => true).catch(() => false),
            java: fs.existsSync(server.java?.path ?? ''),
            directory: fs.existsSync(server.dir),
          },
        };
      }),
    );

    res.json({
      generatedAt: new Date().toISOString(),
      app: { version: config.uiVersion, node: process.version, platform: process.platform, arch: process.arch },
      system: { ...systemInfo(), memory: systemMemory(), cpuPercent: systemCpuPercent(), cpuCount: CPU_COUNT, totalRamMb: totalRamMb() },
      config: {
        port: config.port,
        host: config.host,
        localOnly: config.isLocalOnly,
        reservedRamMb: config.reservedRamMb,
        statsIntervalMs: config.statsIntervalMs,
        autoDownloadJava: config.autoDownloadJava,
        paths: { servers: config.serversDir, data: config.dataDir, backups: config.backupsDir },
      },
      java,
      summary,
      servers,
      recentErrors: recentLogs(200).filter((r) => r.level === 'error' || r.level === 'warn').slice(-60),
      websocket: gateway?.stats ?? null,
    });
  }));

  /** Everything the first-run "Welcome" screen needs. */
  router.get('/onboarding', asyncHandler(async (req, res) => {
    const java = await javaSummary().catch(() => ({ installations: [], majors: [], canRun: {} }));
    const servers = registry.list();
    const disk = await freeSpace(config.dataDir).catch(() => null);

    const steps = [
      { id: 'java', done: java.installations.length > 0, label: 'Java runtime detected', detail: java.installations.length ? `${java.installations.length} installation(s) found` : 'No JDK found — install one before starting a server' },
      { id: 'jar-source', done: true, label: 'Version providers reachable', detail: 'Mojang, PaperMC and Fabric APIs configured' },
      { id: 'first-server', done: servers.length > 0, label: 'Create your first server', detail: servers.length ? `${servers.length} server(s) configured` : 'Use the Create Server wizard to get going' },
      { id: 'disk', done: !disk || disk.free > 5 * 1024 ** 3, label: 'Enough free disk space', detail: disk ? `${formatBytes(disk.free)} available` : 'unknown' },
    ];

    res.json({ steps, complete: steps.every((s) => s.done), java, serverCount: servers.length, disk });
  }));

  return router;
}

/** Is anything listening on this TCP port right now? */
async function checkPort(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect({ host: '127.0.0.1', port: Number(port) });
  });
}

/** Simple JSON-file-backed settings store. */
export class SettingsStore {
  constructor(file) {
    this.file = file;
    this.values = { ...DEFAULT_SETTINGS };
    this.loaded = false;
  }

  async load() {
    ensureDirectories();
    const stored = await readJson(this.file, null);
    this.values = { ...DEFAULT_SETTINGS, ...(stored?.values ?? {}) };
    // Env wins over the stored file for the Java toggle.
    if (process.env.CRAFTKEEP_AUTO_DOWNLOAD_JAVA) this.values.autoDownloadJava = config.autoDownloadJava;
    this.loaded = true;
    return this.values;
  }

  get() {
    return { ...this.values };
  }

  async patch(partial) {
    this.values = { ...this.values, ...partial, updatedAt: Date.now() };
    await this.#persist();
    return this.get();
  }

  async reset() {
    this.values = { ...DEFAULT_SETTINGS };
    await this.#persist();
    return this.get();
  }

  async #persist() {
    await writeJson(this.file, { version: 1, values: this.values });
  }
}

export { DEFAULT_SETTINGS };
export default systemRoutes;
