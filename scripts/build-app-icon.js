// Generates the shipped app icon (.ico with every Windows size, plus a 256px
// PNG) from the same vector design as public/runcontainer-icon.svg.
//
// Why a hand-rolled rasterizer instead of a dependency: the shipped app must not
// gain a build dependency, and the design is a handful of rounded rectangles and
// one triangle. Rendering it with signed-distance sampling keeps the output
// reproducible on every machine and every CI runner.
//
// Usage: node scripts/build-app-icon.js [--check]
//   --check  fail if the committed files differ from what this would write.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ICO_PATH = path.join(PUBLIC, 'runcontainer-icon.ico');
const PNG_PATH = path.join(PUBLIC, 'runcontainer-icon.png');

// Every size Windows asks for: shell lists, taskbar, alt-tab, jumbo icons.
// 256 is required by electron-builder/Inno Setup; 16 and 32 are the ones people
// actually see most.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 256;

const BACKGROUND = [0x0e, 0x11, 0x16];
const ACCENT = [0x3f, 0xcf, 0xaa];

// Design space is the SVG's viewBox: 32 x 32 units.
const UNIT = 32;
const RADIUS_BG = 8;
const BORDER = { x: 3.5, y: 3.5, w: 25, h: 25, r: 6, stroke: 2.25 };
const CORE = { x: 9.25, y: 9.25, w: 13.5, h: 13.5, r: 3 };
const PLAY = [[14.2, 12.8], [18.8, 16], [14.2, 19.2]];

const SUBSAMPLES = 8; // 8x8 per pixel: smooth edges even at 16px.

function roundRectDistance(px, py, rect) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const qx = Math.abs(px - cx) - hw + rect.r;
  const qy = Math.abs(py - cy) - hh + rect.r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - rect.r;
}

function insideTriangle(px, py) {
  const [a, b, c] = PLAY;
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// Returns the color of the design at a point in 32x32 design space, or null for
// transparent (the rounded corners of the background).
function sampleColor(px, py) {
  const bg = { x: 0, y: 0, w: UNIT, h: UNIT, r: RADIUS_BG };
  if (roundRectDistance(px, py, bg) > 0) return null;
  if (insideTriangle(px, py)) return BACKGROUND;
  if (Math.abs(roundRectDistance(px, py, BORDER)) <= BORDER.stroke / 2) return ACCENT;
  if (roundRectDistance(px, py, CORE) <= 0) return ACCENT;
  return BACKGROUND;
}

function renderRgba(size) {
  const data = Buffer.alloc(size * size * 4);
  const scale = UNIT / size;
  const step = 1 / SUBSAMPLES;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          const px = (x + (sx + 0.5) * step) * scale;
          const py = (y + (sy + 0.5) * step) * scale;
          const color = sampleColor(px, py);
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }
      const samples = SUBSAMPLES * SUBSAMPLES;
      const offset = (y * size + x) * 4;
      const alpha = a / samples;
      if (alpha > 0) {
        // Un-premultiply so partly covered edge pixels keep their color.
        const cover = a / 255;
        data[offset] = Math.round(r / cover);
        data[offset + 1] = Math.round(g / cover);
        data[offset + 2] = Math.round(b / cover);
        data[offset + 3] = Math.round(alpha);
      }
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

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

function pngChunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolor with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO (32bpp BMP DIB entries: the most widely supported form for SetupIconFile,
// the shell, and the resource compiler that stamps RunContainer.exe)
// ---------------------------------------------------------------------------

function encodeDib(size, rgba) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    // DIB rows are bottom-up and stored BGRA.
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  // AND mask: padding only matters for 1bpp transparency, which the alpha
  // channel already handles, but the field must be present and row-aligned.
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: XOR image + AND mask
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression: BI_RGB
  header.writeUInt32LE(pixels.length + mask.length, 20); // biSizeImage

  return Buffer.concat([header, pixels, mask]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = 6 + entries.length * 16;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size; // 0 means 256
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0; // palette count
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

// ---------------------------------------------------------------------------

function build() {
  // Windows' icon loader (and electron-builder's validator) expect the 256px
  // layer PNG-compressed; older GDI paths reject a 256px BMP layer outright.
  const entries = ICO_SIZES.map((size) => {
    const rgba = renderRgba(size);
    return { size, data: size >= 256 ? encodePng(size, rgba) : encodeDib(size, rgba) };
  });
  return {
    ico: encodeIco(entries),
    png: encodePng(PNG_SIZE, renderRgba(PNG_SIZE)),
  };
}

function main() {
  const check = process.argv.includes('--check');
  const { ico, png } = build();
  const targets = [
    { path: ICO_PATH, data: ico, label: 'public/runcontainer-icon.ico' },
    { path: PNG_PATH, data: png, label: 'public/runcontainer-icon.png' },
  ];

  if (check) {
    const stale = targets.filter((target) => {
      if (!fs.existsSync(target.path)) return true;
      return !fs.readFileSync(target.path).equals(target.data);
    });
    if (stale.length > 0) {
      console.error(`Icon files are stale: ${stale.map((t) => t.label).join(', ')}`);
      console.error('Run: node scripts/build-app-icon.js');
      process.exit(1);
    }
    console.log(`Icon files up to date (${ICO_SIZES.join('/')} px).`);
    return;
  }

  fs.mkdirSync(PUBLIC, { recursive: true });
  for (const target of targets) {
    fs.writeFileSync(target.path, target.data);
    console.log(`Wrote ${target.label} (${target.data.length} bytes)`);
  }
  console.log(`Icon sizes: ${ICO_SIZES.join(', ')} px`);
}

main();
