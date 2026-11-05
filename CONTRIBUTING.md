# Contributing to Craftkeep

Thanks for wanting to help. This is a small, focused desktop app: it provisions, runs and
monitors Minecraft servers on Windows. Bug reports and pull requests are welcome.

## Before you start

- **Bugs and feature requests** → open an issue; templates guide you through the details.
- **Security problems** → do not open a public issue; see [SECURITY.md](SECURITY.md).
- **Questions** → an issue is fine too; there is no mailing list or chat.

Small, focused pull requests are much easier to review and land than large ones. If you are
planning something substantial, open an issue first so we can agree on the approach before
you spend time on it.

## Getting it running

Requirements: Windows 10 or 11, Node 20+ (development only), and a JDK if you want to
actually start a server — the setup wizard can also fetch one for you.

```powershell
git clone https://github.com/ben605200-dev/craftkeep.git
cd craftkeep
npm install
npm run app
```

Running from source keeps everything in the checkout: servers live in `./servers` and
registry/backups/logs in `./data`, instead of `%APPDATA%\Craftkeep`.

## Before you open a pull request

```powershell
npm run verify   # static checks + unit tests
```

| Command | What it does |
| --- | --- |
| `npm run check` | Static check — imports, forgotten imports, unrendered elements |
| `npm test` | Unit tests (`node:test`) |
| `npm run app` | Launch the app from source |
| `npm run dist` | Build the installer and portable zip; audits the bundle and writes checksums |

If you touched the interface, run the app and look at the views you changed; put a
before/after screenshot in the pull request.

## How the code is organised

| Path | What lives there |
| --- | --- |
| `desktop/` | Electron main process: window, tray, menus, session token, path policy, user-data migration |
| `server/` | The manager library (`startManager()`): registry, process manager, console buffer, stats, providers, routes |
| `web/` | The interface — hand-written CSS and vanilla ES modules, no build step |
| `scripts/` | Maintenance tools: import check, bundle audit, checksums, test fixtures |
| `test/` | Unit tests |
| `docs/` | The download page, published with GitHub Pages |

## Ground rules

These keep the design coherent — please respect them:

1. **The backend is a library, not a service.** `server/index.js` exports `startManager()`
   and the Electron main process is its only caller. There is no CLI, no server mode, and no
   second implementation to keep in sync.
2. **The transport stays private.** Loopback only, OS-chosen ephemeral port, per-launch
   session token. Do not add remote access, a fixed port, or token logging outside
   `CRAFTKEEP_DEBUG_TRANSPORT`.
3. **No build step for the front end.** No frameworks, no bundler, no TypeScript —
   hand-written CSS and ES modules only.
4. **Dependencies are a decision, not a detail.** Runtime dependencies are `express` and
   `ws`. Adding another one needs a reason discussed in an issue first.
5. **Comments explain *why*.** The code already does this; keep it that way. A diff that
   adds a non-obvious mechanism should say what it is for.
6. **Keep the bundle clean.** `npm run dist` refuses to finish if local state (`data/`,
   `servers/`, logs, `.env`) would ship inside the app. Do not weaken
   `scripts/audit-bundle.mjs` or its checks.

## Style

- ES modules, 2-space indentation, single quotes, semicolons.
- Match the formatting and naming of the surrounding file.
- Prefer small, pure functions for anything involving paths or parsing, and add a unit test
  under `test/` — those are the parts where mistakes are expensive.

## Commits and pull requests

- One topic per pull request; say **what** changed and **why** in the description.
- Reference the issue it addresses (`Closes #12`).
- The pull request template has a short checklist — it is there to help, not to gatekeep.

## Licence

Contributions are accepted under the MIT licence — see [LICENSE](LICENSE).
