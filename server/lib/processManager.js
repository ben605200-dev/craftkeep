/**
 * Minecraft server process lifecycle.
 *
 * One `ManagedServer` wraps one JVM. It owns:
 *   - spawning java with the resolved heap/JVM args and the right working dir
 *   - bidirectional stdio (commands in, console out)
 *   - a small state machine (stopped → starting → running → stopping → stopped)
 *   - crash classification, graceful-stop escalation and auto-restart backoff
 *   - resource sampling and rolling history for the dashboard sparklines
 *
 * The class is deliberately free of HTTP/WebSocket knowledge — it publishes
 * through an EventEmitter, and `ws/gateway.js` fans those events out.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ConsoleBuffer } from './consoleBuffer.js';
import { sampleProcesses, forgetProcess } from './stats.js';
import { buildJvmArgs } from './versionRules.js';
import { safeJoin } from './fsUtil.js';
import createLogger from '../logger.js';

const IS_WINDOWS = process.platform === 'win32';

/** Statuses surfaced to the UI. */
export const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  CRASHED: 'crashed',
  ERROR: 'error',
};

const TERMINAL = new Set([STATUS.STOPPED, STATUS.CRASHED, STATUS.ERROR]);
export const isLive = (status) => !TERMINAL.has(status);

/**
 * Detects the single most likely cause of a failed boot from the log tail.
 * Surfaced to the user as an actionable hint instead of a raw stack trace.
 */
const FAILURE_PATTERNS = [
  { re: /You need to agree to the EULA/i, id: 'eula', title: 'EULA not accepted', hint: 'eula.txt must contain eula=true.', action: 'accept-eula' },
  /*
   * Ordered before the port checks: a bad bind address shows up as a startup
   * exception, and the fix is completely different from "the port is busy".
   */
  {
    re: /java\.net\.UnknownHostException|No such host is known/i,
    id: 'bind-address',
    title: 'server-ip is not bindable',
    hint:
      'server-ip is the local network interface the server binds to — it cannot be a domain name. ' +
      'Leave it empty so the server listens on every interface; players still connect using your domain or IP.',
    action: 'fix-server-ip',
  },
  { re: /FAILED TO BIND TO PORT|Address already in use/i, id: 'port', title: 'Port already in use', hint: 'Another process (or another server) is using this port. Change server-port.', action: 'change-port' },
  { re: /UnsupportedClassVersionError|compiled for the newer version|Unsupported class file major version/i, id: 'java', title: 'Wrong Java version', hint: 'The jar was compiled for a newer JVM than the one selected.', action: 'fix-java' },
  { re: /java\.lang\.OutOfMemoryError/i, id: 'memory', title: 'Out of memory', hint: 'The heap is too small for this world/mod set. Raise -Xmx or reduce view-distance.', action: 'raise-memory' },
  { re: /A fatal error has been detected by the Java Runtime|SIGSEGV|EXCEPTION_ACCESS_VIOLATION/i, id: 'jvm-crash', title: 'JVM hard crash', hint: 'Usually a broken native library or a bad Java build. Try a different JDK.', action: 'fix-java' },
  { re: /Incompatible mod set|net\.fabricmc\.loader\.discovery\.ModResolutionException/i, id: 'mods', title: 'Incompatible mods', hint: 'A mod is missing a dependency or targets a different Minecraft version.', action: 'inspect-mods' },
  { re: /Unknown or incomplete command|Failed to load eula\.txt/i, id: 'unknown', title: 'Startup failed', hint: 'Check the console output above for the first error.', action: null },
];

function classifyFailure(tailText) {
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.re.test(tailText)) return { id: pattern.id, title: pattern.title, hint: pattern.hint, action: pattern.action };
  }
  return { id: 'unknown', title: 'Server exited unexpectedly', hint: 'Scroll up to the first red line for the root cause.', action: null };
}

export class ManagedServer extends EventEmitter {
  /**
   * @param {object} definition persisted server record
   */
  constructor(definition) {
    super();
    this.setMaxListeners(0);
    this.def = definition;
    this.id = definition.id;
    this.log = createLogger(`mc:${definition.id}`);

    /** @type {'stopped'|'starting'|'running'|'stopping'|'crashed'|'error'} */
    this.status = STATUS.STOPPED;
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.exitCode = null;
    this.exitSignal = null;
    this.failure = null;
    this.lastError = null;
    this.restartAttempts = 0;
    this.intentionalStop = false;
    this.stopRequestedAt = null;
    this.stopTimer = null;
    this.startTimeout = null;
    this.pendingStartResolve = null;

    /** Rolling 3-minute resource history: `[ts, cpu%, rssBytes]`. */
    this.history = [];
    /** Latest reading from the sampler. */
    this.metrics = { cpuPercent: 0, rssBytes: 0, privateBytes: 0, cpuTimeMs: 0, sampledAt: null, warmingUp: true };

    this.console = new ConsoleBuffer(definition.id, {
      onRecord: (records) => this.emit('console', records),
      onEvent: (record) => this.#handleEvent(record),
    });

    /** Commands the user sent, echoed into the console for context. */
    this.commandHistory = [];
  }

  // -------------------------------------------------------------------------
  // Derived getters
  // -------------------------------------------------------------------------

  get uptimeMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  get onlinePlayers() {
    return this.console.onlinePlayers();
  }

  get onlineCount() {
    return this.console.onlineCount;
  }

  /** Full snapshot for REST responses and `subscribe` replies. */
  snapshot({ includeConsole = false, consoleLimit = 400 } = {}) {
    return {
      ...this.def,
      status: this.status,
      pid: this.pid,
      uptimeMs: this.uptimeMs,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      failure: this.failure,
      lastError: this.lastError,
      restartAttempts: this.restartAttempts,
      metrics: this.metrics,
      onlinePlayers: this.onlinePlayers,
      onlineCount: this.onlineCount,
      playerHistory: this.console.playerHistory.slice(-60),
      startProgress: this.status === STATUS.STARTING ? this.console.startProgress : this.status === STATUS.RUNNING ? 1 : 0,
      consoleSeq: this.console.lastSeq,
      ...(includeConsole ? { console: this.console.tail(consoleLimit) } : {}),
    };
  }

  metricsSnapshot() {
    return {
      serverId: this.id,
      status: this.status,
      cpuPercent: this.metrics.cpuPercent,
      rssBytes: this.metrics.rssBytes,
      rssMb: Math.round(this.metrics.rssBytes / 1024 / 1024),
      heapMaxMb: this.def.memory?.maxHeapMb ?? null,
      uptimeMs: this.uptimeMs,
      onlineCount: this.onlineCount,
      warmingUp: this.metrics.warmingUp,
      sampledAt: this.metrics.sampledAt,
    };
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  #setStatus(status, extra = {}) {
    if (this.status === status && !extra.force) return;
    const from = this.status;
    this.status = status;
    this.log.debug(`status ${from} -> ${status}`);
    this.emit('status', { serverId: this.id, status, from, ...extra });
    this.emit('update', this.snapshot());
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  /**
   * Launch the JVM.
   * @param {{ waitForReady?: boolean, readyTimeoutMs?: number, reason?: string }} [opts]
   */
  async start({ waitForReady = false, readyTimeoutMs = config.startTimeoutMs, reason = 'manual' } = {}) {
    if (isLive(this.status)) {
      const error = new Error('Server is already running.');
      error.status = 409;
      throw error;
    }

    await this.#verifyRuntime();

    this.intentionalStop = false;
    this.failure = null;
    this.lastError = null;
    this.exitCode = null;
    this.exitSignal = null;
    this.metrics = { cpuPercent: 0, rssBytes: 0, privateBytes: 0, cpuTimeMs: 0, sampledAt: null, warmingUp: true };
    this.history = [];

    // Prefer the flag set previously validated against this exact JDK. Only
    // fall back to building it live if the definition predates that.
    const { ensureJvmFlags } = await import('./jvmFlags.js');
    await ensureJvmFlags(this.def);

    const jarPath = safeJoin(this.def.dir, this.def.jarFile);
    const args = [
      ...(this.def.jvmFlags ?? []),
      '-jar',
      jarPath,
      ...(this.def.serverArgs ?? ['nogui']),
    ];

    this.#setStatus(STATUS.STARTING, { reason });
    this.startedAt = Date.now();
    this.stoppedAt = null;

    this.log.info(`Starting "${this.def.name}" (${reason}) — ${path.basename(this.def.java.path)} ${args.slice(0, 4).join(' ')}`);

    const childEnv = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
    // These must be *deleted*, not blanked: an empty-but-present JAVA_TOOL_OPTIONS
    // still makes the JVM print "Picked up JAVA_TOOL_OPTIONS:" on every boot, and
    // a real value would silently inject flags we did not choose.
    delete childEnv.JAVA_TOOL_OPTIONS;
    delete childEnv._JAVA_OPTIONS;
    delete childEnv.JDK_JAVA_OPTIONS;
    delete childEnv.JAVA_OPTS;

    const child = spawn(this.def.java.path, args, {
      cwd: this.def.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv,
    });

    this.child = child;
    this.pid = child.pid;

    // Emitted only once the PID exists, so the registry persists a real
    // `lastPid` — that is what lets a restarted manager adopt a live JVM.
    this.emit('started', { serverId: this.id, reason, pid: this.pid });

    child.stdout.on('data', (chunk) => this.console.push(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => this.console.push(chunk, 'stderr'));

    child.on('error', (error) => {
      this.lastError = error.message;
      this.log.error(`spawn error: ${error.message}`);
      this.console.push(`\n[manager] Failed to launch the JVM: ${error.message}\n`, 'stderr');
      this.#setStatus(STATUS.ERROR, { error: error.message });
      this.#cleanupProcess();
    });

    child.on('exit', (code, signal) => this.#handleExit(code, signal));

    // Watchdog: if the server never reaches "Done", don't leave the UI spinning.
    if (waitForReady) {
      return new Promise((resolve, reject) => {
        const onReady = () => {
          clearTimeout(timer);
          this.pendingStartResolve = null;
          resolve(this.snapshot());
        };
        const timer = setTimeout(() => {
          this.off('status', onStatus);
          this.pendingStartResolve = null;
          const error = new Error(`Server did not finish starting within ${Math.round(readyTimeoutMs / 1000)}s.`);
          error.status = 504;
          reject(error);
        }, readyTimeoutMs);
        this.pendingStartResolve = { resolve, reject, timer };

        const onStatus = ({ status }) => {
          if (status === STATUS.RUNNING) onReady();
          if (status === STATUS.CRASHED || status === STATUS.ERROR) {
            clearTimeout(timer);
            this.off('status', onStatus);
            this.pendingStartResolve = null;
            const error = new Error(this.failure ? `${this.failure.title}: ${this.failure.hint}` : 'Server failed to start.');
            error.status = 500;
            error.detail = this.failure;
            reject(error);
          }
        };
        this.on('status', onStatus);
      });
    }

    return this.snapshot();
  }

  /** Pre-flight checks with actionable errors. */
  async #verifyRuntime() {
    if (!fs.existsSync(this.def.dir)) {
      const error = new Error(`Server directory is missing: ${this.def.dir}`);
      error.status = 410;
      throw error;
    }
    if (!fs.existsSync(this.def.java?.path)) {
      const error = new Error(
        `The configured Java runtime no longer exists at ${this.def.java?.path}. ` +
          'Pick another one in the server settings.',
      );
      error.status = 412;
      throw error;
    }
    const jarPath = safeJoin(this.def.dir, this.def.jarFile);
    if (!fs.existsSync(jarPath)) {
      const error = new Error(`The server jar "${this.def.jarFile}" is missing from ${this.def.dir}. Reinstall the server to fix this.`);
      error.status = 412;
      throw error;
    }
    // eula.txt must exist and be true or the JVM self-terminates immediately.
    const eulaPath = path.join(this.def.dir, 'eula.txt');
    let eulaOk = false;
    try {
      eulaOk = /^\s*eula\s*=\s*true\s*$/im.test(await fsp.readFile(eulaPath, 'utf8'));
    } catch {
      eulaOk = false;
    }
    if (!eulaOk) {
      this.log.warn('eula.txt was missing or false — writing eula=true');
      await fsp.writeFile(
        eulaPath,
        `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toUTCString()}\neula=true\n`,
        'utf8',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Exit handling
  // -------------------------------------------------------------------------

  #handleExit(code, signal) {
    const wasIntentional = this.intentionalStop;
    const uptime = this.uptimeMs;
    this.exitCode = code;
    this.exitSignal = signal;
    this.#cleanupProcess();

    if (wasIntentional) {
      this.#setStatus(STATUS.STOPPED, { code, signal, uptimeMs: uptime });
      this.console.push(`\n[manager] Server stopped${code === 0 ? '' : ` (exit code ${code}${signal ? `, signal ${signal}` : ''})`}.\n`, 'stdout');
      this.restartAttempts = 0;
      this.emit('stopped', { serverId: this.id, code, signal, uptimeMs: uptime, reason: 'requested' });
      return;
    }

    // Unexpected exit → diagnose it.
    const tail = this.console.tail(120).map((r) => r.text).join('\n');
    this.failure = classifyFailure(tail);
    this.log.error(`Unexpected exit (code=${code}, signal=${signal}) — ${this.failure.title}`);
    this.#setStatus(STATUS.CRASHED, { code, signal, failure: this.failure, uptimeMs: uptime });
    this.emit('crashed', { serverId: this.id, code, signal, failure: this.failure, uptimeMs: uptime });

    this.#maybeAutoRestart();
  }

  #cleanupProcess() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.stopTimer = null;
    this.startTimeout = null;

    if (this.pid) forgetProcess(this.pid);
    this.child = null;
    this.pid = null;
    this.stoppedAt = Date.now();
  }

  async #maybeAutoRestart() {
    const policy = this.def.autoRestart ?? {};
    if (!policy.enabled) return;
    // Don't hot-loop a server that dies instantly (e.g. missing jar).
    if (this.uptimeMs < 12_000) this.restartAttempts += 1;
    else this.restartAttempts = 0;

    if (this.restartAttempts > (policy.maxAttempts ?? 5)) {
      this.log.warn(`Auto-restart aborted after ${this.restartAttempts} rapid failures.`);
      this.console.push(`\n[manager] Auto-restart disabled after ${this.restartAttempts} rapid crashes. Fix the underlying issue and start the server manually.\n`, 'stderr');
      return;
    }

    const base = policy.delayMs ?? 5000;
    const delay = Math.min(120_000, base * 2 ** Math.max(0, this.restartAttempts - 1));
    this.console.push(`\n[manager] Auto-restarting in ${Math.round(delay / 1000)}s (attempt ${this.restartAttempts}/${policy.maxAttempts ?? 5})…\n`, 'stdout');
    this.emit('scheduled-restart', { serverId: this.id, delayMs: delay, attempt: this.restartAttempts });

    const timer = setTimeout(() => {
      if (this.intentionalStop || isLive(this.status)) return;
      this.start({ reason: 'auto-restart' }).catch((error) => this.log.error(`Auto-restart failed: ${error.message}`));
    }, delay);
    timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Stop / kill / restart
  // -------------------------------------------------------------------------

  /**
   * Graceful shutdown: `stop` on stdin, escalating to SIGTERM then a hard kill.
   * @param {{ force?: boolean, timeoutMs?: number, reason?: string }} [opts]
   */
  async stop({ force = false, timeoutMs = config.gracefulStopMs, reason = 'requested' } = {}) {
    if (!isLive(this.status) || !this.child) {
      // Already down — make sure the status reflects reality.
      if (this.status !== STATUS.STOPPED) this.#setStatus(STATUS.STOPPED, { force: true });
      return this.snapshot();
    }

    this.intentionalStop = true;
    this.stopRequestedAt = Date.now();
    const previousStatus = this.status;
    this.#setStatus(STATUS.STOPPING, { reason });

    this.console.push(`\n[manager] Stopping server (${reason})…\n`, 'stdout');

    if (!force) {
      try {
        this.send('stop', { silent: true });
      } catch {
        /* stdin closed; fall through to signals */
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.off('status', onStatus);
        clearTimeout(hardKill);
        clearTimeout(termKill);
        resolve(this.snapshot());
      };

      const onStatus = ({ status }) => {
        if (status === STATUS.STOPPED) finish();
        // It crashed while we were stopping — that is still "done".
        else if (status === STATUS.CRASHED || status === STATUS.ERROR) finish();
        else if (status === STATUS.RUNNING && previousStatus === STATUS.STARTING) {
          // Rare: the server came up while we were asking it to stop.
        }
      };
      this.on('status', onStatus);

      // Escalate: SIGTERM at the halfway mark, hard kill at the deadline.
      const termAt = force ? 0 : Math.max(2000, Math.floor(timeoutMs / 2));
      const killAt = force ? 500 : timeoutMs;

      const termKill = setTimeout(() => {
        if (settled || !this.child) return;
        this.console.push('[manager] Server did not exit in time — sending SIGTERM.\n', 'stderr');
        this.#signal('SIGTERM');
      }, termAt);

      const hardKill = setTimeout(() => {
        if (settled || !this.child) return;
        this.console.push('[manager] Still running — force-killing the JVM.\n', 'stderr');
        this.#hardKill();
        setTimeout(finish, 1500);
      }, killAt);

      termKill.unref?.();
      hardKill.unref?.();
    });
  }

  #signal(signal) {
    if (!this.child?.pid) return;
    try {
      if (IS_WINDOWS) this.#hardKill();
      else process.kill(this.child.pid, signal);
    } catch (error) {
      this.log.warn(`signal ${signal} failed: ${error.message}`);
    }
  }

  /** Kill the JVM and any children it spawned. */
  #hardKill() {
    const pid = this.child?.pid ?? this.pid;
    if (!pid) return;
    if (IS_WINDOWS) {
      try {
        // /T kills the process tree, /F forces. Detached so we don't block.
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
      } catch (error) {
        this.log.warn(`taskkill failed: ${error.message}`);
      }
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.intentionalStop = true;
  }

  async restart(opts = {}) {
    if (isLive(this.status)) await this.stop({ reason: 'restart' });
    // Give the OS a beat to release the port and unlock world files.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return this.start({ ...opts, reason: opts.reason ?? 'restart' });
  }

  // -------------------------------------------------------------------------
  // Console I/O
  // -------------------------------------------------------------------------

  /**
   * Send a command to the server's stdin.
   * @param {string} command
   * @param {{ silent?: boolean }} [opts] `silent` skips the local echo
   */
  send(command, { silent = false } = {}) {
    const line = String(command ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!line) return false;

    if (!this.child?.stdin?.writable) {
      const error = new Error('Server is not accepting console input right now.');
      error.status = 409;
      throw error;
    }

    if (!silent) {
      this.console.push(`\n[console] > ${line}\n`, 'stdin');
      this.commandHistory.push({ command: line, ts: Date.now() });
      if (this.commandHistory.length > 200) this.commandHistory.shift();
    }

    this.child.stdin.write(`${line}\n`);
    return true;
  }

  sendMany(commands, opts) {
    let sent = 0;
    for (const command of commands) {
      try {
        if (this.send(command, opts)) sent += 1;
      } catch {
        break;
      }
    }
    return sent;
  }

  // -------------------------------------------------------------------------
  // Log-derived events
  // -------------------------------------------------------------------------

  #handleEvent(record) {
    const event = record.event;
    if (!event) return;
    this.emit('console-event', { serverId: this.id, ...event, ts: record.ts });

    switch (event.type) {
      case 'ready':
        if (this.status === STATUS.STARTING) {
          this.#setStatus(STATUS.RUNNING, { bootSeconds: event.seconds });
          this.console.push(`[manager] Server is ready! Boot took ${event.seconds}s. Uptime clock started.\n`, 'stdout');
        }
        break;

      case 'stopping':
        if (this.status === STATUS.RUNNING) this.#setStatus(STATUS.STOPPING);
        break;

      case 'eula-required':
        this.failure = { id: 'eula', title: 'EULA not accepted', hint: 'eula.txt must contain eula=true.', action: 'accept-eula' };
        break;

      case 'port-conflict':
        this.failure = { id: 'port', title: 'Port already in use', hint: 'Another process is using this port. Change server-port.', action: 'change-port' };
        break;

      case 'bad-bind-address':
        this.failure = {
          id: 'bind-address',
          title: 'server-ip is not bindable',
          hint:
            `server-ip is set to "${event.host ?? 'a hostname'}", which the server cannot bind to. ` +
            'Clear server-ip in Properties — it must be empty or a local IP address.',
          action: 'fix-server-ip',
        };
        break;

      case 'java-mismatch':
        this.failure = { id: 'java', title: 'Wrong Java version', hint: 'Pick a newer JDK for this server.', action: 'fix-java' };
        break;

      case 'out-of-memory':
        this.failure = { id: 'memory', title: 'Out of memory', hint: 'Raise the max heap or lower simulation-distance.', action: 'raise-memory' };
        break;

      case 'join':
      case 'leave':
        this.emit('players', { serverId: this.id, players: this.allPlayersSummary() });
        break;

      default:
        break;
    }
  }

  allPlayersSummary() {
    return {
      online: this.console.onlinePlayers(),
      known: this.console.allPlayers(),
      onlineCount: this.onlineCount,
      history: this.console.playerHistory.slice(-120),
    };
  }

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------

  /** @internal called by the shared sampler tick */
  applySample(sample) {
    if (!sample) {
      if (isLive(this.status)) {
        this.metrics = { ...this.metrics, cpuPercent: 0, rssBytes: 0, sampledAt: Date.now() };
      }
      return false;
    }
    this.metrics = {
      cpuPercent: sample.cpuPercent,
      rssBytes: sample.rssBytes,
      privateBytes: sample.privateBytes ?? sample.rssBytes,
      cpuTimeMs: sample.cpuTimeMs,
      sampledAt: Date.now(),
      warmingUp: Boolean(sample.warmingUp),
    };
    this.history.push([Date.now(), sample.cpuPercent, sample.rssBytes]);
    // Keep ~3 minutes at a 2s cadence.
    if (this.history.length > 90) this.history.splice(0, this.history.length - 90);
    return true;
  }

  dispose() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.console.dispose();
    this.removeAllListeners();
  }
}

export default ManagedServer;
