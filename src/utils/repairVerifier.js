// Independent repair verification.
//
// A repair is not "successful" because a command returned exit code 0 or a
// process was restarted. This module re-checks the condition that was actually
// broken, using the same observable state the monitor already collects, and
// reports verified / unresolved / inconclusive honestly.
//
// This is measurement, not diagnosis: it never decides what is wrong, it only
// answers whether the problem the model named is still present.

const { detectLogSignals } = require('../ai/features');

const STATUS = {
  VERIFIED: 'verified',
  UNRESOLVED: 'unresolved',
  INCONCLUSIVE: 'inconclusive',
  NOT_APPLICABLE: 'not_applicable',
  NEW_PROBLEM: 'new_problem',
};

const ADVICE_ONLY = new Set([
  'advise_runtime_install',
  'advise_configuration',
  'wait',
  'none',
  'observe',
  'escalate',
  'reset_requires_approval',
]);

function logSignals(observation) {
  return detectLogSignals(observation?.logLines || []);
}

function checksFor({ diagnosisId, actionId, before, after }) {
  const process = after?.process || {};
  const signals = logSignals(after);
  const alive = process.alive !== false;
  const windowVisible = Boolean(process.windowVisible);
  const windowExpected = Boolean(process.windowExpected);
  const engineResponsive = process.engineResponsive !== false;
  const hung = Boolean(process.hung);
  const cpu = Number(process.cpuPercent || 0);
  const checks = [];
  const windowKnown = process.windowVisible !== null && process.windowVisible !== undefined;
  const needsWindow = ['window_hang', 'crash_unhandled', 'corrupt_profile', 'profile_in_use'].includes(diagnosisId);
  if (needsWindow && windowExpected && !windowKnown) {
    return {
      status: STATUS.INCONCLUSIVE,
      checks: [],
      detail: 'The window state could not be measured after the repair, so success is unknown.',
    };
  }

  switch (diagnosisId) {
    case 'window_hang':
      checks.push({ name: 'process-still-running', ok: alive, detail: alive ? 'the app is running' : 'the app is not running' });
      checks.push({ name: 'window-present', ok: windowVisible, detail: windowVisible ? 'a visible window exists' : 'no visible window yet' });
      break;
    case 'resource_hang':
      checks.push({ name: 'process-still-running', ok: alive, detail: alive ? 'the app is running' : 'the app is not running' });
      checks.push({ name: 'responsive', ok: !hung, detail: hung ? 'Windows still reports it as not responding' : 'Windows reports it as responding' });
      checks.push({ name: 'work-moving', ok: cpu < 80 || !process.ioIdle, detail: cpu >= 80 && process.ioIdle ? `CPU at ${Math.round(cpu)}% with no file activity` : 'CPU or file activity is moving' });
      break;
    case 'engine_unresponsive':
      checks.push({ name: 'engine-answering', ok: engineResponsive, detail: engineResponsive ? 'the isolation engine is answering' : 'the isolation engine is still not answering' });
      checks.push({ name: 'process-still-running', ok: alive, detail: alive ? 'the app is running' : 'the app is not running' });
      break;
    case 'permission_denied':
      checks.push({ name: 'access-restored', ok: !signals.accessDenied, detail: signals.accessDenied ? 'the new log still reports access denied' : 'no new access-denied output' });
      checks.push({ name: 'process-still-running', ok: alive, detail: alive ? 'the app is running' : 'the app is not running' });
      break;
    case 'corrupt_profile':
    case 'profile_in_use':
      checks.push({ name: 'starts-again', ok: alive, detail: alive ? 'the app started again' : 'the app did not start again' });
      if (windowExpected) checks.push({ name: 'window-present', ok: windowVisible, detail: windowVisible ? 'a visible window exists' : 'no visible window yet' });
      break;
    case 'crash_unhandled':
      checks.push({ name: 'starts-again', ok: alive, detail: alive ? 'the app started again' : 'the app did not start again' });
      if (windowExpected) checks.push({ name: 'window-present', ok: windowVisible, detail: windowVisible ? 'a visible window exists' : 'no visible window yet' });
      checks.push({ name: 'no-repeat-crash', ok: !signals.unhandledCrash, detail: signals.unhandledCrash ? 'the new log reports another crash' : 'no new crash reported' });
      break;
    case 'installer_failed':
      checks.push({ name: 'starts-again', ok: alive, detail: alive ? 'the app started again' : 'the app did not start again' });
      break;
    default:
      return { status: STATUS.NOT_APPLICABLE, checks: [], detail: 'This decision was advice, evidence gathering or escalation; there is no repair to verify.' };
  }

  if (!before) {
    return { status: STATUS.INCONCLUSIVE, checks, detail: 'No pre-repair observation was recorded, so improvement cannot be measured.' };
  }
  return { status: null, checks, detail: '' };
}

// A single check after a restart can be a lucky sample. The verifier asks the
// monitor for consecutive observations and only reports "verified" when the
// repaired condition holds across the whole window.
function createRepairVerifier({
  minObservations = 3,
  timeoutMs = 45000,
  now = () => Date.now(),
} = {}) {
  const runs = new Map();

  function start({ appId, diagnosisId, actionId, before }) {
    const run = {
      appId,
      diagnosisId,
      actionId,
      before,
      startedAt: now(),
      observations: [],
      last: null,
      verdict: null,
    };
    runs.set(appId, run);
    return run;
  }

  function finish(run, statusOverride = null) {
    const evaluations = run.observations.map((observation) => checksFor({
      diagnosisId: run.diagnosisId,
      actionId: run.actionId,
      before: run.before,
      after: observation,
    })).filter((evaluation) => evaluation.status !== STATUS.NOT_APPLICABLE);

    if (run.observations.length === 0) {
      run.verdict = { status: STATUS.INCONCLUSIVE, checks: [], observedChecks: 0, detail: 'No observation arrived after the repair, so success is unknown.' };
      return run.verdict;
    }
    if (evaluations.length === 0) {
      run.verdict = { status: STATUS.NOT_APPLICABLE, checks: [], observedChecks: run.observations.length, detail: 'No verification applies to this decision.' };
      return run.verdict;
    }
    const failed = evaluations.find((evaluation) => evaluation.checks.some((check) => !check.ok));
    const checks = failed?.checks || evaluations[evaluations.length - 1].checks;
    if (failed) {
      run.verdict = {
        status: statusOverride || STATUS.UNRESOLVED,
        checks,
        observedChecks: evaluations.length,
        detail: failed.detail || 'The original problem is still observable.',
      };
      return run.verdict;
    }
    if (evaluations.length < minObservations) {
      run.verdict = {
        status: STATUS.INCONCLUSIVE,
        checks,
        observedChecks: evaluations.length,
        detail: `Only ${evaluations.length} of ${minObservations} post-repair observations arrived.`,
      };
      return run.verdict;
    }
    run.verdict = {
      status: STATUS.VERIFIED,
      checks,
      observedChecks: evaluations.length,
      detail: 'The original condition cleared and stayed clear across the observation window.',
    };
    return run.verdict;
  }

  function observe(appId, observation) {
    const run = runs.get(appId);
    if (!run || run.verdict) return run?.verdict || null;
    run.observations.push(observation);
    run.last = observation;
    // If the original problem is still visible, one observation is enough: do
    // not wait for a timeout to report an unresolved repair.
    const immediate = checksFor({
      diagnosisId: run.diagnosisId,
      actionId: run.actionId,
      before: run.before,
      after: observation,
    });
    if (immediate.status === null && immediate.checks.some((check) => !check.ok)) {
      return finish(run, STATUS.UNRESOLVED);
    }
    const enough = run.observations.length >= minObservations;
    const expired = now() - run.startedAt >= timeoutMs;
    if (enough || expired) return finish(run, expired && !enough ? STATUS.INCONCLUSIVE : null);
    return null;
  }

  function finalize(appId) {
    const run = runs.get(appId);
    if (!run) return null;
    return run.verdict || finish(run, STATUS.INCONCLUSIVE);
  }

  function get(appId) {
    return runs.get(appId) || null;
  }

  function clear(appId) {
    runs.delete(appId);
  }

  return { start, observe, finalize, get, clear, minObservations, timeoutMs };
}

module.exports = {
  STATUS,
  ADVICE_ONLY,
  checksFor,
  createRepairVerifier,
};
