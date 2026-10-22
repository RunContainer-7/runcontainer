// RC-Brain inference.
//
// The trained artefact is the decision maker: it maps a structured observation
// to a diagnosis and a repair action. This module only loads it, calibrates its
// outputs, and applies the explicit safety policy around the decision. If the
// model is missing or corrupt, it reports that state; it never substitutes
// hand-written diagnostic rules.
//
// Which artefact loads is recorded in model/registry.json, so a new model can
// be rolled back to the previous known-good file without a code change.

const fs = require('fs');
const path = require('path');
const knowledge = require('./knowledge.json');
const { FEATURE_NAMES, encodeObservation } = require('./features');
const { validateNetwork, runNetwork } = require('./inference');
const { gateDecision } = require('./policy');

const MODEL_DIR = path.join(__dirname, 'model');
const REGISTRY_PATH = path.join(MODEL_DIR, 'registry.json');
const FALLBACK_MODEL = path.join(MODEL_DIR, 'rc-brain-2.json');
const MODEL_SCHEMA = 'runcontainer.brain.v2';
const DIAGNOSES = knowledge.diagnoses.map((entry) => entry.id);
const ACTIONS = knowledge.actions.map((entry) => entry.id);
const ACTION_BY_ID = Object.fromEntries(knowledge.actions.map((entry) => [entry.id, entry]));
const DIAGNOSIS_BY_ID = Object.fromEntries(knowledge.diagnoses.map((entry) => [entry.id, entry]));

function readRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    if (raw && typeof raw.current === 'string') return raw;
  } catch (error) {
    // A missing registry falls back to the shipped model file.
  }
  return { schema: 'runcontainer.brain.registry.v1', current: path.basename(FALLBACK_MODEL), previous: null, history: [] };
}

function resolveModelPath(modelPath) {
  if (modelPath) return modelPath;
  const registry = readRegistry();
  const candidate = path.join(MODEL_DIR, path.basename(registry.current));
  if (fs.existsSync(candidate)) return candidate;
  return FALLBACK_MODEL;
}

function softmax(output, temperature = 1) {
  const scaled = Object.entries(output).map(([label, value]) => [label, value / (temperature || 1)]);
  const max = Math.max(...scaled.map(([, value]) => value));
  const exps = scaled.map(([label, value]) => [label, Math.exp(value - max)]);
  const total = exps.reduce((sum, [, value]) => sum + value, 0) || 1;
  return Object.fromEntries(exps.map(([label, value]) => [label, value / total]));
}

function topTwo(probabilities) {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 2);
}

function loadModel(modelPath) {
  const resolvedPath = resolveModelPath(modelPath);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    return { available: false, error: `The RC-Brain model could not be read: ${error.message}` };
  }
  if (!raw || raw.schema !== MODEL_SCHEMA) {
    return { available: false, error: 'The RC-Brain model file is not a RunContainer v2 model.' };
  }
  if (!Array.isArray(raw.featureSchema) || raw.featureSchema.length !== FEATURE_NAMES.length
    || raw.featureSchema.some((name, index) => name !== FEATURE_NAMES[index])) {
    return { available: false, error: 'The RC-Brain model was trained with a different feature schema than this build expects.' };
  }
  if (!raw.nets?.diagnosis || !raw.nets?.action) {
    return { available: false, error: 'The RC-Brain model is missing one of its networks.' };
  }
  try {
    validateNetwork(raw.nets.diagnosis, 'diagnosis network');
    validateNetwork(raw.nets.action, 'action network');
    return {
      available: true,
      path: resolvedPath,
      meta: {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        createdAt: raw.createdAt,
        parameters: raw.parameterCount,
        features: raw.featureSchema.length,
        hiddenLayers: raw.hiddenLayers,
        knowledgeVersion: raw.knowledgeVersion,
        evaluation: raw.evaluation,
        training: raw.training,
        calibration: raw.calibration,
        corpus: raw.corpus,
        labels: raw.labels,
        thresholds: raw.thresholds,
        capabilities: {
          diagnosisLabels: DIAGNOSES.length,
          actionLabels: ACTIONS.length,
          readsArbitraryText: false,
          novelDiagnosis: false,
        },
      },
      thresholds: raw.thresholds,
      temperature: raw.calibration?.temperature || 1,
      nets: { diagnosis: raw.nets.diagnosis, action: raw.nets.action },
    };
  } catch (error) {
    return { available: false, error: `The RC-Brain model could not be loaded: ${error.message}` };
  }
}

function createBrain({ modelPath, logger = () => {}, retrieve = null } = {}) {
  const loaded = loadModel(modelPath);
  if (!loaded.available) logger(loaded.error);
  const registry = readRegistry();

  function analyze(observation, history = {}) {
    if (!loaded.available) {
      return {
        available: false,
        error: loaded.error,
        model: null,
        diagnosis: null,
        action: null,
        decision: 'unavailable',
        evidence: [],
        explanation: 'RC-Brain is not loaded, so no AI diagnosis is being made. Monitoring will not attempt repairs.',
        confidence: 0,
        uncertain: true,
      };
    }

    const encoded = encodeObservation(observation);
    // History arrives as a separate argument from the supervisor and is also
    // embedded in the observation for stored/replayed cases; merge both.
    const historyState = { ...(observation?.history || {}), ...(history || {}) };
    const probabilities = softmax(runNetwork(loaded.nets.diagnosis, encoded.values, 'diagnosis network'), loaded.temperature);
    const ranked = topTwo(probabilities);
    const confidence = ranked[0]?.[1] || 0;
    const margin = confidence - (ranked[1]?.[1] || 0);
    const uncertain = confidence < loaded.thresholds.confidence || margin < loaded.thresholds.margin;
    const diagnosisId = uncertain ? 'unknown_failure' : ranked[0][0];
    const diagnosis = DIAGNOSIS_BY_ID[diagnosisId] || { id: diagnosisId, summary: 'Unrecognised diagnosis.' };

    const actionInput = [...encoded.values, ...DIAGNOSES.map((label) => (label === diagnosisId ? 1 : 0))];
    const actionProbabilities = softmax(runNetwork(loaded.nets.action, actionInput, 'action network'), loaded.temperature);
    const actionId = Object.entries(actionProbabilities).sort((a, b) => b[1] - a[1])[0]?.[0] || 'observe';
    const proposed = ACTION_BY_ID[actionId] ? { ...ACTION_BY_ID[actionId], id: actionId } : null;
    const gate = gateDecision({
      diagnosisId,
      action: proposed,
      confidence,
      uncertain,
      history: historyState,
      injection: Boolean(encoded.signals?.injection),
    });
    const action = gate.action;

    const confidenceText = `${Math.round(confidence * 100)}%`;
    const explanation = uncertain
      ? `The evidence did not match any diagnosis strongly enough, so the model is gathering more observations rather than acting. Closest evidence: ${encoded.evidence.slice(0, 3).join('; ') || 'no structured evidence'}.`
      : `${diagnosis.summary} ${gate.reason}`;

    // Previously verified incidents are retrieval context for the user and for
    // the next review cycle. They are deliberately NOT fed back into the
    // feature vector: a similar past case must not overrule current evidence.
    let similar = [];
    if (typeof retrieve === 'function') {
      try {
        similar = retrieve({ observation, diagnosisId, features: encoded.values }) || [];
      } catch (error) {
        similar = [];
      }
    }

    return {
      available: true,
      model: loaded.meta,
      registry: { current: registry.current, previous: registry.previous || null },
      diagnosis: {
        id: diagnosisId,
        summary: diagnosis.summary,
        confidence: Number(confidence.toFixed(3)),
        confidenceText,
        margin: Number(margin.toFixed(3)),
        alternatives: ranked.slice(1).map(([id, probability]) => ({ id, confidence: Number(probability.toFixed(3)) })),
      },
      action: {
        id: action.id,
        label: action.label,
        description: action.description,
        risk: action.risk,
        autonomous: Boolean(action.autonomous) && !action.requiresApproval,
        requiresApproval: Boolean(action.requiresApproval),
      },
      decision: gate.decision,
      reason: gate.reason,
      explanation,
      evidence: encoded.evidence,
      uncertain,
      unknownToModel: diagnosisId === 'unknown_failure',
      securityNote: proposed ? null : 'The model proposed an action outside the catalogue, so it was replaced with gathering more evidence.',
      features: encoded.values,
      similarExperiences: similar,
    };
  }

  return {
    available: loaded.available,
    error: loaded.available ? null : loaded.error,
    model: loaded.available ? loaded.meta : null,
    registry,
    analyze,
  };
}

module.exports = {
  MODEL_DIR,
  REGISTRY_PATH,
  FALLBACK_MODEL,
  DEFAULT_MODEL_PATH: FALLBACK_MODEL,
  MODEL_SCHEMA,
  DIAGNOSES,
  ACTIONS,
  ACTION_BY_ID,
  DIAGNOSIS_BY_ID,
  softmax,
  readRegistry,
  resolveModelPath,
  loadModel,
  createBrain,
};
