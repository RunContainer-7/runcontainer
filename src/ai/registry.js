// Model registry: which RC-Brain artefact is active, how a candidate is gated,
// and how rollback works. Used by scripts/promote-model.js, the release check,
// and tests. Nothing here trains a model or edits weights.

const fs = require('fs');
const path = require('path');
const { FEATURE_NAMES } = require('./features');

const MODEL_DIR = path.join(__dirname, 'model');
const SCHEMA = 'runcontainer.brain.v2';
const GATES = {
  familiarAccuracy: 0.9,
  unseenAccuracy: 0.8,
  finalAccuracy: 0.75,
  falsePositiveRate: 0.05,
};

function registryPath(dir = MODEL_DIR) {
  return path.join(dir, 'registry.json');
}

function readRegistry(dir = MODEL_DIR) {
  try {
    return JSON.parse(fs.readFileSync(registryPath(dir), 'utf8'));
  } catch (error) {
    return { schema: 'runcontainer.brain.registry.v1', current: 'rc-brain-2.json', previous: null, history: [] };
  }
}

function writeRegistry(registry, dir = MODEL_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(dir), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function inspect(file, dir = MODEL_DIR) {
  const full = path.join(dir, path.basename(file));
  if (!fs.existsSync(full)) return { ok: false, errors: [`${file} does not exist`] };
  let artefact;
  try {
    artefact = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`${file} is not valid JSON`] };
  }
  const errors = [];
  if (artefact.schema !== SCHEMA) errors.push(`schema is ${artefact.schema || 'missing'}, expected ${SCHEMA}`);
  if (!Array.isArray(artefact.featureSchema) || artefact.featureSchema.length !== FEATURE_NAMES.length) {
    errors.push('feature schema does not match this build');
  } else if (artefact.featureSchema.some((name, index) => name !== FEATURE_NAMES[index])) {
    errors.push('feature schema order does not match this build');
  }
  const evaluation = artefact.evaluation || {};
  const familiar = evaluation.familiar || {};
  const unseen = evaluation.unseen || {};
  const ambiguous = evaluation.ambiguous || {};
  const finalSplit = evaluation.final || {};
  const corpus = artefact.corpus || {};
  if (Number(familiar.diagnosisAccuracy) < GATES.familiarAccuracy) errors.push('familiar diagnosis accuracy below 90%');
  if (Number(unseen.diagnosisAccuracy) < GATES.unseenAccuracy) errors.push('unseen-family accuracy below 80%');
  if (Number(familiar.falsePositiveRate) > GATES.falsePositiveRate) errors.push('false positives above 5%');
  if (Number(ambiguous.unsafeActions) > 0 || Number(finalSplit.unsafeActions) > 0) errors.push('unsafe actions recorded in evaluation');
  if (Number(ambiguous.overInterventions) > 0) errors.push('a repair was proposed on a restraint case');
  if (Number(finalSplit.diagnosisAccuracy) < GATES.finalAccuracy) errors.push('final untouched accuracy below 75%');
  if (Number(corpus.trainHoldoutLeakage) > 0) errors.push('training/holdout leakage detected');
  if (Number(corpus.labelConflicts) > 0) errors.push('label conflicts in the corpus');
  const headline = (entry) => (entry.headline || {
    diagnosisAccuracyPct: Number((Number(entry.diagnosisAccuracy || 0) * 100).toFixed(1)),
  });
  return {
    ok: errors.length === 0,
    errors,
    file: path.basename(full),
    id: artefact.id,
    version: artefact.version,
    parameters: artefact.parameterCount,
    evaluation: {
      familiar: headline(familiar),
      unseen: headline(unseen),
      final: headline(finalSplit),
    },
  };
}

function activate(file, dir = MODEL_DIR) {
  const report = inspect(file, dir);
  if (!report.ok) return { activated: false, report };
  const registry = readRegistry(dir);
  const previous = registry.current && path.basename(registry.current) !== report.file ? registry.current : registry.previous;
  const updated = {
    ...registry,
    schema: 'runcontainer.brain.registry.v1',
    previous: previous || null,
    current: report.file,
    updatedAt: new Date().toISOString(),
    history: [
      ...(registry.history || []).filter((entry) => entry.file !== report.file),
      { file: report.file, id: report.id, version: report.version, parameters: report.parameters, status: 'active', activatedAt: new Date().toISOString(), source: 'promote-model' },
    ].slice(-10),
  };
  writeRegistry(updated, dir);
  return { activated: true, registry: updated, report };
}

function rollback(dir = MODEL_DIR) {
  const registry = readRegistry(dir);
  if (!registry.previous) return { rolledBack: false, reason: 'no previous model recorded' };
  const report = inspect(registry.previous, dir);
  if (!report.ok) {
    return { rolledBack: false, reason: `previous model is not loadable: ${report.errors.join('; ')}` };
  }
  const updated = {
    ...registry,
    current: registry.previous,
    previous: registry.current,
    updatedAt: new Date().toISOString(),
    history: [
      ...(registry.history || []),
      { file: registry.previous, id: report.id, version: report.version, status: 'active', activatedAt: new Date().toISOString(), source: 'rollback' },
    ].slice(-10),
  };
  writeRegistry(updated, dir);
  return { rolledBack: true, registry: updated, report };
}

module.exports = {
  MODEL_DIR,
  REGISTRY: registryPath(),
  SCHEMA,
  GATES,
  registryPath,
  readRegistry,
  writeRegistry,
  inspect,
  activate,
  rollback,
};
