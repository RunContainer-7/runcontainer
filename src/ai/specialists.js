// The three specialist agents RC-Brain can ask for help.
//
// What these are, and what they are NOT. None of them is a language model, and
// none of them is a second neural network. They are deterministic reasoning over
// RunContainer's own documents (knowledge.json), over the measurements the
// evidence agents just took, and over what the model itself decided. That is
// deliberate: a small classifier is bad at saying WHY, and an "agent" that
// invented an explanation would be worse than no explanation at all. Everything
// these agents return can be traced to a document or to a measurement.
//
// The three, and the problem each one solves:
//
//   research agent  - "has RunContainer documented this before?" It searches the
//                     bundled knowledge base and the store of previously
//                     verified incidents, OFFLINE. It never sends anything to
//                     the internet: a web search would mean shipping the user's
//                     log text to a third party, which is a product decision,
//                     not a monitor decision.
//   expert agent    - "does the whole documented rule set explain this, and does
//                     it know something the model's feature vector cannot
//                     express?" It works through normal-operation rules (what
//                     must NOT be repaired), backend symptoms, prohibitions and
//                     the agents' measurements together, and it names the
//                     evidence it is missing instead of guessing.
//   harmony agent   - "the model and the expert disagree - what is the
//                     conclusion?" It resolves the disagreement by explicit
//                     rules, and when it cannot, it says so rather than picking
//                     a side. It can never make a decision more destructive than
//                     the model's own proposal.
//
// Every one of them is read-only, takes no argument the model can write, and can
// only ever produce a decision that still has to pass the safety policy in
// src/ai/policy.js before anything happens.

const { consult: consultRunbook, agreesWith } = require('./runbook');

const RISK_RANK = { none: 0, low: 1, medium: 2, high: 3 };

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

function actionTable(knowledge) {
  return Object.fromEntries((knowledge.actions || []).map((action) => [action.id, action]));
}

function defaultActionFor(knowledge, diagnosisId) {
  const entry = (knowledge.diagnoses || []).find((diagnosis) => diagnosis.id === diagnosisId);
  return entry ? entry.action : null;
}

function riskOf(knowledge, actionId) {
  const actions = actionTable(knowledge);
  const action = actions[actionId];
  if (!action) return 0;
  return RISK_RANK[action.risk] ?? 0;
}

// Destructive means "can lose the user's data", not "risky": that is what the
// arbitration order protects.
function isDestructive(knowledge, actionId) {
  const actions = actionTable(knowledge);
  const action = actions[actionId];
  return Boolean(action && (action.requiresApproval || action.risk === 'high'));
}

// ---------------------------------------------------------------------------
// Research agent: search RunContainer's own documents, offline
// ---------------------------------------------------------------------------

const SIGNAL_QUESTIONS = {
  missingRuntime: /runtime|redistributable|vcruntime|msvcp|ucrt|dll/i,
  unhandledCrash: /crash|fatal|exception|access violation/i,
  accessDenied: /permission|access denied|write/i,
  diskFull: /disk|space/i,
  networkIssue: /network|offline|firewall|connection/i,
  timeout: /timeout|responding|hang/i,
  crashLoop: /repeat|loop|keeps failing/i,
  unsupported: /unsupported|not available|requires/i,
  installerFailed: /install|setup/i,
  corruptProfile: /profile|corrupt|configuration/i,
  sideBySide: /side-by-side|runtime|assembly/i,
  gpuDriver: /graphics|driver|display/i,
  fileLocked: /locked|in use|holding/i,
  rebootRequired: /restart|reboot/i,
  injection: /untrusted|instruction|log text/i,
};

function createResearcher({ knowledge, limit = 4 } = {}) {
  // The corpus is built once: document strings plus the rule that tells the
  // researcher which question a hit answers.
  const corpus = [
    ...(knowledge.failureDefinitions || []).map((text) => ({ source: 'failureDefinitions', text })),
    ...(knowledge.normalOperation || []).map((text) => ({ source: 'normalOperation', text })),
    ...(knowledge.prohibitions || []).map((text) => ({ source: 'prohibitions', text })),
    ...Object.entries(knowledge.backends || {}).flatMap(([id, backend]) => [
      ...(backend.failureSymptoms || []).map((text) => ({ source: `backends.${id}.failureSymptoms`, text })),
      ...(backend.safeRecovery || []).map((text) => ({ source: `backends.${id}.safeRecovery`, text, recovery: true })),
    ]),
  ];

  function search({ signals = {}, agentSignals = {}, engine = null, diagnosisId = null, experiences = [] } = {}) {
    const asked = [];
    for (const [key, pattern] of Object.entries(SIGNAL_QUESTIONS)) {
      if (signals[key] || agentSignals[key]) asked.push(key);
    }
    const matches = [];
    for (const entry of corpus) {
      const hit = asked.find((key) => SIGNAL_QUESTIONS[key].test(entry.text))
        || (engine && new RegExp(engine, 'i').test(entry.source) ? 'engine' : null);
      if (!hit) continue;
      matches.push({ source: entry.source, text: entry.text, answers: hit, recovery: Boolean(entry.recovery) });
      if (matches.length >= limit) break;
    }

    // Previously verified incidents are evidence too, and they are local: they
    // were confirmed on this machine, not inferred from a document. Entries from
    // the experience store carry nested diagnosis/action objects, so they are
    // normalised here rather than assumed to be strings.
    const similar = [];
    for (const experience of Array.isArray(experiences) ? experiences : []) {
      if (!experience) continue;
      const pastDiagnosis = experience.diagnosis?.id || experience.diagnosis || null;
      const pastAction = experience.action?.id || experience.action || null;
      if (!pastDiagnosis) continue;
      const note = [experience.note, experience.summary, ...(Array.isArray(experience.evidence) ? experience.evidence : [])]
        .filter(Boolean).join(' ');
      const relevant = (diagnosisId && pastDiagnosis === diagnosisId)
        || asked.some((key) => SIGNAL_QUESTIONS[key]?.test(`${pastDiagnosis} ${note}`));
      if (!relevant) continue;
      similar.push({
        id: experience.id || null,
        diagnosis: pastDiagnosis,
        action: pastAction,
        outcome: experience.outcome || null,
        note: note.slice(0, 200),
        verified: experience.outcome === 'success' || experience.verified === true,
      });
      if (similar.length >= 3) break;
    }

    const facts = [];
    if (asked.length === 0) {
      facts.push('nothing in the documentation matches: the observation does not contain a symptom class the knowledge base describes');
    } else {
      facts.push(`${matches.length} documented entr${matches.length === 1 ? 'y' : 'ies'} match the observed symptom classes (${asked.join(', ')})`);
    }
    for (const match of matches.slice(0, 3)) facts.push(`${match.source}: ${match.text}`);
    if (similar.length > 0) {
      facts.push(`${similar.length} earlier incident(s) on this machine look similar: ${similar.map((entry) => `${entry.diagnosis}${entry.action ? `/${entry.action}` : ''}${entry.outcome ? ` (${entry.outcome})` : ''}`).join(', ')}`);
    }

    return {
      agent: 'research',
      searched: ['knowledge.failureDefinitions', 'knowledge.normalOperation', 'knowledge.prohibitions', 'knowledge.backends', 'verified experiences'],
      online: false,
      asked,
      matches,
      similar,
      facts,
      summary: asked.length === 0
        ? 'The documentation was searched and holds nothing for this observation.'
        : `The bundled documentation was searched (offline) and describes ${matches.length} relevant entr${matches.length === 1 ? 'y' : 'ies'}.`,
    };
  }

  return { search };
}

// ---------------------------------------------------------------------------
// Expert agent: the whole documented rule set, plus what the model cannot express
// ---------------------------------------------------------------------------

// States the documentation calls NORMAL. These matter more than the failures:
// repairing one of them is the failure mode the whole product is built to avoid.
function normalStateTests(knowledge) {
  return [
    {
      id: 'console_or_headless',
      diagnosis: 'console_headless',
      action: 'none',
      documented: 'knowledge.normalOperation: a console tool may run with no window; that is not a failure',
      when: (ctx) => ctx.windowExpected === false && ctx.alive !== false,
    },
    {
      id: 'still_starting',
      diagnosis: 'starting_slow',
      action: 'wait',
      documented: 'knowledge.degradedOperation: no window yet with the engine still responsive',
      when: (ctx) => ctx.alive !== false && ctx.engineResponsive !== false
        && ctx.windowExpected !== false && !ctx.windowVisible
        && Number(ctx.ageMs || 0) < 10000,
    },
    {
      id: 'recovered_or_progressing',
      diagnosis: 'healthy',
      action: 'none',
      documented: 'knowledge.normalOperation: repeated progress lines, or crash text from an earlier session, are not a failure while the app is visibly working',
      when: (ctx) => ctx.windowVisible && !ctx.hung && !ctx.agents?.engineDead,
    },
    {
      id: 'host_pressure_only',
      diagnosis: 'healthy',
      action: 'none',
      documented: 'knowledge.normalOperation: host disk or memory pressure is evidence, and is only a failure when the app cannot proceed',
      when: (ctx) => ctx.hostPressure && ctx.alive !== false && ctx.windowVisible,
    },
  ];
}

// Backend symptoms, straight out of the knowledge base. Used when nothing normal
// applies and the engine is the suspect.
const BACKEND_SYMPTOM_PATTERNS = [
  { pattern: /not in job|launcher exited|process not in job/i, diagnosis: 'engine_unresponsive', action: 'restart_engine' },
  { pattern: /window never appears while process spins/i, diagnosis: 'window_hang', action: 'restart_same_profile' },
  { pattern: /acl denies writes|access denied writing/i, diagnosis: 'permission_denied', action: 'repair_permissions' },
  { pattern: /qmp command timed out|guest agent unreachable|qemu process exited|overlay disk missing/i, diagnosis: 'engine_unresponsive', action: 'restart_engine' },
  { pattern: /hyper-v not ready|guest credential missing|vm stopped unexpectedly/i, diagnosis: 'isolation_unsupported', action: 'advise_configuration' },
  { pattern: /container sid missing/i, diagnosis: 'isolation_unsupported', action: 'advise_configuration' },
];

function createExpert({ knowledge } = {}) {
  const normals = normalStateTests(knowledge);

  function assess({
    observation = {},
    signals = {},
    agentSignals = {},
    modelDiagnosis = null,
    modelAction = null,
    evidence = [],
    experiences = [],
  } = {}) {
    const app = observation.app || {};
    const processInfo = observation.process || {};
    const environment = observation.environment || {};
    const history = observation.history || {};
    const ctx = {
      alive: processInfo.alive,
      windowExpected: processInfo.windowExpected,
      windowVisible: Boolean(processInfo.windowVisible),
      hung: Boolean(processInfo.hung),
      engineResponsive: processInfo.engineResponsive,
      ageMs: Number(processInfo.windowAgeMs || observation.launch?.ageMs || 0),
      hostPressure: Boolean(signals.diskFull) || environment.diskFreeBytes !== undefined
        ? Number(environment.diskFreeBytes) < 2 * 1024 ** 3 || Boolean(signals.diskFull)
        : false,
      agents: agentSignals,
      signals,
      history,
      app,
    };

    const reasons = [];
    const unknowns = [];
    const wanted = new Set();
    const exitCode = Number.isSafeInteger(observation.launch?.exitCode) ? observation.launch.exitCode : null;

    // Evidence that something already failed. "The documentation calls this
    // normal" is a strong claim, so it is only available while nothing measured
    // says otherwise: a launch with a non-zero exit code, a dead engine, a denied
    // write, or log text saying the app could not start is not "still starting",
    // however young it looks. Signals that merely sound bad (a network hiccup, a
    // timeout, the word "error") are deliberately NOT in this list: a slow start
    // that logs a warning is still a slow start.
    const failed = (exitCode !== null && exitCode !== 0)
      || Boolean(agentSignals.engineDead)
      || Boolean(agentSignals.aclDenied)
      || Boolean(signals.missingRuntime || signals.unhandledCrash || signals.sideBySide
        || signals.crashLoop || signals.installerFailed || signals.corruptProfile);

    // 1. Anything the documentation calls normal ends the assessment: a repair
    //    here would be the bug, not the fix.
    for (const test of (failed ? [] : normals)) {
      let applies = false;
      try {
        applies = Boolean(test.when(ctx));
      } catch (error) {
        applies = false;
      }
      if (!applies) continue;
      reasons.push(test.documented);
      const disagreement = modelAction && modelAction !== test.action && !['none', 'wait', 'observe', 'spawn_agents'].includes(modelAction);
      return {
        agent: 'expert',
        confidence: 'documented',
        diagnosis: test.diagnosis,
        action: test.action,
        reasons,
        unknowns,
        evidenceUsed: evidence.slice(0, 6),
        experienceUsed: experiences.length,
        disagrees: Boolean(disagreement),
        conflictReason: disagreement
          ? `the documentation describes this as normal behaviour (${test.id}), while the model proposed ${modelAction}`
          : null,
        summary: `The documentation describes this state as normal behaviour (${test.id}), so nothing should be repaired.`,
      };
    }

    // 2. Agent measurements come before symptoms in the log, because a
    //    measurement is about this app and a log line is only text.
    if (agentSignals.engineDead) {
      reasons.push('an agent measured that the engine owning this app is no longer alive');
      return expertVerdict('engine_unresponsive', 'restart_engine', 'documented', reasons, modelDiagnosis, modelAction);
    }
    if (agentSignals.aclDenied) {
      reasons.push('an agent measured a denied write inside the app\u2019s own folder');
      return expertVerdict('permission_denied', 'repair_permissions', 'documented', reasons, modelDiagnosis, modelAction);
    }
    if (agentSignals.installerRunning) {
      reasons.push('an agent measured that this app\u2019s own setup program is still running');
      return expertVerdict('starting_slow', 'wait', 'documented', reasons, modelDiagnosis, modelAction);
    }
    if (agentSignals.newExePresent && !agentSignals.installerRunning) {
      reasons.push('an agent found the executable setup produced, so the staged program has finished its job');
      return expertVerdict('healthy', 'none', 'documented', reasons, modelDiagnosis, modelAction);
    }
    if (agentSignals.windowElsewhere && !agentSignals.engineDead) {
      reasons.push('an agent found a visible window owned outside the host window RunContainer created');
      return expertVerdict('healthy', 'none', 'documented', reasons, modelDiagnosis, modelAction);
    }
    if (agentSignals.reparseLink) {
      reasons.push('an agent found a reparse point inside the app folder; that breaks recursive work but is not by itself a failure');
      unknowns.push('whether the app is failing at all - a link inside the folder is normal after anything is cached');
    }

    // 3. Documented backend symptoms.
    const backend = knowledge.backends?.[app.engine] || null;
    if (backend && (agentSignals.engineDead || processInfo.engineResponsive === false)) {
      for (const symptom of backend.failureSymptoms || []) {
        const match = BACKEND_SYMPTOM_PATTERNS.find((entry) => entry.pattern.test(symptom));
        if (!match) continue;
        reasons.push(`knowledge.backends.${app.engine}.failureSymptoms: ${symptom}`);
        return expertVerdict(match.diagnosis, match.action, 'documented', reasons, modelDiagnosis, modelAction);
      }
    }

    // 4. Nothing normal, nothing measured, no documented backend symptom: say
    //    what is missing and which measurement would close it. This is the
    //    request the expert makes, and it is always a named measurement.
    if (!signals.present) unknowns.push('no output at all: the log is empty, so no symptom class can be read');
    if (observation.launch?.exitCode === null || observation.launch?.exitCode === undefined) unknowns.push('no exit code has been recorded yet');
    if (!agentSignals.foundNew && !history.agentsDispatched) unknowns.push('the components have not been measured yet (engine, window, process, folder, logs, setup)');
    if (ctx.alive !== false && ctx.windowExpected && !ctx.windowVisible) unknowns.push('whether the window is missing or merely late');

    for (const unknown of unknowns) {
      if (/engine/.test(unknown)) wanted.add('engine');
      if (/window/.test(unknown)) wanted.add('window');
      if (/exit code|output|log/.test(unknown)) wanted.add('logs');
    }
    if (wanted.size === 0 && unknowns.length > 0) wanted.add('process');

    return {
      agent: 'expert',
      confidence: unknowns.length > 0 ? 'none' : 'indicative',
      diagnosis: null,
      action: null,
      reasons,
      unknowns,
      wantsMeasurements: [...wanted],
      evidenceUsed: evidence.slice(0, 6),
      experienceUsed: experiences.length,
      disagrees: false,
      conflictReason: null,
      summary: unknowns.length > 0
        ? `The documented rule set does not explain this observation. What is missing: ${unknowns.join('; ')}.`
        : 'The documented rule set recognises the symptom classes but cannot name a single cause from them.',
    };
  }

  function expertVerdict(diagnosis, action, confidence, reasons, modelDiagnosis, modelAction) {
    const disagreement = Boolean(modelAction) && modelAction !== action;
    return {
      agent: 'expert',
      confidence,
      diagnosis,
      action,
      reasons,
      unknowns: [],
      evidenceUsed: [],
      disagrees: disagreement,
      conflictReason: disagreement
        ? `the documentation gives ${diagnosis}/${action} for this evidence, while the model proposed ${modelDiagnosis || 'nothing'}/${modelAction}`
        : null,
      summary: `${reasons.join(' ')} Documented conclusion: ${diagnosis}, ${action}.`,
    };
  }

  return { assess, normals };
}

// ---------------------------------------------------------------------------
// Harmony agent: resolve a disagreement, or admit there is none
// ---------------------------------------------------------------------------

// The rules, in order. They exist so that a disagreement between a small learned
// model and a hand-written rule set has one answer instead of a coin toss.
const HARMONY_RULES = [
  {
    id: 'runbook_exact_signature',
    note: 'A documented signature from the Runbook is quoted evidence, not an inference, so it outranks both a guess and a general rule - unless following it would risk more than the model proposed.',
  },
  {
    id: 'agreement',
    note: 'If the model and the expert name the same action there is no conflict to resolve.',
  },
  {
    id: 'documented_beats_uncertain',
    note: 'A documented conclusion beats the model when the model itself says its evidence was not good enough, or could not name the failure.',
  },
  {
    id: 'measured_beats_unmeasured',
    note: 'A documented conclusion that rests on measurements the model never saw beats a confident model.',
  },
  {
    id: 'least_risk',
    note: 'Two confident, conflicting conclusions: take the one that risks less. If they risk the same, the harmony agent refuses to choose and the incident is reported instead.',
  },
];

function createHarmony({ knowledge } = {}) {
  // `authoritative` is true when the model chose the Runbook as its tool, which
  // makes a match the round's answer. When the model chose the agents instead, a
  // match is still quoted to harmony, but only as the tie-breaker for a real
  // disagreement - the table does not get to overrule a decision nobody doubted.
  function resolve({ model = {}, expert = null, runbook = null, authoritative = false } = {}) {
    const modelAction = model.action || null;
    const modelDiagnosis = model.diagnosis || null;
    const expertAction = expert?.action || null;
    const conflicts = [];

    const conclude = (verdict, diagnosis, action, reason, extra = {}) => {
      // Invariant: arbitration may decide WHICH safe thing happens, because the
      // model asked for this round in the first place - a documented conclusion
      // reached from the agents' own measurements is exactly what the round is
      // for. What it may never do is reach for the user's data: an action that
      // needs approval, or that is destructive, is only available when the model
      // itself already proposed one of those.
      let safeAction = action;
      let safeReason = reason;
      if (safeAction && isDestructive(knowledge, safeAction) && !isDestructive(knowledge, modelAction)) {
        safeAction = modelAction;
        safeReason = `${reason} It was not adopted, because it would risk the app's data while the model proposed nothing that did.`;
        conflicts.push('destructive_upgrade_refused');
      }
      const diagnosisOut = safeAction === action ? diagnosis : modelDiagnosis;
      return {
        agent: 'harmony',
        conflict: Boolean(expert?.disagrees) || Boolean(runbook?.matched && runbook.rule?.action !== modelAction),
        conflicts,
        verdict,
        diagnosis: diagnosisOut || null,
        action: safeAction || modelAction || 'observe',
        reason: safeReason,
        rules: HARMONY_RULES.map((rule) => rule.id),
        summary: safeReason,
      };
    };

    const agree = Boolean(expertAction) && expertAction === modelAction;

    // 1. Ask the Runbook and it answers. That is the whole point of the tool.
    if (runbook?.matched && authoritative) {
      const rule = runbook.rule;
      if (rule.action === modelAction) {
        return conclude('agreement', rule.diagnosis, modelAction,
          `The Runbook matched an exact documented signature (${rule.id}) and it recommends the action the model chose (${rule.action}).`);
      }
      return conclude('runbook', rule.diagnosis, rule.action,
        `The Runbook matched an exact documented signature (${rule.id}: ${rule.label}) and recommends ${rule.diagnosis}/${rule.action}.`);
    }

    if (agree && expert?.confidence === 'documented') {
      return conclude('agreement', expert.diagnosis || modelDiagnosis, modelAction,
        `The model and the expert reached the same action (${modelAction}), so there was nothing to resolve.`);
    }

    if (runbook?.matched) {
      const rule = runbook.rule;
      if (rule.action === modelAction) {
        return conclude('agreement', rule.diagnosis, modelAction,
          `The Runbook matched an exact documented signature (${rule.id}) and it recommends the action the model chose (${rule.action}).`);
      }
      const uncertainty = model.uncertain ? 'the model itself reported uncertain evidence' : 'an exact documented signature is quoted evidence, not an inference';
      return conclude('runbook', rule.diagnosis, rule.action,
        `The Runbook matched an exact documented signature (${rule.id}: ${rule.label}) and recommends ${rule.diagnosis}/${rule.action}; ${uncertainty}.`);
    }

    if (expertAction && expertAction === modelAction) {
      return conclude('agreement', expert.diagnosis || modelDiagnosis, modelAction,
        `The model and the expert reached the same action (${modelAction}), so there was nothing to resolve.`);
    }

    if (expert?.confidence === 'none') {
      return conclude('model', modelDiagnosis, modelAction,
        `The expert could not explain the observation from the documentation (${(expert.unknowns || []).join('; ') || 'no rule applied'}), so the model's own conclusion stands.`);
    }

    if (expert?.confidence === 'documented' && (model.uncertain || !modelDiagnosis || modelDiagnosis === 'unknown_failure')) {
      return conclude('expert', expert.diagnosis, expertAction,
        `The expert's conclusion rests on the documentation (${(expert.reasons || [])[0] || 'a documented rule'}) while the model reported that its evidence was not good enough.`);
    }

    if (expert?.confidence === 'documented' && expertAction !== modelAction) {
      const expertRisk = riskOf(knowledge, expertAction);
      const modelRisk = riskOf(knowledge, modelAction);
      if (expertRisk < modelRisk) {
        return conclude('expert', expert.diagnosis, expertAction,
          `Both the model and the expert are confident but disagree; the expert's conclusion risks less (${expertAction} rather than ${modelAction}), so it is upheld.`);
      }
      if (expertRisk > modelRisk) {
        return conclude('model', modelDiagnosis, modelAction,
          `Both are confident but disagree; the model's action risks less (${modelAction} rather than ${expertAction}), so it is upheld.`);
      }
      return conclude('unresolved', null, 'escalate',
        `The model (${modelDiagnosis}/${modelAction}) and the expert (${expert.diagnosis}/${expertAction}) both rest on evidence and risk the same amount, so no conclusion was forced and the incident is reported instead.`);
    }

    return conclude('model', modelDiagnosis, modelAction,
      'No documented rule applied to the completed evidence, so the model\u2019s conclusion stands.');
  }

  return { resolve };
}

// ---------------------------------------------------------------------------
// The round the model's two tools run in
// ---------------------------------------------------------------------------

// `toolId` is one of the model's two actions:
//   spawn_agents    - measure the components, then ask the specialists for help
//   consult_runbook - ask the hard-coded table for an exact documented signature
function createSpecialistRound({ knowledge, researcher = null, expert = null, harmony = null } = {}) {
  const runbookResearcher = researcher || createResearcher({ knowledge });
  const runbookExpert = expert || createExpert({ knowledge });
  const arbiter = harmony || createHarmony({ knowledge });

  async function run({
    toolId = 'spawn_agents',
    observation = {},
    signals = {},
    agentSignals = {},
    agentFacts = [],
    evidence = [],
    model = {},
    experiences = [],
    agentsWanted = [],
    runbook: providedRunbook = undefined,
  } = {}) {
    // The table is consulted in both rounds: it is pure and costs microseconds,
    // and when the model chose the agents it still settles a disagreement about a
    // documented signature.
    const authoritative = toolId === 'consult_runbook';
    const runbook = providedRunbook !== undefined
      ? providedRunbook
      : consultRunbook({ observation, evidence });

    // The research agent is cheap and offline, so it runs for either tool: it is
    // how the user is told whether RunContainer has seen this before.
    const research = runbookResearcher.search({
      signals,
      agentSignals,
      engine: observation.app?.engine || null,
      diagnosisId: model.diagnosis || null,
      experiences,
    });

    // The expert runs when the model is unsure, could not name the failure, or
    // when a disagreement is possible at all. It is the agent the model "asks"
    // when it struggles.
    const expertNeeds = Boolean(model.uncertain)
      || !model.diagnosis
      || model.diagnosis === 'unknown_failure'
      || authoritative
      || Boolean(runbook?.matched)
      || Boolean(agentSignals.engineDead || agentSignals.aclDenied || agentSignals.installerRunning);
    const expertVerdict = expertNeeds
      ? runbookExpert.assess({
        observation,
        signals,
        agentSignals,
        modelDiagnosis: model.diagnosis || null,
        modelAction: model.action || null,
        evidence: [...evidence, ...agentFacts],
        experiences,
      })
      : null;

    // Harmony only speaks when there is something to harmonise: a disagreement
    // between the model and the expert, or an exact signature the model asked the
    // table for.
    const needsHarmony = Boolean(expertVerdict)
      && (expertVerdict.disagrees
        || Boolean(runbook?.matched && (authoritative || runbook.rule?.action !== model.action)));
    const harmonyVerdict = needsHarmony
      ? arbiter.resolve({ model, expert: expertVerdict, runbook, authoritative })
      : null;

    const facts = [];
    facts.push(`research: ${research.summary}`);
    if (expertVerdict) facts.push(`expert: ${expertVerdict.summary}`);
    if (harmonyVerdict) facts.push(`harmony: ${harmonyVerdict.summary}`);
    if (runbook) facts.push(`runbook: ${runbook.summary}`);

    return {
      toolId,
      runbook,
      research,
      expert: expertVerdict,
      harmony: harmonyVerdict,
      arbitration: harmonyVerdict,
      expertsWanted: expertVerdict?.wantsMeasurements || [],
      agentsWanted,
      authoritative,
      facts,
    };
  }

  return { run, researcher: runbookResearcher, expert: runbookExpert, harmony: arbiter };
}

module.exports = {
  RISK_RANK,
  SIGNAL_QUESTIONS,
  HARMONY_RULES,
  actionTable,
  defaultActionFor,
  riskOf,
  isDestructive,
  createResearcher,
  createExpert,
  createHarmony,
  createSpecialistRound,
  consultRunbook,
  agreesWith,
};
