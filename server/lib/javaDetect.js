/**
 * JDK discovery, version probing and (optional) Adoptium auto-download.
 *
 * Discovery strategy — cheapest first:
 *   1. `JAVA_HOME` and the `java` on `PATH`  (the user already picked one)
 *   2. Well-known vendor install roots for the current OS
 *   3. `CRAFTKEEP_EXTRA_JAVA_DIRS`
 *   4. Anything we previously downloaded into `<data>/java`
 *
 * Each candidate is probed exactly once with `java -XshowSettings:properties
 * -version`, and the result is cached in `data/cache/java-scan.json` so the UI
 * is instant on subsequent boots.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, ensureDirectories } from '../config.js';
import { download, getJson } from './httpClient.js';
import { ensureDir, existsSync, readJsonSync, writeJson, removeDir } from './fsUtil.js';
import createLogger from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('java');

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
export const JAVA_BINARY = IS_WINDOWS ? 'java.exe' : 'java';

/** Vendor hints used only for tie-breaking in `pickJava`. */
const VENDOR_RANK = [
  [/temurin|adoptium|eclipse/i, 10],
  [/microsoft/i, 20],
  [/corretto|amazon/i, 30],
  [/zulu|azul/i, 40],
  [/oracle/i, 50],
  [/graalvm/i, 60],
  [/semeru|ibm|openj9/i, 70],
  [/jbr|jetbrains/i, 80],
];

const rankVendor = (vendor = '', filePath = '') => {
  const haystack = `${vendor} ${filePath}`;
  for (const [re, rank] of VENDOR_RANK) if (re.test(haystack)) return rank;
  return 35; // unknown but not penalised
};

// ---------------------------------------------------------------------------
// Candidate paths
// ---------------------------------------------------------------------------

function candidateRoots() {
  const roots = new Set();

  if (process.env.JAVA_HOME) {
    roots.add(path.join(process.env.JAVA_HOME, 'bin', JAVA_BINARY));
    roots.add(path.join(process.env.JAVA_HOME, 'Contents', 'Home', 'bin', JAVA_BINARY));
  }
  for (const dir of config.extraJavaDirs) {
    roots.add(path.join(dir, 'bin', JAVA_BINARY));
    roots.add(path.join(dir, 'Contents', 'Home', 'bin', JAVA_BINARY));
  }

  if (IS_WINDOWS) {
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    const vendors = [
      'Java',
      'Eclipse Adoptium',
      'Eclipse Foundation',
      'Microsoft',
      'Amazon Corretto',
      'Zulu',
      'Azul',
      'BellSoft',
      'Semeru',
      'IBM',
      'Oracle',
      'Azul Systems',
      'JetBrains',
      'GraalVM',
      'RedHat',
      'SapMachine',
      'Temurin',
    ];
    for (const pf of programFiles) {
      for (const vendor of vendors) roots.add(path.join(pf, vendor));
    }
    roots.add(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'));
    roots.add(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft'));
    roots.add(path.join(process.env.APPDATA || '', '.minecraft', 'runtime')); // launcher-managed JREs
    roots.add(path.join(os.homedir(), '.jdks'));
    roots.add(path.join(os.homedir(), 'scoop', 'apps'));
    roots.add(path.join(os.homedir(), 'sdkman', 'candidates', 'java'));
    roots.add('C:\\Java');
    roots.add('C:\\jdk');
  }

  if (!IS_WINDOWS) {
    for (const base of ['/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk', '/usr/local/java', '/Library/Java/JavaVirtualMachines', '/usr/local/opt']) {
      roots.add(base);
    }
    roots.add(path.join(os.homedir(), '.sdkman', 'candidates', 'java'));
    roots.add(path.join(os.homedir(), '.jdks'));
    roots.add(path.join(os.homedir(), '.gradle', 'jdks'));
  }

  if (IS_MAC) {
    roots.add('/System/Volumes/Data/Library/Java/JavaVirtualMachines');
    roots.add('/Library/Java/JavaVirtualMachines');
  }

  // Our own managed JDKs always win the "previously downloaded" tie-break.
  roots.add(config.jdkDir);

  return [...roots].filter(Boolean);
}

/**
 * Turn a root entry into one or more `java` executables.
 * Roots may be: an install root containing `bin/java`, a directory of JDKs, or
 * a nested `.app`/`.jdk` bundle.
 */
async function expandRoot(root) {
  const found = [];

  const pushIfBinary = (dir) => {
    const binary = path.join(dir, 'bin', JAVA_BINARY);
    if (existsSync(binary)) found.push(binary);
    // macOS bundles keep the real JDK one level down.
    const macBinary = path.join(dir, 'Contents', 'Home', 'bin', JAVA_BINARY);
    if (existsSync(macBinary)) found.push(macBinary);
  };

  pushIfBinary(root);

  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  // Root was a *collection* directory: scan immediate children (and one level
  // deeper for layouts like `Microsoft/jdk-21.0.1+12`).
  const dirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink());
  for (const entry of dirs) {
    const full = path.join(root, entry.name);
    const before = found.length;
    pushIfBinary(full);
    if (found.length > before) continue;

    let nested;
    try {
      nested = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of nested) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      pushIfBinary(path.join(full, child.name));
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** Run `<java> -XshowSettings:properties -version` and parse vendor/version/arch. */
async function probe(binary) {
  const started = Date.now();
  let stderr = '';
  try {
    const { stderr: err } = await execFileAsync(binary, ['-XshowSettings:properties', '-version'], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    stderr = err ?? '';
  } catch (error) {
    // Older/odd JVMs still print everything to stderr while exiting non-zero.
    stderr = `${error?.stderr ?? ''}${error?.stdout ?? ''}`;
    if (!stderr) return null;
  }

  const get = (key) => {
    const match = stderr.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  };

  const versionString =
    get('java.version') ??
    (stderr.match(/version "([^"]+)"/) || [])[1] ??
    null;
  if (!versionString) return null;

  // "1.8.0_402" -> 8 ; "21.0.4" -> 21 ; "25-ea" -> 25
  let major;
  const legacy = versionString.match(/^1\.(\d+)/);
  if (legacy) major = Number(legacy[1]);
  else major = Number.parseInt(versionString, 10);
  if (!Number.isFinite(major) || major <= 0) return null;

  const realBinary = (() => {
    try {
      return fs.realpathSync(binary);
    } catch {
      return binary;
    }
  })();
  const home = path.dirname(path.dirname(realBinary));
  const vendor = get('java.vendor') ?? 'Unknown';

  return {
    path: realBinary,
    home,
    version: versionString,
    major,
    vendor,
    vendorRank: rankVendor(vendor, realBinary),
    vm: get('java.vm.name') ?? 'HotSpot',
    arch: get('os.arch') ?? process.arch,
    isJdk: await hasJavac(home),
    headless: /headless/i.test(realBinary) || /headless/i.test(get('java.home') ?? ''),
    managed: realBinary.startsWith(path.resolve(config.jdkDir)),
    probedMs: Date.now() - started,
  };
}

async function hasJavac(home) {
  const names = IS_WINDOWS ? ['javac.exe'] : ['javac'];
  const search = [path.join(home, 'bin')];
  const macRoot = path.join(home, '..', '..', '..', 'bin');
  search.push(macRoot);
  for (const dir of search) {
    for (const name of names) {
      if (existsSync(path.join(dir, name))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const CACHE_FILE = () => path.join(config.cacheDir, 'java-scan.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

let inflight = null;

/**
 * Discover every usable JDK on the machine.
 * @param {{ force?: boolean }} [opts]
 */
export async function detectJava({ force = false } = {}) {
  if (!force) {
    const cached = readJsonSync(CACHE_FILE(), null);
    if (cached?.scannedAt && Date.now() - cached.scannedAt < CACHE_TTL_MS) return cached.installations;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    ensureDirectories();
    const started = Date.now();

    const pathBinary = await whichJava();
    const roots = candidateRoots();
    const expanded = await Promise.all(roots.map(expandRoot));

    const binaries = new Set();
    if (pathBinary) binaries.add(pathBinary);
    for (const list of expanded) for (const binary of list) binaries.add(binary);

    const probed = await Promise.all([...binaries].map((b) => probe(b).catch(() => null)));

    // Deduplicate by resolved path *and* by major/version/home.
    const seen = new Map();
    for (const java of probed) {
      if (!java) continue;
      const key = java.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, java);
    }

    const installations = [...seen.values()].sort(
      (a, b) => a.major - b.major || a.vendorRank - b.vendorRank || a.vendor.localeCompare(b.vendor),
    );

    await writeJson(CACHE_FILE(), { scannedAt: Date.now(), installations }).catch(() => {});
    log.info(
      `Detected ${installations.length} Java installation(s) in ${Date.now() - started}ms: ` +
        (installations.map((i) => `Java ${i.major} (${i.vendor})`).join(', ') || 'none'),
    );
    return installations;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Resolve the `java` executable on PATH without shelling out to `which`. */
async function whichJava() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir.replace(/^"|"$/g, ''), JAVA_BINARY);
    if (existsSync(candidate)) {
      try {
        await fsp.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not executable */
      }
    }
  }
  return null;
}

/** Re-probe a single explicit path (used when the user types one in). */
export async function inspectJava(binaryPath) {
  const resolved = path.resolve(binaryPath);
  if (!existsSync(resolved)) {
    const err = new Error(`No file at ${resolved}`);
    err.status = 400;
    throw err;
  }
  const info = await probe(resolved);
  if (!info) {
    const err = new Error(`"${resolved}" did not behave like a Java executable.`);
    err.status = 400;
    throw err;
  }
  return info;
}

// ---------------------------------------------------------------------------
// Adoptium auto-download
// ---------------------------------------------------------------------------

const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest';

const adoptiumOs = () => {
  if (IS_WINDOWS) return 'windows';
  if (IS_MAC) return 'mac';
  return 'linux';
};

const adoptiumArch = () => {
  const arch = process.arch;
  if (arch === 'arm64') return 'aarch64';
  if (arch === 'x64') return 'x64';
  if (arch === 'ia32') return 'x32';
  return arch;
};

/** Look up the newest Temurin build for a given feature release. */
export async function findAdoptiumJdk(featureVersion) {
  const url =
    `${ADOPTIUM_API}/${featureVersion}/hotspot` +
    `?architecture=${adoptiumArch()}&image_type=jdk&os=${adoptiumOs()}&vendor=eclipse&page_size=1`;

  const releases = await getJson(url, { timeout: 30_000 });
  const binary = releases?.[0]?.binary?.package;
  if (!binary?.link) {
    const err = new Error(`Adoptium has no JDK ${featureVersion} build for ${adoptiumOs()}/${adoptiumArch()}.`);
    err.status = 502;
    throw err;
  }
  return {
    url: binary.link,
    name: binary.name,
    size: binary.size ?? 0,
    checksum: binary.checksum,
    releaseName: releases[0].release_name ?? `jdk-${featureVersion}`,
  };
}

/**
 * Download + unpack a Temurin JDK into `<data>/java`.
 * Uses the platform `tar` binary, which ships with Windows 10 1803+, macOS and
 * every modern Linux — no npm dependency required.
 *
 * @param {number} featureVersion
 * @param {{ onProgress?: Function }} [opts]
 */
export async function installJdk(featureVersion, { onProgress } = {}) {
  ensureDirectories();
  const build = await findAdoptiumJdk(featureVersion);
  const target = path.join(config.jdkDir, `temurin-${featureVersion}`);

  if (existsSync(path.join(target, 'bin', JAVA_BINARY))) {
    const existing = await inspectJava(path.join(target, 'bin', JAVA_BINARY));
    log.info(`JDK ${featureVersion} already present at ${existing.path}`);
    return existing;
  }

  const archive = path.join(config.downloadsDir, build.name);
  log.info(`Downloading ${build.name} (${Math.round(build.size / 1024 / 1024)} MiB)`);
  await download(build.url, archive, {
    onProgress,
    expectedSha256: build.checksum?.type?.toLowerCase() === 'sha256' ? build.checksum.value : undefined,
  });

  // Extract into a scratch dir first so a failure cannot leave a partial JDK
  // behind where the scanner would trip over it.
  const scratch = path.join(config.downloadsDir, `extract-${featureVersion}-${Date.now()}`);
  await ensureDir(scratch);
  try {
    await extractArchive(archive, scratch);

    // Adoptium archives contain a single top-level `jdk-xx.y.z+n` directory.
    const entries = await fsp.readdir(scratch, { withFileTypes: true });
    const rootDir = entries.find((e) => e.isDirectory());
    const source = rootDir ? path.join(scratch, rootDir.name) : scratch;

    if (!existsSync(path.join(source, 'bin', JAVA_BINARY))) {
      // macOS layout: the binary lives under Contents/Home.
      if (!existsSync(path.join(source, 'Contents', 'Home', 'bin', JAVA_BINARY))) {
        throw new Error('The downloaded archive did not contain a Java runtime (unexpected layout).');
      }
    }

    await removeDir(target).catch(() => {});
    await ensureDir(path.dirname(target));
    await fsp.rename(source, target).catch(async (error) => {
      // Cross-device rename (rare): fall back to a copy.
      if (error?.code !== 'EXDEV') throw error;
      await fsp.cp(source, target, { recursive: true });
    });
  } finally {
    await removeDir(scratch).catch(() => {});
    await fsp.rm(archive, { force: true }).catch(() => {});
  }

  const binary = [path.join(target, 'bin', JAVA_BINARY), path.join(target, 'Contents', 'Home', 'bin', JAVA_BINARY)].find(
    existsSync,
  );
  if (!binary) throw new Error('JDK was extracted but no java binary could be located.');

  const info = await inspectJava(binary);
  await detectJava({ force: true });
  log.info(`Installed Java ${info.major} (${info.vendor}) at ${info.path}`);
  return info;
}

/** Unpack `.zip` / `.tar.gz` using the system `tar`. */
export async function extractArchive(archive, destination) {
  await ensureDir(destination);
  const lower = archive.toLowerCase();
  const args = lower.endsWith('.zip')
    ? ['-xf', archive, '-C', destination]
    : ['-xzf', archive, '-C', destination];

  try {
    await execFileAsync('tar', args, { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const hint =
      error?.code === 'ENOENT'
        ? ' The system `tar` command was not found. Install tar (or unzip the JDK manually and add it in Settings › Java).'
        : '';
    throw new Error(`Failed to extract ${path.basename(archive)}.${hint} ${error?.stderr ?? error?.message ?? ''}`.trim());
  }
}

/** Quick summary of what the machine can run, for the dashboard health card. */
export async function javaSummary() {
  const installations = await detectJava();
  const majors = [...new Set(installations.map((i) => i.major))].sort((a, b) => a - b);
  const highest = majors.length ? Math.max(...majors) : 0;

  // "Can this machine run a server that needs Java N?" — an exact match or any
  // newer JVM counts, since Minecraft only ever requires a *minimum* version.
  const canRun = {};
  for (const required of [8, 16, 17, 21, 25]) {
    canRun[required] = majors.some((m) => m >= required);
  }

  return {
    count: installations.length,
    majors,
    newest: installations.length ? installations[installations.length - 1] : null,
    highest,
    canRun,
    /** Convenience flags the onboarding wizard uses. */
    readyFor: {
      legacy: canRun[8],
      '1.18-1.20.4': canRun[17],
      '1.20.5-1.21.x': canRun[21],
      latest: canRun[25],
    },
    installations,
  };
}
