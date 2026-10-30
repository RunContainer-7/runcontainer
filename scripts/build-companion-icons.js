// Writes the companion's home-screen icons and manifests.
//
// iOS asks for 180px, Android and the manifest for 192 and 512. All of them are the
// same RunContainer mark as the desktop app, rendered by the same rasteriser. Unlike
// the Windows icon, these are full squares: iOS draws transparent corners as black.
// Nightly gets the blue accent and its own folder, so the installed icon matches the
// edition that served the page.
//
// Usage: node scripts/build-companion-icons.js [--check]

const fs = require('fs');
const path = require('path');
const { renderRgba, encodePng } = require('./build-app-icon');

const ROOT = path.join(__dirname, '..');
const COMPANION_DIR = path.join(ROOT, 'public', 'companion');
const ICON_DIR = path.join(COMPANION_DIR, 'icons');
const SIZES = [180, 192, 512];

const DESIGNS = [
  { nightly: false, dir: ICON_DIR, manifest: path.join(COMPANION_DIR, 'manifest.webmanifest') },
  { nightly: true, dir: path.join(ICON_DIR, 'nightly'), manifest: path.join(COMPANION_DIR, 'manifest-nightly.webmanifest') },
];

function manifestFor(design) {
  const icons = SIZES.map((size) => ({
    src: `${design.nightly ? '/icons/nightly' : '/icons'}/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'any',
  }));
  return `${JSON.stringify({
    name: design.nightly ? 'RunContainer Nightly Companion' : 'RunContainer Companion',
    short_name: design.nightly ? 'RC Nightly' : 'RunContainer',
    description: 'See and control an app that is running in RunContainer on your Windows PC.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#080b10',
    theme_color: '#0b0f14',
    icons,
  }, null, 2)}\n`;
}

function build() {
  const files = [];
  for (const design of DESIGNS) {
    for (const size of SIZES) {
      const filePath = path.join(design.dir, `icon-${size}.png`);
      files.push({
        path: filePath,
        label: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        data: encodePng(size, renderRgba(size, { nightly: design.nightly, opaque: true })),
      });
    }
    files.push({
      path: design.manifest,
      label: path.relative(ROOT, design.manifest).replace(/\\/g, '/'),
      data: Buffer.from(manifestFor(design), 'utf8'),
    });
  }
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const files = build();

  if (check) {
    const stale = files.filter((file) => {
      if (!fs.existsSync(file.path)) return true;
      return !fs.readFileSync(file.path).equals(file.data);
    });
    if (stale.length > 0) {
      console.error(`Companion icons are stale: ${stale.map((file) => file.label).join(', ')}`);
      console.error('Run: node scripts/build-companion-icons.js');
      process.exit(1);
    }
    console.log(`Companion icons up to date (${SIZES.join('/')} px, stable and nightly).`);
    return;
  }

  for (const file of files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.data);
    console.log(`Wrote ${file.label}`);
  }
}

main();
