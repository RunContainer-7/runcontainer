// Bumps the app version everywhere it is written down, so package.json, the lockfile
// and the in-app fallback cannot drift apart.
const fs = require('fs');
const path = require('path');

const NEXT = '0.8.1';
const root = process.cwd();

function bumpJson(file, paths) {
  const full = path.join(root, file);
  const text = fs.readFileSync(full, 'utf8');
  const data = JSON.parse(text);
  for (const keyPath of paths) {
    const parts = keyPath.split('.');
    let node = data;
    for (const part of parts.slice(0, -1)) node = node[part];
    if (node[parts[parts.length - 1]] === undefined) throw new Error(`${file}: ${keyPath} not found`);
    node[parts[parts.length - 1]] = NEXT;
  }
  // Preserve the lockfile's own formatting (2-space indent, trailing newline).
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`${file}: set ${paths.join(', ')} to ${NEXT}`);
}

bumpJson('package.json', ['version']);
bumpJson('package-lock.json', ['version', 'packages..version']);

const component = path.join(root, 'src/components/ContainerManager.jsx');
const source = fs.readFileSync(component, 'utf8');
const replaced = source.replace(/const APP_VERSION_FALLBACK = "[^"]+";/, `const APP_VERSION_FALLBACK = "${NEXT}";`);
if (replaced === source) throw new Error('ContainerManager.jsx: version fallback not found');
fs.writeFileSync(component, replaced, 'utf8');
console.log(`src/components/ContainerManager.jsx: fallback set to ${NEXT}`);

const readme = path.join(root, 'README.md');
const readmeText = fs.readFileSync(readme, 'utf8');
const readmeNext = readmeText.replace(/git tag v\d+\.\d+\.\d+ && git push origin v\d+\.\d+\.\d+/,
  `git tag v${NEXT} && git push origin v${NEXT}`);
if (readmeNext !== readmeText) {
  fs.writeFileSync(readme, readmeNext, 'utf8');
  console.log(`README.md: release tag example set to v${NEXT}`);
}
