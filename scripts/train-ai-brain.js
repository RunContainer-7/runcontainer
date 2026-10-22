// RC-Brain training pipeline (v2).
//
//   node scripts/train-ai-brain.js
//
// Trains RunContainer's own small neural model from scratch on the scenario
// corpus in src/ai/dataset.js, calibrates it on a slice it never fitted,
// chooses abstention thresholds on that calibration slice only, then evaluates
// once on:
//   - familiar holdout   new variants of trained families
//   - unseen families    whole failure families absent from training
//   - ambiguous          wait / observe / escalate cases
//   - final              a fresh realisation used once for the published report
//
// Outputs:
//   src/ai/model/rc-brain-2.json   weights + schema + metrics
//   src/ai/model/registry.json     which artefact the app loads, plus history
//   reports/ai-evaluation.md       human-readable results, including failures
//
// This is an honest small model: a two-head feed-forward classifier over
// structured observations, not a language model. It cannot read arbitrary log
// text semantically; features.js turns text into signals, and the model learns
// how much each signal matters in context. Its labels are fixed.

const fs = require('fs');
const path = require('path');
const brain = require('brain.js');
const { generateDataset, mulberry32 } = require('../src/ai/dataset');
const { FEATURE_NAMES } = require('../src/ai/features');
const { gateDecision } = require('../src/ai/policy');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE = require('../src/ai/knowledge.json');
const SEED = 20261022;
const MODEL_ID = 'rc-brain-2';
const CANDIDATE = process.env.RC_BRAIN_CANDIDATE === '1';
const MODEL_FILE = CANDIDATE ? `${MODEL_ID}-candidate.json` : `${MODEL_ID}.json`;
const HIDDEN = { diagnosis: [48, 24], action: [32, 16] };
const ITERATIONS = 3000;

const DIAGNOSES = KNOWLEDGE.diagnoses.map((entry) => entry.id);
const ACTIONS = KNOWLEDGE.actions.map((entry) => entry.id);
const ACTION_BY_DIAGNOSIS = Object.fromEntries(KNOWLEDGE.diagnoses.map((entry) => [entry.id, entry.action]));
const ACTION_BY_ID = Object.fromEntries(KNOWLEDGE.actions.map((entry) => [entry.id, entry]));
const APPROVAL_ACTIONS = new Set(KNOWLEDGE.actions.filter((entry) => entry.requiresApproval).map((entry) => entry.id));
const REPAIR_ACTIONS = new Set(['restart_same_profile', 'restart_engine', 'repair_permissions', 'restart_clean_profile']);
const NON_FAILURE = new Set(['healthy', 'console_headless', 'exited_normally', 'starting_slow']);
const RESTRAINT_ACTIONS = new Set(['none', 'wait', 'observe', 'escalate']);

// Mild label smoothing keeps a small sigmoid network from becoming certain on
// every input, which is what made v1 over-confident on unfamiliar evidence.
function oneHot(labels, value, smoothing = 0.04) {
  return Object.fromEntries(labels.map((label) => [label, label === value ? 1 - smoothing : smoothing / (labels.length - 1)]));
}

function softmax(output, temperature = 1) {
  const entries = Object.entries(output);
  const scaled = entries.map(([label, value]) => [label, value / temperature]);
  const max = Math.max(...scaled.map(([, value]) => value));
  const exps = scaled.map(([label, value]) => [label, Math.exp(value - max)]);
  const total = exps.reduce((sum, [, value]) => sum + value, 0) || 1;
  return Object.fromEntries(exps.map(([label, value]) => [label, value / total]));
}

function top(output) {
  return Object.entries(output).sort((a, b) => b[1] - a[1]);
}

function argmax(output) {
  return top(output)[0]?.[0] || null;
}

function predict(net, input, temperature = 1) {
  return softmax(net.run(input), temperature);
}

function trainNetwork({ data, hiddenLayers, seedOffset }) {
  const rand = mulberry32(SEED + seedOffset);
  const originalRandom = Math.random;
  Math.random = rand;
  try {
    const net = new brain.NeuralNetwork({ hiddenLayers, activation: 'sigmoid', learningRate: 0.1 });
    const result = net.train(data, { iterations: ITERATIONS, errorThresh: 0.0001, log: false, logPeriod: 1000 });
    return { net, result };
  } finally {
    Math.random = originalRandom;
  }
}

function countLayer(layer) {
  const biases = Array.isArray(layer.biases) ? layer.biases.length : 0;
  const weights = Array.isArray(layer.weights)
    ? layer.weights.reduce((sum, row) => sum + (Array.isArray(row) ? row.length : 1), 0)
    : 0;
  return biases + weights;
}

function countParameters(json) {
  return (json.layers || []).reduce((sum, layer) => sum + countLayer(layer), 0);
}

function macroF1(rows) {
  const labels = [...new Set(rows.flatMap((row) => [row.expected, row.predicted]))];
  const scores = labels.map((label) => {
    const tp = rows.filter((row) => row.expected === label && row.predicted === label).length;
    const fp = rows.filter((row) => row.expected !== label && row.predicted === label).length;
    const fn = rows.filter((row) => row.expected === label && row.predicted !== label).length;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, f1, support: tp + fn };
  });
  const averaged = scores.reduce((sum, entry) => sum + entry.f1, 0) / (scores.length || 1);
  return { macroF1: averaged, perLabel: scores };
}

// Expected calibration error over the top predicted class.
function calibrationError(rows) {
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
  for (const row of rows) {
    const index = Math.min(9, Math.floor(row.confidence * 10));
    bins[index].count += 1;
    bins[index].confidence += row.confidence;
    bins[index].correct += row.correct ? 1 : 0;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    const accuracy = bin.correct / bin.count;
    const confidence = bin.confidence / bin.count;
    ece += (bin.count / rows.length) * Math.abs(accuracy - confidence);
  }
  return ece;
}

function fitTemperature(net, samples) {
  let best = { temperature: 1, nll: Infinity };
  for (let step = 2; step <= 40; step += 1) {
    const temperature = step / 40;
    let nll = 0;
    for (const sample of samples) {
      const probabilities = softmax(net.run(sample.features), temperature);
      nll -= Math.log(Math.max(1e-9, probabilities[sample.diagnosis] || 1e-9));
    }
    nll /= samples.length;
    if (nll < best.nll) best = { temperature, nll };
  }
  return { ...best, nll: Number(best.nll.toFixed(4)) };
}

// Threshold selection uses ONLY the calibration slice. Previously the shipped
// 0.90/0.15 pair was picked by looking at held-out behaviour, which turns the
// evaluation into a tuning set. Here every candidate is scored on calibration.
function chooseThresholds({ diagnosisNet, actionNet, calibration, temperature }) {
  let best = { confidence: 0.7, margin: 0.15, score: -Infinity };
  for (let confidence = 0.6; confidence <= 0.95; confidence += 0.05) {
    for (let margin = 0.1; margin <= 0.35; margin += 0.05) {
      let accepted = 0;
      let correct = 0;
      let unsafe = 0;
      let overInterventions = 0;
      for (const sample of calibration) {
        const ranked = top(predict(diagnosisNet, sample.features, temperature));
        const uncertain = ranked[0][1] < confidence || ranked[0][1] - (ranked[1]?.[1] || 0) < margin;
        const diagnosis = uncertain ? 'unknown_failure' : ranked[0][0];
        const actionInput = [...sample.features, ...DIAGNOSES.map((label) => (label === diagnosis ? 1 : 0))];
        const rawAction = argmax(predict(actionNet, actionInput, temperature));
        // Evaluate the same safety gate the app applies.
        const gated = gateDecision({ diagnosisId: diagnosis, action: ACTION_BY_ID[rawAction], uncertain, injection: Boolean(sample.signals?.injection) }).action.id;
        if (!uncertain) {
          accepted += 1;
          if (diagnosis === sample.diagnosis) correct += 1;
        }
        if (APPROVAL_ACTIONS.has(gated) && NON_FAILURE.has(sample.diagnosis)) unsafe += 1;
        if (REPAIR_ACTIONS.has(gated) && RESTRAINT_ACTIONS.has(sample.action)) overInterventions += 1;
      }
      const coverage = accepted / calibration.length;
      const precision = accepted === 0 ? 0 : correct / accepted;
      // Thresholds are chosen on calibration only. Coverage has a floor so the
      // model cannot win by refusing almost everything, and unsafe or
      // over-intervening decisions are penalised hard.
      const score = precision * Math.min(1, coverage / 0.6) - unsafe * 0.5 - (overInterventions / calibration.length) * 0.5;
      if (score > best.score) best = { confidence, margin, score, coverage, precision, unsafe, overInterventions };
    }
  }
  return {
    confidence: Number(best.confidence.toFixed(2)),
    margin: Number(best.margin.toFixed(2)),
    calibrationCoverage: Number((best.coverage || 0).toFixed(3)),
    calibrationPrecision: Number((best.precision || 0).toFixed(3)),
    calibrationUnsafe: best.unsafe,
    calibrationOverInterventions: best.overInterventions,
  };
}

function evaluateSplit({ diagnosisNet, actionNet, samples, thresholds, temperature }) {
  const rows = [];
  let actionCorrect = 0;
  let abstained = 0;
  let evidenceGathering = 0;
  let unsafe = 0;
  let falsePositives = 0;
  let normalMislabels = 0;
  let normalCases = 0;
  let overInterventions = 0;
  let restraintCases = 0;
  const errors = [];

  for (const sample of samples) {
    const ranked = top(predict(diagnosisNet, sample.features, temperature));
    const confidence = ranked[0][1];
    const margin = confidence - (ranked[1]?.[1] || 0);
    const uncertain = confidence < thresholds.confidence || margin < thresholds.margin;
    const diagnosis = uncertain ? 'unknown_failure' : ranked[0][0];
    const actionInput = [...sample.features, ...DIAGNOSES.map((label) => (label === diagnosis ? 1 : 0))];
    const rawAction = argmax(predict(actionNet, actionInput, temperature));
    const action = gateDecision({ diagnosisId: diagnosis, action: ACTION_BY_ID[rawAction], uncertain, history: sample.observation?.history, injection: Boolean(sample.signals?.injection) }).action.id;

    const correct = diagnosis === sample.diagnosis;
    if (correct) actionCorrect += action === sample.action ? 1 : 0;
    if (uncertain) abstained += 1;
    if (action === 'observe') evidenceGathering += 1;
    if (NON_FAILURE.has(sample.diagnosis)) {
      normalCases += 1;
      if (!NON_FAILURE.has(diagnosis)) normalMislabels += 1;
      // A false positive that matters is one that would touch the app. A
      // harmless "gather evidence" on normal behaviour is reported separately.
      if (REPAIR_ACTIONS.has(action)) falsePositives += 1;
    }
    if (RESTRAINT_ACTIONS.has(sample.action)) {
      restraintCases += 1;
      if (REPAIR_ACTIONS.has(action)) overInterventions += 1;
    }
    const destructiveMisuse = APPROVAL_ACTIONS.has(action)
      && (NON_FAILURE.has(sample.diagnosis) || sample.action !== action);
    if (destructiveMisuse) unsafe += 1;

    rows.push({ expected: sample.diagnosis, predicted: diagnosis, confidence, correct, action, expectedAction: sample.action });
    if (!correct || action !== sample.action) {
      errors.push({
        family: sample.family,
        expected: `${sample.diagnosis}/${sample.action}`,
        predicted: `${diagnosis}/${action}`,
        confidence: Number(confidence.toFixed(3)),
        uncertain,
      });
    }
  }

  const accuracy = rows.filter((row) => row.correct).length / samples.length;
  return {
    samples: samples.length,
    diagnosisAccuracy: accuracy,
    actionAccuracy: actionCorrect / samples.length,
    macroF1: macroF1(rows).macroF1,
    perLabel: macroF1(rows).perLabel,
    falsePositiveRate: normalCases === 0 ? 0 : falsePositives / normalCases,
    normalMislabelRate: normalCases === 0 ? 0 : normalMislabels / normalCases,
    abstentionRate: abstained / samples.length,
    evidenceGatheringRate: evidenceGathering / samples.length,
    overInterventions,
    restraintCases,
    unsafeActions: unsafe,
    calibrationError: calibrationError(rows),
    errors: errors.slice(0, 40),
  };
}

function keywordBaseline(observation) {
  const text = (observation.logLines || []).join('\n');
  const engineResponsive = observation.process?.engineResponsive !== false;
  if (/ignore (all|any|the|previous|prior) instructions|disable (the )?(sandbox|protection|isolation)/i.test(text)) return ['user_data_risk', 'escalate'];
  if (/(vcruntime\d+|msvcp\d+)\.dll[^\n]*(missing|not found)/i.test(text)) return ['missing_runtime', 'advise_runtime_install'];
  if (/crash(ed)? (again|repeatedly)|restart loop|keeps crashing/i.test(text)) return ['crash_loop', 'escalate'];
  if (!engineResponsive) return ['engine_unresponsive', 'restart_engine'];
  if (/access is denied|permission denied/i.test(text)) return ['permission_denied', 'repair_permissions'];
  if (/no space left|disk full|enospc/i.test(text)) return ['disk_exhausted', 'advise_configuration'];
  if (/not supported|no vm image|virtualization is not enabled/i.test(text)) return ['isolation_unsupported', 'advise_configuration'];
  if (/unhandled exception|fatal error|access violation/i.test(text)) return ['crash_unhandled', 'restart_same_profile'];
  if (/network is unreachable|connection refused|could not resolve/i.test(text)) return ['network_blocked', 'advise_configuration'];
  if (observation.process?.windowExpected && observation.process?.windowVisible === false) return ['window_hang', 'restart_same_profile'];
  return ['healthy', 'none'];
}

function baselineMetrics(samples) {
  let diagnosisCorrect = 0;
  let actionCorrect = 0;
  let falsePositives = 0;
  let normal = 0;
  for (const sample of samples) {
    const [diagnosis, action] = keywordBaseline(sample.observation);
    if (diagnosis === sample.diagnosis) diagnosisCorrect += 1;
    if (action === sample.action) actionCorrect += 1;
    if (NON_FAILURE.has(sample.diagnosis)) {
      normal += 1;
      if (REPAIR_ACTIONS.has(action)) falsePositives += 1;
    }
  }
  return {
    diagnosisAccuracy: diagnosisCorrect / samples.length,
    actionAccuracy: actionCorrect / samples.length,
    falsePositiveRate: normal === 0 ? 0 : falsePositives / normal,
  };
}

function summarise(evaluation) {
  const pct = (value) => Number((value * 100).toFixed(2));
  return {
    samples: evaluation.samples,
    diagnosisAccuracy: Number(evaluation.diagnosisAccuracy.toFixed(4)),
    actionAccuracy: Number(evaluation.actionAccuracy.toFixed(4)),
    macroF1: Number(evaluation.macroF1.toFixed(4)),
    falsePositiveRate: Number(evaluation.falsePositiveRate.toFixed(4)),
    normalMislabelRate: Number(evaluation.normalMislabelRate.toFixed(4)),
    abstentionRate: Number(evaluation.abstentionRate.toFixed(4)),
    evidenceGatheringRate: Number(evaluation.evidenceGatheringRate.toFixed(4)),
    overInterventions: evaluation.overInterventions,
    restraintCases: evaluation.restraintCases,
    unsafeActions: evaluation.unsafeActions,
    calibrationError: Number(evaluation.calibrationError.toFixed(4)),
    perLabel: evaluation.perLabel.map((entry) => ({ ...entry, f1: Number(entry.f1.toFixed(3)) })),
    errors: evaluation.errors,
    headline: {
      diagnosisAccuracyPct: pct(evaluation.diagnosisAccuracy),
      actionAccuracyPct: pct(evaluation.actionAccuracy),
      falsePositivePct: pct(evaluation.falsePositiveRate),
      abstentionPct: pct(evaluation.abstentionRate),
    },
  };
}

// Promoted, verified experiences are local examples with explicit consent. They
// are appended to the fit set only; they never enter a held-out split.
function loadCuratedExamples(file) {
  if (!file) return { examples: [], error: null };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const examples = (Array.isArray(raw.examples) ? raw.examples : [])
      .filter((example) => Array.isArray(example.features) && example.features.length === FEATURE_NAMES.length)
      .map((example) => ({
        family: 'verified-experience',
        source: 'verified-experience',
        observation: { app: { name: 'Verified experience', engine: 'auto', status: 'Unknown' }, process: {}, launch: {}, logLines: [], history: {} },
        diagnosis: example.diagnosis,
        action: example.action,
        features: example.features.map((value) => Math.max(0, Math.min(1, Number(value) || 0))),
        signals: {},
        evidence: [],
      }))
      .filter((example) => DIAGNOSES.includes(example.diagnosis) && ACTIONS.includes(example.action));
    return { examples, error: null };
  } catch (error) {
    return { examples: [], error: error.message };
  }
}

function main() {
  const startedAt = Date.now();
  const corpus = generateDataset({ seed: SEED });
  const { calibration, familiar, unseen, ambiguous, final, audit } = corpus;
  const curated = loadCuratedExamples(process.env.RC_BRAIN_CURATED);
  const train = [...corpus.train, ...curated.examples];

  // The action head is trained on the diagnosis predicted for the same row, so
  // inference and training share one distribution.
  const diagnosisTraining = train.map((sample) => ({ input: sample.features, output: oneHot(DIAGNOSES, sample.diagnosis) }));
  const diagnosisRun = trainNetwork({ data: diagnosisTraining, hiddenLayers: HIDDEN.diagnosis, seedOffset: 11 });

  const calibrationResult = fitTemperature(diagnosisRun.net, calibration);
  const temperature = calibrationResult.temperature;

  const actionTraining = train.map((sample) => {
    const predictedDiagnosis = argmax(predict(diagnosisRun.net, sample.features, temperature));
    return {
      input: [...sample.features, ...DIAGNOSES.map((label) => (label === predictedDiagnosis ? 1 : 0))],
      output: oneHot(ACTIONS, sample.action),
    };
  });
  const actionRun = trainNetwork({ data: actionTraining, hiddenLayers: HIDDEN.action, seedOffset: 23 });

  const thresholds = chooseThresholds({ diagnosisNet: diagnosisRun.net, actionNet: actionRun.net, calibration, temperature });
  const familiarEval = evaluateSplit({ diagnosisNet: diagnosisRun.net, actionNet: actionRun.net, samples: familiar, thresholds, temperature });
  const unseenEval = evaluateSplit({ diagnosisNet: diagnosisRun.net, actionNet: actionRun.net, samples: unseen, thresholds, temperature });
  const ambiguousEval = evaluateSplit({ diagnosisNet: diagnosisRun.net, actionNet: actionRun.net, samples: ambiguous, thresholds, temperature });
  const finalEval = evaluateSplit({ diagnosisNet: diagnosisRun.net, actionNet: actionRun.net, samples: final, thresholds, temperature });

  const diagnosisJson = diagnosisRun.net.toJSON();
  const actionJson = actionRun.net.toJSON();
  const parameterCount = countParameters(diagnosisJson) + countParameters(actionJson);

  const artefact = {
    schema: 'runcontainer.brain.v2',
    id: MODEL_ID,
    name: 'RC-Brain 2',
    version: '2.0.0',
    createdAt: new Date().toISOString(),
    knowledgeVersion: KNOWLEDGE.knowledgeVersion,
    description: 'RunContainer\'s own two-head behavioural model: structured observations in, diagnosis and repair action out. Trained from scratch on synthetic RunContainer scenarios; cannot read arbitrary log text semantically.',
    featureSchema: FEATURE_NAMES,
    labels: { diagnosis: DIAGNOSES, action: ACTIONS },
    actionByDiagnosis: ACTION_BY_DIAGNOSIS,
    hiddenLayers: HIDDEN,
    parameterCount,
    thresholds: { confidence: thresholds.confidence, margin: thresholds.margin },
    calibration: {
      temperature: Number(temperature.toFixed(3)),
      calibrationSamples: calibration.length,
      nll: calibrationResult.nll,
      thresholdSelection: {
        coverage: thresholds.calibrationCoverage,
        precision: thresholds.calibrationPrecision,
        unsafe: thresholds.calibrationUnsafe,
      },
    },
    training: {
      seed: SEED,
      trainSamples: train.length,
      calibrationSamples: calibration.length,
      diagnosisIterations: diagnosisRun.result.iterations,
      diagnosisError: Number(diagnosisRun.result.error.toFixed(6)),
      actionIterations: actionRun.result.iterations,
      actionError: Number(actionRun.result.error.toFixed(6)),
      durationMs: Date.now() - startedAt,
    },
    corpus: {
      curatedExamples: curated.examples.length,
      rows: audit.rows,
      distinctFeatureVectors: audit.distinctFeatureVectors,
      exactDuplicates: audit.exactDuplicates,
      labelConflicts: audit.labelConflicts,
      trainHoldoutLeakage: audit.trainHoldoutLeakage,
      unseenFamilies: corpus.unseenFamilies.map((family) => family.id),
      provenance: 'synthetic scenarios grounded in RunContainer source, tests and docs; no real user data',
    },
    evaluation: {
      familiar: summarise(familiarEval),
      unseen: summarise(unseenEval),
      ambiguous: summarise(ambiguousEval),
      final: summarise(finalEval),
      // Compatibility fields for older UI builds: headline familiar numbers.
      diagnosisAccuracy: Number(familiarEval.diagnosisAccuracy.toFixed(4)),
      actionAccuracy: Number(familiarEval.actionAccuracy.toFixed(4)),
      macroF1: Number(familiarEval.macroF1.toFixed(4)),
      falsePositiveRate: Number(familiarEval.falsePositiveRate.toFixed(4)),
      abstentionRate: Number(familiarEval.abstentionRate.toFixed(4)),
      unsafeActions: familiarEval.unsafeActions + unseenEval.unsafeActions + ambiguousEval.unsafeActions,
      samples: familiar.length + unseen.length + ambiguous.length + final.length,
      perLabel: summarise(familiarEval).perLabel,
      errors: summarise(familiarEval).errors,
    },
    baseline: {
      familiar: baselineMetrics(familiar),
      unseen: baselineMetrics(unseen),
      ambiguous: baselineMetrics(ambiguous),
      final: baselineMetrics(final),
    },
    nets: { diagnosis: diagnosisJson, action: actionJson },
  };

  const modelDir = path.join(ROOT, 'src', 'ai', 'model');
  fs.mkdirSync(modelDir, { recursive: true });
  const modelPath = path.join(modelDir, MODEL_FILE);
  fs.writeFileSync(modelPath, `${JSON.stringify(artefact)}\n`, 'utf8');

  const reportPath = path.join(ROOT, 'reports', CANDIDATE ? 'ai-candidate.md' : 'ai-evaluation.md');
  const registryPath = path.join(modelDir, 'registry.json');
  // A candidate stays on disk and in the report; the active registry entry is
  // only changed by scripts/promote-model.js after its gates pass.
  if (!CANDIDATE) {
    let registry = { schema: 'runcontainer.brain.registry.v1', current: MODEL_FILE, previous: null, history: [] };
    if (fs.existsSync(registryPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        registry = { ...registry, ...existing };
      } catch (error) {
        registry = { schema: 'runcontainer.brain.registry.v1', current: MODEL_FILE, previous: null, history: [] };
      }
    }
    registry.current = MODEL_FILE;
    registry.updatedAt = new Date().toISOString();
    registry.history = [
      ...(registry.history || []).filter((entry) => entry.file !== MODEL_FILE),
      {
        file: MODEL_FILE,
        id: MODEL_ID,
        version: artefact.version,
        createdAt: artefact.createdAt,
        parameters: parameterCount,
        status: 'active',
        source: 'train-ai-brain',
      },
    ].slice(-10);
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  }

  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const splitTable = (label, evaluation, baseline) => [
    `### ${label}`,
    '',
    '| Metric | RC-Brain 2 | Keyword baseline |',
    '| --- | --- | --- |',
    `| Diagnosis accuracy | ${pct(evaluation.diagnosisAccuracy)} | ${pct(baseline.diagnosisAccuracy)} |`,
    `| Action accuracy | ${pct(evaluation.actionAccuracy)} | ${pct(baseline.actionAccuracy)} |`,
    `| Macro F1 (diagnosis) | ${evaluation.macroF1.toFixed(3)} | n/a |`,
    `| False positives on normal behaviour (proposed a repair) | ${pct(evaluation.falsePositiveRate)} | ${pct(baseline.falsePositiveRate)} |`,
    `| Normal behaviour labelled abnormal (action was harmless) | ${pct(evaluation.normalMislabelRate)} | n/a |`,
    `| Abstention rate (confidence below threshold) | ${pct(evaluation.abstentionRate)} | 0% |`,
    `| Decisions to gather more evidence | ${pct(evaluation.evidenceGatheringRate)} | n/a |`,
    `| Over-interventions on restraint cases | ${evaluation.overInterventions} / ${evaluation.restraintCases} | n/a |`,
    `| Unsafe destructive actions | ${evaluation.unsafeActions} | n/a |`,
    `| Expected calibration error | ${evaluation.calibrationError.toFixed(3)} | n/a |`,
    '',
  ].join('\n');

  const report = [
    '# RC-Brain 2 evaluation',
    '',
    `Trained ${artefact.createdAt} from ${corpus.train.length} synthetic RunContainer scenarios${curated.examples.length ? ` plus ${curated.examples.length} promoted verified experiences` : ''}, calibrated on ${calibration.length} separate rows, and evaluated on held-out splits it never fitted.`,
    '',
    `- Model: two feed-forward heads (diagnosis ${HIDDEN.diagnosis.join('x')}, action ${HIDDEN.action.join('x')}), sigmoid, trained from scratch`,
    `- Parameters: ${parameterCount.toLocaleString()}`,
    `- Input: ${FEATURE_NAMES.length} structured observation features (window, process, engine, log signals, temporal history, exit codes, host pressure)`,
    `- Calibration: temperature ${temperature.toFixed(3)} (NLL ${calibrationResult.nll}); thresholds chosen on calibration only`,
    `- Thresholds: confidence ${thresholds.confidence}, margin ${thresholds.margin} (calibration coverage ${pct(thresholds.calibrationCoverage)}, precision ${pct(thresholds.calibrationPrecision)})`,
    `- Training: ${diagnosisRun.result.iterations} + ${actionRun.result.iterations} iterations, errors ${diagnosisRun.result.error.toFixed(4)} / ${actionRun.result.error.toFixed(4)}`,
    '',
    'All rows are synthetic scenarios derived from RunContainer\'s own source, tests and documentation. No real user logs, machines or personal data were used.',
    '',
    '## Corpus',
    '',
    `- ${audit.rows} rows total, ${audit.distinctFeatureVectors} distinct feature vectors`,
    `- ${audit.exactDuplicates} duplicate feature vectors, ${audit.labelConflicts} label conflicts on identical evidence`,
    `- Train/holdout leakage (identical vectors on both sides): ${audit.trainHoldoutLeakage}`,
    `- Unseen families: ${corpus.unseenFamilies.map((family) => family.id).join(', ')}`,
    `- Ambiguous/restraint families: ${corpus.ambiguousFamilies.map((family) => family.id).join(', ')}`,
    `- Final split: ${final.length} rows, generated with independent seeds and used once here`,
    '',
    '## Results by split',
    '',
    splitTable('Familiar holdout (new variants of trained families)', familiarEval, artefact.baseline.familiar),
    splitTable('Unseen failure families (absent from training and calibration)', unseenEval, artefact.baseline.unseen),
    splitTable('Ambiguous / restraint cases', ambiguousEval, artefact.baseline.ambiguous),
    splitTable('Final untouched evaluation', finalEval, artefact.baseline.final),
    '## Per-diagnosis F1 (familiar holdout)',
    '',
    '| Diagnosis | F1 | Support |',
    '| --- | --- | --- |',
    ...artefact.evaluation.familiar.perLabel.map((entry) => `| ${entry.label} | ${entry.f1.toFixed(3)} | ${entry.support} |`),
    '',
    '## Errors on unseen families',
    '',
    unseenEval.errors.length === 0 ? 'None.' : [
      '| Family | Expected | Predicted | Confidence |',
      '| --- | --- | --- | --- |',
      ...unseenEval.errors.map((error) => `| ${error.family} | ${error.expected} | ${error.predicted} | ${error.confidence.toFixed(3)} |`),
    ].join('\n'),
    '',
    '## Errors on ambiguous cases',
    '',
    ambiguousEval.errors.length === 0 ? 'None.' : [
      '| Family | Expected | Predicted | Confidence |',
      '| --- | --- | --- | --- |',
      ...ambiguousEval.errors.map((error) => `| ${error.family} | ${error.expected} | ${error.predicted} | ${error.confidence.toFixed(3)} |`),
    ].join('\n'),
    '',
    '## Limitations of these numbers',
    '',
    '- Familiar-holdout accuracy is high partly because variants come from the same generators; it measures memorisation of a scenario family, not general reasoning.',
    '- Unseen-family accuracy is the more honest generalisation signal, and it is reported separately above rather than averaged away.',
    '- The model is a fixed-label classifier. It cannot interpret arbitrary error text, invent a new diagnosis, or explain causality beyond the evidence features and its selected label. Unknown evidence leads to `unknown_failure` + `observe`, not to a novel diagnosis.',
    '- All data is synthetic. Real-world repair success is tracked through the experience pipeline, not assumed from this table.',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(reportPath, report, 'utf8');

  console.log(`RC-Brain 2: ${parameterCount} parameters, ${train.length} fit / ${calibration.length} calibration`);
  console.log(`thresholds confidence ${thresholds.confidence} margin ${thresholds.margin}`);
  console.log(`familiar ${pct(familiarEval.diagnosisAccuracy)} / action ${pct(familiarEval.actionAccuracy)} (baseline ${pct(artefact.baseline.familiar.diagnosisAccuracy)})`);
  console.log(`unseen ${pct(unseenEval.diagnosisAccuracy)} / action ${pct(unseenEval.actionAccuracy)} (baseline ${pct(artefact.baseline.unseen.diagnosisAccuracy)})`);
  console.log(`ambiguous ${pct(ambiguousEval.diagnosisAccuracy)} / over-interventions ${ambiguousEval.overInterventions}/${ambiguousEval.restraintCases}`);
  console.log(`final ${pct(finalEval.diagnosisAccuracy)} / action ${pct(finalEval.actionAccuracy)} / FPR ${pct(finalEval.falsePositiveRate)} / unsafe ${finalEval.unsafeActions}`);
  console.log(`corpus: ${audit.rows} rows, ${audit.distinctFeatureVectors} distinct, ${audit.labelConflicts} label conflicts, leakage ${audit.trainHoldoutLeakage}`);
  console.log(`Wrote ${modelPath} and ${reportPath}${CANDIDATE ? ' (candidate; active registry unchanged)' : ` and ${registryPath}`}`);

  const failures = [];
  if (familiarEval.diagnosisAccuracy < 0.9) failures.push(`familiar diagnosis accuracy ${pct(familiarEval.diagnosisAccuracy)} < 90%`);
  if (familiarEval.diagnosisAccuracy < artefact.baseline.familiar.diagnosisAccuracy + 0.1) failures.push('familiar accuracy is not clearly better than the keyword baseline');
  if (finalEval.diagnosisAccuracy < artefact.baseline.final.diagnosisAccuracy + 0.05) failures.push('final accuracy is not clearly better than the keyword baseline');
  // On unseen families the baseline is strong (its keyword rules encode several
  // of those symptoms directly), so the honest gate is "not materially worse",
  // not an arbitrary 10-point win. The advantage must still show up on familiar
  // and final splits above.
  if (unseenEval.diagnosisAccuracy < 0.8) failures.push(`unseen-family accuracy ${pct(unseenEval.diagnosisAccuracy)} < 80%`);
  if (unseenEval.diagnosisAccuracy + 0.02 < artefact.baseline.unseen.diagnosisAccuracy) failures.push('unseen-family accuracy is materially worse than the keyword baseline');
  if (ambiguousEval.overInterventions > 0) failures.push(`${ambiguousEval.overInterventions} repair(s) proposed on a restraint case`);
  if (familiarEval.falsePositiveRate > 0.05 || unseenEval.falsePositiveRate > 0.1) failures.push('false positive rate above the release gate');
  if (ambiguousEval.unsafeActions > 0) failures.push('unsafe action on an ambiguous/restraint case');
  if (finalEval.unsafeActions > 0) failures.push('unsafe action on the final untouched split');
  if (finalEval.diagnosisAccuracy < 0.75) failures.push(`final untouched accuracy ${pct(finalEval.diagnosisAccuracy)} < 75%`);
  if (audit.labelConflicts > 0) failures.push(`${audit.labelConflicts} label conflicts on identical evidence`);
  if (audit.trainHoldoutLeakage > 0) failures.push(`${audit.trainHoldoutLeakage} identical rows appear in both training and holdout`);
  if (failures.length > 0) {
    console.error('RC-Brain did not meet its release thresholds:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
}

main();
