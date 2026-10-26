// Behavioural monitor: continuous observation while RunContainer is open.
//
// The monitor does NOT diagnose. It collects three live vectors (window state,
// CPU/IO movement, and the live log tail), hands them to RC-Brain through the
// supervisor, and reports the model's decision. If the model is unavailable,
// monitoring says so and performs no repairs rather than falling back to rules.

const fs = require('fs');
const path = require('path');
const { detectLogSignals } = require('../ai/features');

const STATES = {
  STARTING: 'STARTING',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  CRITICAL: 'CRITICAL_ANOMALY',
  REPAIRING: 'REPAIRING',
  HEALED: 'HEALED',
};

const RULES = Object.freeze({
  windowTimeoutMs: 10000,
  logLines: 40,
  maxLogTailBytes: 64 * 1024,
  maxRepairsPerWindow: 2,
  repairWindowMs: 10 * 60 * 1000,
});

function readLogTail(logPath, { maxLines = RULES.logLines, maxBytes = RULES.maxLogTailBytes } = {}) {
  if (!logPath) return [];
  let handle;
  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile() || stat.size === 0) return [];
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    handle = fs.openSync(logPath, 'r');
    const read = fs.readSync(handle, buffer, 0, length, start);
    let lines = buffer.subarray(0, read).toString('utf8').split(/\r?\n/).filter((line) => line.trim());
    if (start > 0 && lines.length > 0) lines = lines.slice(1);
    return lines.slice(-maxLines);
  } catch (error) {
    return [];
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch (error) { /* already closed */ }
    }
  }
}

function createLiveLogBuffer({ maxLines = RULES.logLines } = {}) {
  let lines = [];
  return {
    push(chunk) {
      const text = String(chunk || '');
      if (!text) return;
      const incoming = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (incoming.length === 0) return;
      lines = [...lines, ...incoming].slice(-maxLines);
    },
    lines() {
      return [...lines];
    },
    clear() {
      lines = [];
    },
  };
}

// GUI-subsystem PE images are expected to show a window; console tools are not.
function peSubsystemFromBuffer(buffer) {
  try {
    if (!buffer || buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset + 0x58 > buffer.length) return null;
    if (buffer.readUInt32LE(peOffset) !== 0x00004550) return null;
    const optionalHeader = peOffset + 24;
    if (optionalHeader + 70 > buffer.length) return null;
    return buffer.readUInt16LE(optionalHeader + 68);
  } catch (error) {
    return null;
  }
}

function isGuiExecutable(exePath) {
  if (!exePath) return false;
  try {
    const handle = fs.openSync(exePath, 'r');
    const buffer = Buffer.alloc(512);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    fs.closeSync(handle);
    return peSubsystemFromBuffer(buffer.subarray(0, read)) === 2;
  } catch (error) {
    return false;
  }
}

function createMonitorState(appRecord, now = Date.now()) {
  return {
    id: appRecord.id,
    name: appRecord.name || 'App',
    engine: appRecord.activeEngine || appRecord.launchMode || 'rcvm',
    state: STATES.STARTING,
    firstSeenAt: now,
    lastAt: null,
    repairs: [],
    lastDiagnosis: null,
    lastAction: null,
    sameDiagnosisRepeats: 0,
    lastRepairFailed: false,
    active: null,
    healthyTicks: 0,
    // Which incident the specialist agents have already reported for. Cleared
    // when the incident clears, so dispatch is bounded to one round per incident.
    agentsDispatchedFor: null,
    lastAgents: null,
    // Temporal evidence. The model was trained with these features, so the monitor
    // has to actually measure them: how many consecutive checks showed the same
    // incident, how long it has lasted, how often it came back, and whether an
    // earlier abnormal state has only just cleared.
    symptomTicks: 0,
    symptomSince: null,
    signatureEpisodes: {},
    recoveredAt: null,
  };
}

const RECOVERED_RECENTLY_MS = 5 * 60 * 1000;

function recentRepairs(state, now = Date.now()) {
  if (!state) return [];
  state.repairs = (state.repairs || []).filter((at) => now - at < RULES.repairWindowMs);
  return state.repairs;
}

function canRepair(state, now = Date.now()) {
  if (!state) return true;
  return recentRepairs(state, now).length < RULES.maxRepairsPerWindow;
}

function recordRepair(state, { diagnosis, outcome } = {}, now = Date.now()) {
  if (!state) return;
  state.repairs = [...recentRepairs(state, now), now];
  state.lastRepairFailed = outcome !== 'repaired';
  if (diagnosis && diagnosis === state.lastDiagnosis) {
    state.sameDiagnosisRepeats = (state.sameDiagnosisRepeats || 0) + 1;
  } else {
    state.sameDiagnosisRepeats = 0;
  }
  state.lastDiagnosis = diagnosis || state.lastDiagnosis;
  state.state = outcome === 'repaired' ? STATES.HEALED : STATES.DEGRADED;
}

// Maps the model's chosen action to the executor's structured plan. The model
// never passes shell commands; only these plans can run.
function repairPlanFor(actionId) {
  switch (actionId) {
    case 'restart_same_profile':
      return { action: actionId, resetProfile: false, restartEngine: false, repairAcl: false, requiresApproval: false };
    case 'restart_engine':
      return { action: actionId, resetProfile: false, restartEngine: true, repairAcl: false, requiresApproval: false };
    case 'repair_permissions':
      return { action: actionId, resetProfile: false, restartEngine: false, repairAcl: true, requiresApproval: false };
    case 'restart_clean_profile':
      return { action: actionId, resetProfile: true, restartEngine: false, repairAcl: false, requiresApproval: true };
    default:
      return null;
  }
}

// The observation the model sees, plus whatever the specialist agents measured.
// Only additive, measured fields are set here: the encoder is the only thing that
// turns them into features.
function withAgentEvidence(observation, dispatch) {
  if (!dispatch) return observation;
  const signals = dispatch.signals || {};
  return {
    ...observation,
    agents: {
      available: true,
      dispatched: true,
      // False when the model asked the Runbook and an exact signature answered,
      // so nothing needed measuring. The model is told what happened rather than
      // being shown measurements that never took place.
      measured: dispatch.measured !== false,
      foundNew: Boolean(signals.foundNew),
      engineDead: Boolean(signals.engineDead),
      windowElsewhere: Boolean(signals.windowElsewhere),
      aclDenied: Boolean(signals.aclDenied),
      newExePresent: Boolean(signals.newExePresent),
      reparseLink: Boolean(signals.reparseLink),
      installerRunning: Boolean(signals.installerRunning),
    },
    environment: {
      ...(observation.environment || {}),
      agentFindings: (dispatch.report?.facts || []).slice(0, 8),
    },
    history: { ...(observation.history || {}), agentsAvailable: true, agentsDispatched: true },
  };
}

function observationFor(appRecord, sample, history) {
  return {
    agents: { available: Boolean(history.agentsAvailable) },
    app: {
      // The id is not a model feature: it lets a specialist agent look up the
      // record it is measuring (its engine process, folder and staged installer).
      id: appRecord.id || null,
      name: appRecord.name || 'App',
      engine: appRecord.activeEngine || appRecord.launchMode || 'rcvm',
      status: appRecord.status || 'Unknown',
    },
    process: {
      alive: sample.running !== false,
      pidCount: sample.pidCount || 0,
      windowExpected: Boolean(sample.windowExpected),
      windowVisible: sample.windowVisible === null ? null : Boolean(sample.windowVisible),
      windowAgeMs: sample.windowAgeMs || 0,
      hung: Boolean(sample.windowHung),
      cpuPercent: sample.cpuPercent || 0,
      ioIdle: Boolean(sample.ioIdle),
      engineResponsive: sample.engineResponsive !== false,
    },
    launch: {
      ageMs: sample.ageMs || 0,
      exitCode: sample.exitCode ?? null,
      previousLaunchFailed: Boolean(appRecord.lastLaunchFailed),
    },
    logLines: sample.logLines || [],
    environment: sample.environment || {},
    history,
  };
}

function createBehavioralSupervisor({
  brain,
  listApps,
  probe,
  // Optional specialist agents. Without it the monitor behaves exactly as
  // before: the model's evidence-gathering action simply observes.
  agents = null,
  // Verified incidents from the experience store, for the research agent. It is
  // local evidence: nothing is sent anywhere.
  experiencesFor = null,
  onDecision = () => {},
  onRecovered = () => {},
  onUnavailable = () => {},
  // Every tick's raw observation, used for independent repair verification and
  // nothing else. It is not a second diagnosis path.
  onSample = () => {},
  canRepairFn = canRepair,
  intervalMs = 5000,
  now = () => Date.now(),
  logger = () => {},
} = {}) {
  const monitors = new Map();
  let timer = null;
  let ticking = false;
  let unavailableReported = false;
  // Observability only: Settings reports that monitoring is actually alive
  // instead of trusting a switch. It never changes a diagnosis.
  let startedAt = null;
  let lastTickAt = null;
  let ticks = 0;

  function historyFor(state) {
    const at = now();
    return {
      repairs: recentRepairs(state, at).length,
      lastRepairFailed: Boolean(state.lastRepairFailed),
      sameDiagnosisRepeats: state.sameDiagnosisRepeats || 0,
      agentsAvailable: Boolean(agents && typeof agents.dispatch === 'function'),
      agentsDispatched: Boolean(state?.agentsDispatchedFor),
      // Persistence of the current incident, as measured (not interpreted).
      symptomTicks: Number(state?.symptomTicks || 0),
      symptomAgeMs: state?.symptomSince ? Math.max(0, at - state.symptomSince) : 0,
      recurrences: Number(state?.recurrences || 0),
      recoveredRecently: Boolean(state?.recoveredAt && at - state.recoveredAt < RECOVERED_RECENTLY_MS),
    };
  }

  // Called with the incident the model just reported. A new incident starts a new
  // streak; the same one extends it. Recurrences count how many separate episodes
  // of the same signature this app has had in this session.
  function recordIncident(state, signature) {
    if (!state) return;
    const continuing = state.activeSignature === signature && state.symptomSince !== null;
    if (continuing) {
      state.symptomTicks = Number(state.symptomTicks || 0) + 1;
    } else {
      const episodes = Number(state.signatureEpisodes?.[signature] || 0);
      state.signatureEpisodes = { ...(state.signatureEpisodes || {}), [signature]: episodes + 1 };
      state.recurrences = episodes;
      state.symptomTicks = 1;
      state.symptomSince = now();
    }
    state.activeSignature = signature;
  }

  function clearIncident(state) {
    if (!state) return;
    if (state.symptomSince !== null) state.recoveredAt = now();
    state.symptomTicks = 0;
    state.symptomSince = null;
    state.activeSignature = null;
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    ticks += 1;
    lastTickAt = now();
    try {
      const apps = (await listApps()).filter((entry) => entry?.status === 'Running');
      const liveIds = new Set(apps.map((entry) => entry.id));
      for (const id of [...monitors.keys()]) {
        if (!liveIds.has(id)) monitors.delete(id);
      }
      if (!brain?.available) {
        if (!unavailableReported) {
          unavailableReported = true;
          onUnavailable({ error: brain?.error || 'RC-Brain is not loaded.' });
        }
        return;
      }
      unavailableReported = false;

      for (const appRecord of apps) {
        const state = monitors.get(appRecord.id) || createMonitorState(appRecord, now());
        monitors.set(appRecord.id, state);
        let sample;
        try {
          sample = await probe(appRecord, state);
        } catch (error) {
          logger(`Behavioural probe failed for ${appRecord.name || appRecord.id}: ${error.message}`);
          continue;
        }
        let observation = observationFor(appRecord, sample, historyFor(state));
        let decision = brain.analyze(observation, historyFor(state));

        // The model said the evidence is incomplete, not that the app is broken.
        // Dispatch the specialist agents named for those gaps, merge what they
        // measured, and give the model one more look at the completed evidence.
        //
        // The model chooses dispatch; the monitor ALSO measures once on the first
        // unknown failure of an incident, even when the model only abstained.
        // That rule exists because a small classifier is least reliable on
        // evidence it has never seen, and measuring is the one move that is
        // always safe: it touches nothing and happens at most once per incident.
        // Without it, an unfamiliar failure would be observed forever instead of
        // measured. Dispatch is bounded either way, and the policy refuses a
        // second round even if the model asks for one.
        let dispatch = null;
        // The model's two tools. `investigate` is the model asking for help;
        // which help it asked for is in the action id. The monitor ALSO measures
        // once on the first unknown failure of an incident, even when the model
        // only abstained: a small classifier is least reliable on evidence it has
        // never seen, and measuring is the one move that is always safe. Without
        // that rule an unfamiliar failure would be observed forever instead of
        // measured. Either way the round happens at most once per incident and the
        // policy refuses a second one even if the model asks.
        const wantsTools = decision.decision === 'investigate'
          || (decision.diagnosis?.id === 'unknown_failure'
            && decision.decision === 'abstain'
            && decision.action?.id === 'observe');
        const runTools = agents && (typeof agents.dispatchTool === 'function' || typeof agents.dispatch === 'function');
        if (decision.available && wantsTools && !state.agentsDispatchedFor && runTools) {
          const toolId = decision.action?.id === 'consult_runbook' ? 'consult_runbook' : 'spawn_agents';
          const modelView = {
            diagnosis: decision.diagnosis?.id || null,
            action: decision.action?.id || null,
            confidence: decision.diagnosis?.confidence ?? 0,
            uncertain: Boolean(decision.uncertain),
            evidence: decision.evidence || [],
          };
          try {
            dispatch = typeof agents.dispatchTool === 'function'
              ? await agents.dispatchTool({
                toolId,
                observation,
                diagnosisId: decision.diagnosis?.id || null,
                history: historyFor(state),
                model: modelView,
                experiences: typeof experiencesFor === 'function' ? experiencesFor(appRecord) : [],
              })
              : await agents.dispatch({
                observation,
                diagnosisId: decision.diagnosis?.id || null,
                history: historyFor(state),
              });
            state.agentsDispatchedFor = `${decision.diagnosis?.id}/${decision.action?.id}`;
            state.lastAgents = {
              at: dispatch.dispatchedAt,
              spawned: (dispatch.agents || []).map((agent) => agent.id),
              toolId: dispatch.toolId || toolId,
              reasoning: dispatch.specialist
                ? ['research', 'expert', 'harmony'].filter((id) => Boolean(dispatch.specialist[id]))
                : [],
              runbook: dispatch.runbook?.matched ? dispatch.runbook.rule.id : null,
              arbitration: dispatch.arbitration
                ? { verdict: dispatch.arbitration.verdict, action: dispatch.arbitration.action, diagnosis: dispatch.arbitration.diagnosis }
                : null,
              facts: dispatch.facts,
              durationMs: dispatch.durationMs,
            };
            observation = withAgentEvidence(observation, dispatch);
            decision = brain.analyze(observation, { ...historyFor(state), agentsDispatched: true });

            // The specialists may have concluded something the model did not.
            // That conclusion goes through the same safety policy as the model's
            // own proposal; arbitration decides WHICH safe thing happens, never
            // whether something unsafe may.
            const arbitration = dispatch.arbitration || dispatch.specialist?.arbitration || null;
            if (decision.available && arbitration && typeof brain.applyArbitration === 'function') {
              decision = brain.applyArbitration(decision, {
                ...arbitration,
                expertSummary: dispatch.specialist?.expert?.summary || null,
                researchSummary: dispatch.specialist?.research?.summary || null,
                runbookSummary: dispatch.specialist?.runbook?.matched ? dispatch.specialist.runbook.summary : null,
              }, {
                history: { ...historyFor(state), agentsDispatched: true },
                // Log text that tries to give the monitor orders is still never
                // obeyed, however the arbitration round concluded.
                injection: Boolean(detectLogSignals(observation.logLines || []).injection),
              });
            }
          } catch (error) {
            logger(`Specialist agents could not report for ${appRecord.name || appRecord.id}: ${error.message}`);
            dispatch = null;
          }
        }

        if (!decision.available) {
          if (!unavailableReported) {
            unavailableReported = true;
            onUnavailable({ error: decision.error });
          }
          continue;
        }

        try {
          onSample({ id: appRecord.id, name: appRecord.name || 'App', observation, decision, dispatch });
        } catch (error) {
          logger(`Behavioural sample hook failed for ${appRecord.name || appRecord.id}: ${error.message}`);
        }

        const actionable = decision.decision !== 'monitor';
        if (!actionable) {
          state.healthyTicks += 1;
          // Two healthy observations in a row clear an earlier diagnosis, so a
          // single noisy sample cannot flip the UI back and forth.
          clearIncident(state);
          if (state.active && state.healthyTicks >= 2) {
            state.active = null;
            // A new incident starts with an empty investigation budget.
            state.agentsDispatchedFor = null;
            state.lastAgents = null;
            state.state = STATES.HEALTHY;
            onRecovered({ id: appRecord.id });
          } else {
            state.state = state.active ? state.state : STATES.HEALTHY;
          }
          continue;
        }

        state.healthyTicks = 0;
        const severity = ['execute', 'awaiting_approval', 'escalate'].includes(decision.decision) ? STATES.CRITICAL : STATES.DEGRADED;
        state.state = severity;
        const signature = `${decision.diagnosis.id}/${decision.action.id}`;
        const isNew = !state.active || state.active.signature !== signature;
        recordIncident(state, signature);
        state.active = {
          signature,
          diagnosis: decision.diagnosis,
          action: decision.action,
          decision: decision.decision,
          detectedAt: new Date(now()).toISOString(),
        };
        if (!isNew) continue;

        onDecision({
          id: appRecord.id,
          name: appRecord.name || 'App',
          engine: observation.app.engine,
          state: severity,
          detectedAt: state.active.detectedAt,
          diagnosis: decision.diagnosis,
          action: decision.action,
          decision: decision.decision,
          reason: decision.reason,
          explanation: decision.explanation,
          evidence: decision.evidence,
          uncertain: decision.uncertain,
          model: decision.model,
          // What the agents measured for this decision, if the model dispatched
          // any. Present only when a dispatch actually happened.
          agents: dispatch ? {
            spawned: (dispatch.agents || []).map((agent) => ({ id: agent.id, label: agent.label, ok: agent.ok, reason: agent.reason || null, durationMs: agent.durationMs || 0, facts: agent.facts }) ),
            facts: dispatch.facts,
            durationMs: dispatch.durationMs,
            dispatchedAt: dispatch.dispatchedAt,
            catalogue: agents.catalogue?.map((agent) => ({ id: agent.id, label: agent.label, purpose: agent.purpose })) || [],
            // The two tools: which one the model asked for, what the hard-coded
            // table found, what the reasoning agents concluded, and which side
            // the harmony agent upheld.
            tool: dispatch.toolId || null,
            runbook: dispatch.runbook || null,
            specialists: dispatch.specialist ? {
              research: dispatch.specialist.research || null,
              expert: dispatch.specialist.expert || null,
              harmony: dispatch.specialist.harmony || null,
            } : null,
            arbitration: dispatch.arbitration || null,
          } : null,
          arbitration: decision.arbitration || null,
          canRepair: canRepairFn(state, now()),
          autoExecute: decision.decision === 'execute' && Boolean(decision.action.autonomous) && canRepairFn(state, now()),
          observation: {
            windowVisible: observation.process.windowVisible,
            windowExpected: observation.process.windowExpected,
            cpuPercent: observation.process.cpuPercent,
            ioIdle: observation.process.ioIdle,
            engineResponsive: observation.process.engineResponsive,
            logLine: observation.logLines[observation.logLines.length - 1] || '',
          },
        });
      }
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      startedAt = now();
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status() {
      return {
        running: Boolean(timer),
        intervalMs,
        startedAt,
        lastTickAt,
        ticks,
        watchedApps: monitors.size,
      };
    },
    tick,
    getState(id) {
      return monitors.get(id) || null;
    },
    recordRepair(id, details) {
      recordRepair(monitors.get(id), details, now());
    },
    clearActive(id) {
      const state = monitors.get(id);
      if (state) {
        state.active = null;
        clearIncident(state);
        state.agentsDispatchedFor = null;
        state.lastAgents = null;
        state.state = STATES.HEALTHY;
        state.healthyTicks = 1;
      }
    },
    // What the agents measured most recently for an app, for the interface.
    agentReport(id) {
      return monitors.get(id)?.lastAgents || null;
    },
    reset(id) {
      monitors.delete(id);
    },
  };
}

module.exports = {
  STATES,
  RULES,
  readLogTail,
  createLiveLogBuffer,
  peSubsystemFromBuffer,
  isGuiExecutable,
  createMonitorState,
  canRepair,
  recordRepair,
  repairPlanFor,
  observationFor,
  withAgentEvidence,
  createBehavioralSupervisor,
};
