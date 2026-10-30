// Writes the companion's home-screen icons.
//
// iOS asks for 180px, Android and the manifest for 192 and 512. All three are the same
// RunContainer mark as the desktop app, rendered by the same rasteriser, so the icon on
// the home screen is recognisably the same product.
//
// Usage: node scripts/build-companion-icons.js [--check]

const fs = require('fs');
const path = require('path');
const { renderRgba, encodePng } = require('./build-app-icon');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'companion', 'icons');
const SIZES = [180, 192, 512];

function build() {
  return SIZES.map((size) => ({
    size,
    path: path.join(OUT_DIR, `icon-${size}.png`),
    label: `public/companion/icons/icon-${size}.png`,
    data: encodePng(size, renderRgba(size)),
  }));
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
    console.log(`Companion icons up to date (${SIZES.join('/')} px).`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(file.path, file.data);
    console.log(`Wrote ${file.label} (${file.data.length} bytes)`);
  }
}

main();
