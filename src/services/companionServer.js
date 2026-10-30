// The iPhone companion's server.
//
// The companion is a small home-screen web app that shows and controls an app that is
// running on this PC. It is not a way to run Windows programs or iOS apps on the phone;
// the phone is a screen and a keyboard for the PC.
//
// This module owns the part that faces the network, and nothing else:
//
//   - pairing      a six-digit code shown on the PC is exchanged once for a long token
//   - authorisation every request and every message after that needs the token
//   - assets       the companion page is served from public/companion
//   - transport    one WebSocket per paired phone
//
// It never starts apps, never touches files outside its own asset folder, and never
// decides what an input event means. Those belong to the main process, so this file can
// be tested on any platform. Node's http and crypto only: no dependencies, no native code.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 64 * 1024;
const PAIRING_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 8;
const TOKEN_BYTES = 32;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Six digits, generated with the same randomness as a token: a predictable code would
// let somebody on the same network pair before the person at the PC does.
function createPairingCode(randomInt = crypto.randomInt) {
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

// Compared in constant time so a wrong code cannot be guessed by timing the answer.
function codesMatch(expected, given) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(given || ''));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function createToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokensMatch(storedHash, token) {
  if (!storedHash || !token) return false;
  const given = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(String(storedHash), 'hex');
  if (given.length !== stored.length) return false;
  return crypto.timingSafeEqual(given, stored);
}

// Only files inside the asset folder may be served. A request for /../package.json, an
// absolute path, an encoded separator or a null byte is refused rather than normalised
// into something outside it.
function isSafeAssetPath(urlPath, rootDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || '/'));
  } catch (error) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  if (!relative) return path.join(rootDir, 'index.html');
  if (relative.includes('..') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return null;
  const resolved = path.resolve(rootDir, relative);
  const root = path.resolve(rootDir) + path.sep;
  if (resolved !== path.resolve(rootDir, 'index.html') && !resolved.startsWith(root)) return null;
  return resolved;
}

function acceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

// One text or binary frame, server to client (unmasked, as the RFC requires).
function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

// Reads as many complete frames as the buffer holds. Client frames are masked, so the
// payload is unmasked here. Fragmented messages are refused (this protocol sends one
// small JSON message at a time) instead of being silently joined.
function parseFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) === 0x80;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let headerBytes = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerBytes = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('message-too-large');
      length = Number(big);
      headerBytes = 10;
    }
    if (length > MAX_MESSAGE_BYTES) throw new Error('message-too-large');
    const maskBytes = masked ? 4 : 0;
    if (buffer.length - offset < headerBytes + maskBytes + length) break;
    if (!masked) throw new Error('client-frame-unmasked');
    if (!fin) throw new Error('fragmented-message');
    const mask = buffer.subarray(offset + headerBytes, offset + headerBytes + 4);
    const payload = Buffer.from(buffer.subarray(
      offset + headerBytes + maskBytes,
      offset + headerBytes + maskBytes + length,
    ));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    messages.push({ opcode, payload });
    offset += headerBytes + maskBytes + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

function normaliseApps(apps) {
  return (Array.isArray(apps) ? apps : []).map((app) => ({
    id: app.id,
    name: app.name || 'App',
    status: app.status || 'Unknown',
    running: app.status === 'Running' || app.status === 'Displaying',
    note: app.statusNote || '',
  }));
}

function createCompanionServer({
  rootDir,
  version = '0.0.0',
  channel = 'stable',
  productName = 'RunContainer',
  apps = () => [],
  logger = () => {},
  now = () => Date.now(),
} = {}) {
  let server = null;
  let port = 0;
  let pairingCode = null;
  let pairingExpires = 0;
  let pairingAttempts = 0;
  const sockets = new Map(); // socket -> { tokenHash, device, watching, send }
  const sessions = [];
  let persistTokens = () => {};
  let storedTokens = [];

  function setTokens(tokens) {
    storedTokens = Array.isArray(tokens) ? tokens.filter((entry) => entry && entry.hash) : [];
  }
  function onTokensChanged(handler) {
    persistTokens = typeof handler === 'function' ? handler : () => {};
  }

  function issuePairingCode() {
    pairingCode = createPairingCode();
    pairingExpires = now() + PAIRING_WINDOW_MS;
    pairingAttempts = 0;
    return { code: pairingCode, expiresAt: pairingExpires };
  }

  function currentPairingCode() {
    if (!pairingCode || now() > pairingExpires) return null;
    return { code: pairingCode, expiresAt: pairingExpires };
  }

  function hasValidToken(token) {
    return storedTokens.some((entry) => tokensMatch(entry.hash, token));
  }

  // Pairing is the only unauthenticated exchange. A wrong code counts against a small
  // budget, so six digits cannot be walked through in a few minutes.
  function pair({ code, device } = {}) {
    if (pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
      return { ok: false, status: 429, error: 'Too many pairing attempts. Ask for a new code on the PC.' };
    }
    if (!pairingCode || now() > pairingExpires) {
      return { ok: false, status: 410, error: 'That pairing code has expired. Ask for a new one on the PC.' };
    }
    if (!codesMatch(pairingCode, String(code || '').trim())) {
      pairingAttempts += 1;
      return { ok: false, status: 403, error: 'That code is not the one shown on the PC.' };
    }
    const token = createToken();
    const name = String(device || 'iPhone').slice(0, 60) || 'iPhone';
    storedTokens = [...storedTokens.filter((entry) => entry.device !== name), {
      hash: hashToken(token),
      device: name,
      createdAt: new Date(now()).toISOString(),
    }];
    persistTokens(storedTokens);
    // A code is used once: a second person who saw it cannot also pair.
    pairingCode = null;
    pairingExpires = 0;
    return { ok: true, token, device: name };
  }

  function authorised(req) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? hasValidToken(match[1].trim()) : false;
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  function serveAsset(res, filePath) {
    fs.readFile(filePath, (error, data) => {
      if (error) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': type,
        // The companion is replaced with the app, so the phone must not keep an old page
        // that speaks an older protocol.
        'cache-control': 'no-cache',
        'content-length': data.length,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(data);
    });
  }

  function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (error) {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }
    const pathname = url.pathname;

    if (pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (error) { parsed = {}; }
        const result = pair(parsed);
        if (result.ok) {
          logger(`A phone paired as ${result.device}.`);
          sendJson(res, 200, { token: result.token, device: result.device, productName, version, channel });
        } else {
          sendJson(res, result.status, { error: result.error });
        }
      });
      return;
    }

    if (pathname === '/api/state') {
      if (!authorised(req)) {
        sendJson(res, 401, { error: 'This phone is not paired with RunContainer on that PC.' });
        return;
      }
      sendJson(res, 200, {
        productName,
        version,
        channel,
        apps: normaliseApps(apps()),
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const filePath = isSafeAssetPath(pathname, rootDir);
    if (!filePath) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    // A directory request is the page, never a listing.
    serveAsset(res, filePath);
  }

  // A phone may only connect from the page this server served: the browser sends the
  // page's own origin, so a website on another origin cannot silently open a control
  // socket to a PC on the local network.
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // a native client (or a test) sends none
    try {
      const parsed = new URL(origin);
      return parsed.host === req.headers.host;
    } catch (error) {
      return false;
    }
  }

  function attachSocket(socket, token) {
    const record = {
      tokenHash: hashToken(token),
      device: storedTokens.find((entry) => entry.hash === hashToken(token))?.device || 'iPhone',
      watching: null,
    };
    sockets.set(socket, record);

    const send = (payload, opcode) => {
      if (socket.destroyed) return false;
      try {
        socket.write(encodeFrame(payload, opcode));
        return true;
      } catch (error) {
        return false;
      }
    };
    record.send = send;

    send(JSON.stringify({ type: 'hello', productName, version, channel, apps: normaliseApps(apps()) }));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let parsed;
      try {
        parsed = parseFrames(buffer);
      } catch (error) {
        logger(`Companion message refused: ${error.message}`);
        socket.destroy();
        return;
      }
      buffer = parsed.rest;
      for (const message of parsed.messages) {
        if (message.opcode === 0x8) {
          sockets.delete(socket);
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch (error) { /* closing */ }
          socket.end();
          return;
        }
        if (message.opcode === 0x9) {
          send(message.payload, 0xa);
          continue;
        }
        if (message.opcode !== 0x1) continue;
        let payload;
        try {
          payload = JSON.parse(message.payload.toString('utf8'));
        } catch (error) {
          continue;
        }
        if (payload && typeof payload.type === 'string') {
          for (const handler of sessions) {
            try { handler(payload, record, socket); } catch (error) { logger(`Companion handler failed: ${error.message}`); }
          }
        }
      }
    });
    socket.on('error', () => {
      sockets.delete(socket);
    });
    socket.on('close', () => {
      sockets.delete(socket);
      for (const handler of sessions) {
        try { handler({ type: 'socket.closed' }, record, socket); } catch (error) { /* closing */ }
      }
    });
  }

  function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (error) {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!originAllowed(req)) {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') || '';
    if (!hasValidToken(token)) {
      socket.destroy();
      return;
    }
    const key = String(req.headers['sec-websocket-key'] || '');
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ].join('\r\n'));
    if (head && head.length) socket.unshift(head);
    attachSocket(socket, token);
  }

  function broadcast(text) {
    let sent = 0;
    for (const [socket, record] of sockets.entries()) {
      if (!record.send) continue;
      if (record.send(text)) sent += 1;
    }
    return sent;
  }

  function broadcastApps() {
    return broadcast(JSON.stringify({ type: 'apps', apps: normaliseApps(apps()) }));
  }

  function sendFrame(jpeg, meta = {}) {
    if (!Buffer.isBuffer(jpeg) || jpeg.length === 0) return 0;
    let sent = 0;
    for (const record of sockets.values()) {
      if (!record.send) continue;
      if (meta.appId && record.watching !== meta.appId) continue;
      if (record.send(JSON.stringify({
        type: 'view.meta',
        appId: meta.appId,
        width: meta.width,
        height: meta.height,
        sequence: meta.sequence,
      }), 0x1)) {
        if (record.send(jpeg, 0x2)) sent += 1;
      }
    }
    return sent;
  }

  function socketCount() {
    return sockets.size;
  }

  // Which app windows the paired phones are watching right now. The desktop uses this
  // to stop sharing as soon as the last phone leaves, rather than leaving a capture
  // running for nobody.
  function watchingAppIds() {
    const ids = new Set();
    for (const record of sockets.values()) {
      if (record.watching) ids.add(record.watching);
    }
    return [...ids];
  }

  function onSession(handler) {
    sessions.push(handler);
  }

  function start(listenPort = 7878, host = '0.0.0.0') {
    if (server) return Promise.resolve({ port });
    return new Promise((resolve, reject) => {
      const created = http.createServer((req, res) => {
        try {
          handleRequest(req, res);
        } catch (error) {
          logger(`Companion request failed: ${error.message}`);
          try { sendJson(res, 500, { error: 'Server error' }); } catch (writeError) { /* closed */ }
        }
      });
      created.on('upgrade', handleUpgrade);
      created.once('error', (error) => {
        created.removeAllListeners('upgrade');
        reject(error);
      });
      created.listen(listenPort, host, () => {
        server = created;
        port = created.address().port;
        logger(`Companion listening on port ${port}.`);
        resolve({ port });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      for (const socket of sockets.keys()) {
        try { socket.destroy(); } catch (error) { /* already gone */ }
      }
      sockets.clear();
      sessions.length = 0;
      if (!server) {
        resolve();
        return;
      }
      const closing = server;
      server = null;
      port = 0;
      closing.close(() => resolve());
      // keep-alive sockets would otherwise hold the port open after close()
      try { closing.closeAllConnections?.(); } catch (error) { /* older Node */ }
    });
  }

  return {
    start,
    stop,
    pair,
    issuePairingCode,
    currentPairingCode,
    setTokens,
    onTokensChanged,
    hasValidToken,
    broadcast,
    broadcastApps,
    sendFrame,
    socketCount,
    watchingAppIds,
    onSession,
    get port() { return port; },
    get listening() { return Boolean(server); },
  };
}

module.exports = {
  createCompanionServer,
  createPairingCode,
  codesMatch,
  createToken,
  hashToken,
  tokensMatch,
  isSafeAssetPath,
  acceptKey,
  encodeFrame,
  parseFrames,
  normaliseApps,
  PAIRING_WINDOW_MS,
  MAX_PAIRING_ATTEMPTS,
  MAX_MESSAGE_BYTES,
};
