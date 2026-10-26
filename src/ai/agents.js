// Specialist evidence agents for RC-Brain.
//
// Why this exists: RC-Brain is a fixed-label classifier with a small feature
// vector. When the vector is *incomplete* (a window is missing but nothing says
// whose window it is, the log is empty, an installer is mid-setup), the model can
// only answer "gather more evidence". This module is what makes that answer real:
// the model's `spawn_agents` action dispatches specialist agents, each of which
// measures ONE thing, and their findings are merged back into the observation
// before the model decides again.
//
// What an agent is NOT:
//   - it is not a language model and it does not plan;
//   - it never receives shell text and never runs a command of its own;
//   - it cannot touch the app: an agent measures and reports, nothing else.
// The probes are supplied by the application (see probeAgents in public/main.js),
// so this file stays pure, testable, and free of platform code.
//
// Agents are addressed by id from a fixed catalogue. A probe may only report the
// signal keys declared for its own agent: anything else is recorded as evidence
// text and ignored as a feature, so a buggy (or hostile) probe cannot invent a
// feature the model was not trained on.

const { FEATURE_NAMES, detectLogSignals } = require('./features');
const knowledge = require('./knowledge.json');
const { createSpecialistRound } = require('./specialists');
const { consult: consultRunbook } = require('./runbook');

// v3 agent features. Every one of them is something an agent measured, plus the
// two bookkeeping flags that keep dispatch bounded.
const AGENT_FEATURES = [
  'agents_available',
  'agents_dispatched',
  'agents_found_new',
  'agent_engine_dead',
  'agent_window_elsewhere',
  'agent_acl_denied',
  'agent_new_exe_present',
  'agent_reparse_link',
  'agent_installer_running',
];

const AGENT_CATALOGUE = [
  {
    id: 'engine',
    label: 'Engine agent',
    purpose: 'Check whether the containment engine (RCVM launcher, AppContainer, VM) is alive and still holds the app.',
    signalKeys: ['engine_dead'],
    basis: 'public/rcvm-runtime.js containment verification; knowledge.backends.*.failureSymptoms',
  },
  {
    id: 'window',
    label: 'Window agent',
    purpose: 'Enumerate the app\'s real windows and say whether a visible window exists at all, or belongs to a host that is not the app.',
    signalKeys: ['window_elsewhere'],
    basis: 'public/behavioral-probe.js EnumWindows/EnumChildWindows walk',
  },
  {
    id: 'process',
    label: 'Process agent',
    purpose: 'List the contained process tree that actually executes from the app folder, and its CPU/IO movement.',
    signalKeys: [],
    basis: 'src/utils/behavioralMonitor.js probeAppBehaviour process tree sum',
  },
  {
    id: 'filesystem',
    label: 'Filesystem agent',
    purpose: 'Measure the app folder: access control entries, free space, and reparse points (junctions) that break recursive work.',
    signalKeys: ['acl_denied', 'reparse_link'],
    basis: 'public/main.js removeSandboxTree link handling and ACL repair',
  },
  {
    id: 'logs',
    label: 'Log agent',
    purpose: 'Read the live log tail and report the signal classes it contains, including text that tries to instruct the monitor.',
    signalKeys: [],
    basis: 'src/ai/features.js LOG_SIGNALS',
  },
  {
    id: 'setup',
    label: 'Setup agent',
    purpose: 'Report whether an installer is staged or running for this app and whether setup has produced a real executable yet.',
    signalKeys: ['new_exe_present', 'installer_running'],
    basis: 'public/main.js install-in-environment + knowledge.lifecycle.install',
  },
  {
    id: 'research',
    label: 'Research agent',
    purpose: 'Search RunContainer\'s own documented knowledge and the incidents already verified on this machine for an explanation of the observed symptom classes. Offline: it never sends an observation anywhere.',
    signalKeys: [],
    kind: 'specialist',
    basis: 'src/ai/knowledge.json (failureDefinitions, normalOperation, prohibitions, backends) + the verified experience store',
  },
  {
    id: 'expert',
    label: 'Expert agent',
    purpose: 'Work through the whole documented rule set over the completed evidence: what the documentation calls normal, backend symptoms, the prohibitions, and the agents\' measurements together. It names what it cannot explain and which measurement would settle it, instead of guessing.',
    signalKeys: [],
    kind: 'specialist',
    basis: 'src/ai/knowledge.json (normalOperation, degradedOperation, backends.*.failureSymptoms, prohibitions)',
  },
  {
    id: 'harmony',
    label: 'Harmony agent',
    purpose: 'Resolve a disagreement between the model and the expert by explicit rules, and refuse to choose when the two conclusions rest on equal evidence and equal risk. It can never make a decision more destructive than the model\'s own proposal.',
    signalKeys: [],
    kind: 'specialist',
    basis: 'src/ai/specialists.js HARMONY_RULES + knowledge.actions risk and approval fields',
  },
];

const AGENT_BY_ID = Object.fromEntries(AGENT_CATALOGUE.map((agent) => [agent.id, agent]));
// The six measuring agents, in catalogue order. Kept as `AGENT_IDS` because the
// model's feature schema, the docs and the interface all address them by it.
const AGENT_IDS = AGENT_CATALOGUE.filter((agent) => (agent.kind || 'evidence') === 'evidence').map((agent) => agent.id);
// The three agents that reason rather than measure. They are dispatched by the
// same `spawn_agents` action, and they are named separately because they never
// produce a feature: their output is a conclusion, not a measurement.
const SPECIALIST_IDS = AGENT_CATALOGUE.filter((agent) => agent.kind === 'specialist').map((agent) => agent.id);
const EVIDENCE_CATALOGUE = AGENT_CATALOGUE.filter((agent) => (agent.kind || 'evidence') === 'evidence');
const SPECIALIST_CATALOGUE = AGENT_CATALOGUE.filter((agent) => agent.kind === 'specialist');

// Routing is deterministic and driven by what is MISSING from the observation,
// never by a guess about the cause. Each rule names the evidence gap it closes.
function routeAgents({ observation = {}, diagnosisId = null, history = {}, maxAgents = 3 } = {}) {
  const process = observation.process || {};
  const app = observation.app || {};
  const logs = Array.isArray(observation.logLines) ? observation.logLines : [];
  const requested = [];

  const add = (id) => {
    if (!requested.includes(id)) requested.push(id);
  };

  // Ordered by how much the answer changes the decision, because the cap means
  // the last ones may not be dispatched at all.
  // 1. The engine is the one component whose death invalidates every other
  //    reading: an app whose engine is gone needs no window measurement.
  if (process.engineResponsive === false || diagnosisId === 'engine_unresponsive') add('engine');
  // 2. A window is expected and none is visible: whose window is it, and is the
  //    process even alive?
  if (process.windowExpected && !process.windowVisible) {
    add('window');
    if (Number(process.pidCount) > 0 || process.alive !== false) add('process');
  }
  // 3. A launch that never became Running, or an app in setup, is a setup question.
  if (['Launching', 'Installed'].includes(String(app.status)) || diagnosisId === 'installer_failed' || history.installerPending) {
    add('setup');
  }
  // 4. Nothing in the log at all: read it directly, because there is nothing to
  //    classify yet.
  if (logs.length === 0) add('logs');
  // 5. A failing app with no explanation is a folder question: ACLs, space, links.
  if (diagnosisId === 'unknown_failure' || diagnosisId === 'permission_denied' || diagnosisId === 'disk_exhausted') {
    add('filesystem');
  }
  // 6. A live app whose window Windows says is not responding: measure both the
  //    process and the window, because "not responding" and "gone" differ.
  if (process.hung) {
    add('process');
    add('window');
  }

  return requested.slice(0, Math.max(1, Math.min(AGENT_IDS.length, maxAgents)));
}

function signalNameFor(agent, key) {
  return `agent_${key}`;
}

function clampText(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// One probe's answer, normalised. A probe that reports a signal it does not own,
// or a value that is not a boolean, is ignored for the feature vector and kept
// only as text: the model must never receive a feature outside its schema.
function normalizeFinding(agent, raw) {
  const findings = raw && typeof raw === 'object' ? raw : {};
  const facts = (Array.isArray(findings.facts) ? findings.facts : [])
    .map((fact) => clampText(fact))
    .filter(Boolean)
    .slice(0, 6);
  const signals = {};
  const ignored = [];
  const reported = findings.signals && typeof findings.signals === 'object' ? findings.signals : {};
  for (const [key, value] of Object.entries(reported)) {
    if (!agent.signalKeys.includes(key)) {
      ignored.push(key);
      continue;
    }
    if (typeof value !== 'boolean') {
      ignored.push(key);
      continue;
    }
    signals[key] = value;
  }
  if (ignored.length > 0) {
    facts.push(`the ${agent.label} reported fields outside its declared signals (${ignored.join(', ')}), which were not used`);
  }
  return { signals, facts, ignored };
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms} ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// The consolidated report. Facts are statements a person can check; they are
// shown next to the diagnosis in the interface.
function buildReport(agents) {
  const facts = [];
  for (const agent of agents) {
    if (!agent.ok) {
      facts.push(`${agent.label} could not report: ${agent.reason}`);
      continue;
    }
    for (const fact of agent.facts) facts.push(`${agent.label}: ${fact}`);
  }
  return { facts, spawned: agents.map((agent) => agent.id) };
}

function agentFeatureValues(agents, { dispatched = true, available = true } = {}) {
  const values = Object.fromEntries(AGENT_FEATURES.map((name) => [name, 0]));
  values.agents_available = available ? 1 : 0;
  values.agents_dispatched = dispatched ? 1 : 0;
  const answered = agents.filter((agent) => agent.ok);
  if (dispatched && answered.length > 0) values.agents_found_new = 1;
  for (const agent of answered) {
    for (const [key, value] of Object.entries(agent.signals)) {
      const name = signalNameFor(agent, key);
      if (FEATURE_NAMES.includes(name)) values[name] = value ? 1 : 0;
    }
  }
  return values;
}

function createAgentCoordinator({
  probes = {},
  logger = () => {},
  now = () => Date.now(),
  timeoutMs = 5000,
} = {}) {
  const catalogue = EVIDENCE_CATALOGUE.map((agent) => ({ ...agent, available: typeof probes[agent.id] === 'function' }));
  const round = createSpecialistRound({ knowledge });

  // Dispatches the routed agents in parallel, each one boxed by its own timeout.
  // A probe that throws, hangs or is missing becomes an honest "could not
  // report" line: one broken agent never hides the others' evidence.
  async function dispatch({ observation = {}, diagnosisId = null, history = {}, maxAgents = 3, dispatchedBefore = false } = {}) {
    const startedAt = now();
    const selectedIds = routeAgents({ observation, diagnosisId, history, maxAgents });
    const selected = selectedIds.map((id) => AGENT_BY_ID[id]).filter(Boolean);

    const agents = await Promise.all(selected.map(async (agent) => {
      const probe = probes[agent.id];
      if (typeof probe !== 'function') {
        return { id: agent.id, label: agent.label, ok: false, reason: 'no probe is registered in this build', signals: {}, facts: [] };
      }
      const agentStartedAt = now();
      try {
        const raw = await withTimeout(Promise.resolve(probe({ observation, diagnosisId, history })), timeoutMs, agent.label);
        const { signals, facts } = normalizeFinding(agent, raw);
        return {
          id: agent.id,
          label: agent.label,
          ok: true,
          durationMs: now() - agentStartedAt,
          signals,
          facts,
          detail: raw?.detail ? clampText(raw.detail) : null,
        };
      } catch (error) {
        logger(`${agent.label} failed: ${error.message}`);
        return { id: agent.id, label: agent.label, ok: false, reason: error.message, signals: {}, facts: [] };
      }
    }));

    const report = buildReport(agents);
    const features = agentFeatureValues(agents, { dispatched: true, available: true });
    const answered = agents.filter((agent) => agent.ok);
    const signalOf = (id, key) => Boolean(answered.find((agent) => agent.id === id)?.signals?.[key]);
    return {
      dispatchedAt: new Date(now()).toISOString(),
      durationMs: now() - startedAt,
      dispatchedBefore: Boolean(dispatchedBefore),
      agents,
      report,
      facts: report.facts,
      features,
      // The same measurements in the shape the observation encoder reads, so the
      // second analysis sees the completed evidence rather than a list of text.
      signals: {
        engineDead: signalOf('engine', 'engine_dead'),
        windowElsewhere: signalOf('window', 'window_elsewhere'),
        aclDenied: signalOf('filesystem', 'acl_denied'),
        newExePresent: signalOf('setup', 'new_exe_present'),
        reparseLink: signalOf('filesystem', 'reparse_link'),
        installerRunning: signalOf('setup', 'installer_running'),
        foundNew: answered.length > 0,
      },
      // How the coordinator changed the evidence. Only additive measurements.
      observationPatch: { environment: { ...(observation.environment || {}), agentFindings: report.facts.slice(0, 8) }, agentFeatures: features },
    };
  }

  const specialistCatalogue = SPECIALIST_CATALOGUE.map((agent) => ({ ...agent }));

  // The model's two tools. `spawn_agents` measures, then asks the specialists;
  // `consult_runbook` asks the hard-coded table for an exact documented
  // signature. Both take no argument the model can write, both are bounded, and
  // neither can touch the app.
  async function dispatchTool({
    toolId = 'spawn_agents',
    observation = {},
    diagnosisId = null,
    history = {},
    maxAgents = 3,
    model = {},
    experiences = [],
  } = {}) {
    const logs = Array.isArray(observation.logLines) ? observation.logLines : [];
    const signals = detectLogSignals(logs);
    const evidence = Array.isArray(model.evidence) ? model.evidence : [];

    // The hard-coded table is consulted first in both rounds: it is pure, it
    // costs microseconds, and an exact signature it recognises is quoted
    // evidence rather than an inference.
    const runbook = consultRunbook({ observation, evidence });

    // A match ends the round - there is nothing left to measure. Choosing the
    // wrong tool is therefore never fatal: the agents still run, in the same
    // round and against the same budget, when the table has no answer.
    const measure = toolId === 'spawn_agents' || !runbook.matched;
    const dispatchResult = measure
      ? await dispatch({ observation, diagnosisId, history, maxAgents, dispatchedBefore: false })
      : null;

    const specialist = await round.run({
      toolId,
      observation,
      signals,
      agentSignals: dispatchResult?.signals || {},
      agentFacts: dispatchResult?.facts || [],
      evidence,
      model,
      experiences,
      runbook,
    });

    return {
      ...(dispatchResult || { agents: [], facts: [], report: { facts: [], spawned: [] }, signals: {}, features: {}, durationMs: 0 }),
      toolId,
      measured: measure,
      runbook,
      specialist,
      arbitration: specialist.arbitration,
      // One honest list for the interface: what was measured, and what the
      // specialists concluded, with the source of each line.
      facts: [...((dispatchResult?.facts) || []), ...specialist.facts],
    };
  }

  return { catalogue, specialistCatalogue, specialists: specialistCatalogue, dispatch, dispatchTool };
}

module.exports = {
  AGENT_CATALOGUE,
  EVIDENCE_CATALOGUE,
  SPECIALIST_CATALOGUE,
  AGENT_BY_ID,
  AGENT_IDS,
  SPECIALIST_IDS,
  AGENT_FEATURES,
  routeAgents,
  normalizeFinding,
  buildReport,
  agentFeatureValues,
  createAgentCoordinator,
};
