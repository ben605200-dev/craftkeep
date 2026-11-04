/**
 * Create a fake server for exercising the UI.
 *
 * Writes a server directory and a registry entry directly, without downloading
 * a jar or starting a JVM. Enough for every view to render — the Overview,
 * Players, Properties and Files tabs all read from disk and the API, none of
 * them need a running Minecraft server.
 *
 * Usage:  node scripts/make-test-server.mjs [id] [name]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] ?? 'uitest';
const name = process.argv[3] ?? 'UI Test Server';
const dir = path.join(ROOT, 'servers', id);

fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
fs.writeFileSync(
  path.join(dir, 'server.properties'),
  [
    '#Minecraft server properties',
    'level-name=world',
    `motd=${name}`,
    'server-ip=',
    'server-port=25599',
    'max-players=20',
    'online-mode=true',
    'gamemode=survival',
    'difficulty=normal',
    'view-distance=10',
    'simulation-distance=10',
    'white-list=false',
    'pvp=true',
    '',
  ].join('\n'),
);
// A jar is only ever checked for existence, never run, by these views.
fs.writeFileSync(path.join(dir, 'server.jar'), 'placeholder');
fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify([{ uuid: '00000000-0000-0000-0000-000000000000', name: 'Notch', level: 4, bypassesPlayerLimit: false }], null, 2));
fs.writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify([{ uuid: '00000000-0000-0000-0000-000000000000', name: 'Alex' }], null, 2));
fs.writeFileSync(path.join(dir, 'banned-players.json'), '[]');
fs.writeFileSync(path.join(dir, 'banned-ips.json'), '[]');

const registryFile = path.join(ROOT, 'data', 'servers.json');
fs.mkdirSync(path.dirname(registryFile), { recursive: true });

let registry = { version: 2, updatedAt: Date.now(), servers: [] };
try {
  registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
} catch {
  /* fresh */
}
registry.servers = (registry.servers ?? []).filter((s) => s.id !== id);
registry.servers.push({
  id,
  name,
  slug: id,
  platform: 'paper',
  version: '1.21.11',
  build: 132,
  jarFile: 'server.jar',
  dir,
  java: { path: 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe', major: 21, vendor: 'Test', autoSelected: true },
  memory: { minHeapMb: 2048, maxHeapMb: 4096, gcProfile: 'aikar', preTouch: true },
  port: 25599,
  motd: name,
  maxPlayers: 20,
  viewDistance: 10,
  simulationDistance: 10,
  gamemode: 'survival',
  difficulty: 'normal',
  onlineMode: true,
  whiteList: false,
  serverArgs: ['nogui'],
  jvmArgs: [],
  autoRestart: { enabled: false, delayMs: 5000, maxAttempts: 5 },
  schedules: {
    restart: { enabled: false, mode: 'none', time: '04:00', intervalMinutes: 360 },
    backup: { enabled: false, mode: 'none', time: '03:00', intervalMinutes: 1440, keep: 7 },
  },
  options: { autoStart: false, stopOnExit: true, backupBeforeRestart: true },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Created "${id}" at ${dir}`);
console.log(`Registered in ${registryFile} (${registry.servers.length} total)`);
