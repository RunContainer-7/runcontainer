// Guards the one thing that silently breaks in-app updates: a packaged build
// whose update checker cannot resolve a real repository. The unit tests cover
// the source file, but a release can still ship a stale or mis-built archive
// (that is exactly how an update notice can go missing in a shipped installer),
// so this reads the app archive that is about to be installed and asserts the
// values inside it.
//
// Usage: node scripts/verify-packaged-update-repo.js [path\to\app.asar]
// Exits 1 with PACKAGED_UPDATE_REPO_FAIL when the packaged checker is wrong.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXPECTED_REPO = 'RunContainer-7/runcontainer';
const archive = path.resolve(
  process.argv[2] || path.join('out', 'RunContainer-win32-x64', 'resources', 'app.asar'),
);

function fail(message) {
  console.error(`PACKAGED_UPDATE_REPO_FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(archive)) {
  fail(`no packaged app archive at ${archive}. Run "npm run package" first.`);
}

const asar = require('@electron/asar');
const files = asar.listPackage(archive).map((entry) => entry.replace(/\\/g, '/'));
if (!files.includes('/public/update-check.js')) {
  fail('public/update-check.js is not inside the packaged app, so no build could ever show an update notice.');
}

const source = asar.extractFile(archive, 'public/update-check.js').toString('utf8');
const declared = source.match(/const DEFAULT_UPDATE_REPO = '([^']+)'/);
if (!declared) {
  fail('DEFAULT_UPDATE_REPO is missing from the packaged update checker.');
}
if (declared[1] !== EXPECTED_REPO) {
  fail(`packaged DEFAULT_UPDATE_REPO is "${declared[1]}", expected "${EXPECTED_REPO}".`);
}

// Evaluate the packaged copy itself (not the working tree) with no environment
// override set, which is how a real install determines its repository.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-packaged-check-'));
const extracted = path.join(tempDir, 'update-check.js');
fs.writeFileSync(extracted, source, 'utf8');
delete process.env.RUNCONTAINER_UPDATE_REPO;
let mod;
try {
  mod = require(extracted);
} catch (error) {
  fail(`packaged update checker cannot be loaded: ${error.message}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const resolved = mod.resolveUpdateRepo();
if (resolved !== EXPECTED_REPO) {
  fail(`packaged resolveUpdateRepo() returned "${resolved}", expected "${EXPECTED_REPO}".`);
}
if (!mod.isUpdateRepoConfigured(resolved)) {
  fail(`packaged repository "${resolved}" reads as unconfigured, so the notice is suppressed.`);
}

console.log(`PACKAGED_UPDATE_REPO_OK repo=${resolved} archive=${path.basename(archive)}`);
