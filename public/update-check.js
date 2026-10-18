// Update notice only. RunContainer never downloads or installs an update: it reads the latest
// public Stable release from GitHub and tells the user where to get it.
const https = require('https');

const RELEASES_API = 'https://api.github.com/repos/RunContainer-7/runcontainer/releases/latest';
const RELEASES_PAGE = 'https://github.com/RunContainer-7/runcontainer/releases/latest';

// Returns the numeric parts of a version such as "v0.5.1" or "0.5.1", or null when it is not
// plain dotted numbers. Pre-release suffixes are not used by this project.
function parseVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+)*$/.test(text)) return null;
  return text.split('.').map((part) => Number(part));
}

// -1 when a < b, 0 when equal, 1 when a > b, null when either version cannot be read.
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Turns the GitHub "latest release" response into the update notice the UI shows.
// Anything unexpected means no notice, never an error shown to the user.
function interpretLatestRelease(release, currentVersion) {
  const none = { available: false, current: currentVersion || null, latest: null, url: RELEASES_PAGE };
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return none;
  const latest = parseVersion(release.tag_name) ? String(release.tag_name).replace(/^v/i, '') : null;
  if (!latest) return none;
  const order = compareVersions(latest, currentVersion);
  if (order !== 1) return { ...none, latest };
  return {
    available: true,
    current: currentVersion,
    latest,
    url: typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : RELEASES_PAGE,
  };
}

// Fetches the latest Stable release. Resolves with the notice; never rejects.
function checkForUpdate(currentVersion, { timeoutMs = 5000, get = https.get } = {}) {
  const fallback = { available: false, current: currentVersion || null, latest: null, url: RELEASES_PAGE };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) { settled = true; resolve(value); }
    };
    try {
      const request = get(RELEASES_API, {
        headers: { 'User-Agent': `RunContainer/${currentVersion || 'unknown'}`, Accept: 'application/vnd.github+json' },
        timeout: timeoutMs,
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(fallback);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) response.destroy(); });
        response.on('end', () => {
          try { finish(interpretLatestRelease(JSON.parse(body), currentVersion)); } catch (_error) { finish(fallback); }
        });
        response.on('error', () => finish(fallback));
      });
      request.on('timeout', () => { request.destroy(); finish(fallback); });
      request.on('error', () => finish(fallback));
    } catch (_error) {
      finish(fallback);
    }
  });
}

module.exports = {
  RELEASES_API,
  RELEASES_PAGE,
  parseVersion,
  compareVersions,
  interpretLatestRelease,
  checkForUpdate,
};
