// Packaged-app guard.
//
// v0.6.5 shipped `require('brain.js')` from the main process. brain.js is a
// devDependency, so electron-packager pruned it and the installed app died
// before it could open a window. Nothing in the shipped runtime may require a
// package that is not in "dependencies"; the trainer is the only allowed
// exception and it lives under scripts/.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BUILTINS = new Set(require('module').builtinModules);
const ENTRY = path.join(ROOT, 'public', 'main.js');

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.json`, `${base}.cjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function scanRuntimeGraph(entry = ENTRY) {
  const visited = new Set();
  const bare = new Set();
  const missing = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      continue;
    }
    for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier);
        if (resolved) queue.push(resolved);
        else missing.push(`${path.relative(ROOT, file)} -> ${specifier}`);
      } else if (specifier.startsWith('node:')) {
        continue;
      } else if (!BUILTINS.has(specifier.split('/')[0]) && !BUILTINS.has(specifier)) {
        bare.add(specifier.split('/')[0]);
      }
    }
  }
  return { files: visited, bare, missing };
}

// 'electron' is supplied by the Electron runtime itself, never by node_modules
// resolution, so it is legitimately absent from "dependencies".
function runtimeDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return new Set([...Object.keys(pkg.dependencies || {}), 'electron']);
}

describe('packaged runtime dependencies', () => {
  it('only requires modules that ship in dependencies', () => {
    const { bare } = scanRuntimeGraph();
    const allowed = runtimeDependencies();
    const devOnly = [...bare].filter((name) => !allowed.has(name));
    // A devDependency here is invisible in development and fatal when packaged.
    expect(devOnly).toEqual([]);
  });

  it('resolves every relative require in the runtime graph', () => {
    const { missing } = scanRuntimeGraph();
    expect(missing).toEqual([]);
  });

  it('keeps the training library out of the shipped AI runtime', () => {
    for (const file of ['engine.js', 'inference.js', 'features.js', 'experiences.js']) {
      const full = path.join(__dirname, file);
      if (!fs.existsSync(full)) continue;
      expect(fs.readFileSync(full, 'utf8')).not.toMatch(/require\(\s*['"]brain\.js['"]\s*\)/);
    }
    expect(fs.readFileSync(ENTRY, 'utf8')).not.toMatch(/require\(\s*['"]brain\.js['"]\s*\)/);
  });
});

module.exports = { scanRuntimeGraph, runtimeDependencies };
