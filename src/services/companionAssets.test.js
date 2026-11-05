// The phone's shortcut is a web page, so its icon, its palette and its offline state are
// static files. These checks catch the cases that only show up on a phone: a stale icon
// iOS never refetches, green left in the stylesheet, and an empty page when the PC is off.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const COMPANION = path.join(ROOT, 'public', 'companion');

function pixelColours(file) {
  const buffer = fs.readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const colours = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? line[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + left) & 0xff;
      else if (filter === 2) line[i] = (line[i] + up) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
      }
    }
    for (let x = 0; x < stride; x += 4) colours.push(`${line[x]},${line[x + 1]},${line[x + 2]}`);
    previous = line;
  }
  return colours;
}

describe('companion appearance', () => {
  it('draws the home-screen icon in grey, not the desktop green', () => {
    const colours = pixelColours(path.join(COMPANION, 'icons', 'icon-180.png'));
    expect(colours).toContain('154,163,176');
    expect(colours).not.toContain('63,207,170');
    expect(colours).not.toContain('79,216,180');
  });

  it('gives icon URLs a version so an installed shortcut refetches them', () => {
    const html = fs.readFileSync(path.join(COMPANION, 'index.html'), 'utf8');
    expect(html).toMatch(/apple-touch-icon[^>]+icon-180\.png\?v=/);
    expect(html).toMatch(/rel="icon"[^>]+icon-192\.png\?v=/);
    expect(html).toMatch(/href="\/companion\.css\?v=/);
    expect(html).toMatch(/src="\/companion\.js\?v=/);
    const script = fs.readFileSync(path.join(COMPANION, 'companion.js'), 'utf8');
    expect(script).toMatch(/icon-180\.png\?v=\$\{ICON_VERSION\}/);
    for (const manifest of ['manifest.webmanifest', 'manifest-nightly.webmanifest']) {
      expect(fs.readFileSync(path.join(COMPANION, manifest), 'utf8')).toMatch(/icon-\d+\.png\?v=/);
    }
  });

  it('has no green left in the companion page styles', () => {
    const css = fs.readFileSync(path.join(COMPANION, 'companion.css'), 'utf8');
    expect(css).not.toMatch(/3fcfaa|2bb390|0f8c6f|4fd8b4|120,\s*200,\s*180|140,\s*233,\s*208/i);
  });

  it('keeps the install sheet title rule off the inline <strong>s in its steps', () => {
    const css = fs.readFileSync(path.join(COMPANION, 'companion.css'), 'utf8');
    expect(css).toContain('.install-card > strong');
    expect(css).not.toMatch(/^\.install-card strong \{/m);
  });

  it('keeps the last app list so the shortcut is not empty when the PC is off', () => {
    const script = fs.readFileSync(path.join(COMPANION, 'companion.js'), 'utf8');
    expect(script).toMatch(/rc-companion-apps/);
    expect(script).toMatch(/readAppsCache\(\)/);
    expect(script).toMatch(/setOffline\(true\)/);
  });

  it('keeps RunContainer running when its window is closed and the companion is on', () => {
    const main = fs.readFileSync(path.join(ROOT, 'public', 'main.js'), 'utf8');
    expect(main).toMatch(/mainWindow\.on\('close'/);
    expect(main).toMatch(/if \(isQuitting\) return;/);
    expect(main).toMatch(/if \(!loadCompanionState\(\)\.enabled\) return;/);
    expect(main).toMatch(/event\.preventDefault\(\);/);
    expect(main).toMatch(/function ensureTray\(\)/);
  });
});
