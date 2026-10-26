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
const { AGENT_CATALOGUE, AGENT_IDS, SPECIALIST_IDS, createAgentCoordinator } = require('./agents');
const { createResearcher, createExpert, createHarmony } = require('./specialists');
const { consult: consultRunbook } = require('./runbook');
const { validateNetwork, runNetwork } = require('./inference');
const { gateDecision } = require('./policy');

const MODEL_DIR = path.join(__dirname, 'model');
const REGISTRY_PATH = path.join(MODEL_DIR, 'registry.json');
const MODEL_SCHEMA = 'runcontainer.brain.v2';
// The fallback is not a fixed file name: a build whose registry has gone missing
// must still load the newest model on disk rather than a hard-coded older one. A
// stale fallback would quietly hand the monitor a model trained without the
// agents' features, which is exactly the silent degradation the registry exists
// to prevent.
function shippedModelFiles(dir = MODEL_DIR) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^rc-brain-\d+\.json$/.test(name))
      .sort((a, b) => Number(b.match(/(\d+)/)[1]) - Number(a.match(/(\d+)/)[1]));
  } catch (error) {
    return [];
  }
}

function resolveFallbackModel(dir = MODEL_DIR) {
  const files = shippedModelFiles(dir);
  return path.join(dir, files[0] || 'rc-brain-4.json');
}

const FALLBACK_MODEL = resolveFallbackModel();
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

// A model trained on a PREFIX of this build's features is still usable: it knows
// fewer things, but every feature it knows is in the same position, so its input
// vector is simply the first N values. This is what makes rollback real - after a
// retrain adds features, the previous artefact remains a loadable, decision-making
// model instead of an artefact the loader rejects. Everything else about the
// schema must match exactly, including the order of the names.
function featurePrefixOf(raw) {
  if (!Array.isArray(raw.featureSchema)) return null;
  if (raw.featureSchema.length > FEATURE_NAMES.length) return null;
  for (let index = 0; index < raw.featureSchema.length; index += 1) {
    if (raw.featureSchema[index] !== FEATURE_NAMES[index]) return null;
  }
  return raw.featureSchema.length;
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
  const featureCount = featurePrefixOf(raw);
  if (featureCount === null) {
    return { available: false, error: 'The RC-Brain model was trained with a different feature schema than this build expects.' };
  }
  if (!raw.nets?.diagnosis || !raw.nets?.action) {
    return { available: false, error: 'The RC-Brain model is missing one of its networks.' };
  }
  try {
    validateNetwork(raw.nets.diagnosis, 'diagnosis network');
    validateNetwork(raw.nets.action, 'action network');
    if (raw.nets.diagnosis.sizes[0] > featureCount || raw.nets.action.sizes[0] !== featureCount + DIAGNOSES.length) {
      return { available: false, error: 'The RC-Brain model\u2019s networks do not match the feature schema it declares.' };
    }
    return {
      available: true,
      path: resolvedPath,
      featureCount,
      meta: {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        createdAt: raw.createdAt,
        parameters: raw.parameterCount,
        features: raw.featureSchema.length,
        modelsBuildFeatures: FEATURE_NAMES.length,
        featureSchemaPrefix: featureCount < FEATURE_NAMES.length,
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
          // The model can ask for the specialist evidence agents. It chooses
          // WHICH of the fixed agents to dispatch and nothing else about them.
          spawnAgents: true,
          specialistAgents: AGENT_IDS,
          // The second tier: the agents that reason over the completed evidence
          // and resolve a disagreement, and the hard-coded table that answers an
          // exact documented signature. None of them is a neural network.
          reasoningAgents: SPECIALIST_IDS,
          tools: ['spawn_agents', 'consult_runbook'],
        },
      },
      thresholds: raw.thresholds,
      temperature: raw.calibration?.temperature || 1,
      // A model that predates some of this build's features (a rollback target,
      // for example) reads only the prefix it was trained on. Both networks take
      // the same width, so the same slice feeds both.
      fromFeatures: (values) => values.slice(0, featureCount),
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
    // Only the features this artefact was trained on; see featurePrefixOf.
    const features = loaded.fromFeatures(encoded.values);
    // History arrives as a separate argument from the supervisor and is also
    // embedded in the observation for stored/replayed cases; merge both.
    const historyState = { ...(observation?.history || {}), ...(history || {}) };
    const probabilities = softmax(runNetwork(loaded.nets.diagnosis, features, 'diagnosis network'), loaded.temperature);
    const ranked = topTwo(probabilities);
    const confidence = ranked[0]?.[1] || 0;
    const margin = confidence - (ranked[1]?.[1] || 0);
    const uncertain = confidence < loaded.thresholds.confidence || margin < loaded.thresholds.margin;
    const diagnosisId = uncertain ? 'unknown_failure' : ranked[0][0];
    const diagnosis = DIAGNOSIS_BY_ID[diagnosisId] || { id: diagnosisId, summary: 'Unrecognised diagnosis.' };

    const actionInput = [...features, ...DIAGNOSES.map((label) => (label === diagnosisId ? 1 : 0))];
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

  // The model's second half. After the two tools have run, the harmony agent may
  // have arrived at a different conclusion than the model did. That conclusion is
  // NOT applied here as a new truth: it is offered to the same safety policy the
  // model's own proposal goes through, so every invariant that protects the user
  // (never repair what is normal, never retry a declined repair, never obey log
  // text, never exceed the repair budget) still holds. Arbitration can change
  // which safe thing happens; it can never make one happen that policy forbids.
  function applyArbitration(decision, arbitration, { history = {}, injection = false } = {}) {
    if (!decision?.available || !arbitration?.action) return decision;
    const summary = arbitration.summary || arbitration.reason || 'The specialist agents were consulted.';
    const view = {
      verdict: arbitration.verdict,
      conflict: Boolean(arbitration.conflict),
      conflicts: arbitration.conflicts || [],
      rules: arbitration.rules || [],
      reason: summary,
      expert: arbitration.expertSummary || null,
      research: arbitration.researchSummary || null,
      runbook: arbitration.runbookSummary || null,
    };

    const candidate = ACTION_BY_ID[arbitration.action];
    const diagnosisId = arbitration.diagnosis || decision.diagnosis?.id || 'unknown_failure';
    if (!candidate) {
      return { ...decision, arbitration: { ...view, outcome: 'ignored-invalid-action' } };
    }

    // Agreement needs no new decision, only a note that it happened.
    if (candidate.id === decision.action?.id && diagnosisId === decision.diagnosis?.id) {
      return { ...decision, arbitration: { ...view, outcome: 'agreed' } };
    }

    const gate = gateDecision({
      diagnosisId,
      action: { ...candidate, id: candidate.id },
      confidence: decision.diagnosis?.confidence ?? 0.5,
      uncertain: false,
      history: { ...history, ...(decision.history || {}) },
      injection,
    });
    const diagnosis = DIAGNOSIS_BY_ID[diagnosisId] || { id: diagnosisId, summary: 'Unrecognised diagnosis.' };
    const changed = gate.action.id !== decision.action?.id || diagnosisId !== decision.diagnosis?.id;

    return {
      ...decision,
      diagnosis: {
        ...(decision.diagnosis || {}),
        id: diagnosisId,
        summary: diagnosis.summary,
        arbitration: view.verdict,
      },
      action: {
        id: gate.action.id,
        label: gate.action.label,
        description: gate.action.description,
        risk: gate.action.risk,
        autonomous: Boolean(gate.action.autonomous) && !gate.action.requiresApproval,
        requiresApproval: Boolean(gate.action.requiresApproval),
      },
      decision: gate.decision,
      reason: `${summary} ${gate.reason}`,
      explanation: `${summary} ${gate.reason}`,
      uncertain: false,
      arbitration: { ...view, outcome: changed ? `applied:${gate.decision}` : 'agreed' },
    };
  }

  return {
    available: loaded.available,
    error: loaded.available ? null : loaded.error,
    model: loaded.available ? loaded.meta : null,
    registry,
    analyze,
    applyArbitration,
  };
}

// The three reasoning agents and the hard-coded table, for callers that want to
// ask them directly (the monitor asks them through the coordinator).
function createSpecialists(knowledgeOverrides = {}) {
  const merged = { ...knowledge, ...knowledgeOverrides };
  return {
    researcher: createResearcher({ knowledge: merged }),
    expert: createExpert({ knowledge: merged }),
    harmony: createHarmony({ knowledge: merged }),
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
  AGENT_CATALOGUE,
  softmax,
  readRegistry,
  resolveModelPath,
  resolveFallbackModel,
  shippedModelFiles,
  featurePrefixOf,
  loadModel,
  createAgentCoordinator,
  createBrain,
  createSpecialists,
  consultRunbook,
};
