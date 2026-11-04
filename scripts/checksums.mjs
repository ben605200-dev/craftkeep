/**
 * Write the two files that go out alongside a shared build:
 *
 *   SHA256SUMS.txt      so a recipient can verify the download arrived intact
 *   HOW-TO-INSTALL.txt  what to do about the SmartScreen warning, and where
 *                       the app keeps its data
 *
 * Run automatically by `npm run dist`; can also be run on its own with
 * `npm run checksums`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist-app');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (!fs.existsSync(DIST)) {
  console.error('No dist-app/ yet — build first with `npm run dist`.');
  process.exit(1);
}

/** Shippable artifacts only: no blockmap, no unpacked build, no uninstaller. */
const ARTIFACT = /\.(exe|zip|dmg|AppImage|deb|rpm)$/i;
const artifacts = fs
  .readdirSync(DIST)
  .filter((name) => ARTIFACT.test(name) && !name.includes('__uninstaller'))
  .sort();

if (!artifacts.length) {
  console.error('No installable artifacts in dist-app/.');
  process.exit(1);
}

const hashes = [];
for (const name of artifacts) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, name))).digest('hex');
  hashes.push(`${hash}  ${name}`);
}
fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), hashes.join('\n') + '\n', 'utf8');

const installer = artifacts.find((n) => n.endsWith('.exe')) ?? artifacts[0];
const zipName = artifacts.find((n) => n.endsWith('.zip'));
const mb = (n) => `${(fs.statSync(path.join(DIST, n)).size / 1024 / 1024).toFixed(1)} MB`;

const howTo = `Minecraft Server Manager ${pkg.version}
How to install and run it on your PC
=================================================

Files in this folder
--------------------
  ${installer}
      The installer. Recommended. (${mb(installer)})
${zipName ? `  ${zipName}\n      Portable version, no installation. (${mb(zipName)})\n` : ''}  SHA256SUMS.txt
      Checksums, so you can verify your download.

Install (recommended)
---------------------
  1. Run ${installer}.
  2. Windows shows "Windows protected your PC" the first time, because this
     app has no paid code-signing certificate. Click "More info", then
     "Run anyway". You can verify the file yourself first (see below).
  3. Follow the wizard. Everything goes into your own user folder, so no
     administrator rights are needed.
  4. Start "Minecraft Server Manager" from the Start menu or the desktop
     shortcut.

No-install option
-----------------
${
  zipName
    ? `  1. Right-click ${zipName} and choose "Extract All..." first.
     Running the app from inside the ZIP file does not work.
  2. Open the extracted folder and run "Minecraft Server Manager.exe".
  3. Keep the folder together — the app needs the files next to it.

  Windows shows the same "Windows protected your PC" warning as the
  installer does the first time: "More info", then "Run anyway".`
    : '  (No ZIP was included in this build.)'
}

Verify your download (optional)
-------------------------------
  Open PowerShell in this folder and run:

      Get-FileHash .\\${installer} -Algorithm SHA256

  The printed hash must match the first line of SHA256SUMS.txt. If it does
  not, don't run the file and ask the sender to re-send it.

First run
---------
  - The app starts empty. Nothing from the sender's machine is included.
  - Your servers, backups and logs stay in your own profile:
        %APPDATA%\\Minecraft Server Manager
  - Java is detected automatically. If the version a server needs is
    missing, the app can download a matching JDK from Adoptium for you.
  - To let friends join a server when port forwarding is impossible
    (CGNAT, mobile or many fibre plans), open the server's Connect tab and
    set up the playit.gg tunnel.

Requirements
------------
  - Windows 10 or 11, 64-bit
  - An internet connection (server files and the tunnel agent are
    downloaded on demand)
  - No administrator rights required
`;

fs.writeFileSync(path.join(DIST, 'HOW-TO-INSTALL.txt'), howTo, 'utf8');

console.log('Release info written:');
for (const name of [...artifacts, 'SHA256SUMS.txt', 'HOW-TO-INSTALL.txt']) {
  console.log(`  ${name}`);
}
console.log('');
for (const line of hashes) console.log(`  ${line}`);
