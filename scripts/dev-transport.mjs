/**
 * Launch the desktop app with its internal transport pinned to a known port and
 * its session token printed to the log.
 *
 * The transport is loopback-only, uses an ephemeral port and requires a fresh
 * token per launch, which is exactly what you want in normal use and exactly
 * what makes it impossible to attach a diagnostic tool. This script relaxes two
 * of those three things for local debugging only:
 *
 *   - `MCSM_PORT=31415` pins the port (still loopback, still token-gated).
 *   - `MCSM_DEBUG_TRANSPORT=1` makes the app log the token.
 *
 * The token is still generated per launch and never persisted, so this does not
 * open a stable, reusable door — it just makes the current door findable while
 * the process is alive.
 *
 * Usage:
 *   npm run app:debug
 *   # then, in another shell, using the token printed by the app:
 *   $env:MCSM_TOKEN="<token>"; node scripts/smoke-test.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = {
  ...process.env,
  MCSM_PORT: process.env.MCSM_PORT || '31415',
  MCSM_DEBUG_TRANSPORT: '1',
};

// Resolve the Electron binary from node_modules so this works without a global
// install and without relying on shell-specific env syntax.
const electronBinary = (() => {
  try {
    // `require('electron')` outside Electron resolves to the path of the binary.
    const require = createRequire(import.meta.url);
    return require('electron');
  } catch {
    return null;
  }
})();

if (!electronBinary || typeof electronBinary !== 'string') {
  console.error('Electron is not installed. Run `npm install` first.');
  process.exit(1);
}

console.log('Launching with a pinned, token-gated transport on http://127.0.0.1:' + env.MCSM_PORT);
console.log('The session token will be printed with the app\'s log output.');
console.log('');

const child = spawn(electronBinary, ['.', '--enable-logging'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code) => process.exit(code ?? 0));
