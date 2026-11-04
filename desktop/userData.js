/**
 * Carry data across a product rename.
 *
 * The user-data folder is named after the product, so renaming the app would
 * otherwise look like a factory reset: the new build would open with no
 * servers, no backups and default window preferences. This moves the entries
 * that hold real data from the old folder into the new one, once.
 *
 * Deliberately free of Electron and of any app state: `desktop/main.js` passes
 * the paths in, and `test/userData.test.js` exercises it against temporary
 * directories — the guarantee is too important to leave untested.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Entries worth carrying across; everything else is cache that regenerates. */
export const MIGRATED_ENTRIES = ['servers', 'data', 'desktop-config.json'];

/**
 * @param {object} options
 * @param {string} options.targetDir  the new user-data folder
 * @param {string} options.legacyDir  the previous name's folder
 * @param {(message: string) => void} [options.warn]
 * @param {(from: string, to: string) => void} [options.rename]  injectable for tests
 * @returns {{ moved: string[], skipped: string[], removedLegacy: boolean }}
 */
export function adoptLegacyUserData({
  targetDir,
  legacyDir,
  warn = console.warn,
  rename = fs.renameSync,
}) {
  const result = { moved: [], skipped: [], removedLegacy: false };

  try {
    if (!legacyDir || path.resolve(legacyDir) === path.resolve(targetDir)) return result;
    if (!fs.existsSync(legacyDir)) return result;

    // A target that already has state of its own wins; never merge two sets of data.
    if (MIGRATED_ENTRIES.some((name) => fs.existsSync(path.join(targetDir, name)))) {
      return result;
    }

    fs.mkdirSync(targetDir, { recursive: true });

    for (const name of MIGRATED_ENTRIES) {
      const from = path.join(legacyDir, name);
      const to = path.join(targetDir, name);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        rename(from, to);
        result.moved.push(name);
      } catch (err) {
        result.skipped.push(name);
        warn(`[desktop] could not move "${name}" from the previous user-data folder: ${err.message}`);
      }
    }

    // Remove the old folder only when nothing that holds data is left inside it.
    const stuck = MIGRATED_ENTRIES.some((name) => fs.existsSync(path.join(legacyDir, name)));
    if (!stuck) {
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
        result.removedLegacy = true;
      } catch {
        /* the old folder can stay; nothing depends on it */
      }
    }
  } catch (err) {
    // Housekeeping must never stop the app from starting.
    warn(`[desktop] user-data adoption failed: ${err.message}`);
  }

  return result;
}
