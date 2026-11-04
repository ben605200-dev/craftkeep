/**
 * Craftkeep — backend.
 *
 * This module is a *library*. The only supported entry point is the Electron
 * desktop shell, which imports `startManager()` and runs the backend inside its
 * main process. There is intentionally no CLI and no standalone server: the
 * HTTP + WebSocket layer here exists purely to carry messages between the main
 * process and its own renderer, over loopback, behind a per-launch token.
 *
 * Boot order matters:
 *   1. validate config (a session token is mandatory)
 *   2. build the registry and reconcile with reality
 *   3. start the scheduler
 *   4. bring up the renderer transport
 *   5. auto-start flagged servers
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config, validateConfig, ensureDirectories } from './config.js';
import createLogger from './logger.js';
import { ServerRegistry, Provisioner } from './lib/registry.js';
import { Scheduler } from './lib/scheduler.js';
import { Gateway } from './ws/gateway.js';
import { requestContext, securityGate, apiNotFound, errorHandler, noStore } from './routes/middleware.js';
import { serverRoutes } from './routes/servers.js';
import { versionRoutes } from './routes/versions.js';
import { javaRoutes } from './routes/java.js';
import { fileRoutes } from './routes/files.js';
import { systemRoutes, settingsRoutes, SettingsStore } from './routes/system.js';
import { tunnelRoutes } from './routes/tunnel.js';
import { PlayitTunnel } from './lib/tunnel.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..');

/*
 * Where the renderer's assets come from.
 *
 * `CRAFTKEEP_WEB_DIR` overrides it, which matters for a packaged build: the UI lives
 * inside the read-only `app.asar`, so without an override every front-end tweak
 * would need a full rebuild and reinstall.
 */
const WEB_DIR = process.env.CRAFTKEEP_WEB_DIR
  ? path.resolve(process.env.CRAFTKEEP_WEB_DIR)
  : path.join(ROOT_DIR, 'web');

const log = createLogger('boot');

const BANNER = String.raw`
   __  ____ ____  __  __
  /  |/  / ___||  \/  |___ _ __  __ _ __ _ ___ _ _
 / |\/| \___ \| |\/| / __| '_ \/ _' / _' / _ \ '_|
/ |  | |___) | |  | \__ \ | | | (_| | (_| |  __/ |
\/_/  |_|____/|_|  |_|___/_| |_|\__,_|\__, |\___|_|
                                      |___/  v${config.uiVersion}
`;

/**
 * Start the whole backend, in-process.
 *
 * @param {object} options
 * @param {string} options.token      Session token the renderer must present.
 *                                    Required — this is the only thing standing
 *                                    between the API and any other local process.
 * @param {number} [options.port]     Pin a port. Omit (or pass 0) to let the OS
 *                                    choose a free one.
 * @param {object} [options.paths]    Override data/servers/backups dirs. The
 *                                    desktop shell points these at the user-data
 *                                    folder, since a packaged app's own
 *                                    directory is read-only.
 * @param {boolean} [options.banner]  Print the ASCII banner into the log.
 * @returns {Promise<{ port, host, url, app, server, registry, gateway, scheduler,
 *                     provisioner, settings, shutdown }>}
 */
export async function startManager(options = {}) {
  const { token, port: requestedPort, paths = {}, banner = false } = options;

  if (token) config.token = String(token);

  // -- Path overrides must be applied before anything reads them -------------
  if (paths.serversDir) config.serversDir = paths.serversDir;
  if (paths.dataDir) config.dataDir = paths.dataDir;
  if (paths.backupsDir) config.backupsDir = paths.backupsDir;
  if (paths.jdkDir) config.jdkDir = paths.jdkDir;

  // -------------------------------------------------------------------------
  // 1. Configuration
  // -------------------------------------------------------------------------
  const configErrors = validateConfig();
  if (configErrors.length) {
    log.fatal('Configuration is invalid:');
    for (const error of configErrors) process.stderr.write(`  • ${error}\n`);
    throw Object.assign(new Error(`Configuration is invalid: ${configErrors.join(' ')}`), { code: 'bad-config' });
  }

  ensureDirectories();

  // -------------------------------------------------------------------------
  // 2. Settings + registry
  // -------------------------------------------------------------------------
  const settings = new SettingsStore(config.settingsFile);
  await settings.load();
  if (settings.get().autoDownloadJava) config.autoDownloadJava = true;

  const registry = new ServerRegistry();
  await registry.init();

  // -------------------------------------------------------------------------
  // 3. Provisioner + scheduler
  // -------------------------------------------------------------------------
  // The gateway does not exist yet; queue job frames until it does.
  let gateway = null;
  const pendingJobs = [];
  const provisioner = new Provisioner(registry, {
    onProgress: (progress) => {
      if (gateway) gateway.broadcastJob(progress);
      else if (pendingJobs.length < 500) pendingJobs.push(progress);
    },
  });

  const scheduler = new Scheduler(registry, {
    onEvent: (event) => {
      log.info(`Scheduler event: ${event.type}${event.serverId ? ` (${event.serverId})` : ''}`);
      gateway?.broadcast({ type: 'schedule-event', ...event });
    },
  });
  scheduler.start();

  // playit.gg tunnel agent — the escape hatch for connections that cannot be
  // port-forwarded (carrier NAT in particular).
  const tunnel = new PlayitTunnel();

  // -------------------------------------------------------------------------
  // 4. HTTP + WebSocket
  // -------------------------------------------------------------------------
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(requestContext);
  // Uploads arrive as raw bodies, so the JSON parser only sees JSON-ish routes.
  app.use((req, res, next) => {
    if (req.path.includes('/upload')) return next();
    return express.json({ limit: '8mb' })(req, res, next);
  });
  app.use((req, res, next) => {
    if (!req.path.includes('/upload')) return next();
    express.raw({ type: '*/*', limit: '4gb' })(req, res, next);
  });

  app.use('/api', noStore, securityGate);

  // The gateway is created after the HTTP server (it upgrades from it), so
  // routes receive a live accessor rather than the instance itself.
  const gatewayRef = {
    broadcastJob: (payload) => gateway?.broadcastJob(payload),
    jobDone: (jobId, result) => gateway?.jobDone(jobId, result),
    broadcast: (payload) => gateway?.broadcast(payload),
    get stats() {
      return gateway?.stats ?? null;
    },
  };

  app.use('/api/system', systemRoutes({ registry, gateway: gatewayRef, settings }));
  app.use('/api/settings', settingsRoutes({ settings }));
  app.use('/api/versions', versionRoutes());
  app.use('/api/java', javaRoutes({ gateway: gatewayRef }));
  app.use('/api/servers', serverRoutes({ registry, scheduler, gateway: gatewayRef, provisioner }));
  app.use('/api/files', fileRoutes({ registry }));
  app.use('/api/tunnel', tunnelRoutes({ tunnel, gateway: gatewayRef }));

  // Mounted at `/api` so it only catches unmatched API routes — anything else
  // falls through to the static dashboard and the SPA deep-link handler.
  app.use('/api', apiNotFound);

  // Static dashboard
  if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
    log.warn(`No dashboard found at ${WEB_DIR}. The API is up but the UI will 404.`);
  }
  app.use(
    express.static(WEB_DIR, {
      index: 'index.html',
      etag: true,
      lastModified: true,
      // Everything is served from localhost, so revalidation costs ~nothing and
      // guarantees the browser never runs a stale module after an app update.
      // Aggressive `max-age` here is a real footgun: a changed module graph
      // otherwise keeps throwing "does not provide an export named ...".
      setHeaders: (res, filePath) => {
        res.setHeader('cache-control', filePath.endsWith('.html') ? 'no-cache' : 'no-cache, must-revalidate');
      },
    }),
  );

  // SPA fallback for deep links.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(WEB_DIR, 'index.html'), (error) => {
      if (error) next();
    });
  });

  app.use(errorHandler);

  const server = http.createServer(app);
  // Uploads of world files can legitimately take minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;

  gateway = new Gateway(server, { registry, scheduler, provisioner });
  // Route WS upgrades into the gateway.
  gateway.wss.on('connection', (socket, req) => gateway.handleConnection(socket, req));

  for (const progress of pendingJobs) gateway.broadcastJob(progress);
  pendingJobs.length = 0;

  // -- Bind -----------------------------------------------------------------
  // Loopback only. A port of 0 asks the OS for a free one, so two copies (or an
  // unrelated app) can never collide — there is no stable URL to fight over.
  const host = config.host;
  const desiredPort = requestedPort ?? config.port;

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${desiredPort} is already in use. Omit CRAFTKEEP_PORT to let the app pick a free one.`,
          ),
        );
      } else {
        reject(error);
      }
    });
    server.listen(desiredPort, host, resolve);
  });

  // Read back the real port — the OS chose it when we asked for 0.
  const port = server.address()?.port ?? desiredPort;
  config.port = port;

  // -------------------------------------------------------------------------
  // 5. Post-boot
  // -------------------------------------------------------------------------
  if (banner) process.stdout.write(BANNER);
  log.info(`Transport      ${config.publicUrl} (loopback, session token required)`);
  log.info(`Serve UI from  ${WEB_DIR}`);
  log.info(`Servers dir    ${config.serversDir}`);
  log.info(`Data dir       ${config.dataDir}`);

  if (registry.servers.size) {
    const summary = registry.summary();
    log.info(`Servers        ${summary.total} configured, ${summary.running} running${summary.crashed ? `, ${summary.crashed} crashed` : ''}`);
  } else {
    log.info('Servers        none yet — open the dashboard and create your first one');
  }

  if (settings.get().startServersOnLaunch) {
    const started = await registry.autoStart();
    if (started) log.info(`Auto-started ${started} server(s).`);
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------
  let shuttingDown = false;

  /**
   * Stop everything cleanly.
   *
   * Never calls `process.exit` itself — the caller decides what to do after a
   * graceful stop, which is what lets the Electron shell await this before
   * quitting.
   *
   * @returns {Promise<{ ok: boolean, forced: boolean }>}
   */
  const shutdown = async ({ reason = 'shutdown', force = false, timeoutMs } = {}) => {
    if (shuttingDown) {
      log.warn(`Shutdown already in progress (${reason}).`);
      return { ok: true, forced: false };
    }
    shuttingDown = true;
    log.info(`Shutting down (${reason})…`);

    try {
      server.close();
    } catch {
      /* already closed */
    }
    gateway?.close();
    scheduler.stop();
    // Leave no orphaned tunnel agent behind.
    await tunnel.dispose().catch(() => {});

    const budget = timeoutMs ?? (force ? 4_000 : 45_000);
    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      log.warn(`Shutdown exceeded ${Math.round(budget / 1000)}s — abandoning the wait.`);
    }, budget);
    guard.unref?.();

    try {
      await registry.shutdown({ force });
    } catch (error) {
      log.error(`Error while stopping servers: ${error.message}`);
    }

    clearTimeout(guard);
    log.info('Manager stopped.');
    return { ok: !timedOut, forced: timedOut };
  };

  // No signal handlers: Electron owns the process lifecycle and routes every
  // quit path through `shutdown()` itself.
  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  });
  process.on('uncaughtException', (error) => {
    // A crash in the manager must not take running Minecraft servers with it.
    log.error(`Uncaught exception: ${error?.stack ?? error}`);
  });

  return {
    app,
    server,
    registry,
    gateway,
    scheduler,
    provisioner,
    settings,
    tunnel,
    host,
    port,
    url: `http://${host}:${port}`,
    shutdown,
  };
}

/*
 * No CLI bootstrap.
 *
 * This file is a library with exactly one caller: the Electron shell. Running
 * it directly does nothing — on purpose. There is no standalone server mode to
 * start, and nothing here should ever become one again.
 */
export default startManager;
