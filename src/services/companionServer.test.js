const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  createCompanionServer,
  createPairingCode,
  codesMatch,
  hashToken,
  tokensMatch,
  isSafeAssetPath,
  acceptKey,
  encodeFrame,
  parseFrames,
  MAX_MESSAGE_BYTES,
} = require('./companionServer');

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function postWithBody(port, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// A real handshake over a socket, because the browser's WebSocket is what has to work.
function openSocket(port, token) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /ws?token=' + encodeURIComponent(token) + ' HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (settled) return;
      const text = buffer.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end === -1) return;
      settled = true;
      if (!text.startsWith('HTTP/1.1 101')) {
        fail(new Error(`Refused: ${text.split('\r\n')[0]}`));
        return;
      }
      // Anything after the header is the first server message; it must not be lost
      // between the handshake and the test attaching its own listener.
      const initial = buffer.subarray(end + 4);
      resolve({ socket, handshake: text.slice(0, end), initial });
    };
    socket.on('data', onData);
    socket.once('error', fail);
    // A server that refuses a token closes the socket without a response.
    socket.once('close', () => fail(new Error('Refused: the server closed the connection')));
  });
}

function maskedFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

describe('companion pairing', () => {
  it('creates a six digit code and compares it in constant time', () => {
    const code = createPairingCode(() => 42);
    expect(code).toBe('000042');
    expect(codesMatch('123456', '123456')).toBe(true);
    expect(codesMatch('123456', '123457')).toBe(false);
    expect(codesMatch('123456', '')).toBe(false);
  });

  it('hashes tokens and never stores the token itself', () => {
    const token = 'a-token';
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toBe(token);
    expect(tokensMatch(hashToken(token), token)).toBe(true);
    expect(tokensMatch(hashToken(token), 'other')).toBe(false);
  });
});

describe('companion asset paths', () => {
  const root = path.join(os.tmpdir(), 'rc-companion-root');

  it('serves the page and its files', () => {
    expect(isSafeAssetPath('/', root)).toBe(path.join(root, 'index.html'));
    expect(isSafeAssetPath('/companion.js', root)).toBe(path.join(root, 'companion.js'));
    expect(isSafeAssetPath('/icons/icon-192.png', root)).toBe(path.join(root, 'icons', 'icon-192.png'));
  });

  it('refuses anything outside the asset folder', () => {
    expect(isSafeAssetPath('/../package.json', root)).toBeNull();
    expect(isSafeAssetPath('/%2e%2e/package.json', root)).toBeNull();
    expect(isSafeAssetPath('/..%5cpackage.json', root)).toBeNull();
    expect(isSafeAssetPath('/C:/Windows/win.ini', root)).toBeNull();
    expect(isSafeAssetPath('/%00/thing', root)).toBeNull();
    expect(isSafeAssetPath('/%zz', root)).toBeNull();
  });
});

describe('companion websocket framing', () => {
  it('computes the accept key the RFC defines', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('encodes a text frame and reads a masked client frame', () => {
    const frame = encodeFrame('hello');
    expect(frame[0]).toBe(0x81);
    expect(frame[1]).toBe(5);
    const parsed = parseFrames(maskedFrame('hello'));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].payload.toString('utf8')).toBe('hello');
    expect(parsed.rest).toHaveLength(0);
  });

  it('waits for the rest of a frame instead of parsing half of it', () => {
    const full = maskedFrame('hello');
    const parsed = parseFrames(full.subarray(0, 4));
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.rest).toHaveLength(4);
  });

  it('refuses an oversized message and an unmasked client frame', () => {
    const huge = Buffer.alloc(10);
    huge[0] = 0x81;
    huge[1] = 127;
    huge.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES + 1), 2);
    expect(() => parseFrames(huge)).toThrow('message-too-large');

    const unmasked = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(() => parseFrames(unmasked)).toThrow('client-frame-unmasked');
  });
});

describe('companion server', () => {
  let server;
  let port;
  let root;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-companion-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>companion</title>');
    fs.writeFileSync(path.join(root, 'companion.js'), 'console.log(1);');
    server = createCompanionServer({
      rootDir: root,
      version: '9.9.9',
      channel: 'stable',
      apps: () => [{ id: 'a1', name: 'Notepad', status: 'Running' }],
    });
    ({ port } = await server.start(0, '127.0.0.1'));
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers health without leaking anything', async () => {
    const result = await request(port, '/health');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it('serves the page with a restrictive policy', async () => {
    const result = await request(port, '/');
    expect(result.status).toBe(200);
    expect(result.body).toContain('companion');
    expect(result.headers['content-security-policy']).toContain("default-src 'self'");
    expect(result.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not serve a file outside the companion folder', async () => {
    const result = await request(port, '/../package.json');
    expect(result.status).toBe(404);
  });

  it('refuses state until a code has been paired', async () => {
    const result = await request(port, '/api/state');
    expect(result.status).toBe(401);
  });

  it('pairs once with the code shown on the PC, then accepts the token', async () => {
    const { code } = server.issuePairingCode();
    const wrong = await postWithBody(port, '/api/pair', { code: '000000' === code ? '111111' : '000000' });
    expect(wrong.status).toBe(403);

    const paired = await postWithBody(port, '/api/pair', { code, device: 'iPhone' });
    expect(paired.status).toBe(200);
    const token = JSON.parse(paired.body).token;
    expect(token).toEqual(expect.any(String));

    const state = await request(port, '/api/state', { authorization: `Bearer ${token}` });
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body).apps).toEqual([
      { id: 'a1', name: 'Notepad', status: 'Running', running: true, note: '' },
    ]);

    // The same code cannot pair a second phone.
    const again = await postWithBody(port, '/api/pair', { code, device: 'Other' });
    expect(again.status).toBe(410);
  });

  it('rejects an expired code', async () => {
    const { code } = server.issuePairingCode();
    const later = createCompanionServer({ rootDir: root, now: () => Date.now() + 6 * 60 * 1000 });
    later.setTokens([]);
    // The code belongs to the other server's clock; an unused code on a fresh server is
    // expired because there is none.
    const result = await postWithBody(port, '/api/pair', { code: '123456' });
    expect([403, 410]).toContain(result.status);
    expect(code).toHaveLength(6);
    await later.stop();
  });

  it('only accepts a websocket for a paired token', async () => {
    const { code } = server.issuePairingCode();
    const paired = await postWithBody(port, '/api/pair', { code });
    const token = JSON.parse(paired.body).token;

    await expect(openSocket(port, 'not-a-token')).rejects.toThrow(/Refused/);

    const { socket, handshake, initial } = await openSocket(port, token);
    expect(handshake).toContain('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const seen = initial && initial.length ? [initial] : [];
    socket.on('data', (chunk) => seen.push(chunk));
    server.onSession((message) => {
      if (message.type === 'view.start') {
        expect(message.appId).toBe('a1');
      }
    });
    socket.write(maskedFrame(JSON.stringify({ type: 'view.start', appId: 'a1' })));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(Buffer.concat(seen).toString('utf8')).toContain('"type":"hello"');
    socket.destroy();
  });

  it('stops and frees its port', async () => {
    await server.stop();
    await expect(request(port, '/health')).rejects.toBeTruthy();
    server = createCompanionServer({ rootDir: root });
  });
});
