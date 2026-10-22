// RC-Brain inference.
//
// The trained artefact (model/rc-brain-1.json) is the decision maker: it maps a
// structured observation to a diagnosis and a repair action. This module only
// loads it, calibrates its outputs, and applies the explicit safety gate around
// the decision. If the model is missing or corrupt, it reports that state; it
// never substitutes hand-written diagnostic rules.

const fs = require('fs');
const path = require('path');
const brain = require('brain.js');
const knowledge = require('./knowledge.json');
const { FEATURE_NAMES, encodeObservation } = require('./features');

const DEFAULT_MODEL_PATH = path.join(__dirname, 'model', 'rc-brain-1.json');
const DIAGNOSES = knowledge.diagnoses.map((entry) => entry.id);
const ACTIONS = knowledge.actions.map((entry) => entry.id);
const ACTION_BY_ID = Object.fromEntries(knowledge.actions.map((entry) => [entry.id, entry]));
const DIAGNOSIS_BY_ID = Object.fromEntries(knowledge.diagnoses.map((entry) => [entry.id, entry]));
const NON_FAILURE = new Set(['healthy', 'console_headless', 'exited_normally', 'starting_slow']);

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

function loadModel(modelPath = DEFAULT_MODEL_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  } catch (error) {
    return { available: false, error: `The RC-Brain model could not be read: ${error.message}` };
  }
  if (!raw || raw.schema !== 'runcontainer.brain.v1') {
    return { available: false, error: 'The RC-Brain model file is not a RunContainer model.' };
  }
  if (!Array.isArray(raw.featureSchema) || raw.featureSchema.length !== FEATURE_NAMES.length
    || raw.featureSchema.some((name, index) => name !== FEATURE_NAMES[index])) {
    return { available: false, error: 'The RC-Brain model was trained with a different feature schema than this build expects.' };
  }
  if (!raw.nets?.diagnosis || !raw.nets?.action) {
    return { available: false, error: 'The RC-Brain model is missing one of its networks.' };
  }
  try {
    const diagnosisNet = new brain.NeuralNetwork({ hiddenLayers: raw.hiddenLayers?.diagnosis });
    diagnosisNet.fromJSON(raw.nets.diagnosis);
    const actionNet = new brain.NeuralNetwork({ hiddenLayers: raw.hiddenLayers?.action });
    actionNet.fromJSON(raw.nets.action);
    return {
      available: true,
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
      },
      thresholds: raw.thresholds,
      temperature: raw.calibration?.temperature || 1,
      diagnosisNet,
      actionNet,
    };
  } catch (error) {
    return { available: false, error: `The RC-Brain model could not be loaded: ${error.message}` };
  }
}

function createBrain({ modelPath = DEFAULT_MODEL_PATH, logger = () => {} } = {}) {
  const loaded = loadModel(modelPath);
  if (!loaded.available) logger(loaded.error);

  function escalateDecision(reason, base) {
    const action = ACTION_BY_ID.escalate;
    return {
      ...base,
      action: {
        id: 'escalate',
        label: action.label,
        description: action.description,
        risk: action.risk,
        autonomous: false,
        requiresApproval: false,
      },
      decision: 'escalate',
      reason,
    };
  }

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
    const probabilities = softmax(loaded.diagnosisNet.run(encoded.values), loaded.temperature);
    const ranked = topTwo(probabilities);
    const confidence = ranked[0]?.[1] || 0;
    const margin = confidence - (ranked[1]?.[1] || 0);
    const uncertain = confidence < loaded.thresholds.confidence || margin < loaded.thresholds.margin;
    const diagnosisId = uncertain ? 'unknown_failure' : ranked[0][0];
    const diagnosis = DIAGNOSIS_BY_ID[diagnosisId] || { id: diagnosisId, summary: 'Unrecognised diagnosis.' };

    const actionInput = [...encoded.values, ...DIAGNOSES.map((label) => (label === diagnosisId ? 1 : 0))];
    const actionProbabilities = softmax(loaded.actionNet.run(actionInput), loaded.temperature);
    let actionId = Object.entries(actionProbabilities).sort((a, b) => b[1] - a[1])[0]?.[0] || 'observe';
    let action = ACTION_BY_ID[actionId];
    let securityNote = null;
    if (!action) {
      actionId = 'observe';
      action = ACTION_BY_ID.observe;
      securityNote = 'The model proposed an action outside the catalogue, so it was replaced with gathering more evidence.';
    }
    // Safety gate, deliberately separate from diagnosis: destructive actions on
    // normal behaviour escalate instead of touching user data, and nothing is
    // ever executed without its declared permission.
    if (NON_FAILURE.has(diagnosisId) && (action.requiresApproval || action.risk === 'high')) {
      return escalateDecision('The model proposed a destructive repair for an app that is not failing, so the safety gate stopped it and asked for attention.', {
        available: true,
        model: loaded.meta,
        diagnosis: { id: diagnosisId, summary: diagnosis.summary, confidence: Number(confidence.toFixed(3)) },
        evidence: encoded.evidence,
        explanation: `${diagnosis.summary} The proposed repair would affect app data, and the evidence does not show a failure. Nothing was changed.`,
        confidence: Number(confidence.toFixed(3)),
        uncertain,
      });
    }

    // History arrives as a separate argument from the supervisor and is also
    // embedded in the observation for stored/replayed cases; merge both.
    const historyState = { ...(observation?.history || {}), ...(history || {}) };
    const repairBudgetSpent = Number(historyState.repairs || 0) >= 2;
    const repeatedFailure = Boolean(historyState.lastRepairFailed) && Number(historyState.sameDiagnosisRepeats || 0) >= 1;
    const actionable = !['none', 'wait', 'observe'].includes(actionId);
    if (actionable && (repairBudgetSpent || repeatedFailure)) {
      return escalateDecision(
        repairBudgetSpent
          ? 'Automatic repair has already run twice for this app in the monitoring window, so the model stopped instead of retrying.'
          : 'The previous identical repair did not work, so the model stopped instead of repeating it.',
        {
          available: true,
          model: loaded.meta,
          diagnosis: { id: diagnosisId, summary: diagnosis.summary, confidence: Number(confidence.toFixed(3)) },
          evidence: encoded.evidence,
          explanation: `${diagnosis.summary} A repair was indicated, but the bounded-retry policy requires a person to look at it instead of trying again.`,
          confidence: Number(confidence.toFixed(3)),
          uncertain,
        },
      );
    }

    const decision = action.requiresApproval
      ? 'awaiting_approval'
      : actionId === 'observe'
        ? 'abstain'
        : ['advise_runtime_install', 'advise_configuration'].includes(actionId)
          ? 'advise'
          : actionId === 'escalate'
            ? 'escalate'
            : ['none', 'wait'].includes(actionId)
              ? 'monitor'
              : 'execute';

    const confidenceText = `${Math.round(confidence * 100)}%`;
    const reason = uncertain
      ? 'The evidence did not match any diagnosis strongly enough, so the model is gathering more observations rather than acting.'
      : action.description;
    const explanation = uncertain
      ? `${reason} Closest evidence: ${encoded.evidence.slice(0, 3).join('; ') || 'no structured evidence'}.`
      : `${diagnosis.summary} ${action.description}`;

    return {
      available: true,
      model: loaded.meta,
      diagnosis: {
        id: diagnosisId,
        summary: diagnosis.summary,
        confidence: Number(confidence.toFixed(3)),
        confidenceText,
        margin: Number(margin.toFixed(3)),
        alternatives: ranked.slice(1).map(([id, probability]) => ({ id, confidence: Number(probability.toFixed(3)) })),
      },
      action: {
        id: actionId,
        label: action.label,
        description: action.description,
        risk: action.risk,
        autonomous: Boolean(action.autonomous) && !action.requiresApproval,
        requiresApproval: Boolean(action.requiresApproval),
      },
      decision,
      reason,
      explanation,
      evidence: encoded.evidence,
      uncertain,
      securityNote,
      features: encoded.values,
    };
  }

  return {
    available: loaded.available,
    error: loaded.available ? null : loaded.error,
    model: loaded.available ? loaded.meta : null,
    analyze,
  };
}

module.exports = {
  DEFAULT_MODEL_PATH,
  DIAGNOSES,
  ACTIONS,
  ACTION_BY_ID,
  DIAGNOSIS_BY_ID,
  softmax,
  loadModel,
  createBrain,
};
