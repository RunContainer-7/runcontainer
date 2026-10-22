const fs = require('fs');
const os = require('os');
const path = require('path');

const telemetry = require('./telemetryLogger');

const ANOMALY = {
  id: 'app-1',
  name: 'Editor',
  rule: 'FATAL_LOG',
  title: 'App failed to start',
  detail: 'The live log shows a fatal startup error.',
  snippet: 'C:\\Users\\arish\\AppData\\Local\\Temp\\app.exe: VCRUNTIME140.dll was not found (user arish, host DESKTOP-1, 10.0.0.7, arish@example.com)',
  trigger: 'missing-runtime',
};

describe('anonymised telemetry manifests', () => {
  it('strips paths, usernames, hosts, IPs and e-mail addresses', () => {
    const text = telemetry.anonymizeText(ANOMALY.snippet, { username: 'arish', hostname: 'DESKTOP-1' });
    expect(text).toContain('VCRUNTIME140.dll was not found');
    expect(text).not.toContain('C:\\');
    expect(text).not.toContain('arish');
    expect(text).not.toContain('DESKTOP-1');
    expect(text).not.toContain('10.0.0.7');
    expect(text).not.toContain('arish@example.com');
    expect(text).toContain('<path>');
    expect(text).toContain('<user>');
  });

  it('builds the four-part manifest the registry expects', () => {
    const manifest = telemetry.buildAnomalyManifest({
      anomaly: ANOMALY,
      appRecord: { id: 'app-1', name: 'Editor' },
      resolution: { action: 'restart', outcome: 'repaired', detail: 'App restarted with a clean profile.' },
      appVersion: '0.6.5',
      platform: 'win32',
      now: new Date('2026-10-22T12:00:00.000Z'),
      username: 'arish',
      hostname: 'DESKTOP-1',
    });
    expect(manifest.schema).toBe(telemetry.SCHEMA);
    expect(manifest.event).toBe('behavioural-anomaly');
    expect(manifest.target.app).toBe('Editor');
    expect(manifest.trigger.rule).toBe('FATAL_LOG');
    expect(manifest.trigger.logSnippet).not.toContain('arish');
    expect(manifest.diagnosis.title).toBe('App failed to start');
    expect(manifest.resolution).toEqual({ action: 'restart', outcome: 'repaired', detail: 'App restarted with a clean profile.' });
    expect(manifest.capturedAt).toBe('2026-10-22T12:00:00.000Z');
  });
});

describe('telemetry delivery', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-telemetry-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends a JSON POST through fetch and empties the queue', async () => {
    const calls = [];
    const logger = telemetry.createTelemetryLogger({
      userDataDir: dir,
      appVersion: '0.6.5',
      endpoint: 'https://registry.example.com/anomalies',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 202 };
      },
    });
    const result = await logger.recordHandled({ anomaly: ANOMALY, appRecord: { name: 'Editor' }, resolution: { action: 'restart', outcome: 'repaired' } });
    expect(result.delivered).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://registry.example.com/anomalies');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.headers['X-RunContainer-Event']).toBe('behavioural-anomaly');
    expect(JSON.parse(calls[0].options.body).trigger.rule).toBe('FATAL_LOG');
    expect(logger.pending()).toBe(0);
  });

  it('keeps a manifest when delivery fails and sends it on the next attempt', async () => {
    let online = false;
    const logger = telemetry.createTelemetryLogger({
      userDataDir: dir,
      endpoint: 'https://registry.example.com/anomalies',
      logger: () => {},
      fetchImpl: async () => (online ? { ok: true, status: 200 } : { ok: false, status: 503 }),
    });
    await logger.recordHandled({ anomaly: ANOMALY, appRecord: { name: 'Editor' }, resolution: { action: 'restart', outcome: 'repaired' } });
    expect(logger.pending()).toBe(1);
    online = true;
    const flushed = await logger.flush();
    expect(flushed.delivered).toBe(1);
    expect(logger.pending()).toBe(0);
  });

  it('stores nothing when no registry endpoint is configured', async () => {
    const logger = telemetry.createTelemetryLogger({
      userDataDir: dir,
      endpoint: null,
      fetchImpl: async () => {
        throw new Error('must not be called');
      },
    });
    const result = await logger.recordHandled({ anomaly: ANOMALY, appRecord: { name: 'Editor' }, resolution: { action: 'restart', outcome: 'repaired' } });
    expect(result.reason).toBe('not-configured');
    expect(fs.existsSync(telemetry.queuePath(dir))).toBe(false);
  });

  it('only accepts an https endpoint', () => {
    expect(telemetry.resolveTelemetryEndpoint({ RUNCONTAINER_TELEMETRY_ENDPOINT: 'http://registry.example.com' })).toBeNull();
    expect(telemetry.resolveTelemetryEndpoint({ RUNCONTAINER_TELEMETRY_ENDPOINT: 'https://registry.example.com/hook' }))
      .toBe('https://registry.example.com/hook');
  });
});
