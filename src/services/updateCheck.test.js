const {
  buildLatestReleaseUrl,
  classifyReleaseHttpStatus,
  normalizeVersion,
  isNewerVersion,
  pickReleaseLink,
  isUpdateRepoConfigured,
  updateApiBase,
  DEFAULT_UPDATE_REPO,
  PLACEHOLDER_UPDATE_REPO,
  parseNightly,
  selectNightlyRelease,
} = require('../../public/update-check');

describe('update check helpers', () => {
  it('builds the stable-only latest-release endpoint', () => {
    expect(buildLatestReleaseUrl('acme/RunContainer'))
      .toBe('https://api.github.com/repos/acme/RunContainer/releases/latest');
  });

  it('treats the default repo as configured and rejects junk', () => {
    expect(DEFAULT_UPDATE_REPO).toBe('RunContainer-7/runcontainer');
    expect(isUpdateRepoConfigured(DEFAULT_UPDATE_REPO)).toBe(true);
    expect(isUpdateRepoConfigured('acme/RunContainer')).toBe(true);
    expect(isUpdateRepoConfigured(PLACEHOLDER_UPDATE_REPO)).toBe(false);
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

  it('prefers the renamed stable installer while retaining legacy release support', () => {
    const assets = [
      { name: 'RunContainer-Setup-0.9.1.exe', browser_download_url: 'https://example.com/legacy' },
      { name: 'RunContainer-Stable-Setup-0.9.1.exe', browser_download_url: 'https://example.com/stable' },
      { name: 'RunContainer-Nightly-Setup-0.9.1.exe', browser_download_url: 'https://example.com/nightly' },
    ];
    expect(pickReleaseLink({ version: '0.9.1', assets }).installerUrl).toBe('https://example.com/stable');
    expect(pickReleaseLink({ version: '0.9.1', assets: assets.slice(0, 1) }).installerUrl).toBe('https://example.com/legacy');
    expect(pickReleaseLink({ version: '0.9.1', channel: 'nightly', assets: assets.slice(0, 2) }).installerUrl).toBeNull();
  });

  it('selects the newest nightly prerelease and never selects stable or drafts', () => {
    const releases = [
      { tag_name: 'v9.0.0', prerelease: false },
      { tag_name: 'v0.9.1-nightly.10', prerelease: true, draft: true },
      { tag_name: 'v0.9.1-nightly.2', prerelease: true },
      { tag_name: 'v0.9.1-nightly.9', prerelease: true },
      { tag_name: 'v0.9.1-beta.10', prerelease: true },
    ];
    expect(selectNightlyRelease(releases).tag_name).toBe('v0.9.1-nightly.9');
    expect(parseNightly('0.9.1-nightly.9').build).toBe(9);
    expect(parseNightly('0.9.1')).toBeNull();
    expect(pickReleaseLink({ version: '0.9.1-nightly.9', channel: 'nightly', assets: [
      { name: 'RunContainer-Setup-0.9.1-nightly.9.exe', browser_download_url: 'https://example.com/stable' },
    ] }).installerUrl).toBeNull();
    expect(pickReleaseLink({ version: '0.9.1', assets: [
      { name: 'RunContainer-Nightly-Setup-0.9.1.exe', browser_download_url: 'https://example.com/nightly' },
    ] }).installerUrl).toBeNull();
  });

  it('defaults the API base to GitHub but honors the test override', () => {
    delete process.env.RUNCONTAINER_UPDATE_API;
    expect(updateApiBase()).toBe('https://api.github.com');
    process.env.RUNCONTAINER_UPDATE_API = 'http://127.0.0.1:8977/';
    expect(updateApiBase()).toBe('http://127.0.0.1:8977');
    delete process.env.RUNCONTAINER_UPDATE_API;
  });
});

describe('checkForUpdates network behaviour', () => {
  const { checkForUpdates, resolveUpdateRepo } = require('../../public/update-check');
  const net = require('net');

  afterEach(() => {
    delete process.env.RUNCONTAINER_UPDATE_API;
    delete process.env.RUNCONTAINER_UPDATE_REPO;
  });

  it('resolves the built-in repository without any environment variable', () => {
    delete process.env.RUNCONTAINER_UPDATE_REPO;
    expect(resolveUpdateRepo()).toBe('RunContainer-7/runcontainer');
    process.env.RUNCONTAINER_UPDATE_REPO = 'fork/RunContainer';
    expect(resolveUpdateRepo()).toBe('fork/RunContainer');
  });

  it('survives a refused connection instead of throwing (offline)', async () => {
    // Bind a port, then close it: the port is known-closed, so the connection is
    // refused immediately rather than hanging on a filtered port.
    const port = await new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port: assigned } = server.address();
        server.close(() => resolve(assigned));
      });
    });
    process.env.RUNCONTAINER_UPDATE_API = `http://127.0.0.1:${port}`;
    const result = await checkForUpdates({ currentVersion: '0.6.0' });
    expect(result.status).toBe('unavailable');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('reports unavailable for an unconfigured repository without any request', async () => {
    const result = await checkForUpdates({ currentVersion: '0.6.0', repo: 'not-a-slug' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('not configured');
  });

  it('reports unavailable for an unreadable installed version', async () => {
    const result = await checkForUpdates({ currentVersion: 'unknown-build' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('unreadable');
  });
});
