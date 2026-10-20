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
// The repo slug is resolved from RUNCONTAINER_UPDATE_REPO (owner/repo) so forks
// and renames keep working without a code change. Until it is set to the real
// repository, checks report 'unavailable' instead of guessing.
//
// Pure helpers (URL building, version compare, asset picking) are unit tested.
// Network lives in fetchLatestRelease/checkForUpdates and never throws: any
// failure (offline, rate-limited, misconfigured) resolves to 'unavailable' so
// update checking can never block launch.

const https = require('https');

const DEFAULT_UPDATE_REPO = 'OWNER/RunContainer';
const UPDATE_CHECK_TIMEOUT_MS = 8000;

function resolveUpdateRepo() {
  const fromEnv = (process.env.RUNCONTAINER_UPDATE_REPO || '').trim();
  if (fromEnv && /^[^/\s]+\/[^/\s]+$/.test(fromEnv)) return fromEnv;
  return DEFAULT_UPDATE_REPO;
}

function isUpdateRepoConfigured(repo) {
  return Boolean(repo) && repo !== DEFAULT_UPDATE_REPO && /^[^/\s]+\/[^/\s]+$/.test(repo);
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

// Prefer a direct Setup-exe download; fall back to the release page when no
// installer asset matches (the page always lets the user pick).
function pickReleaseLink({ assets, htmlUrl }) {
  const list = Array.isArray(assets) ? assets : [];
  const installer = list.find((asset) => (
    asset
    && typeof asset.name === 'string'
    && /runcontainer.*setup.*\.exe$/i.test(asset.name)
    && typeof asset.browser_download_url === 'string'
  )) || list.find((asset) => (
    asset
    && typeof asset.name === 'string'
    && /setup.*\.exe$/i.test(asset.name)
    && typeof asset.browser_download_url === 'string'
  ));
  return {
    installerUrl: installer ? installer.browser_download_url : null,
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

function fetchLatestRelease({ repo, timeoutMs = UPDATE_CHECK_TIMEOUT_MS } = {}) {
  const url = buildLatestReleaseUrl(repo);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
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

async function checkForUpdates({ currentVersion, repo = resolveUpdateRepo() } = {}) {
  if (!isUpdateRepoConfigured(repo)) {
    return { status: 'unavailable', reason: 'Update repository is not configured yet (RUNCONTAINER_UPDATE_REPO).' };
  }
  const normalizedCurrent = normalizeVersion(currentVersion);
  if (!normalizedCurrent) {
    return { status: 'unavailable', reason: 'Installed version is unreadable.' };
  }
  let release;
  try {
    release = await fetchLatestRelease({ repo });
  } catch (error) {
    return { status: 'unavailable', reason: error?.message || 'Update check failed.' };
  }
  // /releases/latest only ever returns a published non-prerelease, but the
  // version is still compared locally: GitHub orders "latest" by creation
  // date, not by version number.
  const latestVersion = normalizeVersion(release?.tag_name);
  if (!latestVersion) {
    return { status: 'unavailable', reason: 'Latest release has no readable version.' };
  }
  if (!isNewerVersion(normalizedCurrent, latestVersion)) {
    return { status: 'up-to-date', currentVersion: normalizedCurrent, latestVersion };
  }
  const { installerUrl, releaseUrl } = pickReleaseLink({
    assets: release?.assets,
    htmlUrl: release?.html_url,
  });
  return {
    status: 'update-available',
    currentVersion: normalizedCurrent,
    latestVersion,
    releaseName: typeof release?.name === 'string' ? release.name : '',
    releaseNotes: typeof release?.body === 'string' ? release.body : '',
    installerUrl,
    releaseUrl,
  };
}

module.exports = {
  DEFAULT_UPDATE_REPO,
  UPDATE_CHECK_TIMEOUT_MS,
  resolveUpdateRepo,
  isUpdateRepoConfigured,
  buildLatestReleaseUrl,
  classifyReleaseHttpStatus,
  normalizeVersion,
  compareVersions,
  isNewerVersion,
  pickReleaseLink,
  fetchLatestRelease,
  checkForUpdates,
};
