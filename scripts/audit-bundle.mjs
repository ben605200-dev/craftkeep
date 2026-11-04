/**
 * Audit what actually ships inside `app.asar`.
 *
 * Worth running before sharing a build: the packaging glob is broad, and it is
 * easy to bundle local state by accident — a registry listing someone's
 * servers, a `.env` with a token, a stray world folder. This reads the asar
 * header directly (no dependency) and flags anything that should not be there.
 *
 * Usage:  node scripts/audit-bundle.mjs [path/to/app.asar]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asarPath = process.argv[2] ?? path.join(ROOT, 'dist-app', 'win-unpacked', 'resources', 'app.asar');

/**
 * Read the file table out of an asar archive.
 *
 * Layout, from Chromium's Pickle (two nested pickles, then the JSON): 
 *
 *    0   uint32  outer payload size (always 4)
 *    4   uint32  header buffer size
 *    8   uint32  inner payload size (header buffer size − 4)
 *    12  uint32  JSON string length
 *    16  bytes   JSON header
 *
 * The string length at 12 is the authoritative one. Reading the buffer size at
 * 8 instead is four bytes too long, which leaves stray bytes past the JSON and
 * makes JSON.parse fail with "Unexpected non-whitespace character after JSON".
 */
function readAsarIndex(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);

    const bufferSize = prefix.readUInt32LE(8);
    const stringSize = prefix.readUInt32LE(12);
    const length = stringSize > 0 && stringSize <= bufferSize ? stringSize : bufferSize - 4;

    const header = Buffer.alloc(length);
    fs.readSync(fd, header, 0, length, 16);

    const text = header.toString('utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // Be forgiving about padding if a future asar layout adds any.
      json = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
    }

    const files = [];

    const walk = (node, prefixPath) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = prefixPath ? `${prefixPath}/${name}` : name;
        if (entry.files) {
          files.push({ path: full, dir: true, size: 0 });
          walk(entry, full);
        } else {
          files.push({
            path: full,
            dir: false,
            size: entry.size ?? 0,
            unpacked: Boolean(entry.unpacked),
          });
        }
      }
    };
    walk(json, '');

    return { files, bufferSize };
  } finally {
    fs.closeSync(fd);
  }
}

if (!fs.existsSync(asarPath)) {
  console.error(`No asar at ${asarPath}. Build first with \`npm run dist\`.`);
  process.exit(1);
}

const { files } = readAsarIndex(asarPath);
const fileEntries = files.filter((f) => !f.dir);
const totalBytes = fileEntries.reduce((sum, f) => sum + f.size, 0);

/**
 * Patterns that must never appear in a distributed build. Each is something
 * that would either leak the developer's local state or expose a secret.
 */
const FORBIDDEN = [
  { re: /^data\//i, why: "local runtime state (server registry, settings, logs)" },
  { re: /^servers\//i, why: "server directories / world data" },
  { re: /^dist-app\//i, why: "build output" },
  { re: /(^|\/)\.env$/i, why: "environment file, may contain a token" },
  { re: /(^|\/)\.env\./i, why: "environment file" },
  { re: /\.log$/i, why: "log file" },
  // Runtime dependencies (express, ws) *do* ship inside the asar — that is how
  // a packaged Electron app resolves them. Only dev tooling must never appear.
  { re: /^node_modules\/(electron|electron-builder|@electron|app-builder-lib)(\/|$)/i, why: "development tooling, not shipped at runtime" },
  { re: /(^|\/)\.git\//i, why: "git metadata" },
  { re: /\.(zip|tar\.gz|mca|jar)$/i, why: "archive or world file" },
  { re: /secret/i, why: "filename mentions a secret" },
  { re: /(^|\/)test\//i, why: "test fixtures" },
];

const violations = [];
for (const entry of fileEntries) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(entry.path)) violations.push({ ...entry, why: rule.why });
  }
}

/*
 * Files flagged `unpacked` are not in the archive body — they sit next to it as
 * plain files on disk, so the header alone cannot clear them. Scan them too.
 */
const unpackedDir = `${asarPath}.unpacked`;
let unpackedFiles = [];
if (fs.existsSync(unpackedDir)) {
  const walkDir = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkDir(full));
      else out.push({ path: path.relative(unpackedDir, full).replace(/\\/g, '/'), size: fs.statSync(full).size });
    }
    return out;
  };
  unpackedFiles = walkDir(unpackedDir);
  for (const entry of unpackedFiles) {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(entry.path)) violations.push({ ...entry, why: rule.why });
    }
  }
}

/** What the app legitimately needs at runtime. */
const EXPECTED_ROOTS = ['desktop/', 'server/', 'web/', 'scripts/', 'node_modules/', 'README.md', 'package.json'];

/**
 * Not just "nothing bad": the bundle must also contain everything needed to
 * boot, or a recipient gets an app that dies on first run.
 */
const REQUIRED = [
  ['desktop/main.js', 'Electron entry point'],
  ['server/index.js', 'manager library'],
  ['web/index.html', 'UI shell'],
  ['node_modules/express/package.json', 'runtime dependency: express'],
  ['node_modules/ws/package.json', 'runtime dependency: ws'],
];
const present = new Set(fileEntries.map((f) => f.path));
const missing = REQUIRED.filter(([p]) => !present.has(p));

console.log(`Auditing ${path.relative(ROOT, asarPath)}`);
console.log(`  ${files.filter((f) => f.dir).length} directories, ${fileEntries.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB\n`);

console.log('Top-level layout:');
const roots = new Map();
for (const entry of fileEntries) {
  const root = entry.path.includes('/') ? `${entry.path.split('/')[0]}/` : entry.path;
  const current = roots.get(root) ?? { count: 0, bytes: 0 };
  current.count += 1;
  current.bytes += entry.size;
  roots.set(root, current);
}
for (const [root, info] of [...roots.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  const expected = EXPECTED_ROOTS.includes(root);
  console.log(`  ${expected ? ' ' : '?'} ${root.padEnd(22)} ${String(info.count).padStart(4)} files  ${(info.bytes / 1024).toFixed(0).padStart(6)} KiB`);
}

const unexpectedRoots = [...roots.keys()].filter((r) => !EXPECTED_ROOTS.includes(r));
if (unexpectedRoots.length) {
  console.log(`\n  '?' marks root entries not on the expected list: ${unexpectedRoots.join(', ')}`);
}

const unpackedEntries = fileEntries.filter((f) => f.unpacked);
if (unpackedEntries.length || unpackedFiles.length) {
  const bytes = unpackedFiles.reduce((sum, f) => sum + f.size, 0);
  console.log(
    `\n  note: ${unpackedEntries.length} header entr(ies) unpacked to disk (${unpackedFiles.length} file(s), ${(bytes / 1024 / 1024).toFixed(2)} MiB) — scanned as well`,
  );
}

if (violations.length) {
  console.error(`\n\x1b[31m✖ ${violations.length} entr(ies) that must not ship:\x1b[0m`);
  for (const v of violations.slice(0, 40)) console.error(`  • ${v.path}  — ${v.why}`);
  if (violations.length > 40) console.error(`  … and ${violations.length - 40} more`);
  process.exit(1);
}

if (missing.length) {
  console.error(`\n\x1b[31m✖ ${missing.length} required entr(ies) missing from the bundle:\x1b[0m`);
  for (const [p, why] of missing) console.error(`  • ${p}  — ${why}`);
  process.exit(1);
}

console.log('\n\x1b[32m✔\x1b[0m No local state, secrets or archives found in the bundle.');
console.log('\x1b[32m✔\x1b[0m All required runtime files present (entry point, UI, express, ws).');
