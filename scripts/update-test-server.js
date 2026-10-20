// Local mock of the GitHub Releases API + asset download, for testing the
// update wizard end-to-end BEFORE any real release exists.
//
// Usage:
//   node scripts/update-test-server.js [port] [scenario]
//   RUNCONTAINER_UPDATE_API=http://127.0.0.1:PORT <start the app>
// (the main process reads the env var; it is never taken from renderer input)
//
// Scenarios: newer (default), same, none (404), noasset, ratelimit, wrongsize.
// The /assets/installer.exe route streams ~2 MB slowly so wizard progress
// (including indeterminate mode when ?nolength=1) can be watched.
const http = require('http');
const crypto = require('crypto');
const port = Number(process.argv[2]) || 8977;
const scenario = process.argv[3] || 'newer';
const LATEST = '0.9.0';
const payload = crypto.randomBytes(2 * 1024 * 1024);
const payloadSha = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
function releaseJson(base) {
  const common = {
    tag_name: 'v' + LATEST,
    name: 'RunContainer v' + LATEST + ' (test)',
    body: 'Test release notes. Faster boots. Fewer bugs.',
    html_url: base + '/releases/tag/v' + LATEST
  };
  if (scenario === 'same') {
    common.tag_name = 'v0.6.0';
    return common;
  }
  if (scenario === 'noasset') {
    common.assets = [{ name: 'notes.txt', browser_download_url: base + '/assets/notes.txt', size: 12 }];
    return common;
  }
  if (scenario === 'wrongsize') {
    common.assets = [{ name: 'RunContainer-Setup-' + LATEST + '.exe', browser_download_url: base + '/assets/installer.exe', size: payload.length + 999, digest: payloadSha }];
    return common;
  }
  common.assets = [{ name: 'RunContainer-Setup-' + LATEST + '.exe', browser_download_url: base + '/assets/installer.exe', size: payload.length, digest: payloadSha }];
  return common;
}
const server = http.createServer((req, res) => {
  const base = 'http://127.0.0.1:' + port;
  if (req.url === '/repos/test/app/releases/latest') {
    if (scenario === 'none') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return;
    }
    if (scenario === 'ratelimit') {
      res.writeHead(403, { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '0' });
      res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(releaseJson(base)));
    return;
  }
  if (req.url.indexOf('/assets/installer.exe') === 0) {
    const noLength = req.url.indexOf('nolength=1') !== -1;
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (!noLength) headers['Content-Length'] = payload.length;
    res.writeHead(200, headers);
    const CHUNK = 64 * 1024;
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= payload.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(payload.subarray(offset, offset + CHUNK));
      offset += CHUNK;
    }, 30);
    return;
  }
  res.writeHead(404);
  res.end('unknown route');
});
server.listen(port, '127.0.0.1', () => {
  console.log('update-test-server on http://127.0.0.1:' + port + ' scenario=' + scenario);
});
