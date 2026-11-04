/**
 * Tests for the filesystem helpers.
 *
 * The `directorySize` cases exist because of a genuinely nasty bug: writing the
 * accumulation as a single compound assignment over an awaited value
 *
 *     bytes += (await fsp.stat(full)).size;
 *
 * under-reports the total by an order of magnitude under concurrency on the
 * Node/V8 build this project targets — silently, with no thrown error. Splitting
 * it into a read and an assignment fixes it. These tests pin the correct
 * behaviour so the one-liner cannot creep back in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { directorySize, safeJoin, slugify, formatBytes, formatDuration, timestampSlug, atomicWrite, readJson, writeJson } from '../server/lib/fsUtil.js';

/** Build a throwaway tree with a known total size. */
async function makeFixture({ dirs = 4, filesPerDir = 40, size = 4096 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-size-'));
  let expected = 0;

  for (let d = 0; d < dirs; d += 1) {
    const nested = path.join(root, `level-${d}`, 'nested', 'deep');
    await fsp.mkdir(nested, { recursive: true });
    for (let f = 0; f < filesPerDir; f += 1) {
      const target = path.join(nested, `file-${f}.bin`);
      await fsp.writeFile(target, Buffer.alloc(size, f));
      expected += size;
    }
    // A file at the root of the tree too.
    await fsp.writeFile(path.join(root, `top-${d}.bin`), Buffer.alloc(size, d));
    expected += size;
  }

  return { root, expected, count: dirs * (filesPerDir + 1) };
}

test('directorySize sums every file across a deep tree', async () => {
  const { root, expected, count } = await makeFixture();
  try {
    const result = await directorySize(root);
    assert.equal(result.files, count, 'file count');
    assert.equal(result.bytes, expected, 'byte total — a mismatch means compound-assignment-over-await regression');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('directorySize is correct with a large fan-out (concurrency regression)', async () => {
  // 600 files is enough to make the worker pool actually queue work.
  const { root, expected, count } = await makeFixture({ dirs: 6, filesPerDir: 100, size: 1024 });
  try {
    const result = await directorySize(root, { concurrency: 32 });
    assert.equal(result.files, count);
    assert.equal(result.bytes, expected);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('directorySize honours an abort signal', async () => {
  const { root } = await makeFixture({ dirs: 2, filesPerDir: 10, size: 128 });
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await directorySize(root, { signal: controller.signal });
    assert.equal(result.bytes, 0, 'an already-aborted scan should do no work');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// safeJoin — the security boundary for the file manager
// ---------------------------------------------------------------------------

test('safeJoin resolves normal paths inside the base', () => {
  const base = path.resolve('C:/servers/alpha');
  assert.equal(safeJoin(base, 'server.properties'), path.join(base, 'server.properties'));
  assert.equal(safeJoin(base, 'logs/latest.log'), path.join(base, 'logs', 'latest.log'));
  assert.equal(safeJoin(base, ''), base);
  assert.equal(safeJoin(base, '.'), base);
});

test('safeJoin rejects traversal, absolute paths and device names', () => {
  const base = path.resolve('C:/servers/alpha');
  const cases = [
    '../../etc/passwd',
    '../sibling/server.properties',
    'logs/../../escape.txt',
    'C:\\Windows\\win.ini',
    '/etc/shadow',
    '..\\..\\windows',
    'nul',
    'CON.txt',
  ];
  for (const attempt of cases) {
    assert.throws(() => safeJoin(base, attempt), `expected "${attempt}" to be rejected`);
  }
});

test('safeJoin strips NUL bytes rather than passing them through', () => {
  const base = path.resolve('C:/servers/alpha');
  assert.equal(safeJoin(base, 'logs\0/latest.log'), path.join(base, 'logs', 'latest.log'));
});

// ---------------------------------------------------------------------------
// Misc formatting helpers used all over the UI
// ---------------------------------------------------------------------------

test('slugify produces filesystem-safe folder names', () => {
  assert.equal(slugify('My Cool Server!'), 'my-cool-server');
  assert.equal(slugify('  Spaced   Out  '), 'spaced-out');
  assert.equal(slugify('...'), 'server');
  assert.equal(slugify(''), 'server');
  assert.equal(slugify('a'.repeat(200)).length, 48);
  assert.ok(!slugify(`${'a'.repeat(47)} b`).endsWith('-'), 'a length cut must not leave a trailing hyphen');
});

test('slugify transliterates characters Unicode decomposition misses', () => {
  // NFKD handles Ü -> U, but ø/ß/æ have no canonical decomposition.
  assert.equal(slugify('Ünïcøde Námes'), 'unicode-names');
  assert.equal(slugify('Straße'), 'strasse');
  assert.equal(slugify('Æther Ørn'), 'aether-orn');
});

test('formatBytes and formatDuration read naturally', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');

  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_600_000), '1h 0m');
  assert.equal(formatDuration(90_000_000), '1d 1h');
});

test('timestampSlug is filename-safe', () => {
  const slug = timestampSlug(new Date('2026-11-01T10:30:00Z'));
  assert.match(slug, /^[0-9]{8}-[0-9]{6}$/);
  assert.ok(!slug.includes(':'), 'colons break Windows filenames');
});

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

test('writeJson/readJson round-trip and never leave a partial file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-json-'));
  const file = path.join(dir, 'nested', 'state.json');
  try {
    await writeJson(file, { hello: 'world', n: 42 });
    assert.deepEqual(await readJson(file), { hello: 'world', n: 42 });

    // A broken file yields the fallback instead of throwing.
    await fsp.writeFile(file, '{ not json');
    assert.equal(await readJson(file, 'fallback'), 'fallback');

    // No .tmp siblings are left behind.
    const leftovers = (await fsp.readdir(path.dirname(file))).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('atomicWrite replaces content in place', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsm-atomic-'));
  const file = path.join(dir, 'server.properties');
  try {
    await atomicWrite(file, 'motd=first\n');
    await atomicWrite(file, 'motd=second\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'motd=second\n');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
