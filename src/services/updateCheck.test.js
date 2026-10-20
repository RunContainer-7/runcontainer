const {
  buildLatestReleaseUrl,
  classifyReleaseHttpStatus,
  normalizeVersion,
  isNewerVersion,
  pickReleaseLink,
  isUpdateRepoConfigured,
  updateApiBase,
  DEFAULT_UPDATE_REPO,
} = require('../../public/update-check');

describe('update check helpers', () => {
  it('builds the stable-only latest-release endpoint', () => {
    expect(buildLatestReleaseUrl('acme/RunContainer'))
      .toBe('https://api.github.com/repos/acme/RunContainer/releases/latest');
  });

  it('treats the placeholder repo as unconfigured', () => {
    expect(isUpdateRepoConfigured(DEFAULT_UPDATE_REPO)).toBe(false);
    expect(isUpdateRepoConfigured('acme/RunContainer')).toBe(true);
    expect(isUpdateRepoConfigured('not-a-slug')).toBe(false);
  });

  it('normalizes v-prefixed versions and rejects junk', () => {
    expect(normalizeVersion('v0.5.1')).toBe('0.5.1');
    expect(normalizeVersion(' 1.2.3 ')).toBe('1.2.3');
    expect(normalizeVersion('0.5')).toBeNull();
    expect(normalizeVersion('latest')).toBeNull();
    expect(normalizeVersion(null)).toBeNull();
  });

  it('compares versions numerically, not lexicographically', () => {
    expect(isNewerVersion('0.5.1', '0.5.10')).toBe(true);
    expect(isNewerVersion('0.5.10', '0.5.9')).toBe(false);
    expect(isNewerVersion('0.5.1', '0.5.1')).toBe(false);
    expect(isNewerVersion('0.5.1', '0.4.9')).toBe(false);
    expect(isNewerVersion('0.5.1', 'junk')).toBe(false);
  });

  it('maps HTTP failures to actionable reasons', () => {
    expect(classifyReleaseHttpStatus(200)).toBeNull();
    expect(classifyReleaseHttpStatus(429)).toContain('rate limit');
    expect(classifyReleaseHttpStatus(403)).toContain('rate limit');
    expect(classifyReleaseHttpStatus(404)).toContain('No published releases');
    expect(classifyReleaseHttpStatus(500)).toContain('HTTP 500');
  });

  it('picks the exact Setup exe for the version, with size and digest', () => {
    const htmlUrl = 'https://github.com/acme/RunContainer/releases/tag/v0.5.1';
    const picked = pickReleaseLink({
      htmlUrl,
      version: '0.5.1',
      assets: [
        { name: 'Setup.exe', browser_download_url: 'https://example.com/wrong.exe', size: 1 },
        { name: 'checksums.txt', browser_download_url: 'https://example.com/sums' },
        { name: 'RunContainer-Setup-0.5.1.exe', browser_download_url: 'https://example.com/setup.exe', size: 123, digest: 'sha256:abc' },
      ],
    });
    expect(picked.installerUrl).toBe('https://example.com/setup.exe');
    expect(picked.installerSize).toBe(123);
    expect(picked.installerDigest).toBe('sha256:abc');
    expect(picked.releaseUrl).toBe(htmlUrl);

    const fallback = pickReleaseLink({ htmlUrl, assets: [{ name: 'src.zip' }] });
    expect(fallback.installerUrl).toBeNull();
    expect(fallback.installerSize).toBeNull();
    expect(fallback.releaseUrl).toBe(htmlUrl);
  });

  it('defaults the API base to GitHub but honors the test override', () => {
    delete process.env.RUNCONTAINER_UPDATE_API;
    expect(updateApiBase()).toBe('https://api.github.com');
    process.env.RUNCONTAINER_UPDATE_API = 'http://127.0.0.1:8977/';
    expect(updateApiBase()).toBe('http://127.0.0.1:8977');
    delete process.env.RUNCONTAINER_UPDATE_API;
  });
});
