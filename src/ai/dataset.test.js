const { generateDataset, FAMILIES, UNSEEN_FAMILIES, featureKey } = require('./dataset');
const { FEATURE_NAMES } = require('./features');

describe('RC-Brain corpus', () => {
  const corpus = generateDataset();

  it('records provenance and grounded evidence for every family', () => {
    for (const family of [...FAMILIES, ...UNSEEN_FAMILIES]) {
      expect(typeof family.basis).toBe('string');
      expect(family.basis.length).toBeGreaterThan(20);
    }
  });

  it('is deterministic', () => {
    const again = generateDataset();
    expect(again.audit.rows).toBe(corpus.audit.rows);
    expect(JSON.stringify(again.train[0].features)).toBe(JSON.stringify(corpus.train[0].features));
  });

  it('has no duplicate feature vectors or label conflicts across splits', () => {
    expect(corpus.audit.exactDuplicates).toBe(0);
    expect(corpus.audit.labelConflicts).toBe(0);
    expect(corpus.audit.trainHoldoutLeakage).toBe(0);
    expect(corpus.audit.distinctFeatureVectors).toBe(corpus.audit.rows);
  });

  it('keeps whole failure families out of training', () => {
    const trained = new Set(corpus.train.map((row) => row.family));
    const unseen = new Set(corpus.unseen.map((row) => row.family));
    expect(unseen.size).toBeGreaterThanOrEqual(6);
    for (const family of unseen) expect(trained.has(family)).toBe(false);
    expect(corpus.audit.unseenFamilyOverlap).toEqual([]);
  });

  it('covers restraint cases where acting would be wrong', () => {
    const actions = new Set(corpus.ambiguous.map((row) => row.action));
    expect(actions.has('observe')).toBe(true);
    expect(actions.has('escalate')).toBe(true);
    expect(actions.has('wait')).toBe(true);
    for (const row of corpus.ambiguous) {
      expect(['none', 'wait', 'observe', 'escalate']).toContain(row.action);
    }
  });

  it('uses the same feature width as the shipped schema', () => {
    for (const row of [...corpus.train, ...corpus.final]) {
      expect(row.features).toHaveLength(FEATURE_NAMES.length);
    }
  });

  it('keeps the final split disjoint from training by construction', () => {
    const trainKeys = new Set(corpus.train.map((row) => featureKey(row.features)));
    expect(corpus.final.every((row) => !trainKeys.has(featureKey(row.features)))).toBe(true);
  });

  it('includes misleading healthy cases and contradictory evidence in training', () => {
    const families = new Set(corpus.train.map((row) => row.family));
    expect(families.has('healthy_error_word')).toBe(true);
    expect(families.has('healthy_repeated_lines')).toBe(true);
    expect(families.has('contradiction_engine_vs_window')).toBe(true);
    expect(families.has('user_data_risk')).toBe(true);
  });
});
