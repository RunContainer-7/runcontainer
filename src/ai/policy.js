// Safety policy around RC-Brain's decision.
//
// This module does NOT diagnose anything. It only restricts what may happen to
// a diagnosis the model already produced, and it is the same code in training
// evaluation and in the shipped app so the published numbers describe the
// behaviour users actually get.
//
// Every restriction is an explicit safety invariant from knowledge.json:
//   - a destructive repair is never applied to an app that is not failing
//   - an unrecognised failure is observed, not wiped
//   - suspicious log instructions are escalated, never executed
//   - a declined approval is not retried
//   - the bounded repair budget ends automatic action

const NON_FAILURE = new Set(['healthy', 'console_headless', 'exited_normally', 'starting_slow']);
const DESTRUCTIVE = new Set(['restart_clean_profile', 'reset_requires_approval']);
const REPAIR_ACTIONS = new Set(['restart_same_profile', 'restart_engine', 'repair_permissions', 'restart_clean_profile', 'reset_requires_approval']);
// The model's two tools. Neither is a repair: dispatching agents measures and
// reports, and consulting the Runbook looks a signature up in a fixed table, so
// neither ever touches the app. They are still bounded, because an unbounded
// investigation loop would be a failure mode of its own.
const INVESTIGATE_ACTIONS = new Set(['spawn_agents', 'consult_runbook']);
const TOOL_ACTIONS = INVESTIGATE_ACTIONS;
const OBSERVE_ACTION = {
  id: 'observe',
  label: 'Gather more evidence',
  description: 'Evidence is insufficient or conflicting; collect more observations before acting.',
  risk: 'none',
  autonomous: true,
  requiresApproval: false,
};
const ESCALATE_ACTION = {
  id: 'escalate',
  label: 'Ask for help',
  description: 'The evidence suggests a problem RunContainer cannot safely repair, so it is reported instead of guessed at.',
  risk: 'none',
  autonomous: false,
  requiresApproval: false,
};

function gateDecision({
  diagnosisId,
  action,
  confidence = 1,
  uncertain = false,
  history = {},
  injection = false,
  maxRepairs = 2,
}) {
  const repairs = Number(history.repairs || 0);
  const actionable = action && REPAIR_ACTIONS.has(action.id);
  const investigating = action && INVESTIGATE_ACTIONS.has(action.id);

  if (!action) {
    return { action: OBSERVE_ACTION, decision: 'abstain', reason: 'The model proposed no valid action, so it is gathering evidence.' };
  }

  // Text in a log that tries to give the monitor orders is never acted on, no
  // matter what the model concluded from the surrounding evidence.
  if (injection && action.id !== 'escalate') {
    return {
      action: ESCALATE_ACTION,
      decision: 'escalate',
      reason: 'The log contains instructions aimed at the monitor. They are treated as data, so the incident is reported instead of executed.',
    };
  }

  // An unrecognised failure must never lead to a repair. Dispatching agents (to
  // complete the evidence) or observing (to keep it) is safe; a restorative
  // action on a diagnosis the model cannot name is not.
  if (diagnosisId === 'unknown_failure' && !investigating && action.id !== 'observe' && action.id !== 'escalate') {
    return {
      action: OBSERVE_ACTION,
      decision: 'abstain',
      reason: 'The diagnosis is unrecognised, so the model is gathering more evidence instead of acting on a guess.',
    };
  }

  if (investigating) {
    if (history.agentsAvailable === false) {
      return {
        action: OBSERVE_ACTION,
        decision: 'abstain',
        reason: 'No specialist agents are registered in this build, so the model observes instead of dispatching.',
      };
    }
    if (history.agentsDispatched) {
      return {
        action: OBSERVE_ACTION,
        decision: 'abstain',
        reason: 'Specialist agents have already reported for this incident, so the model does not dispatch them again.',
      };
    }
    // Never spend an investigation on an app the model itself called normal.
    if (NON_FAILURE.has(diagnosisId)) {
      return {
        action: OBSERVE_ACTION,
        decision: 'abstain',
        reason: 'The diagnosis is normal behaviour, so no agents are dispatched; monitoring continues.',
      };
    }
    return {
      action,
      decision: 'investigate',
      reason: uncertain
        ? 'The evidence is weak and incomplete, so the model dispatches specialist agents to measure it instead of guessing.'
        : action.description,
    };
  }

  if (NON_FAILURE.has(diagnosisId) && (DESTRUCTIVE.has(action.id) || action.risk === 'high')) {
    return {
      action: ESCALATE_ACTION,
      decision: 'escalate',
      reason: 'The proposed repair would affect app data, and the evidence does not show a failure. Nothing was changed.',
    };
  }

  // Even a low-risk repair is not applied to an app the model just called
  // normal: interrupting a working app is never a repair. This holds even if
  // the action head disagrees with the diagnosis head.
  if (NON_FAILURE.has(diagnosisId) && actionable) {
    return {
      action: OBSERVE_ACTION,
      decision: 'abstain',
      reason: 'The diagnosis is normal behaviour, so nothing is restarted or changed; monitoring continues.',
    };
  }

  if (diagnosisId === 'user_data_risk' && actionable) {
    return {
      action: ESCALATE_ACTION,
      decision: 'escalate',
      reason: 'The log contained instructions aimed at the monitor. They are treated as evidence, and no repair is executed from them.',
    };
  }

  if (history.approvalDenied && (DESTRUCTIVE.has(action.id) || action.requiresApproval)) {
    return {
      action: ESCALATE_ACTION,
      decision: 'escalate',
      reason: 'A repair for this app was already declined, so it will not be proposed again automatically.',
    };
  }

  if (actionable && repairs >= maxRepairs) {
    return {
      action: ESCALATE_ACTION,
      decision: 'escalate',
      reason: 'Automatic repair has already run its budget for this app in the monitoring window, so the model stopped instead of retrying.',
    };
  }

  if (actionable && history.lastRepairFailed && Number(history.sameDiagnosisRepeats || 0) >= 1) {
    return {
      action: ESCALATE_ACTION,
      decision: 'escalate',
      reason: 'The previous identical repair did not work, so the model stopped instead of repeating it.',
    };
  }

  // A destructive action always needs approval, even when the model is sure.
  if (action.requiresApproval) {
    return { action, decision: 'awaiting_approval', reason: action.description };
  }

  const decision = action.id === 'observe'
    ? 'abstain'
    : ['none', 'wait'].includes(action.id)
      ? 'monitor'
      : ['advise_runtime_install', 'advise_configuration'].includes(action.id)
        ? 'advise'
        : action.id === 'escalate'
          ? 'escalate'
          : 'execute';

  return { action, decision, reason: uncertain ? 'The evidence is weak, so only a safe step is taken.' : action.description };
}

module.exports = {
  NON_FAILURE,
  DESTRUCTIVE,
  REPAIR_ACTIONS,
  INVESTIGATE_ACTIONS,
  TOOL_ACTIONS,
  OBSERVE_ACTION,
  ESCALATE_ACTION,
  gateDecision,
};
