/**
 * Getting a server reachable from the internet.
 *
 * Three separate things have to line up, and it is worth being precise about
 * which is which because they are constantly confused:
 *
 *   1. **The server must listen on an interface.** `server-ip` empty means
 *      "all interfaces", which is what you want. Putting a *domain name* there
 *      is the classic mistake — it is a bind address, not a hostname, and the
 *      server crashes with UnknownHostException.
 *   2. **The router must forward the port** from the public IP to this machine.
 *      Either configured by hand or, on most home routers, requested over UPnP —
 *      which is what `upnp.js` does.
 *   3. **The OS firewall must allow it.** On Windows, inbound TCP is blocked by
 *      default and an explicit rule is needed (and requires elevation).
 *
 * This module reports on all three. Nothing here is required for a LAN server.
 */

import os from 'node:os';
import net from 'node:net';
import { getJson } from './httpClient.js';
import createLogger from '../logger.js';

const log = createLogger('network');

const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Every non-internal IPv4 address this machine has, most plausible first.
 *
 * A machine usually has several (Wi-Fi, Ethernet, VPN, Hyper-V, WSL). VPN and
 * virtual adapters are deprioritised because handing someone a Tailscale or
 * VMware address as "your LAN address" is worse than useless.
 */
export function lanAddresses() {
  const out = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const virtual = /virtual|vmware|vbox|hyper-v|loopback|tailscale|zerotier|wsl|docker|utun|tun\d|tap\d|npcap|radmin/i.test(name);
      out.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        virtual,
        // 192.168.x.x and 10.x.x.x are the common home/office ranges.
        private: /^192\.168\./.test(entry.address) || /^10\./.test(entry.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address),
      });
    }
  }

  return out.sort((a, b) => {
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1;
    if (a.private !== b.private) return a.private ? -1 : 1;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.address.localeCompare(b.address);
  });
}

/** The best guess at the address another machine on the LAN should use. */
export function primaryLanAddress() {
  return lanAddresses().find((entry) => !entry.virtual) ?? lanAddresses()[0] ?? null;
}

/** Where UPnP and firewall rules need to point: this machine's LAN address. */
export const localAddress = () => primaryLanAddress()?.address ?? '127.0.0.1';

const PUBLIC_IP_SOURCES = [
  { url: 'https://api.ipify.org?format=json', pick: (d) => d?.ip },
  { url: 'https://api64.ipify.org?format=json', pick: (d) => d?.ip },
  { url: 'https://ifconfig.co/json', pick: (d) => d?.ip },
];

let publicIpCache = { value: null, resolvedAt: 0, error: null };
const PUBLIC_IP_TTL_MS = 10 * 60 * 1000;

/**
 * This network's public IP, as the outside world sees it.
 *
 * Several providers are tried because any one of them can be blocked or down,
 * and a failure here must never be more than a missing line of text in the UI.
 */
export async function publicAddress({ force = false } = {}) {
  const fresh = Date.now() - publicIpCache.resolvedAt < PUBLIC_IP_TTL_MS;
  if (!force && fresh && publicIpCache.value) return publicIpCache;

  for (const source of PUBLIC_IP_SOURCES) {
    try {
      const data = await getJson(source.url, { retries: 0, timeout: 6000 });
      const value = source.pick(data);
      if (value && net.isIP(value)) {
        publicIpCache = { value, resolvedAt: Date.now(), error: null };
        return publicIpCache;
      }
    } catch (error) {
      log.debug(`Public IP lookup via ${source.url} failed: ${error.message}`);
    }
  }

  publicIpCache = {
    value: publicIpCache.value,
    resolvedAt: Date.now(),
    error: 'Could not reach any public IP service.',
  };
  return publicIpCache;
}

// ---------------------------------------------------------------------------
// Can forwarding work at all?
// ---------------------------------------------------------------------------

/** RFC 6598 — the range carriers use for CGNAT. */
const isCgnatRange = (ip) => {
  const match = /^(\d+)\./.exec(ip ?? '');
  const first = Number(match?.[1]);
  const second = Number(String(ip).split('.')[1]);
  return first === 100 && second >= 64 && second <= 127;
};

/** RFC 1918 private ranges. */
const isPrivateRange = (ip) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/**
 * Compare the router's own WAN address with what the internet sees.
 *
 * This is the check that saves hours. A router can happily accept a UPnP port
 * mapping and still be unreachable, because the address it holds is not a public
 * one — either the ISP is NATing you (very common on LTE/5G home broadband) or
 * there is a second router upstream. In both cases port forwarding is a dead end
 * and no amount of router configuration will change that.
 *
 * @param {string|null} routerWanIp from the gateway's GetExternalIPAddress
 * @param {string|null} publicIp    as reported by an outside service
 */
export function classifyWanAddress(routerWanIp, publicIp) {
  if (!routerWanIp) {
    return { kind: 'unknown', forwardingWorks: null, message: 'The router did not report its own WAN address.' };
  }

  if (isCgnatRange(routerWanIp)) {
    return {
      kind: 'cgnat',
      forwardingWorks: false,
      summary: 'Your ISP is using Carrier-Grade NAT',
      message:
        `Your router's own internet address is ${routerWanIp}, which is inside the carrier-grade NAT range ` +
        '(100.64.0.0/10). That address belongs to your ISP, not to you — so opening a port on the router ' +
        'only opens it inside the ISP\u2019s network. Players on the internet still cannot reach you.',
      options: [
        'Ask your ISP for a public (static) IP address — usually a paid add-on, and often unavailable on mobile/LTE plans.',
        'Use a tunnel that works through CGNAT: playit.gg is purpose-built for Minecraft, or use Tailscale/ZeroTier for a private group.',
      ],
    };
  }

  if (isPrivateRange(routerWanIp)) {
    return {
      kind: 'double-nat',
      forwardingWorks: false,
      summary: 'There is a second router in front of this one',
      message:
        `Your router's internet address is ${routerWanIp}, which is a private address. Something upstream ` +
        '(a modem in router mode, or another router) is doing the actual connecting.',
      options: [
        'Forward the port on the upstream device too, pointing at this router.',
        'Put the upstream device into bridge/modem-only mode so this router gets the public address.',
      ],
    };
  }

  if (publicIp && routerWanIp !== publicIp) {
    return {
      kind: 'nat',
      forwardingWorks: false,
      summary: 'Your router reports a different address than the internet sees',
      message:
        `The router says ${routerWanIp}, but outside services see ${publicIp}. Something between you and ` +
        'the internet is rewriting addresses, so an inbound port is unlikely to reach you.',
      options: [
        'Ask your ISP whether you are behind carrier NAT.',
        'Use a tunnel service (playit.gg, Tailscale) which works regardless.',
      ],
    };
  }

  return {
    kind: 'direct',
    forwardingWorks: true,
    summary: 'Your router holds a public address',
    message: `The router's address (${routerWanIp}) matches what the internet sees, so normal port forwarding will work.`,
    options: [],
  };
}

// ---------------------------------------------------------------------------
// Local port checks
// ---------------------------------------------------------------------------

/** Is something accepting TCP connections on this port right now? */
export function isPortListening(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect({ port: Number(port), host });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Can this machine reach a port on its own LAN address?
 *
 * The server binding to `127.0.0.1` only (because `server-ip` was set to
 * localhost) is invisible from outside but looks perfectly healthy on the
 * machine itself. This check catches that.
 */
export async function isPortReachableOnLan(port) {
  const entry = primaryLanAddress();
  if (!entry?.address) return null;
  return isPortListening(port, entry.address);
}

// ---------------------------------------------------------------------------
// Windows firewall
// ---------------------------------------------------------------------------

const firewallRuleName = (port) => `Minecraft Server Manager (TCP ${port})`;

/**
 * Is there an inbound allow rule for this port?
 *
 * `netsh` is present on every supported Windows version and needs no
 * elevation to *read* rules, so this is a safe, silent check.
 */
export async function firewallRuleExists(port) {
  if (!IS_WINDOWS) return { supported: false, exists: null };

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync(
      'netsh',
      ['advfirewall', 'firewall', 'show', 'rule', `name=${firewallRuleName(port)}`],
      { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    // `netsh` exits 0 and prints "No rules match" when nothing is found.
    const exists = !/No rules match/i.test(stdout) && /LocalPort:\s*(\S+)/i.test(stdout);
    return { supported: true, exists, ruleName: firewallRuleName(port) };
  } catch {
    // A non-zero exit usually means "no such rule".
    return { supported: true, exists: false, ruleName: firewallRuleName(port) };
  }
}

/**
 * The exact command that opens the port.
 *
 * Returned as a string so the UI can show it and the user can run it in an
 * elevated terminal themselves — that is the trustworthy path, and it is also
 * what happens automatically if they press the button.
 */
export function firewallCommand(port, { action = 'add' } = {}) {
  const name = firewallRuleName(port);
  if (action === 'remove') {
    return `netsh advfirewall firewall delete rule name="${name}"`;
  }
  return (
    `netsh advfirewall firewall add rule name="${name}" ` +
    `dir=in action=allow protocol=TCP localport=${port} profile=private,domain`
  );
}

/**
 * Apply a firewall change, raising a UAC prompt.
 *
 * Deliberately shelling out to an elevated `powershell` rather than trying to
 * elevate ourselves: the OS shows the user exactly what is being asked for, and
 * they can decline. The profile is limited to `private,domain` so the rule does
 * not also open the port on untrusted networks.
 */
export async function applyFirewallRule(port, { action = 'add' } = {}) {
  if (!IS_WINDOWS) {
    return { ok: false, error: 'Automatic firewall changes are only implemented for Windows.' };
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const command = firewallCommand(port, { action });
  // Run through PowerShell's RunAs verb so Windows raises the consent dialog.
  const script = `Start-Process -FilePath 'netsh' -ArgumentList '${command.slice('netsh '.length)}' -Verb RunAs -Wait -WindowStyle Hidden`;

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 90_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? '');
    if (/canceled|cancelled|The operation was canceled by the user/i.test(message)) {
      return { ok: false, cancelled: true, command, error: 'The elevation prompt was declined.' };
    }
    return { ok: false, command, error: message.split('\n')[0] || 'Elevation failed.' };
  }

  // Give the firewall service a moment, then report the rule's real state
  // rather than assuming the command succeeded.
  await new Promise((resolve) => setTimeout(resolve, 900));
  const status = await firewallRuleExists(port);
  return { ok: Boolean(status.exists), command, exists: status.exists };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Everything the Connect panel needs, in one call.
 * @param {{ port: number, running: boolean }} options
 */
export async function connectionSummary({ port, running }) {
  const lan = primaryLanAddress();
  const [publicIp, lanReachable, firewall] = await Promise.all([
    publicAddress(),
    running ? isPortReachableOnLan(port) : Promise.resolve(null),
    firewallRuleExists(port),
  ]);

  return {
    port,
    running,
    addresses: {
      lan: lan ? `${lan.address}:${port}` : null,
      lanHost: lan?.address ?? null,
      lanInterface: lan?.name ?? null,
      public: publicIp.value ? `${publicIp.value}:${port}` : null,
      publicHost: publicIp.value,
      publicError: publicIp.error,
      localhost: `127.0.0.1:${port}`,
    },
    adapters: lanAddresses(),
    checks: {
      /** Is the JVM actually accepting connections? */
      listening: running ? await isPortListening(port) : false,
      /** Reachable on the LAN address, not just loopback? */
      reachableOnLan: lanReachable,
      /** An inbound firewall rule exists (Windows only). */
      firewallRule: firewall.exists,
      firewallSupported: firewall.supported,
    },
    firewall: {
      ruleName: firewallRuleName(port),
      addCommand: firewallCommand(port),
      removeCommand: firewallCommand(port, { action: 'remove' }),
      /** Only true when everything needed for a public server is in place. */
      complete: Boolean(firewall.exists) || !firewall.supported,
    },
  };
}

export default {
  lanAddresses,
  primaryLanAddress,
  localAddress,
  publicAddress,
  classifyWanAddress,
  isPortListening,
  isPortReachableOnLan,
  firewallRuleExists,
  firewallCommand,
  applyFirewallRule,
  connectionSummary,
};
