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
    // Last resort only, for a build whose registry file is missing entirely: the
    // newest shipped artefact is what the app would load in that case.
    return { schema: 'runcontainer.brain.registry.v1', current: 'rc-brain-4.json', previous: null, history: [] };
  }
}

function writeRegistry(registry, dir = MODEL_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(dir), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

// A model trained before this build grew new features still loads (see
// engine.featurePrefixOf), so a rollback target with an older, shorter schema is
// loadable and therefore valid. A model being PROMOTED is different: the shipped
// artefact must be trained on this build's whole feature schema, or the monitor
// would be running blind on the newest evidence it collects. `requireFullSchema`
// draws that line.
function schemaVerdict(artefact, requireFullSchema) {
  const names = artefact.featureSchema;
  if (!Array.isArray(names) || names.length === 0) return 'feature schema is missing';
  if (names.length > FEATURE_NAMES.length) return 'feature schema is longer than this build\u2019s';
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== FEATURE_NAMES[index]) return 'feature schema order does not match this build';
  }
  if (requireFullSchema && names.length !== FEATURE_NAMES.length) {
    return `feature schema covers ${names.length} of this build's ${FEATURE_NAMES.length} features`;
  }
  return null;
}

function inspect(file, dir = MODEL_DIR, { requireFullSchema = false } = {}) {
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
  const schemaProblem = schemaVerdict(artefact, requireFullSchema);
  if (schemaProblem) errors.push(schemaProblem);
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
    features: Array.isArray(artefact.featureSchema) ? artefact.featureSchema.length : 0,
    featureSchemaPrefix: Array.isArray(artefact.featureSchema) && artefact.featureSchema.length < FEATURE_NAMES.length,
    evaluation: {
      familiar: headline(familiar),
      unseen: headline(unseen),
      final: headline(finalSplit),
    },
  };
}

function activate(file, dir = MODEL_DIR) {
  const report = inspect(file, dir, { requireFullSchema: true });
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
  schemaVerdict,
  inspect,
  activate,
  rollback,
};
