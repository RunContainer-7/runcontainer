// Anomaly telemetry: a small, private, opt-in delivery path for the behavioural
// monitor. It is deliberately boring and fail-open: nothing here can block a
// launch or surface a dialog.
//
// What is sent (only when a registry endpoint is configured by the build owner
// through RUNCONTAINER_TELEMETRY_ENDPOINT):
//   - the app's display name,
//   - the rule that fired and a short, scrubbed log snippet,
//   - the diagnosis the monitor produced,
//   - the resolution the user chose and whether it worked.
// What is never sent: file paths, the user or machine name, IP addresses,
// e-mail addresses, environment variables, or anything from outside the app's
// own log tail.
//
// Delivery uses the standard asynchronous fetch API and a durable queue, so an
// offline machine keeps the manifest until the next attempt. With no endpoint
// configured the logger stores nothing at all.

const fs = require('fs');
const os = require('os');
const path = require('path');

const QUEUE_FILE = 'runcontainer-telemetry-queue.jsonl';
const MAX_QUEUE = 20;
const MAX_SNIPPET = 280;
const SEND_TIMEOUT_MS = 8000;
const SCHEMA = 'runcontainer.behavior.v1';

function resolveTelemetryEndpoint(env = process.env) {
  const raw = String(env.RUNCONTAINER_TELEMETRY_ENDPOINT || '').trim();
  if (!raw) return null;
  // Only HTTPS endpoints are accepted; a mistyped value must not silently send
  // plaintext reports somewhere.
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch (error) {
    return null;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Removes the things that identify a person or a machine while keeping the
// failure readable. Order matters: paths before bare usernames, so a path is a
// single <path> token rather than a partially substituted string.
function anonymizeText(value, { username = '', hostname = '', maxLength = MAX_SNIPPET } = {}) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(/[A-Za-z]:\\(?:[^\\\s"']+\\?)+/g, '<path>');
  text = text.replace(/\\\\[^\\\s"']+\\[^\s"']+/g, '<path>');
  text = text.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>');
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
  text = text.replace(/https?:\/\/\S+/gi, '<url>');
  if (username) text = text.replace(new RegExp(escapeRegExp(username), 'gi'), '<user>');
  if (hostname) text = text.replace(new RegExp(escapeRegExp(hostname), 'gi'), '<host>');
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text;
}

function buildAnomalyManifest({
  anomaly,
  appRecord,
  resolution,
  appVersion = '',
  platform = process.platform,
  now = new Date(),
  username = '',
  hostname = '',
}) {
  return {
    schema: SCHEMA,
    event: 'behavioural-anomaly',
    capturedAt: now.toISOString(),
    source: {
      app: 'RunContainer',
      version: String(appVersion || ''),
      platform,
    },
    target: {
      app: anonymizeText(appRecord?.name || anomaly?.name || 'Unknown app', { username, hostname, maxLength: 120 }),
    },
    trigger: {
      rule: String(anomaly?.rule || 'UNKNOWN'),
      detail: anonymizeText(anomaly?.trigger || anomaly?.detail || '', { username, hostname }),
      logSnippet: anonymizeText(anomaly?.snippet || '', { username, hostname }),
    },
    diagnosis: {
      title: anonymizeText(anomaly?.title || 'Unknown anomaly', { username, hostname, maxLength: 120 }),
      confidence: Number.isFinite(Number(anomaly?.confidence)) ? Number(anomaly.confidence) : null,
    },
    resolution: {
      action: String(resolution?.action || 'none'),
      outcome: String(resolution?.outcome || 'unknown'),
      detail: anonymizeText(resolution?.detail || '', { username, hostname }),
    },
  };
}

function queuePath(userDataDir) {
  return path.join(userDataDir, QUEUE_FILE);
}

function readQueue(userDataDir) {
  try {
    return fs.readFileSync(queuePath(userDataDir), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (error) { return null; }
      })
      .filter(Boolean)
      .slice(-MAX_QUEUE);
  } catch (error) {
    return [];
  }
}

function writeQueue(userDataDir, entries) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const trimmed = entries.slice(-MAX_QUEUE);
    fs.writeFileSync(queuePath(userDataDir), trimmed.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
  } catch (error) {
    // A full or read-only profile must not affect the app.
  }
}

async function postJson(endpoint, manifest, { fetchImpl, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  const body = JSON.stringify(manifest);
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (doFetch) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RunContainer-Event': 'behavioural-anomaly',
        },
        body,
        signal: controller ? controller.signal : undefined,
      });
      return { delivered: Boolean(response && response.ok), status: response ? response.status : null };
    } catch (error) {
      return { delivered: false, status: null, reason: error?.message || 'send failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Node without global fetch: a plain HTTPS POST with the same payload.
  const https = require('https');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = https.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-RunContainer-Event': 'behavioural-anomaly',
      },
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      finish({ delivered: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300, status: response.statusCode });
    });
    request.on('timeout', () => request.destroy(new Error('telemetry send timed out')));
    request.on('error', (error) => finish({ delivered: false, reason: error.message }));
    request.end(body);
  });
}

function createTelemetryLogger({
  userDataDir,
  appVersion = '',
  endpoint = resolveTelemetryEndpoint(),
  fetchImpl,
  logger = () => {},
  now = () => new Date(),
  platform = process.platform,
} = {}) {
  const resolvedEndpoint = endpoint || null;
  let flushing = null;

  async function flush() {
    if (!resolvedEndpoint || !userDataDir) return { delivered: 0, pending: 0, reason: 'not-configured' };
    if (flushing) return flushing;
    flushing = (async () => {
      const pending = readQueue(userDataDir);
      if (pending.length === 0) return { delivered: 0, pending: 0 };
      const remaining = [];
      let delivered = 0;
      for (const manifest of pending) {
        const result = await postJson(resolvedEndpoint, manifest, { fetchImpl });
        if (result.delivered) {
          delivered += 1;
        } else {
          remaining.push(manifest);
          logger(`Behavioural telemetry kept for a later attempt: ${result.reason || `HTTP ${result.status}`}`);
        }
      }
      writeQueue(userDataDir, remaining);
      return { delivered, pending: remaining.length };
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // Called after an anomaly was handled. Sending is fire-and-forget; callers
  // never await it and a failure only appends a line to the app log.
  function recordHandled({ anomaly, appRecord, resolution }) {
    if (!resolvedEndpoint || !userDataDir) {
      return Promise.resolve({ delivered: false, reason: 'not-configured' });
    }
    const manifest = buildAnomalyManifest({
      anomaly,
      appRecord,
      resolution,
      appVersion,
      platform,
      now: now(),
      username: os.userInfo().username,
      hostname: os.hostname(),
    });
    writeQueue(userDataDir, [...readQueue(userDataDir), manifest]);
    return flush().catch((error) => ({ delivered: 0, reason: error.message }));
  }

  return {
    endpoint: resolvedEndpoint,
    enabled: Boolean(resolvedEndpoint),
    recordHandled,
    flush,
    pending: () => (userDataDir ? readQueue(userDataDir).length : 0),
  };
}

module.exports = {
  SCHEMA,
  QUEUE_FILE,
  MAX_QUEUE,
  MAX_SNIPPET,
  resolveTelemetryEndpoint,
  anonymizeText,
  buildAnomalyManifest,
  createTelemetryLogger,
  postJson,
  queuePath,
  readQueue,
  writeQueue,
};
