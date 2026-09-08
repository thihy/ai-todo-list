// Generates resources/icon.png (256x256) and resources/tray.png (64x64) at
// build time. The same design as resources/icon.svg, rasterised with a small
// SDF rasteriser + 4x supersampling so edges are anti-aliased.
//
// electron-builder picks up resources/icon.png automatically (buildResources
// = "resources") and generates .ico/.icns from it. tray.png is bundled via
// extraResources and loaded by TrayController at runtime.
//
// Run via: `node resources/build-icons.mjs`

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));

// --- design params (in a 0..1 uv space, origin top-left) ---
const RADIUS = 56 / 256; // rounded-rect corner radius
const PAD = 12 / 256; // padding from canvas edge
const GRAD_TOP = [0x34, 0xd3, 0x99];
const GRAD_BOT = [0x04, 0x78, 0x57];
const WHITE = [0xff, 0xff, 0xff];
const LINE_W = 12 / 256; // list line stroke width
const DOT_R = 9 / 256;

// list lines (y) and dot positions (x), in uv
const LINES = [
  { y: 86 / 256, x1: 74 / 256, x2: 180 / 256 },
  { y: 128 / 256, x1: 74 / 256, x2: 180 / 256 },
  { y: 170 / 256, x1: 74 / 256, x2: 140 / 256 },
];
const DOTS = [86 / 256, 128 / 256, 170 / 256].map((y) => ({ x: 58 / 256, y }));

// --- SDF primitives ---

// Distance to rounded rect centered in [PAD, 1-PAD]^2 with corner radius R.
function sdRoundedRect(px, py) {
  const half = 0.5 - PAD; // half-extent of inner rect (square)
  const qx = Math.abs(px - 0.5) - (half - RADIUS);
  const qy = Math.abs(py - 0.5) - (half - RADIUS);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - RADIUS;
}

// Distance from point (px,py) to segment (ax,ay)-(bx,by).
function sdSegment(px, py, ax, ay, bx, by) {
  const ex = px - ax;
  const ey = py - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (ex * dx + ey * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Shade one pixel (uv in 0..1). Returns [r,g,b,a] 0..255.
function shade(px, py) {
  // background rounded rect
  const dRect = sdRoundedRect(px, py);
  // antialias edge over ~1.5px (in uv; supersampling handles most of it)
  const aa = 1.0 / 256;
  let alpha = 1 - smoothstep(-aa, aa, dRect);
  if (alpha <= 0) return [0, 0, 0, 0];

  // vertical gradient
  const t = (py - (PAD)) / (1 - 2 * PAD);
  const gt = Math.max(0, Math.min(1, t));
  let r = lerp(GRAD_TOP[0], GRAD_BOT[0], gt);
  let g = lerp(GRAD_TOP[1], GRAD_BOT[1], gt);
  let b = lerp(GRAD_TOP[2], GRAD_BOT[2], gt);

  // list lines
  for (const ln of LINES) {
    const d = sdSegment(px, py, ln.x1, ln.y, ln.x2, ln.y);
    const m = 1 - smoothstep(0, aa, d - LINE_W / 2);
    if (m > 0) {
      r = lerp(r, WHITE[0], m);
      g = lerp(g, WHITE[1], m);
      b = lerp(b, WHITE[2], m);
    }
  }
  // dots
  for (const dot of DOTS) {
    const d = Math.hypot(px - dot.x, py - dot.y);
    const m = 1 - smoothstep(0, aa, d - DOT_R);
    if (m > 0) {
      r = lerp(r, WHITE[0], m);
      g = lerp(g, WHITE[1], m);
      b = lerp(b, WHITE[2], m);
    }
  }
  return [r, g, b, Math.round(alpha * 255)];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// --- rasterise with supersampling ---

function render(size, ss) {
  const ssN = size * ss;
  const out = Buffer.alloc(size * size * 4);
  const row = Buffer.alloc(ssN * 4); // one source row reused

  for (let oy = 0; oy < size; oy++) {
    // fill ss rows into an accumulator
    const acc = Buffer.alloc(ssN * ss * 4);
    for (let sy = 0; sy < ss; sy++) {
      const v = (oy * ss + sy + 0.5) / (size * ss);
      for (let ox = 0; ox < ssN; ox++) {
        const u = (ox + 0.5) / (size * ss);
        const c = shade(u, v);
        const o = (sy * ssN + ox) * 4;
        acc[o] = c[0];
        acc[o + 1] = c[1];
        acc[o + 2] = c[2];
        acc[o + 3] = c[3];
      }
    }
    // downsample ssN*ss -> size for this output row
    for (let ox = 0; ox < size; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const o = (sy * ssN + ox * ss + sx) * 4;
          r += acc[o];
          g += acc[o + 1];
          b += acc[o + 2];
          a += acc[o + 3];
        }
      }
      const n = ss * ss;
      const oi = (oy * size + ox) * 4;
      out[oi] = Math.round(r / n);
      out[oi + 1] = Math.round(g / n);
      out[oi + 2] = Math.round(b / n);
      out[oi + 3] = Math.round(a / n);
    }
  }
  return out;
}

// --- PNG encode (RGBA8) ---

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter type 0
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = y * (1 + w * 4) + 1 + x * 4;
      raw[di] = rgba[si];
      raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2];
      raw[di + 3] = rgba[si + 3];
    }
  }
  const idat = deflateRawSync(raw);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function writeIcon(name, size) {
  const rgba = render(size, 4);
  const png = encodePng(rgba, size, size);
  const out = join(here, name);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes, ${size}x${size})`);
}

// Encode a multi-size .ico from pre-rendered PNG bytes. Windows shows the
// taskbar/window icon from the .ico; a bare .png does not reliably apply to
// the taskbar in `pnpm dev` (no .ico exists there because electron-builder
// only generates one for packaged builds), so we ship one ourselves.
function writeIco(name, sizes) {
  const entries = sizes.map((s) => {
    const rgba = render(s, 4);
    const png = encodePng(rgba, s, s);
    return { size: s, png };
  });
  const dirHeader = 6; // reserved(2) + type(2) + count(2)
  const entryLen = 16;
  const dataOffset = dirHeader + entries.length * entryLen;
  let offset = dataOffset;
  const dirBufs = [];
  const dataBufs = [];
  for (const e of entries) {
    const w = e.size >= 256 ? 0 : e.size; // 256 → 0 in ICO field
    const entry = Buffer.alloc(entryLen);
    entry.writeUInt8(w, 0); // width
    entry.writeUInt8(w, 1); // height
    entry.writeUInt8(0, 2); // palette (0 for >8bpp)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(e.png.length, 8); // image size
    entry.writeUInt32LE(offset, 12); // offset
    dirBufs.push(entry);
    dataBufs.push(e.png);
    offset += e.png.length;
  }
  const header = Buffer.alloc(dirHeader);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4); // count
  const ico = Buffer.concat([header, ...dirBufs, ...dataBufs]);
  const out = join(here, name);
  writeFileSync(out, ico);
  console.log(`wrote ${out} (${ico.length} bytes, ${entries.length} sizes)`);
}

writeIcon('icon.png', 256);
writeIcon('tray.png', 64);
writeIco('icon.ico', [16, 24, 32, 48, 64, 128, 256]);
