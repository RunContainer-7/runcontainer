// Verified experience store for RC-Brain.
//
// This is the honest part of "learning from experience":
//   - it stores what the model predicted, what was actually executed, and what
//     an independent verifier observed afterwards;
//   - it keeps only sanitised evidence (no paths, user names, hosts, emails,
//     IPs or raw log dumps) and lives locally under the app's userData folder;
//   - it can promote *verified* outcomes into a curated dataset;
//   - it never changes model weights. Turning curated examples into a new model
//     is a separate, offline, gated process (scripts/train-ai-candidate.js).
//
// Memory (this history), retrieval (showing a similar past incident), dataset
// curation and weight retraining are four different things and the UI says so.
//
// Log text is untrusted data. It is stored as evidence, never as instructions.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const knowledge = require('./knowledge.json');

const SCHEMA = 'runcontainer.brain.experience.v1';
const CURATED_SCHEMA = 'runcontainer.brain.curated.v1';
const FILE_NAME = 'rc-brain-experiences.jsonl';
const CURATED_FILE = 'rc-brain-curated.json';
const MAX_ENTRIES = 300;
const MAX_EVIDENCE = 8;
const MAX_TEXT = 200;
const MAX_SNIPPET = 280;
const OUTCOMES = new Set(['success', 'failure', 'inconclusive', 'user_corrected']);

const DIAGNOSIS_IDS = new Set(knowledge.diagnoses.map((entry) => entry.id));
const ACTION_IDS = new Set(knowledge.actions.map((entry) => entry.id));

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same redaction rules as the telemetry logger: keep the failure readable,
// remove anything that identifies a person or a machine.
function scrubText(value, { username = '', hostname = '', maxLength = MAX_TEXT } = {}) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(/[A-Za-z]:\\(?:[^\\\s"']+\\?)+/g, '<path>');
  text = text.replace(/\\\\[^\\\s"']+\\[^\s"']+/g, '<path>');
  text = text.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>');
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
  text = text.replace(/https?:\/\/\S+/gi, '<url>');
  if (username) text = text.replace(new RegExp(escapeRegExp(username), 'gi'), '<user>');
  if (hostname) text = text.replace(new RegExp(escapeRegExp(hostname), 'gi'), '<host>');
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text;
}

function featuresBucket(features) {
  if (!Array.isArray(features)) return null;
  const rounded = features.map((value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
  });
  return crypto.createHash('sha256').update(rounded.join(',')).digest('hex').slice(0, 20);
}

function sanitizeFeatures(features) {
  if (!Array.isArray(features)) return null;
  if (features.length === 0) return null;
  return features.map((value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
  });
}

function experiencePath(dir) {
  return path.join(dir, FILE_NAME);
}

function curatedPath(dir) {
  return path.join(dir, CURATED_FILE);
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (error) { return null; }
      })
      .filter((entry) => entry && entry.schema === SCHEMA);
  } catch (error) {
    return [];
  }
}

function writeJsonLines(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
}

function readCurated(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(curatedPath(dir), 'utf8'));
    if (raw?.schema === CURATED_SCHEMA && Array.isArray(raw.examples)) return raw;
  } catch (error) {
    // A missing or corrupt curated file simply means no examples are promoted.
  }
  return { schema: CURATED_SCHEMA, createdAt: null, examples: [] };
}

function writeCurated(dir, curated) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(curatedPath(dir), JSON.stringify(curated, null, 2), 'utf8');
}

function createExperienceStore({
  dir,
  now = () => Date.now(),
  username = '',
  hostname = '',
  logger = () => {},
} = {}) {
  if (!dir) throw new Error('The experience store needs a directory.');

  function all() {
    return readJsonLines(experiencePath(dir)).slice(-MAX_ENTRIES);
  }

  function record({
    observation = {},
    decision = {},
    execution = {},
    verification = {},
    outcome,
  } = {}) {
    const diagnosisId = decision.diagnosis?.id || decision.diagnosisId || null;
    const actionId = execution.actionId || decision.action?.id || null;
    if (!DIAGNOSIS_IDS.has(diagnosisId) || !ACTION_IDS.has(actionId)) {
      return { stored: false, reason: 'unknown-label' };
    }
    // Only independently verified outcomes can later become training labels.
    // Everything else is history, useful for the user but not for weights.
    const normalizedOutcome = OUTCOMES.has(outcome)
      ? outcome
      : verification.status === 'verified' ? 'success' : verification.status === 'unresolved' ? 'failure' : 'inconclusive';

    const evidence = (Array.isArray(decision.evidence) ? decision.evidence : [])
      .slice(0, MAX_EVIDENCE)
      .map((item) => scrubText(item, { username, hostname }))
      .filter(Boolean);
    const logLines = (Array.isArray(observation.logLines) ? observation.logLines : [])
      .slice(-6)
      .map((line) => scrubText(line, { username, hostname, maxLength: 120 }))
      .filter(Boolean);

    const entry = {
      schema: SCHEMA,
      id: crypto.randomUUID(),
      at: new Date(now()).toISOString(),
      model: {
        id: decision.model?.id || 'unknown',
        version: decision.model?.version || 'unknown',
      },
      app: {
        name: scrubText(observation.app?.name || 'App', { username, hostname, maxLength: 80 }),
        engine: scrubText(observation.app?.engine || 'auto', { maxLength: 24 }),
      },
      diagnosis: {
        id: diagnosisId,
        confidence: Number.isFinite(Number(decision.diagnosis?.confidence)) ? Number(decision.diagnosis.confidence) : null,
        evidence,
      },
      action: {
        id: actionId,
        requiresApproval: Boolean(decision.action?.requiresApproval),
        justification: scrubText(decision.reason || decision.explanation || '', { username, hostname }),
      },
      execution: {
        performed: Boolean(execution.performed),
        completed: Boolean(execution.completed),
        error: scrubText(execution.error || '', { username, hostname }),
        steps: (Array.isArray(execution.steps) ? execution.steps : []).slice(0, 6)
          .map((step) => scrubText(step, { username, hostname, maxLength: 120 })),
      },
      verification: {
        status: ['verified', 'unresolved', 'inconclusive', 'not_applicable', 'new_problem'].includes(verification.status)
          ? verification.status
          : 'inconclusive',
        checks: (Array.isArray(verification.checks) ? verification.checks : []).slice(0, 8).map((check) => ({
          name: String(check.name || 'check').slice(0, 60),
          ok: Boolean(check.ok),
          detail: scrubText(check.detail || '', { username, hostname, maxLength: 120 }),
        })),
        observedChecks: Number(verification.observedChecks || 0),
      },
      observed: {
        windowExpected: Boolean(observation.process?.windowExpected),
        windowVisible: Boolean(observation.process?.windowVisible),
        hung: Boolean(observation.process?.hung),
        cpuPercent: Number(observation.process?.cpuPercent || 0),
        engineResponsive: observation.process?.engineResponsive !== false,
        logSnippet: logLines.slice(-2),
      },
      outcome: normalizedOutcome,
      untrustedLogContent: true,
      labelsLocked: verification.status !== 'verified' && verification.status !== 'unresolved',
      features: sanitizeFeatures(decision.features),
      featuresBucket: featuresBucket(decision.features),
      promoted: false,
    };

    const entries = all();
    const duplicate = entries.find((item) => item.featuresBucket === entry.featuresBucket
      && item.diagnosis.id === entry.diagnosis.id
      && item.action.id === entry.action.id
      && Math.abs(new Date(item.at).getTime() - now()) < 6 * 60 * 60 * 1000);
    if (duplicate) return { stored: false, reason: 'duplicate', entry: duplicate };

    writeJsonLines(experiencePath(dir), [...entries, entry].slice(-MAX_ENTRIES));
    return { stored: true, entry };
  }

  function list({ limit = 20, verifiedOnly = false } = {}) {
    const entries = all().slice().reverse();
    return (verifiedOnly ? entries.filter((entry) => ['success', 'failure'].includes(entry.outcome)) : entries).slice(0, limit);
  }

  function stats() {
    const entries = all();
    return {
      total: entries.length,
      verified: entries.filter((entry) => entry.outcome === 'success').length,
      failed: entries.filter((entry) => entry.outcome === 'failure').length,
      inconclusive: entries.filter((entry) => entry.outcome === 'inconclusive').length,
      promoted: entries.filter((entry) => entry.promoted).length,
      pendingPromotion: entries.filter((entry) => entry.labelsLocked === false && !entry.promoted).length,
      outcomesLocked: entries.filter((entry) => entry.labelsLocked).length,
    };
  }

  function promote(ids, { consent = false } = {}) {
    if (!consent) return { promoted: 0, reason: 'consent-required' };
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    const entries = all();
    const eligible = entries.filter((entry) => wanted.has(entry.id)
      && entry.labelsLocked === false
      && Array.isArray(entry.features)
      && (entry.outcome === 'success' || entry.outcome === 'failure' || entry.outcome === 'user_corrected'));
    if (eligible.length === 0) return { promoted: 0, reason: 'no-verified-examples' };

    const curated = readCurated(dir);
    const existingKeys = new Set(curated.examples.map((example) => `${example.featuresBucket}/${example.diagnosis}/${example.action}`));
    const additions = [];
    for (const entry of eligible) {
      const key = `${entry.featuresBucket}/${entry.diagnosis.id}/${entry.action.id}`;
      // A verified failure is only a trustworthy label if we know what the
      // correct answer was; without a user correction it teaches "this
      // diagnosis was wrong", which is not the same thing. Only successes and
      // explicit user corrections become labels.
      if (entry.outcome === 'failure' && !entry.userCorrected) continue;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      additions.push({
        schema: 'runcontainer.brain.example.v1',
        source: 'verified-experience',
        provenance: `local experience ${entry.id}`,
        at: entry.at,
        features: entry.features,
        featuresBucket: entry.featuresBucket,
        diagnosis: entry.userCorrected?.diagnosis || entry.diagnosis.id,
        action: entry.userCorrected?.action || entry.action.id,
        outcome: entry.outcome,
      });
    }
    if (additions.length === 0) return { promoted: 0, reason: 'nothing-eligible' };

    writeCurated(dir, {
      schema: CURATED_SCHEMA,
      createdAt: new Date(now()).toISOString(),
      consent: true,
      examples: [...curated.examples, ...additions].slice(-500),
    });
    const promotedIds = new Set(eligible.map((entry) => entry.id));
    writeJsonLines(experiencePath(dir), entries.map((entry) => (promotedIds.has(entry.id) ? { ...entry, promoted: true } : entry)));
    return { promoted: additions.length, total: curated.examples.length + additions.length };
  }

  function correct(id, { diagnosis, action, note = '' } = {}) {
    if (!DIAGNOSIS_IDS.has(diagnosis) || !ACTION_IDS.has(action)) return { updated: false, reason: 'unknown-label' };
    const entries = all();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return { updated: false, reason: 'not-found' };
    entries[index] = {
      ...entries[index],
      outcome: 'user_corrected',
      labelsLocked: false,
      userCorrected: {
        diagnosis,
        action,
        note: scrubText(note, { username, hostname }),
        at: new Date(now()).toISOString(),
      },
    };
    writeJsonLines(experiencePath(dir), entries);
    return { updated: true, entry: entries[index] };
  }

  // Retrieval is context, not evidence. Distances are over the model's own
  // observation features; the caller shows them next to the current diagnosis
  // and never merges them into the input vector.
  function retrieve({ features, k = 3 } = {}) {
    if (!Array.isArray(features)) return [];
    const scored = all()
      .filter((entry) => Array.isArray(entry.features) && entry.features.length === features.length)
      .filter((entry) => ['success', 'failure', 'user_corrected'].includes(entry.outcome))
      .map((entry) => {
        let sum = 0;
        for (let index = 0; index < features.length; index += 1) {
          const delta = Number(features[index]) - Number(entry.features[index]);
          sum += delta * delta;
        }
        return {
          id: entry.id,
          at: entry.at,
          distance: Number(Math.sqrt(sum).toFixed(3)),
          diagnosis: entry.userCorrected?.diagnosis || entry.diagnosis.id,
          action: entry.userCorrected?.action || entry.action.id,
          outcome: entry.outcome,
          verified: Boolean(entry.outcome === 'success' || entry.outcome === 'failure'),
          app: entry.app?.name || 'App',
        };
      })
      .sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k);
  }

  function clear() {
    try { fs.unlinkSync(experiencePath(dir)); } catch (error) { /* already gone */ }
    return { cleared: true };
  }

  function curated() {
    return readCurated(dir);
  }

  return {
    dir,
    record,
    list,
    all,
    stats,
    promote,
    correct,
    retrieve,
    clear,
    curated,
    paths: { experiences: experiencePath(dir), curated: curatedPath(dir) },
  };
}

module.exports = {
  SCHEMA,
  CURATED_SCHEMA,
  FILE_NAME,
  CURATED_FILE,
  MAX_ENTRIES,
  scrubText,
  featuresBucket,
  sanitizeFeatures,
  readCurated,
  writeCurated,
  createExperienceStore,
};
