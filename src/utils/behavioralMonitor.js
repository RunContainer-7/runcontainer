// Behavioural monitor: continuous observation while RunContainer is open.
//
// The monitor does NOT diagnose. It collects three live vectors (window state,
// CPU/IO movement, and the live log tail), hands them to RC-Brain through the
// supervisor, and reports the model's decision. If the model is unavailable,
// monitoring says so and performs no repairs rather than falling back to rules.

const fs = require('fs');
const path = require('path');

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
  };
}

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

function observationFor(appRecord, sample, history) {
  return {
    app: {
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
  onDecision = () => {},
  onRecovered = () => {},
  onUnavailable = () => {},
  canRepairFn = canRepair,
  intervalMs = 5000,
  now = () => Date.now(),
  logger = () => {},
} = {}) {
  const monitors = new Map();
  let timer = null;
  let ticking = false;
  let unavailableReported = false;

  function historyFor(state) {
    return {
      repairs: recentRepairs(state, now()).length,
      lastRepairFailed: Boolean(state.lastRepairFailed),
      sameDiagnosisRepeats: state.sameDiagnosisRepeats || 0,
    };
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
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
        const observation = observationFor(appRecord, sample, historyFor(state));
        const decision = brain.analyze(observation, historyFor(state));
        if (!decision.available) {
          if (!unavailableReported) {
            unavailableReported = true;
            onUnavailable({ error: decision.error });
          }
          continue;
        }

        const actionable = decision.decision !== 'monitor';
        if (!actionable) {
          state.healthyTicks += 1;
          // Two healthy observations in a row clear an earlier diagnosis, so a
          // single noisy sample cannot flip the UI back and forth.
          if (state.active && state.healthyTicks >= 2) {
            state.active = null;
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
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
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
        state.state = STATES.HEALTHY;
        state.healthyTicks = 1;
      }
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
  createBehavioralSupervisor,
};
