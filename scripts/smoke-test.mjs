/**
 * End-to-end smoke test against a *running* desktop app.
 *
 * Exercises the paths unit tests cannot: the real transport, the Minecraft
 * Server List Ping handshake against a live JVM, console round-trips, the backup
 * pipeline, and the security boundaries (path traversal, the session token,
 * cross-origin rejection).
 *
 * The app's transport is loopback-only, on an OS-chosen port, behind a token
 * that is regenerated every launch — so both have to be supplied. `npm run
 * app:debug` pins the port and prints the token:
 *
 *   npm run app:debug                              # terminal 1
 *   $env:MCSM_PORT="31415"                         # terminal 2
 *   $env:MCSM_TOKEN="<token from the app log>"
 *   node scripts/smoke-test.mjs <serverId>
 *
 * The SLP, console and backup checks need the server to be *running*; the rest
 * pass either way. Exit code is non-zero if anything fails.
 */

import { resolveJvmFlags } from '../server/lib/jvmFlags.js';
import { pingServer } from '../server/lib/slp.js';

const PORT = process.env.MCSM_PORT ?? '31415';
const TOKEN = process.env.MCSM_TOKEN ?? '';
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_ID = process.argv[2] ?? 'test-smp';
const HEADERS = {
  'x-requested-with': 'MinecraftServerManager',
  'content-type': 'application/json',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

if (!TOKEN) {
  console.error(
    '\n\x1b[31mNo MCSM_TOKEN set.\x1b[0m\n' +
      'The transport requires the per-launch session token.\n' +
      'Run `npm run app:debug`, copy the token it prints, then:\n' +
      `  $env:MCSM_PORT="${PORT}"; $env:MCSM_TOKEN="<token>"\n\n`,
  );
  process.exit(2);
}

let pass = 0;
let fail = 0;

async function check(label, fn) {
  try {
    const result = await fn();
    pass += 1;
    console.log(`  PASS  ${label}${result ? ` — ${result}` : ''}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL  ${label} — ${error.message}`);
  }
}

const req = async (path, init = {}) => {
  const response = await fetch(`${BASE}${path}`, { headers: HEADERS, ...init });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${response.status} ${body?.error ?? text.slice(0, 160)}`);
  return body;
};

console.log('\n=== JVM flag reconciliation (Java 27 removed several Aikar flags) ===');
await check('resolveJvmFlags strips/replaces unsupported options', async () => {
  const result = await resolveJvmFlags({
    javaPath: process.env.JAVA_PATH ?? 'C:\\Program Files\\Java\\jdk-27.0.1.0.2\\bin\\java.exe',
    javaMajor: 27,
    minHeapMb: 2048,
    maxHeapMb: 2048,
    gcProfile: 'aikar',
  });
  const joined = result.flags.join(' ');
  if (joined.includes('ParallelRefProcEnabled')) throw new Error('removed flag was kept');
  if (!joined.includes('G1IHOP')) throw new Error('G1IHOP substitution did not happen');
  if (joined.includes('InitiatingHeapOccupancyPercent')) throw new Error('deprecated flag was kept');
  return `removed ${result.removed.length}, substituted ${result.substituted.length}, probed=${result.probed}`;
});

console.log('\n=== Server list ping (real protocol handshake) ===');
await check('SLP status query returns MOTD + player counts', async () => {
  const result = await pingServer({ host: '127.0.0.1', port: 25565, timeoutMs: 5000 });
  if (!result.online) throw new Error(result.error ?? 'offline');
  return `${result.latencyMs}ms · "${result.motd}" · ${result.players?.online}/${result.players?.max} · ${result.version?.name}`;
});

console.log('\n=== REST surface ===');
await check('GET /api/servers', async () => {
  const data = await req('/api/servers');
  return `${data.servers.length} server(s), ${data.summary.running} running`;
});

await check('GET /api/system/storage', async () => {
  const data = await req('/api/system/storage');
  return `servers=${data.servers.formatted} backups=${data.backups.formatted}`;
});

await check(`GET /api/servers/${SERVER_ID}/diagnostics`, async () => {
  const data = await req(`/api/servers/${SERVER_ID}/diagnostics`);
  const failed = data.checks.filter((c) => !c.ok).map((c) => c.id);
  return `${data.passed}/${data.total} checks pass${failed.length ? ` (failing: ${failed.join(', ')})` : ''}`;
});

await check(`GET /api/servers/${SERVER_ID}/players`, async () => {
  const data = await req(`/api/servers/${SERVER_ID}/players`);
  return `online=${data.onlineCount} ops=${data.ops.length} whitelist=${data.whitelist.length}`;
});

await check(`GET /api/servers/${SERVER_ID}/properties`, async () => {
  const data = await req(`/api/servers/${SERVER_ID}/properties`);
  const keys = Object.keys(data.values);
  if (!keys.includes('server-port')) throw new Error('server.properties did not parse');
  return `${keys.length} keys, ${data.schema.length} schema entries, port=${data.values['server-port']}`;
});

await check(`GET /api/servers/${SERVER_ID}/jvm`, async () => {
  const data = await req(`/api/servers/${SERVER_ID}/jvm`);
  return `${data.args.length} flags, ${data.args[0]} ${data.args[1]}`;
});

console.log('\n=== Console round-trip ===');
await check('send "list" and read the reply', async () => {
  const before = await req(`/api/servers/${SERVER_ID}/console?limit=1`);
  await req(`/api/servers/${SERVER_ID}/console`, {
    method: 'POST',
    body: JSON.stringify({ command: 'list' }),
  });
  await new Promise((r) => setTimeout(r, 1800));
  const after = await req(`/api/servers/${SERVER_ID}/console?limit=40`);
  const reply = after.records.find((r) => r.seq > before.lastSeq && /players online|There are \d+/i.test(r.text));
  if (!reply) throw new Error('no reply captured');
  return reply.text.trim();
});

await check('send "say" and confirm the broadcast is echoed', async () => {
  await req(`/api/servers/${SERVER_ID}/console`, {
    method: 'POST',
    body: JSON.stringify({ command: 'say smoke-test-marker' }),
  });
  await new Promise((r) => setTimeout(r, 1500));
  const after = await req(`/api/servers/${SERVER_ID}/console?limit=40`);
  const reply = after.records.find((r) => r.text.includes('smoke-test-marker'));
  if (!reply) throw new Error('broadcast not found in the console');
  return reply.text.trim();
});

console.log('\n=== Backup pipeline (quiesce -> archive -> verify) ===');
await check('create a backup of a running server', async () => {
  const manifest = await req(`/api/servers/${SERVER_ID}/backups`, {
    method: 'POST',
    body: JSON.stringify({ label: 'smoke' }),
  });
  if (!manifest.bytes) throw new Error('archive is empty');
  return `${manifest.file} · ${manifest.formatted} · hot=${manifest.hot}`;
});

await check('list backups and confirm metadata', async () => {
  const data = await req(`/api/servers/${SERVER_ID}/backups`);
  if (!data.backups.length) throw new Error('no backups returned');
  return `${data.backups.length} archive(s), ${data.totalFormatted}`;
});

console.log('\n=== File manager ===');
await check(`GET /api/files/${SERVER_ID}/list`, async () => {
  const data = await req(`/api/files/${SERVER_ID}/list?path=`);
  return `${data.entries.length} entries, ${data.totals.files} files, ${data.totals.bytes} bytes`;
});

await check('path traversal is rejected', async () => {
  const response = await fetch(`${BASE}/api/files/${SERVER_ID}/read?path=${encodeURIComponent('../../../servers.json')}`, {
    headers: HEADERS,
  });
  if (response.ok) throw new Error('traversal was ALLOWED — security bug');
  return `blocked with ${response.status}`;
});

await check('absolute path is rejected', async () => {
  const response = await fetch(`${BASE}/api/files/${SERVER_ID}/read?path=${encodeURIComponent('C:\\Windows\\win.ini')}`, {
    headers: HEADERS,
  });
  if (response.ok) throw new Error('absolute path was ALLOWED — security bug');
  return `blocked with ${response.status}`;
});

await check('read + write a config file', async () => {
  const original = await req(`/api/files/${SERVER_ID}/read?path=server.properties`);
  await req(`/api/files/${SERVER_ID}/write`, {
    method: 'PUT',
    body: JSON.stringify({ path: 'smoke-test.txt', content: 'written by the smoke test\n' }),
  });
  const written = await req(`/api/files/${SERVER_ID}/read?path=smoke-test.txt`);
  if (!written.content.includes('smoke test')) throw new Error('round-trip failed');
  await fetch(`${BASE}/api/files/${SERVER_ID}?path=smoke-test.txt`, { method: 'DELETE', headers: HEADERS });
  return `${original.lines} lines read back, temp file round-tripped and deleted`;
});

console.log('\n=== Security ===');
await check('mutating request without the custom header is rejected', async () => {
  const response = await fetch(`${BASE}/api/servers/${SERVER_ID}/stop`, { method: 'POST' });
  if (response.ok) throw new Error('request was ALLOWED without the header — CSRF hole');
  return `blocked with ${response.status}`;
});

await check('cross-origin request is rejected', async () => {
  const response = await fetch(`${BASE}/api/servers`, {
    headers: { ...HEADERS, origin: 'http://evil.example.com' },
  });
  if (response.ok) throw new Error('cross-origin request was ALLOWED');
  return `blocked with ${response.status}`;
});

await check('unknown API route returns JSON 404, not the SPA', async () => {
  const response = await fetch(`${BASE}/api/does-not-exist`, { headers: HEADERS });
  const body = await response.json();
  if (response.status !== 404 || !body.code) throw new Error('unexpected response');
  return `404 ${body.code}`;
});

await check('deep link serves the SPA shell', async () => {
  const response = await fetch(`${BASE}/servers/${SERVER_ID}`);
  const html = await response.text();
  if (!html.includes('<!doctype html>') || !html.includes('/js/main.js')) throw new Error('SPA shell not served');
  return 'index.html returned';
});

console.log(`\n${fail === 0 ? '\u001b[32m' : '\u001b[31m'}${pass} passed, ${fail} failed\u001b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
