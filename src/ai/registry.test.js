const fs = require('fs');
const os = require('os');
const path = require('path');
const { FEATURE_NAMES } = require('./features');
const { readRegistry, writeRegistry, inspect, activate, rollback } = require('./registry');

function artefact(overrides = {}) {
  return {
    schema: 'runcontainer.brain.v2',
    id: 'rc-brain-2-candidate',
    version: '2.0.1',
    parameterCount: 8334,
    featureSchema: FEATURE_NAMES,
    corpus: { trainHoldoutLeakage: 0, labelConflicts: 0 },
    evaluation: {
      familiar: { diagnosisAccuracy: 0.99, falsePositiveRate: 0.0 },
      unseen: { diagnosisAccuracy: 0.96 },
      ambiguous: { unsafeActions: 0, overInterventions: 0 },
      final: { diagnosisAccuracy: 0.95, unsafeActions: 0 },
    },
    ...overrides,
  };
}

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-registry-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(contents), 'utf8');
  }
  return dir;
}

describe('RC-Brain model registry', () => {
  it('activates a candidate that passes the gates and keeps the old model for rollback', () => {
    const dir = tempDir({ 'rc-brain-2.json': artefact({ id: 'rc-brain-2' }), 'candidate.json': artefact() });
    writeRegistry({ schema: 'runcontainer.brain.registry.v1', current: 'rc-brain-2.json', previous: null, history: [] }, dir);
    const result = activate('candidate.json', dir);
    expect(result.activated).toBe(true);
    expect(readRegistry(dir).current).toBe('candidate.json');
    expect(readRegistry(dir).previous).toBe('rc-brain-2.json');
    expect(fs.existsSync(path.join(dir, 'rc-brain-2.json'))).toBe(true);
  });

  it('refuses a candidate that misses a gate', () => {
    const dir = tempDir({
      'rc-brain-2.json': artefact({ id: 'rc-brain-2' }),
      'bad.json': artefact({ evaluation: { familiar: { diagnosisAccuracy: 0.5, falsePositiveRate: 0 }, unseen: { diagnosisAccuracy: 0.4 }, ambiguous: { unsafeActions: 0, overInterventions: 0 }, final: { diagnosisAccuracy: 0.5, unsafeActions: 0 } } }),
    });
    writeRegistry({ schema: 'runcontainer.brain.registry.v1', current: 'rc-brain-2.json', previous: null, history: [] }, dir);
    const result = activate('bad.json', dir);
    expect(result.activated).toBe(false);
    expect(result.report.errors.length).toBeGreaterThan(0);
    expect(readRegistry(dir).current).toBe('rc-brain-2.json');
  });

  it('refuses a candidate trained with a different feature schema', () => {
    const dir = tempDir({ 'wrong.json': artefact({ featureSchema: ['a', 'b'] }) });
    expect(inspect('wrong.json', dir).ok).toBe(false);
    expect(inspect('wrong.json', dir).errors.join(' ')).toContain('feature schema');
  });

  it('rolls back to the previous model and can roll forward again', () => {
    const dir = tempDir({ 'rc-brain-2.json': artefact({ id: 'rc-brain-2' }), 'candidate.json': artefact() });
    writeRegistry({ schema: 'runcontainer.brain.registry.v1', current: 'rc-brain-2.json', previous: null, history: [] }, dir);
    activate('candidate.json', dir);
    const back = rollback(dir);
    expect(back.rolledBack).toBe(true);
    expect(readRegistry(dir).current).toBe('rc-brain-2.json');
    expect(readRegistry(dir).previous).toBe('candidate.json');
    const forward = rollback(dir);
    expect(forward.rolledBack).toBe(true);
    expect(readRegistry(dir).current).toBe('candidate.json');
  });

  it('reports that there is nothing to roll back to', () => {
    const dir = tempDir({ 'rc-brain-2.json': artefact() });
    writeRegistry({ schema: 'runcontainer.brain.registry.v1', current: 'rc-brain-2.json', previous: null, history: [] }, dir);
    expect(rollback(dir).rolledBack).toBe(false);
  });
});
