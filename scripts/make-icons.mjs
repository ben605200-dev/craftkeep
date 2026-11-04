/**
 * Generates every icon the desktop app needs — no image library, no binary
 * assets checked in, no design tool.
 *
 * A minimal PNG encoder (zlib deflate + CRC32) and an ICO writer that embeds
 * PNGs (valid since Windows Vista) are enough to produce crisp results. The
 * artwork is an isometric cube — the same mark the dashboard uses — drawn with
 * 4× supersampling so the edges are properly anti-aliased at every size.
 *
 * Output (`desktop/icons/`):
 *   icon.png       512px, rounded-square plate — window + installer icon
 *   icon.ico       16/24/32/48/64/128/256 embedded PNGs — Windows executable
 *   tray.png       32px emerald cube on transparency — a server is running
 *   tray-idle.png  32px slate cube on transparency — nothing running
 *
 * Usage:  npm run icons
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'desktop', 'icons');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

/** Standard CRC-32 (IEEE 802.3) used by PNG chunks. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encode an RGBA buffer as a PNG.
 * @param {Uint8Array} rgba length must be width*height*4
 */
function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with a filter byte; 0 = None.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container. Each entry embeds a complete PNG (Vista+ behaviour). */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    // 0 means "256" in the ICO directory.
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // palette size
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32BE(0, entry + 8);
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const mix = (a, b, t) => a + (b - a) * clamp01(t);

/** `#rrggbb` -> `[r, g, b]` */
const hex = (value) => [
  Number.parseInt(value.slice(1, 3), 16),
  Number.parseInt(value.slice(3, 5), 16),
  Number.parseInt(value.slice(5, 7), 16),
];

/** Even-odd point-in-polygon test. */
function inPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Rounded-rectangle containment. */
function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** The six corners of an isometric cube's silhouette, plus the centre. */
function cubeGeometry(size, scale, centerY = 0.5) {
  const cx = size / 2;
  const cy = size * centerY;
  const s = size * scale;
  const w = s * Math.cos(Math.PI / 6);
  const v = s * 0.5;

  return {
    cx,
    cy,
    top: [cx, cy - 2 * v],
    upperRight: [cx + w, cy - v],
    lowerRight: [cx + w, cy + v],
    bottom: [cx, cy + 2 * v],
    lowerLeft: [cx - w, cy + v],
    upperLeft: [cx - w, cy - v],
    center: [cx, cy],
  };
}

/**
 * Render the icon.
 *
 * @param {number} size              output edge length in pixels
 * @param {{ plate?: boolean, glow?: boolean, scale?: number,
 *           palette?: { top: string, left: string, right: string },
 *           plateColor?: [string, string], outline?: string|null }} options
 * @param {Uint8Array} out           destination RGBA buffer (size*size*4)
 */
function render(size, options = {}, out = new Uint8Array(size * size * 4)) {
  const {
    plate = true,
    glow = true,
    scale = 0.30,
    palette = { top: '#6ee7b7', left: '#10b981', right: '#047857' },
    plateColor = ['#0c0f14', '#161b23'],
    outline = null,
  } = options;

  const SS = 4; // supersampling factor per axis
  const geo = cubeGeometry(size, scale);

  const topFace = [geo.top, geo.upperRight, geo.center, geo.upperLeft];
  // Outline pass: the whole silhouette.
  const silhouette = [geo.top, geo.upperRight, geo.lowerRight, geo.bottom, geo.lowerLeft, geo.upperLeft];
  const leftFace = [geo.upperLeft, geo.center, geo.bottom, geo.lowerLeft];
  const rightFace = [geo.center, geo.upperRight, geo.lowerRight, geo.bottom];

  const topRgb = hex(palette.top);
  const leftRgb = hex(palette.left);
  const rightRgb = hex(palette.right);
  const plateTop = hex(plateColor[0]);
  const plateBottom = hex(plateColor[1]);
  const outlineRgb = outline ? hex(outline) : null;

  const radius = size * 0.22;
  const accent = hex('#10b981');

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // Accumulate sub-samples, then average — this is the anti-aliasing.
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sa = 0;

          if (plate) {
            if (inRoundedRect(px, py, 0, 0, size, size, radius)) {
              const t = py / size;
              sr = mix(plateTop[0], plateBottom[0], t);
              sg = mix(plateTop[1], plateBottom[1], t);
              sb = mix(plateTop[2], plateBottom[2], t);
              sa = 255;

              if (glow) {
                const dx = (px - geo.cx) / (size * 0.42);
                const dy = (py - geo.cy) / (size * 0.42);
                const d = Math.sqrt(dx * dx + dy * dy);
                const strength = Math.pow(clamp01(1 - d), 2.2) * 0.55;
                sr = mix(sr, accent[0], strength);
                sg = mix(sg, accent[1], strength);
                sb = mix(sb, accent[2], strength);
              }
            }
          }

          // Outline sits behind the faces, so it reads as a stroke.
          if (outlineRgb && inPolygon(px, py, silhouette)) {
            sr = outlineRgb[0];
            sg = outlineRgb[1];
            sb = outlineRgb[2];
            sa = 255;
          }

          let face = null;
          if (inPolygon(px, py, topFace)) face = topRgb;
          else if (inPolygon(px, py, leftFace)) face = leftRgb;
          else if (inPolygon(px, py, rightFace)) face = rightRgb;

          if (face) {
            sr = face[0];
            sg = face[1];
            sb = face[2];
            sa = 255;
          }

          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }

      const samples = SS * SS;
      const index = (y * size + x) * 4;
      const alpha = a / samples;
      // Un-premultiply so transparent edges keep their colour.
      const coverage = alpha / 255;
      out[index] = Math.round(coverage > 0 ? r / samples / coverage : 0);
      out[index + 1] = Math.round(coverage > 0 ? g / samples / coverage : 0);
      out[index + 2] = Math.round(coverage > 0 ? b / samples / coverage : 0);
      out[index + 3] = Math.round(alpha);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function write(name, buffer) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  return `${name} (${(buffer.length / 1024).toFixed(1)} KB)`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const written = [];
const started = Date.now();

// Main plate icon.
const platePng = encodePng(render(512), 512, 512);
written.push(write('icon.png', platePng));

// Windows .ico with the sizes Windows actually picks from.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
written.push(
  write(
    'icon.ico',
    encodeIco(icoSizes.map((size) => ({ size, png: encodePng(render(size), size, size) }))),
  ),
);

// Tray icons: no plate, outlined so they read on light and dark taskbars.
const trayPalette = { top: '#6ee7b7', left: '#10b981', right: '#047857' };
written.push(
  write(
    'tray.png',
    encodePng(render(32, { plate: false, glow: false, scale: 0.36, palette: trayPalette, outline: '#04160f' }, new Uint8Array(32 * 32 * 4)), 32, 32),
  ),
);
written.push(
  write(
    'tray-idle.png',
    encodePng(
      render(
        32,
        { plate: false, glow: false, scale: 0.36, outline: '#0b0d11', palette: { top: '#9aa4b2', left: '#6b7280', right: '#4b5563' } },
        new Uint8Array(32 * 32 * 4),
      ),
      32,
      32,
    ),
  ),
);

// A larger tray PNG for HiDPI taskbars.
written.push(
  write(
    'tray@2x.png',
    encodePng(render(64, { plate: false, glow: false, scale: 0.36, palette: trayPalette, outline: '#04160f' }, new Uint8Array(64 * 64 * 4)), 64, 64),
  ),
);

console.log(`Generated ${written.length} icon file(s) in ${Date.now() - started}ms:`);
for (const line of written) console.log(`  ${line}`);
console.log(`→ ${OUT_DIR}`);
