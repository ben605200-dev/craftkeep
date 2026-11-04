/**
 * Tests for the product-rename data migration.
 *
 * Getting this wrong is the difference between "my servers are still here" and
 * "the app lost everything" after a rename, so every branch runs against real
 * temporary directories.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { adoptLegacyUserData } from '../desktop/userData.js';

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftkeep-migrate-'));
  return { root, legacyDir: path.join(root, 'Old Name'), targetDir: path.join(root, 'New Name') };
}

const noWarn = () => {};

test('adopts servers, data and window preferences from the old folder', () => {
  const { legacyDir, targetDir } = makeDirs();
  fs.mkdirSync(path.join(legacyDir, 'servers', 'world'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'servers', 'world', 'level.dat'), 'x');
  fs.mkdirSync(path.join(legacyDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'data', 'servers.json'), '{"servers":[]}');
  fs.writeFileSync(path.join(legacyDir, 'desktop-config.json'), '{}');
  // Cache folders must not disqualify the migration.
  fs.mkdirSync(path.join(legacyDir, 'GPUCache'), { recursive: true });

  const result = adoptLegacyUserData({ targetDir, legacyDir, warn: noWarn });

  assert.deepEqual([...result.moved].sort(), ['data', 'desktop-config.json', 'servers']);
  assert.equal(result.removedLegacy, true);
  assert.ok(fs.existsSync(path.join(targetDir, 'servers', 'world', 'level.dat')));
  assert.ok(fs.existsSync(path.join(targetDir, 'data', 'servers.json')));
  assert.ok(!fs.existsSync(legacyDir), 'old folder should be gone once everything moved');
});

test('does nothing when the new folder already has state of its own', () => {
  const { legacyDir, targetDir } = makeDirs();
  fs.mkdirSync(path.join(legacyDir, 'servers'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'servers', 'keep.txt'), 'legacy');
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'data', 'servers.json'), '{"servers":[]}');

  const result = adoptLegacyUserData({ targetDir, legacyDir, warn: noWarn });

  assert.equal(result.moved.length, 0);
  assert.ok(fs.existsSync(path.join(legacyDir, 'servers', 'keep.txt')), 'legacy data must be left alone');
  assert.ok(fs.existsSync(path.join(targetDir, 'data', 'servers.json')));
});

test('is a no-op when there is no legacy folder', () => {
  const { legacyDir, targetDir } = makeDirs();
  const result = adoptLegacyUserData({ targetDir, legacyDir, warn: noWarn });

  assert.equal(result.moved.length, 0);
  assert.equal(result.removedLegacy, false);
  assert.ok(!fs.existsSync(targetDir));
});

test('removes an old folder that contains only caches', () => {
  const { legacyDir, targetDir } = makeDirs();
  fs.mkdirSync(path.join(legacyDir, 'GPUCache'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'GPUCache', 'data_0'), 'x');

  const result = adoptLegacyUserData({ targetDir, legacyDir, warn: noWarn });

  assert.equal(result.moved.length, 0);
  assert.equal(result.removedLegacy, true);
});

test('keeps the old folder when something holding data could not be moved', () => {
  const { legacyDir, targetDir } = makeDirs();
  fs.mkdirSync(path.join(legacyDir, 'servers'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'servers', 'keep.txt'), 'x');
  fs.mkdirSync(path.join(legacyDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'data', 'servers.json'), '{}');

  // Simulate the Windows case that motivates the branch: one entry is locked
  // by a running process (EBUSY) while the others move fine.
  const result = adoptLegacyUserData({
    targetDir,
    legacyDir,
    warn: noWarn,
    rename: (from, to) => {
      if (path.basename(from) === 'data') throw new Error('EBUSY: resource busy or locked');
      fs.renameSync(from, to);
    },
  });

  assert.ok(result.moved.includes('servers'));
  assert.deepEqual(result.skipped, ['data']);
  assert.equal(result.removedLegacy, false);
  assert.ok(fs.existsSync(path.join(legacyDir, 'data', 'servers.json')), 'unmoved data must survive');
});

test('never throws when the folders misbehave', () => {
  const { root, legacyDir } = makeDirs();
  fs.mkdirSync(path.join(legacyDir, 'servers'), { recursive: true });
  // A file where the target folder's parent should be: creating it must fail.
  fs.writeFileSync(path.join(root, 'blocker'), 'x');
  const targetDir = path.join(root, 'blocker', 'child');

  let warned = '';
  const result = adoptLegacyUserData({ targetDir, legacyDir, warn: (message) => { warned = message; } });

  assert.equal(result.moved.length, 0);
  assert.match(warned, /user-data adoption failed/);
});
