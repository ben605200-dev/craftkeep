# Security Policy

## Supported versions

Only the latest release is supported; fixes ship as a new release rather than as patches to
older versions.

| Version | Supported |
| --- | --- |
| 1.1.x | ✅ |
| 1.0.x | ❌ |

## Reporting a vulnerability

Please **do not open a public issue**. Instead use the **Security** tab of this repository
and choose **Report a vulnerability** — private vulnerability reporting is enabled, so only
the maintainer sees the report. If that is not available to you, contact the maintainer
through GitHub.

A useful report includes:

- What an attacker can do (and what they cannot).
- The smallest set of steps that demonstrates it.
- The Craftkeep version, your Windows version, and any relevant logs or screenshots.

This is a hobby project maintained in spare time. Expect an initial reply within about a
week — quicker is a bonus, not a promise. If you want credit, say so and pick a name.

## What is in scope

Craftkeep can start processes and write files, so its attack surface is treated seriously in
the design. Things that count as vulnerabilities:

- **Reaching the local transport.** The app serves its interface on loopback only, on an
  OS-chosen ephemeral port, guarded by a per-launch session token (compared in constant
  time) plus `Origin` and `X-Requested-With` checks. If another program, another Windows
  user, or a web page can drive the API, that is a vulnerability.
- **Leaking the session token** — to disk, to `argv`, to logs outside
  `CRAFTKEEP_DEBUG_TRANSPORT`, or over the network.
- **Escaping a server's folder.** Every path goes through `safeJoin`, which rejects `..`,
  absolute paths, drive letters, NUL bytes and Windows device names. Writing outside the
  intended server directory is a vulnerability.
- **Substituted downloads.** Server jars are checked against the provider's published
  SHA-256 where one exists; the playit.gg agent must pass an Authenticode signature check
  against its publisher. A way to bypass either check is a vulnerability.
- **Command execution** through `server.properties`, console input, or any other user data
  that reaches a shell or process launch.
- **Renderer escapes** — breaking out of the sandboxed window (context isolation is on,
  Node integration is off, the preload bridge exposes a fixed list of functions).

## What is not in scope

- **The unsigned installer.** Windows SmartScreen says "unknown publisher" on first run
  because no code-signing certificate is configured; the release notes and
  `HOW-TO-INSTALL.txt` explain it. Signing is a funding question, not a vulnerability.
- **Anything that requires code already running with your user's privileges.**
- **Server settings you chose.** Running without a whitelist, in offline mode, or with
  operators you added is a choice, not a flaw in Craftkeep.
- **Upstream services** — Mojang, PaperMC, Fabric, Adoptium, playit.gg, GitHub. Report
  problems with those to those projects.
- **Windows firewall prompts** when a server first opens a port.

## How fixes are handled

Once a report is confirmed, a fix is prepared in private and shipped in the next release,
usually with a `Security` note in the release description. Credit is given in the release
notes unless you prefer otherwise.
