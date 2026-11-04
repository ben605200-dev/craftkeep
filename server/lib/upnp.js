/**
 * UPnP IGD port mapping.
 *
 * Most home routers implement the Internet Gateway Device profile, which lets a
 * client on the LAN ask the router to forward a port. That turns "log into your
 * router and find the port forwarding page" into one button.
 *
 * The protocol is two steps:
 *
 *   1. **SSDP discovery.** Multicast `M-SEARCH` to 239.255.255.250:1900. Every
 *      IGD replies with a `LOCATION:` header pointing at its device description.
 *   2. **SOAP control.** Fetch that description, find the WANIPConnection (or
 *      WANPPPConnection) service, and POST `AddPortMapping` to its control URL.
 *
 * Deliberately dependency-free, and deliberately pessimistic: every failure is
 * reported as a value rather than thrown, because a router that does not support
 * UPnP is a perfectly normal outcome and the caller needs to say so plainly.
 * Nothing here is destructive — the worst case is a failed mapping request.
 */

import dgram from 'node:dgram';
import { getText } from './httpClient.js';
import createLogger from '../logger.js';

const log = createLogger('upnp');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const DISCOVERY_TIMEOUT_MS = 3000;
const SOAP_TIMEOUT_MS = 8000;

/** Search targets, most specific first. */
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
  'upnp:rootdevice',
];

/**
 * Multicast an M-SEARCH and collect replies.
 *
 * @returns {Promise<Array<{ location: string, server: string, address: string }>>}
 */
function ssdpSearch({ timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const finish = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', (error) => {
      log.debug(`SSDP socket error: ${error.message}`);
      clearTimeout(timer);
      finish();
    });

    socket.on('message', (buffer, remote) => {
      const text = buffer.toString('utf8');
      const location = text.match(/^location:\s*(.+)$/im)?.[1]?.trim();
      if (!location) return;
      if (!found.has(location)) {
        found.set(location, {
          location,
          server: text.match(/^server:\s*(.+)$/im)?.[1]?.trim() ?? 'unknown',
          address: remote.address,
        });
      }
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(2);
      } catch {
        /* not fatal */
      }

      for (const target of SEARCH_TARGETS) {
        const request = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${target}`,
            '',
            '',
          ].join('\r\n'),
        );
        socket.send(request, 0, request.length, SSDP_PORT, SSDP_ADDRESS, (error) => {
          if (error) log.debug(`SSDP send failed for ${target}: ${error.message}`);
        });
      }
    });
  });
}

/** Pull the first `<Tag>value</Tag>` out of an XML document. */
const tagValue = (xml, tag) => {
  const match = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].trim() : null;
};

/**
 * Find the port-mapping control endpoint inside a device description.
 *
 * The IGD service can be nested at the top level or under a WAN device, and the
 * control URL is usually relative, so it has to be resolved against the
 * description's own URL.
 */
async function resolveControlEndpoint(descriptionUrl) {
  const xml = await getText(descriptionUrl, { retries: 0, timeout: SOAP_TIMEOUT_MS });

  // Prefer WANIPConnection (plain IP WAN); fall back to PPP.
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1]);
  const wanted = ['WANIPConnection', 'WANPPPConnection'];

  for (const type of wanted) {
    for (const block of services) {
      const serviceType = tagValue(block, 'serviceType') ?? '';
      if (!serviceType.includes(type)) continue;

      const controlUrl = tagValue(block, 'controlURL');
      if (!controlUrl) continue;

      const absolute = new URL(controlUrl, descriptionUrl).toString();
      return { serviceType, controlUrl: absolute, device: tagValue(xml, 'friendlyName') };
    }
  }

  return null;
}

/** POST a SOAP action and return the parsed response fields. */
async function soap(controlUrl, serviceType, action, args = {}) {
  const body =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${serviceType}">` +
    Object.entries(args)
      .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;

  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: `"${serviceType}#${action}"`,
      connection: 'close',
    },
    body,
    signal: AbortSignal.timeout(SOAP_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    // UPnP returns the real reason in a SOAP fault.
    const description = tagValue(text, 'errorDescription') ?? `HTTP ${response.status}`;
    const code = tagValue(text, 'errorCode');
    throw Object.assign(new Error(description), { upnpCode: code, status: response.status });
  }

  const result = {};
  for (const match of text.matchAll(/<([A-Za-z][\w]*)>([\s\S]*?)<\/\1>/g)) {
    if (match[1].includes(':')) continue;
    result[match[1]] = match[2].trim();
  }
  return result;
}

const escapeXml = (value) =>
  String(value ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/**
 * Locate a usable gateway.
 * @returns {Promise<{ ok: true, gateway: object } | { ok: false, reason: string }>}
 */
export async function discoverGateway() {
  const replies = await ssdpSearch();
  if (!replies.length) {
    return {
      ok: false,
      reason: 'no-gateway',
      message:
        'No UPnP gateway answered. Your router either has UPnP disabled or does not support it — ' +
        'you can still forward the port manually.',
    };
  }

  // Try each reply until one exposes a port-mapping service.
  const errors = [];
  for (const reply of replies) {
    try {
      const endpoint = await resolveControlEndpoint(reply.location);
      if (!endpoint) continue;

      const info = await soap(endpoint.controlUrl, endpoint.serviceType, 'GetExternalIPAddress').catch(() => ({}));
      return {
        ok: true,
        gateway: {
          ...endpoint,
          descriptionUrl: reply.location,
          server: reply.server,
          externalIp: info.NewExternalIPAddress ?? null,
        },
      };
    } catch (error) {
      errors.push(error.message);
    }
  }

  return {
    ok: false,
    reason: 'no-igd-service',
    message:
      `Found ${replies.length} UPnP device(s) but none exposed a port-mapping service. ` +
      'Forward the port manually on your router.',
    detail: errors[0] ?? null,
  };
}

/**
 * What is currently mapped for a port, if anything?
 *
 * `NewRemoteHost` must be the empty string: an IGD distinguishes "any remote
 * host" (wildcard) from a specific one, and omitting the element entirely is
 * rejected by some routers.
 */
export async function getMapping(gateway, { port, protocol = 'TCP' }) {
  try {
    const result = await soap(gateway.controlUrl, gateway.serviceType, 'GetSpecificPortMappingEntry', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: protocol,
    });
    return {
      exists: true,
      internalClient: result.NewInternalClient ?? null,
      internalPort: result.NewInternalPort ?? null,
      description: result.NewPortMappingDescription ?? null,
      enabled: result.NewEnabled === '1',
    };
  } catch (error) {
    // 714 = NoSuchEntryInArray, which simply means "nothing mapped".
    if (String(error.upnpCode) === '714') return { exists: false };
    return { exists: false, error: error.message };
  }
}

/**
 * Ask the gateway to forward a port to this machine.
 *
 * @returns {Promise<{ ok: boolean, message: string, mapping?: object, reason?: string }>}
 */
export async function addMapping(gateway, { port, internalPort, internalClient, protocol = 'TCP', description = 'Craftkeep' }) {
  try {
    await soap(gateway.controlUrl, gateway.serviceType, 'AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: protocol,
      NewInternalPort: internalPort ?? port,
      NewInternalClient: internalClient,
      NewEnabled: 1,
      NewPortMappingDescription: description,
      // 0 = no expiry. Some routers cap this, which is fine — the mapping just
      // needs re-adding after a reboot, and the UI says so.
      NewLeaseDuration: 0,
    });
  } catch (error) {
    const code = String(error.upnpCode ?? '');
    if (code === '718') {
      return {
        ok: false,
        reason: 'conflict',
        message:
          'The router refused the mapping (718: ConflictInMappingEntry). Another rule already uses ' +
          'that port — remove it on the router, or pick a different server port.',
      };
    }
    if (code === '725') {
      return {
        ok: false,
        reason: 'not-authorized',
        message: 'The router refused the mapping (725: OnlyPermanentLeasesSupported) — retry, or forward the port manually.',
      };
    }
    return { ok: false, reason: 'failed', message: `The router rejected the request: ${error.message}` };
  }

  const mapping = await getMapping(gateway, { port, protocol });
  return {
    ok: Boolean(mapping.exists),
    message: mapping.exists
      ? `Your router now forwards TCP ${port} to ${internalClient}.`
      : 'The router accepted the request but does not report an active mapping — check it on the router.',
    mapping,
  };
}

/** Remove a mapping this app previously added. */
export async function removeMapping(gateway, { port, protocol = 'TCP' }) {
  try {
    await soap(gateway.controlUrl, gateway.serviceType, 'DeletePortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: protocol,
    });
    return { ok: true, message: `Removed the forwarding rule for TCP ${port}.` };
  } catch (error) {
    if (String(error.upnpCode) === '714') {
      return { ok: true, message: 'There was no forwarding rule to remove.' };
    }
    return { ok: false, message: `Could not remove the rule: ${error.message}` };
  }
}

/**
 * Full picture for the Connect panel: is there a gateway, and what is mapped?
 */
export async function portForwardingStatus({ port }) {
  const discovery = await discoverGateway();
  if (!discovery.ok) {
    return {
      available: false,
      reason: discovery.reason,
      message: discovery.message,
      detail: discovery.detail ?? null,
      mapping: null,
    };
  }

  const mapping = await getMapping(discovery.gateway, { port });
  return {
    available: true,
    gateway: {
      name: discovery.gateway.device ?? 'Router',
      server: discovery.gateway.server,
      externalIp: discovery.gateway.externalIp,
    },
    mapping,
  };
}

export default { discoverGateway, getMapping, addMapping, removeMapping, portForwardingStatus };
