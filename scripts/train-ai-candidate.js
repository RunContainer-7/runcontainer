// Candidate training from promoted, verified experiences.
//
//   node scripts/train-ai-candidate.js --check [path/to/rc-brain-curated.json]
//   node scripts/train-ai-candidate.js --train [path]
//   node scripts/train-ai-candidate.js --train --activate
//
// --check validates the curated file only (no training): schema, label ranges,
// feature width, duplicates and conflicting labels. It is what the app calls
// before offering "review and train", and what CI runs.
//
// --train re-runs the full training pipeline with the curated examples added to
// the fit set, writes rc-brain-2-candidate.json, and leaves the active model
// untouched. --activate then applies scripts/promote-model.js, which re-checks
// every gate. Training is offline and local; nothing leaves the machine.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FEATURE_NAMES } = require('../src/ai/features');
const knowledge = require('../src/ai/knowledge.json');
const { CURATED_SCHEMA } = require('../src/ai/experiences');
const { inspect, activate } = require('./promote-model');

const ROOT = path.join(__dirname, '..');
const MIN_EXAMPLES = 20;
const DIAGNOSES = new Set(knowledge.diagnoses.map((entry) => entry.id));
const ACTIONS = new Set(knowledge.actions.map((entry) => entry.id));

function validate(curatedFile) {
  const errors = [];
  if (!curatedFile) return { ok: false, errors: ['No curated dataset path given.'] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(curatedFile, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`Could not read ${curatedFile}: ${error.message}`] };
  }
  if (raw?.schema !== CURATED_SCHEMA) errors.push(`schema is ${raw?.schema || 'missing'}, expected ${CURATED_SCHEMA}`);
  if (raw?.consent !== true) errors.push('the dataset was not promoted with explicit consent');
  const examples = Array.isArray(raw?.examples) ? raw.examples : [];
  if (examples.length < MIN_EXAMPLES) errors.push(`only ${examples.length} verified examples; at least ${MIN_EXAMPLES} are needed`);
  const keys = new Set();
  const labelByKey = new Map();
  let conflicts = 0;
  let duplicates = 0;
  for (const [index, example] of examples.entries()) {
    if (!Array.isArray(example.features) || example.features.length !== FEATURE_NAMES.length) {
      errors.push(`example ${index} does not have ${FEATURE_NAMES.length} features`);
      continue;
    }
    if (example.features.some((value) => !Number.isFinite(Number(value)))) {
      errors.push(`example ${index} contains a non-numeric feature`);
    }
    if (!DIAGNOSES.has(example.diagnosis)) errors.push(`example ${index} has unknown diagnosis ${example.diagnosis}`);
    if (!ACTIONS.has(example.action)) errors.push(`example ${index} has unknown action ${example.action}`);
    const key = example.featuresBucket || example.features.map((value) => Math.round(Number(value) * 100)).join(',');
    if (keys.has(key)) duplicates += 1;
    keys.add(key);
    const label = `${example.diagnosis}/${example.action}`;
    const existing = labelByKey.get(key);
    if (existing && existing !== label) {
      conflicts += 1;
      if (conflicts <= 5) errors.push(`conflicting labels for identical evidence in example ${index}: ${existing} vs ${label}`);
    }
    labelByKey.set(key, label);
  }
  if (duplicates > 0) errors.push(`${duplicates} duplicate feature vectors in the curated set`);
  return {
    ok: errors.length === 0,
    errors,
    examples: examples.length,
    duplicates,
    conflicts,
    minExamples: MIN_EXAMPLES,
    examplesBySource: examples.reduce((counts, example) => {
      const key = example.source || 'unknown';
      return { ...counts, [key]: (counts[key] || 0) + 1 };
    }, {}),
  };
}

function train(curatedFile) {
  const validation = validate(curatedFile);
  if (!validation.ok) return { trained: false, validation };
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'train-ai-brain.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RC_BRAIN_CANDIDATE: '1',
      RC_BRAIN_CURATED: path.resolve(curatedFile),
    },
    stdio: 'inherit',
  });
  const candidateFile = 'rc-brain-2-candidate.json';
  const report = inspect(candidateFile);
  return {
    trained: result.status === 0 && report.ok,
    exitCode: result.status,
    validation,
    candidate: report,
    next: report.ok
      ? `node scripts/promote-model.js --activate ${candidateFile}`
      : 'The candidate did not pass its gates; the active model was not changed.',
  };
}

function main(argv) {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const file = positional[0];
  if (!file) {
    console.error('Give a curated dataset path (for example the app userData/rc-brain-curated.json).');
    process.exit(2);
  }
  if (flags.includes('--train')) {
    const result = train(file);
    console.log(JSON.stringify(result, null, 2));
    if (!result.trained) process.exit(1);
    if (flags.includes('--activate')) {
      const activation = activate('rc-brain-2-candidate.json');
      console.log(JSON.stringify(activation, null, 2));
      process.exit(activation.activated ? 0 : 1);
    }
    return;
  }
  const validation = validate(file);
  console.log(JSON.stringify(validation, null, 2));
  process.exit(validation.ok ? 0 : 1);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { validate, train, MIN_EXAMPLES };
