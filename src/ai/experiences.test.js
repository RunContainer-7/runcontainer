const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExperienceStore, scrubText, CURATED_SCHEMA } = require('./experiences');

function observation(overrides = {}) {
  return {
    app: { name: 'Editor', engine: 'rcvm', status: 'Running' },
    process: { windowExpected: true, windowVisible: false, hung: false, cpuPercent: 5, engineResponsive: true },
    logLines: ['Access is denied for C:\\Users\\alice\\AppData\\secret.txt', 'mail bob@example.com from 10.0.0.7'],
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    model: { id: 'rc-brain-2', version: '2.0.0' },
    diagnosis: { id: 'permission_denied', confidence: 0.93 },
    action: { id: 'repair_permissions', requiresApproval: false },
    reason: 'The app cannot write to its own folder under C:\\Users\\alice.',
    evidence: ['the log reports access denied', 'machine DESKTOP-ABC'],
    features: Array.from({ length: 65 }, (_value, index) => (index % 5) / 5),
    ...overrides,
  };
}

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-exp-'));
  return {
    dir,
    store: createExperienceStore({ dir, username: 'alice', hostname: 'DESKTOP-ABC', now: () => 1700000000000 }),
  };
}

describe('RC-Brain experiences', () => {
  it('redacts paths, users, hosts, e-mail addresses and IPs', () => {
    const text = scrubText('C:\\Users\\alice\\secret.txt bob@example.com 10.0.0.7 DESKTOP-ABC alice', { username: 'alice', hostname: 'DESKTOP-ABC' });
    expect(text).not.toContain('alice');
    expect(text).not.toContain('DESKTOP-ABC');
    expect(text).not.toContain('bob@example.com');
    expect(text).not.toContain('10.0.0.7');
    expect(text).toContain('<path>');
  });

  it('stores a sanitised entry with locked labels until verification', () => {
    const { store: experiences } = store();
    const result = experiences.record({
      observation: observation(),
      decision: decision(),
      execution: { performed: true, completed: true },
      verification: { status: 'verified', checks: [{ name: 'access-restored', ok: true }], observedChecks: 3 },
      outcome: 'success',
    });
    expect(result.stored).toBe(true);
    expect(result.entry.labelsLocked).toBe(false);
    expect(result.entry.untrustedLogContent).toBe(true);
    const serialised = JSON.stringify(result.entry);
    expect(serialised).not.toContain('alice');
    expect(serialised).not.toContain('DESKTOP-ABC');
    expect(serialised).not.toContain('10.0.0.7');
  });

  it('rejects labels outside the model catalogue', () => {
    const { store: experiences } = store();
    const result = experiences.record({ observation: observation(), decision: decision({ diagnosis: { id: 'made_up' } }) });
    expect(result.stored).toBe(false);
    expect(result.reason).toBe('unknown-label');
  });

  it('does not turn unverified successes into training examples', () => {
    const { store: experiences } = store();
    experiences.record({
      observation: observation(),
      decision: decision(),
      execution: { performed: true, completed: true },
      verification: { status: 'inconclusive', checks: [] },
      outcome: 'inconclusive',
    });
    const stats = experiences.stats();
    expect(stats.verified).toBe(0);
    expect(stats.inconclusive).toBe(1);
    expect(experiences.promote(experiences.all().map((entry) => entry.id), { consent: true }).promoted).toBe(0);
  });

  it('requires consent before promotion and deduplicates examples', () => {
    const { dir, store: experiences } = store();
    const record = experiences.record({
      observation: observation(),
      decision: decision(),
      execution: { performed: true, completed: true },
      verification: { status: 'verified', checks: [{ name: 'access-restored', ok: true }], observedChecks: 3 },
      outcome: 'success',
    });
    expect(experiences.promote([record.entry.id], { consent: false }).promoted).toBe(0);
    const promoted = experiences.promote([record.entry.id], { consent: true });
    expect(promoted.promoted).toBe(1);
    const curated = JSON.parse(fs.readFileSync(path.join(dir, 'rc-brain-curated.json'), 'utf8'));
    expect(curated.schema).toBe(CURATED_SCHEMA);
    expect(curated.examples).toHaveLength(1);
    // The same experience cannot be promoted twice.
    expect(experiences.promote([record.entry.id], { consent: true }).promoted).toBe(0);
  });

  it('keeps a user-correction as the label instead of the model prediction', () => {
    const { store: experiences } = store();
    const record = experiences.record({
      observation: observation(),
      decision: decision({ diagnosis: { id: 'window_hang', confidence: 0.8 }, action: { id: 'restart_same_profile' } }),
      execution: { performed: true, completed: true },
      verification: { status: 'verified', checks: [], observedChecks: 3 },
      outcome: 'success',
    });
    const corrected = experiences.correct(record.entry.id, { diagnosis: 'permission_denied', action: 'repair_permissions', note: 'log said access denied' });
    expect(corrected.updated).toBe(true);
    experiences.promote([record.entry.id], { consent: true });
    const curated = experiences.curated();
    expect(curated.examples[0].diagnosis).toBe('permission_denied');
    expect(curated.examples[0].action).toBe('repair_permissions');
  });

  it('retrieves similar verified incidents but keeps them out of the feature vector', () => {
    const { store: experiences } = store();
    experiences.record({
      observation: observation(),
      decision: decision(),
      execution: { performed: true, completed: true },
      verification: { status: 'verified', checks: [], observedChecks: 3 },
      outcome: 'success',
    });
    const similar = experiences.retrieve({ features: decision().features, k: 3 });
    expect(similar).toHaveLength(1);
    expect(similar[0].verified).toBe(true);
    expect(similar[0].diagnosis).toBe('permission_denied');
  });

  it('survives a corrupt store file', () => {
    const { dir, store: experiences } = store();
    fs.writeFileSync(path.join(dir, 'rc-brain-experiences.jsonl'), '{not json\n', 'utf8');
    expect(experiences.list()).toEqual([]);
    expect(experiences.stats().total).toBe(0);
  });
});
