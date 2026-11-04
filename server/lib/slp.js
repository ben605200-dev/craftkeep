/**
 * Minecraft Server List Ping (SLP) — the same handshake the multiplayer server
 * list uses.
 *
 * Lets the dashboard show the MOTD, online player sample, and round-trip
 * latency exactly as a real client would see them, without parsing logs.
 *
 * Protocol: https://minecraft.wiki/w/Java_Edition_protocol#Status
 *   handshake(packet 0x00, nextState=1) → status request(0x00) → status response(0x00)
 */

import net from 'node:net';

/** Encode a VarInt (LEB128, 7 bits per byte). */
function writeVarInt(value) {
  let v = value >>> 0;
  const bytes = [];
  do {
    let temp = v & 0b0111_1111;
    v >>>= 7;
    if (v !== 0) temp |= 0b1000_0000;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function writeString(str) {
  const data = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

function packet(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** Incremental VarInt reader over a stream of buffers. */
class VarIntReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  readVarInt() {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < this.buffer.length && i < 5; i += 1) {
      const byte = this.buffer[i];
      result |= (byte & 0b0111_1111) << shift;
      if ((byte & 0b1000_0000) === 0) {
        this.buffer = this.buffer.subarray(i + 1);
        return result >>> 0;
      }
      shift += 7;
    }
    return null; // incomplete
  }
}

/**
 * Query a server's status.
 *
 * @param {{ host?: string, port: number, timeoutMs?: number, protocolVersion?: number }} opts
 * @returns {Promise<{ online: boolean, latencyMs: number|null, motd: string|null, players: object|null, version: object|null, favicon: string|null, error?: string }>}
 */
export function pingServer({ host = '127.0.0.1', port, timeoutMs = 4000, protocolVersion = -1 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    const reader = new VarIntReader();
    let settled = false;

    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      cleanup({ online: false, latencyMs: null, error: 'Timed out — the server did not answer the status request.' });
    }, timeoutMs);

    socket.setNoDelay(true);
    socket.on('error', (error) => {
      cleanup({ online: false, latencyMs: null, error: error.code === 'ECONNREFUSED' ? 'Nothing is listening on that port.' : error.message });
    });
    socket.on('close', () => {
      if (!settled) cleanup({ online: false, latencyMs: null, error: 'Connection closed before a status response arrived.' });
    });

    socket.on('data', (chunk) => {
      reader.push(chunk);
      const length = reader.readVarInt();
      if (length === null) return;
      if (reader.buffer.length < length) return;

      const frame = reader.buffer.subarray(0, length);
      reader.buffer = reader.buffer.subarray(length);

      let offset = 0;
      let shift = 0;
      let packetId = 0;
      do {
        packetId |= (frame[offset] & 0b0111_1111) << shift;
        shift += 7;
      } while ((frame[offset++] & 0b1000_0000) !== 0);

      if (packetId !== 0x00) {
        cleanup({ online: false, latencyMs: null, error: `Unexpected packet id 0x${packetId.toString(16)}.` });
        return;
      }

      let jsonLength = 0;
      shift = 0;
      do {
        jsonLength |= (frame[offset] & 0b0111_1111) << shift;
        shift += 7;
      } while ((frame[offset++] & 0b1000_0000) !== 0);

      let payload;
      try {
        payload = JSON.parse(frame.subarray(offset, offset + jsonLength).toString('utf8'));
      } catch (error) {
        cleanup({ online: false, latencyMs: null, error: `Could not parse the status JSON: ${error.message}` });
        return;
      }

      cleanup({
        online: true,
        latencyMs: Date.now() - started,
        motd: flattenChat(payload.description),
        rawMotd: payload.description ?? null,
        players: payload.players
          ? {
              max: payload.players.max ?? null,
              online: payload.players.online ?? null,
              sample: (payload.players.sample ?? []).map((p) => ({ name: p.name, id: p.id ?? null })),
            }
          : null,
        version: payload.version ?? null,
        favicon: payload.favicon ?? null,
        // Paper/Vanilla expose the mod list here on modded servers.
        mods: Array.isArray(payload.mods) ? payload.mods : null,
        forgeData: payload.forgeData ?? null,
      });
    });

    socket.connect({ host, port: Number(port) }, () => {
      const hostField = host;
      const handshake = Buffer.concat([
        writeVarInt(protocolVersion),
        writeString(hostField),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1), // next state = status
      ]);
      socket.write(packet(0x00, handshake));
      socket.write(packet(0x00, Buffer.alloc(0)));
    });
  });
}

/**
 * Collapse a chat component tree into plain text, keeping §-style formatting
 * codes so the UI can render colours itself.
 */
export function flattenChat(component) {
  if (component === null || component === undefined) return null;
  if (typeof component === 'string') return component;
  if (Array.isArray(component)) return component.map(flattenChat).filter(Boolean).join('');
  if (typeof component !== 'object') return String(component);

  const parts = [];
  if (typeof component.text === 'string') parts.push(component.text);
  if (typeof component.translate === 'string') parts.push(component.translate);
  if (Array.isArray(component.with)) parts.push(component.with.map(flattenChat).join(''));
  if (typeof component.extra === 'string') parts.push(component.extra);
  else if (Array.isArray(component.extra)) parts.push(component.extra.map(flattenChat).join(''));

  return parts.join('');
}

/** Strip §-formatting codes (for plain-text contexts like the OS title bar). */
export const stripFormatting = (text) => String(text ?? '').replace(/§[0-9a-fk-or]/gi, '');

export default pingServer;
