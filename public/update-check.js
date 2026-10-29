// In-app update checks against GitHub Releases (stable releases only).
//
// How users get updates:
// - Installed users: the app checks the latest GitHub Release on launch (and on
//   demand from the Updates tab). When a newer stable version exists, a notice
//   banner appears with buttons that open the release page / installer.
// - Everyone else: new installers are attached to the GitHub Release itself
//   (see .github/workflows/release.yml), so the docs and release page always
//   point at the newest Setup exe.
//
// The repo slug defaults to the real RunContainer repository so installed apps
// check for updates out of the box. RUNCONTAINER_UPDATE_REPO (owner/repo)
// overrides it, so forks and renames keep working without a code change.
//
// Pure helpers (URL building, version compare, asset picking) are unit tested.
// Network lives in fetchLatestRelease/checkForUpdates and never throws: any
// failure (offline, rate-limited, misconfigured) resolves to 'unavailable' so
// update checking can never block launch.

const https = require('https');

const DEFAULT_UPDATE_REPO = 'RunContainer-7/runcontainer';
// The pre-wiring sentinel. If this ever resolves as the repo (stale env var,
// old config), checks report 'unavailable' instead of querying a nonsense slug.
const PLACEHOLDER_UPDATE_REPO = 'OWNER/RunContainer';
const UPDATE_CHECK_TIMEOUT_MS = 8000;

function resolveUpdateRepo() {
  const fromEnv = (process.env.RUNCONTAINER_UPDATE_REPO || '').trim();
  if (fromEnv && /^[^/\s]+\/[^/\s]+$/.test(fromEnv)) return fromEnv;
  return DEFAULT_UPDATE_REPO;
}

function isUpdateRepoConfigured(repo) {
  return Boolean(repo) && repo !== PLACEHOLDER_UPDATE_REPO && /^[^/\s]+\/[^/\s]+$/.test(repo);
}

function buildLatestReleaseUrl(repo) {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

// 'v0.5.1' -> '0.5.1'. Returns null for anything that is not a numeric
// dotted version (optionally with a pre-release/build suffix).
function normalizeVersion(version) {
  if (typeof version !== 'string') return null;
  const cleaned = version.trim().replace(/^[vV]/, '');
  const match = cleaned.match(/^(\d+\.\d+\.\d+)([-+][0-9A-Za-z.-]+)?$/);
  return match ? match[1] : null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// True only when latest is a valid, strictly newer stable version.
function isNewerVersion(current, latest) {
  const normalizedCurrent = normalizeVersion(current);
  const normalizedLatest = normalizeVersion(latest);
  if (!normalizedCurrent || !normalizedLatest) return false;
  return compareVersions(normalizedCurrent, normalizedLatest) < 0;
}

// Pick the exact channel-specific installer asset for a release. Stable releases
// before the rename use the legacy prefix; keep those updates working.
// Never the first .exe returned: a wrong asset would install the wrong thing.
// The asset size + digest travel with the pick so the downloader can verify.
function pickReleaseLink({ assets, htmlUrl, version, channel = 'stable' }) {
  const list = Array.isArray(assets) ? assets : [];
  const hasUrl = (asset) => asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string';
  // Never fall back to a different channel's installer: the two are separate products.
  const prefixes = channel === 'nightly'
    ? ['RunContainer-Nightly-Setup-']
    : ['RunContainer-Stable-Setup-', 'RunContainer-Setup-'];
  const installer = version && prefixes.reduce((found, prefix) => found || list.find(
    (asset) => hasUrl(asset) && asset.name.toLowerCase() === `${prefix}${version}.exe`.toLowerCase()
  ), null);
  return {
    installerUrl: installer ? installer.browser_download_url : null,
    installerName: installer ? installer.name : null,
    installerSize: Number.isSafeInteger(installer?.size) ? installer.size : null,
    installerDigest: typeof installer?.digest === 'string' ? installer.digest : null,
    releaseUrl: typeof htmlUrl === 'string' ? htmlUrl : null,
  };
}

// Maps non-200 release-API statuses to user-actionable reasons. Pure (tested).
// Returns null when the caller should treat the body as a release payload.
function classifyReleaseHttpStatus(statusCode) {
  if (statusCode === 200) return null;
  if (statusCode === 403 || statusCode === 429) {
    return 'GitHub rate limit reached (60 checks/hour unauthenticated). Try again later.';
  }
  if (statusCode === 404) return 'No published releases found for this repository yet.';
  return `GitHub Releases answered HTTP ${statusCode}.`;
}

// RUNCONTAINER_UPDATE_API overrides the API base for local testing ONLY
// (e.g. http://127.0.0.1:PORT against scripts/update-test-server.js). It is
// read from the process environment, never from renderer input, and production
// builds simply never set it.
function updateApiBase() {
  const override = (process.env.RUNCONTAINER_UPDATE_API || '').trim().replace(/\/$/, '');
  return override || 'https://api.github.com';
}

function fetchLatestRelease({ repo, channel = 'stable', timeoutMs = UPDATE_CHECK_TIMEOUT_MS } = {}) {
  const endpoint = channel === 'nightly' ? '/releases?per_page=100' : '/releases/latest';
  const url = `${updateApiBase()}/repos/${repo}${endpoint}`;
  // Plain http is allowed ONLY for the loopback test override; production is https.
  const transport = url.startsWith('http://127.0.0.1') ? require('http') : https;
  if (!url.startsWith('https://') && !url.startsWith('http://127.0.0.1')) {
    return Promise.reject(new Error('Update API must be https (or loopback http for tests).'));
  }
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'RunContainer',
      },
      timeout: timeoutMs,
    }, (response) => {
      const { statusCode } = response;
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        const classified = classifyReleaseHttpStatus(statusCode);
        if (classified) {
          reject(new Error(classified));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('GitHub Releases returned an unreadable response.'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Update check timed out.')));
    request.on('error', reject);
  });
}

// Nightly tags are semver prereleases, for example v0.9.1-nightly.2.
// Comparing only the numeric core would silently miss every later nightly build.
function parseNightly(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^[vV]?(\d+\.\d+\.\d+)-nightly\.(\d+)$/);
  return match ? { core: match[1], build: Number(match[2]), version: `${match[1]}-nightly.${match[2]}` } : null;
}

function selectNightlyRelease(releases) {
  if (!Array.isArray(releases)) return null;
  return releases.filter((release) => !release?.draft && release?.prerelease && parseNightly(release.tag_name))
    .sort((a, b) => {
      const av = parseNightly(a.tag_name);
      const bv = parseNightly(b.tag_name);
      return compareVersions(bv.core, av.core) || bv.build - av.build;
    })[0] || null;
}

async function checkForUpdates({ currentVersion, repo = resolveUpdateRepo(), channel = 'stable' } = {}) {
  if (!isUpdateRepoConfigured(repo)) {
    return { status: 'unavailable', reason: 'Update repository is not configured yet (RUNCONTAINER_UPDATE_REPO).' };
  }
  const normalizedCurrent = channel === 'nightly' ? parseNightly(currentVersion)?.version : normalizeVersion(currentVersion);
  if (!normalizedCurrent) {
    return { status: 'unavailable', reason: 'Installed version is unreadable.' };
  }
  let release;
  try {
    release = await fetchLatestRelease({ repo, channel });
    if (channel === 'nightly') release = selectNightlyRelease(release);
  } catch (error) {
    return { status: 'unavailable', reason: error?.message || 'Update check failed.' };
  }
  // /releases/latest only ever returns a published non-prerelease, but the
  // version is still compared locally: GitHub orders "latest" by creation
  // date, not by version number.
  const latestVersion = channel === 'nightly' ? parseNightly(release?.tag_name)?.version : normalizeVersion(release?.tag_name);
  if (!latestVersion) {
    return { status: 'unavailable', reason: 'Latest release has no readable version.' };
  }
  const currentNightly = channel === 'nightly' && parseNightly(normalizedCurrent);
  const latestNightly = channel === 'nightly' && parseNightly(latestVersion);
  const newer = channel === 'nightly'
    ? compareVersions(currentNightly.core, latestNightly.core) < 0 || (currentNightly.core === latestNightly.core && currentNightly.build < latestNightly.build)
    : isNewerVersion(normalizedCurrent, latestVersion);
  if (!newer) {
    return { status: 'up-to-date', currentVersion: normalizedCurrent, latestVersion };
  }
  const { installerUrl, installerName, installerSize, installerDigest, releaseUrl } = pickReleaseLink({
    assets: release?.assets,
    htmlUrl: release?.html_url,
    version: latestVersion,
    channel,
  });
  return {
    status: 'update-available',
    currentVersion: normalizedCurrent,
    latestVersion,
    releaseName: typeof release?.name === 'string' ? release.name : '',
    releaseNotes: typeof release?.body === 'string' ? release.body : '',
    installerUrl,
    installerName,
    installerSize,
    installerDigest,
    releaseUrl,
  };
}

module.exports = {
  DEFAULT_UPDATE_REPO,
  PLACEHOLDER_UPDATE_REPO,
  UPDATE_CHECK_TIMEOUT_MS,
  resolveUpdateRepo,
  isUpdateRepoConfigured,
  buildLatestReleaseUrl,
  updateApiBase,
  classifyReleaseHttpStatus,
  normalizeVersion,
  compareVersions,
  isNewerVersion,
  pickReleaseLink,
  parseNightly,
  selectNightlyRelease,
  fetchLatestRelease,
  checkForUpdates,
};
