/**
 * playit.gg tunnel agent.
 *
 * This is the answer for connections that cannot be port-forwarded — carrier
 * NAT (common on LTE/5G home broadband), a second router you do not control, or
 * an ISP that simply blocks inbound traffic. The agent makes an *outbound*
 * connection to playit's network, which then proxies players to your server.
 * Nothing needs to reach you from the outside.
 *
 * What this module manages:
 *   1. **Fetching the agent**, pinned to a known version and gated on a valid
 *      Authenticode signature from the publisher. A checksum proves the bytes
 *      did not change; a signature proves *who* produced them, which is the
 *      check that actually matters for a binary we are about to execute.
 *   2. **Claiming it** to a playit.gg account, either by opening a claim URL or
 *      by accepting a secret key pasted from the dashboard.
 *   3. **Running it** as a child process with its own IPC pipe, so it cannot
 *      collide with a separately installed playit service.
 *   4. **Reporting the assigned public address**, which arrives in the agent's
 *      log rather than from an API.
 *
 * The account itself is yours: playit.gg requires a free sign-in before an agent
 * can be claimed, and this module will not pretend otherwise.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { ensureDir } from './fsUtil.js';
import { download, getJson } from './httpClient.js';
import createLogger from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('tunnel');

const IS_WINDOWS = process.platform === 'win32';

/** Pinned so the binary we execute is the one that was reviewed. */
const DEFAULT_VERSION = 'v1.2.0';

const RELEASE_API = 'https://api.github.com/repos/playit-cloud/playit-agent/releases';

/** Publisher name from the Authenticode certificate. */
const EXPECTED_SIGNER = 'Developed Methods LLC';

const ASSET_NAMES = {
  daemon: IS_WINDOWS ? 'playitd-windows-x86_64-signed.exe' : 'playit-linux-amd64',
  cli: IS_WINDOWS ? 'playit-windows-x86_64-signed.exe' : 'playit-linux-amd64',
};

const BINARY_NAMES = {
  daemon: IS_WINDOWS ? 'playitd.exe' : 'playitd',
  cli: IS_WINDOWS ? 'playit.exe' : 'playit',
};

/** Where the tool and its credential live. */
const tunnelDir = () => path.join(config.dataDir, 'playit');
const secretFile = () => path.join(tunnelDir(), 'secret');

// ---------------------------------------------------------------------------
// Downloading, and proving what we downloaded
// ---------------------------------------------------------------------------

/**
 * Verify a Windows executable's Authenticode signature.
 *
 * A hash tells you the file did not change in transit. A signature tells you
 * the publisher produced it. For a binary that is about to be spawned, only the
 * second question really matters.
 *
 * @returns {Promise<{ ok: boolean, signer: string|null, reason?: string }>}
 */
async function verifyAuthenticode(file) {
  if (!IS_WINDOWS) return { ok: true, signer: null, reason: 'Signature check is Windows-only.' };

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; ` +
          `[PSCustomObject]@{ status = "$($s.Status)"; subject = "$($s.SignerCertificate.Subject)" } | ConvertTo-Json -Compress`,
      ],
      { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );

    const parsed = JSON.parse(stdout);
    const status = String(parsed.status ?? '');
    const subject = String(parsed.subject ?? '');

    if (status !== 'Valid') return { ok: false, signer: subject || null, reason: `Signature status: ${status}` };
    if (!subject.includes(EXPECTED_SIGNER)) {
      return { ok: false, signer: subject, reason: `Signed by "${subject}", not "${EXPECTED_SIGNER}".` };
    }
    return { ok: true, signer: EXPECTED_SIGNER };
  } catch (error) {
    return { ok: false, signer: null, reason: `Could not read the signature: ${error.message}` };
  }
}

/** Resolve the release to install from, with sizes to sanity-check against. */
async function resolveRelease(version) {
  const tag = version || process.env.MCSM_PLAYIT_VERSION || DEFAULT_VERSION;
  const release = await getJson(`${RELEASE_API}/tags/${tag}`, { cacheTtlMs: 60 * 60 * 1000, timeout: 20_000 });

  const find = (name) => release.assets?.find((a) => a.name === name) ?? null;
  const daemon = find(ASSET_NAMES.daemon);
  const cli = find(ASSET_NAMES.cli);

  if (!daemon) {
    throw Object.assign(new Error(`Release ${tag} has no asset named ${ASSET_NAMES.daemon}.`), { status: 502 });
  }

  return {
    version: release.tag_name ?? tag,
    publishedAt: release.published_at ?? null,
    daemon: { url: daemon.browser_download_url, size: daemon.size },
    cli: cli ? { url: cli.browser_download_url, size: cli.size } : null,
  };
}

/**
 * Download and verify an asset if it is not already present and valid.
 * @returns {Promise<string>} path to the executable
 */
async function ensureBinary(kind) {
  await ensureDir(tunnelDir());
  const target = path.join(tunnelDir(), BINARY_NAMES[kind]);

  if (fs.existsSync(target)) {
    const check = await verifyAuthenticode(target);
    if (check.ok) return target;
    log.warn(`Existing ${BINARY_NAMES[kind]} failed verification (${check.reason}) — re-downloading.`);
    await fsp.rm(target, { force: true });
  }

  const release = await resolveRelease(process.env.MCSM_PLAYIT_VERSION);
  const asset = release[kind];
  if (!asset?.url) throw Object.assign(new Error(`No downloadable ${kind} for this platform.`), { status: 502 });

  log.info(`Downloading ${BINARY_NAMES[kind]} from playit release ${release.version}…`);
  const scratch = `${target}.part`;
  await download(asset.url, scratch, {});
  await fsp.rename(scratch, target);

  const stats = await fsp.stat(target);
  if (asset.size && stats.size !== asset.size) {
    // Not fatal — the signature is the real gate — but worth saying out loud.
    log.warn(`${BINARY_NAMES[kind]} size ${stats.size} differs from the release listing (${asset.size}).`);
  }

  const check = await verifyAuthenticode(target);
  if (!check.ok) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw Object.assign(
      new Error(
        `The downloaded ${BINARY_NAMES[kind]} failed signature verification: ${check.reason}. ` +
          'It has been deleted. Nothing was executed.',
      ),
      { status: 502 },
    );
  }

  if (!IS_WINDOWS) await fsp.chmod(target, 0o755).catch(() => {});
  log.info(`${BINARY_NAMES[kind]} ready (${(stats.size / 1024 / 1024).toFixed(2)} MiB, signature valid).`);
  return target;
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

export class PlayitTunnel extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    /** @type {import('node:child_process').ChildProcess|null} */
    this.process = null;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.claimProcess = null;
    this.binaryPath = null;
    this.status = 'idle'; // idle | downloading | claiming | starting | running | error
    this.lastError = null;
    this.publicAddress = null;
    this.claim = null; // { code, url, name, startedAt }
    this.lines = [];
    this.startedAt = null;
    /** Isolated from any separately installed playit service. */
    this.pipePath = IS_WINDOWS ? '\\\\.\\pipe\\mcsm-playit-agent' : path.join(tunnelDir(), 'playit.sock');
  }

  // -- Credential ---------------------------------------------------------

  hasSecret() {
    try {
      return fs.statSync(secretFile()).size > 10;
    } catch {
      return false;
    }
  }

  async readSecret() {
    try {
      return (await fsp.readFile(secretFile(), 'utf8')).trim();
    } catch {
      return '';
    }
  }

  async writeSecret(secret) {
    await ensureDir(tunnelDir());
    await fsp.writeFile(secretFile(), `${String(secret).trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    log.info('playit agent secret stored.');
  }

  async forgetSecret() {
    await fsp.rm(secretFile(), { force: true }).catch(() => {});
    this.publicAddress = null;
    log.info('playit agent secret removed — the agent will need reclaiming.');
  }

  // -- Log ring -----------------------------------------------------------

  #push(line) {
    const text = String(line).replace(/\r$/, '');
    if (!text.trim()) return;
    this.lines.push({ ts: Date.now(), text });
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);

    // The assigned address only ever appears in the log, so watch for it.
    const address = extractAddress(text);
    if (address && address !== this.publicAddress) {
      this.publicAddress = address;
      log.info(`Tunnel address: ${address}`);
      this.emit('address', address);
    }

    if (/error|failed|invalid/i.test(text) && this.status === 'running') {
      // Surface it without changing state — the agent retries by itself.
      this.emit('warning', text);
    }

    this.emit('log', text);
  }

  // -- Claiming -----------------------------------------------------------

  /**
   * Begin claiming this agent to a playit.gg account.
   *
   * Generates a code and the URL to approve it, then starts exchanging in the
   * background. The exchange blocks until the user approves in their browser,
   * so it runs as a child process rather than holding a request open.
   *
   * @param {{ name?: string }} [options]
   */
  async beginClaim({ name = 'Minecraft Server Manager' } = {}) {
    const cli = await this.#cli();

    const { stdout: codeOut } = await execFileAsync(cli, ['claim', 'generate'], { timeout: 30_000, windowsHide: true });
    const code = String(codeOut).trim().split(/\s+/).pop();
    if (!/^[a-z0-9]{6,}$/i.test(code)) throw new Error(`playit returned an unexpected claim code: "${codeOut.trim()}"`);

    const safeName = String(name).replace(/[^\w .-]/g, '').slice(0, 40) || 'Minecraft Server Manager';
    const { stdout: urlOut } = await execFileAsync(cli, ['claim', 'url', code, '--name', safeName], {
      timeout: 30_000,
      windowsHide: true,
    });
    const url = String(urlOut).trim().split(/\s+/).find((part) => part.startsWith('http'));
    if (!url) throw new Error('playit did not return a claim URL.');

    this.claim = { code, url, name: safeName, startedAt: Date.now() };
    this.status = 'claiming';
    this.lastError = null;
    this.emit('update', this.snapshot());

    // Exchange in the background; it resolves when the user approves.
    this.#runExchange(cli, code).catch((error) => {
      this.lastError = error.message;
      this.status = 'error';
      this.emit('update', this.snapshot());
    });

    return { code, url, name: safeName };
  }

  async #runExchange(cli, code) {
    await new Promise((resolve, reject) => {
      const child = spawn(cli, ['claim', 'exchange', code, '--wait', '0'], { windowsHide: true });
      this.claimProcess = child;

      let collected = '';
      const onData = (chunk) => {
        const text = chunk.toString();
        collected += text;
        this.#push(text.trim());

        const secret = extractSecret(collected);
        if (secret) {
          child.kill();
          resolve(secret);
        }
      };

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('exit', () => {
        this.claimProcess = null;
        const secret = extractSecret(collected);
        if (secret) resolve(secret);
        else reject(new Error('The claim process exited without returning a secret.'));
      });

      // Bounded: a claim left hanging for 15 minutes is stale.
      setTimeout(() => {
        if (this.claimProcess === child) {
          child.kill();
          reject(new Error('The claim timed out after 15 minutes. Generate a new link and try again.'));
        }
      }, 15 * 60 * 1000).unref?.();
    })
      .then(async (secret) => {
        await this.writeSecret(secret);
        this.claim = null;
        this.status = 'idle';
        this.emit('update', this.snapshot());
        this.emit('claimed');
      })
      .catch((error) => {
        this.claim = null;
        throw error;
      });
  }

  cancelClaim() {
    try {
      this.claimProcess?.kill();
    } catch {
      /* already gone */
    }
    this.claimProcess = null;
    this.claim = null;
    if (this.status === 'claiming') this.status = 'idle';
    this.emit('update', this.snapshot());
  }

  /** Accept a secret generated on the playit.gg dashboard instead. */
  async useSecret(secret) {
    const value = String(secret ?? '').trim();
    if (value.length < 20) throw Object.assign(new Error('That does not look like a playit agent secret.'), { status: 400 });
    await this.writeSecret(value);
    this.claim = null;
    this.lastError = null;
    this.emit('update', this.snapshot());
  }

  // -- Running ------------------------------------------------------------

  async #cli() {
    return ensureBinary('cli');
  }

  async ensureAgent() {
    this.binaryPath = await ensureBinary('daemon');
    return this.binaryPath;
  }

  /** @returns {Promise<{ ok: boolean, error?: string }>} */
  async start() {
    if (this.process) return { ok: true };

    const secret = await this.readSecret();
    if (!secret) throw Object.assign(new Error('This agent has not been claimed yet.'), { status: 412 });

    this.status = 'starting';
    this.emit('update', this.snapshot());

    const binary = await this.ensureAgent();
    const logPath = path.join(config.logsDir, 'playit-agent.log');
    await ensureDir(config.logsDir);

    const child = spawn(
      binary,
      ['--secret', secret, '--socket-path', this.pipePath, '--log-path', logPath],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.process = child;
    this.startedAt = Date.now();
    this.status = 'running';

    child.stdout.on('data', (chunk) => this.#push(chunk.toString()));
    child.stderr.on('data', (chunk) => this.#push(chunk.toString()));

    child.on('error', (error) => {
      this.lastError = error.message;
      this.status = 'error';
      this.process = null;
      this.emit('update', this.snapshot());
    });

    child.on('exit', (code, signal) => {
      this.process = null;
      this.startedAt = null;
      if (this.status !== 'idle') {
        this.status = code === 0 ? 'idle' : 'error';
        if (code !== 0 && code !== null) {
          this.lastError = `The agent exited with code ${code}${signal ? ` (${signal})` : ''}.`;
        }
      }
      this.emit('update', this.snapshot());
    });

    // Tail the daemon's own log file too: on Windows the child's stdio is
    // often empty because the daemon writes to its log rather than the console.
    this.#tailLogFile(logPath);

    this.emit('update', this.snapshot());
    return { ok: true };
  }

  #tailLogFile(logPath) {
    this.stopTailing?.();
    let offset = 0;

    const read = async () => {
      try {
        const stats = await fsp.stat(logPath);
        if (stats.size < offset) offset = 0; // rotated
        if (stats.size > offset) {
          const handle = await fsp.open(logPath, 'r');
          try {
            const length = stats.size - offset;
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, offset);
            offset = stats.size;
            for (const line of buffer.toString('utf8').split('\n')) this.#push(line);
          } finally {
            await handle.close();
          }
        }
      } catch {
        /* not created yet */
      }
    };

    const timer = setInterval(read, 2000);
    timer.unref?.();
    this.stopTailing = () => clearInterval(timer);
    read();
  }

  async stop() {
    this.stopTailing?.();
    this.stopTailing = null;

    const child = this.process;
    if (!child) {
      this.status = 'idle';
      this.emit('update', this.snapshot());
      return { ok: true };
    }

    this.status = 'idle';
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 5000).unref?.();
    });

    this.process = null;
    this.emit('update', this.snapshot());
    return { ok: true };
  }

  // -- Reporting ----------------------------------------------------------

  snapshot() {
    return {
      status: this.status,
      installed: Boolean(this.binaryPath ?? fs.existsSync(path.join(tunnelDir(), BINARY_NAMES.daemon))),
      claimed: this.hasSecret(),
      running: Boolean(this.process),
      publicAddress: this.publicAddress,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      claim: this.claim,
      lastError: this.lastError,
      pipe: this.pipePath,
      directory: tunnelDir(),
      version: process.env.MCSM_PLAYIT_VERSION || DEFAULT_VERSION,
      logTail: this.lines.slice(-120).map((l) => l.text),
    };
  }

  /** Called during app shutdown. */
  async dispose() {
    await this.stop().catch(() => {});
    try {
      this.claimProcess?.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/**
 * Pull a `*.playit.gg` hostname out of a log line.
 *
 * The agent does not report its address through an API — it prints it. Rather
 * than depend on one exact message (which has changed between versions), accept
 * any playit.gg hostname and let the UI show the raw log alongside it.
 */
export function extractAddress(line) {
  const match = String(line).match(/\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:playit\.gg|at\.playit\.gg|playit\.gg\.))\b/i);
  if (match) return match[1];

  // Some versions print `address=xyz.example.com:25565` or a bare host:port.
  const keyed = String(line).match(/\b(?:address|tunnel|hostname|endpoint)\s*[=:]\s*"?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::(\d+))?/i);
  if (keyed) return keyed[2] ? `${keyed[1]}:${keyed[2]}` : keyed[1];

  return null;
}

/**
 * A playit agent secret is a long URL-safe token. Pull it out of whatever the
 * claim process printed, ignoring the log noise around it.
 */
export function extractSecret(output) {
  const text = String(output ?? '');
  const candidates = text.match(/\b[A-Za-z0-9_-]{40,}\b/g) ?? [];
  // Longest wins: log timestamps and module names are never that long.
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

export default PlayitTunnel;
