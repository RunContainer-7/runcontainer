const { gateDecision, OBSERVE_ACTION, ESCALATE_ACTION } = require('./policy');

const restart = { id: 'restart_same_profile', label: 'Restart', risk: 'low', autonomous: true, requiresApproval: false };
const clean = { id: 'restart_clean_profile', label: 'Clean profile', risk: 'medium', autonomous: false, requiresApproval: true };
const escalate = { id: 'escalate', label: 'Ask for help', risk: 'none', autonomous: false, requiresApproval: false };
const spawn = { id: 'spawn_agents', label: 'Dispatch specialist agents', risk: 'none', autonomous: true, requiresApproval: false };

describe('RC-Brain safety policy', () => {
  it('never wipes app data for an app that is not failing', () => {
    const result = gateDecision({ diagnosisId: 'healthy', action: clean });
    expect(result.decision).toBe('escalate');
    expect(result.action.id).toBe('escalate');
    expect(result.reason).toContain('does not show a failure');
  });

  it('never restarts an app the model just called normal', () => {
    const result = gateDecision({ diagnosisId: 'healthy', action: restart });
    expect(result.decision).toBe('abstain');
    expect(result.action.id).toBe(OBSERVE_ACTION.id);
    expect(result.reason).toContain('nothing is restarted');
  });

  it('gathers evidence instead of repairing an unrecognised failure', () => {
    const result = gateDecision({ diagnosisId: 'unknown_failure', action: restart });
    expect(result.decision).toBe('abstain');
    expect(result.action.id).toBe(OBSERVE_ACTION.id);
  });

  it('allows escalation for an unrecognised failure', () => {
    const result = gateDecision({ diagnosisId: 'unknown_failure', action: escalate });
    expect(result.action.id).toBe(ESCALATE_ACTION.id);
    expect(result.decision).toBe('escalate');
  });

  it('ignores instructions found in logs, whatever the model chose', () => {
    const result = gateDecision({ diagnosisId: 'healthy', action: restart, injection: true });
    expect(result.action.id).toBe('escalate');
    expect(result.reason).toContain('treated as data');
  });

  it('does not retry a repair the user already declined', () => {
    const result = gateDecision({ diagnosisId: 'corrupt_profile', action: clean, history: { approvalDenied: true } });
    expect(result.decision).toBe('escalate');
  });

  it('stops after the bounded repair budget', () => {
    const result = gateDecision({ diagnosisId: 'window_hang', action: restart, history: { repairs: 2 } });
    expect(result.decision).toBe('escalate');
    expect(result.reason).toContain('budget');
  });

  it('stops when the identical repair already failed', () => {
    const result = gateDecision({ diagnosisId: 'window_hang', action: restart, history: { repairs: 1, lastRepairFailed: true, sameDiagnosisRepeats: 1 } });
    expect(result.decision).toBe('escalate');
  });

  it('still needs approval for a destructive repair on a real failure', () => {
    const result = gateDecision({ diagnosisId: 'corrupt_profile', action: clean });
    expect(result.decision).toBe('awaiting_approval');
    expect(result.action.requiresApproval).toBe(true);
  });

  it('lets a low-risk repair execute on a real failure with budget available', () => {
    const result = gateDecision({ diagnosisId: 'window_hang', action: restart, history: { repairs: 0 } });
    expect(result.decision).toBe('execute');
  });

  it('lets the model dispatch agents to complete incomplete evidence', () => {
    const result = gateDecision({ diagnosisId: 'unknown_failure', action: spawn, history: { agentsAvailable: true } });
    expect(result.decision).toBe('investigate');
    expect(result.action.id).toBe('spawn_agents');
  });

  it('never dispatches agents more than once for the same incident', () => {
    const result = gateDecision({
      diagnosisId: 'unknown_failure',
      action: spawn,
      history: { agentsAvailable: true, agentsDispatched: true },
    });
    expect(result.decision).toBe('abstain');
    expect(result.action.id).toBe(OBSERVE_ACTION.id);
    expect(result.reason).toContain('already reported');
  });

  it('does not dispatch agents when this build has none registered', () => {
    const result = gateDecision({ diagnosisId: 'unknown_failure', action: spawn, history: { agentsAvailable: false } });
    expect(result.decision).toBe('abstain');
    expect(result.reason).toContain('No specialist agents');
  });

  it('does not spend an investigation on an app the model called normal', () => {
    const result = gateDecision({ diagnosisId: 'healthy', action: spawn, history: { agentsAvailable: true } });
    expect(result.decision).toBe('abstain');
    expect(result.action.id).toBe(OBSERVE_ACTION.id);
  });

  it('treats dispatching agents as evidence gathering, not as a repair', () => {
    // Even with the repair budget spent, completing the evidence is still allowed
    // because it never touches the app: only the outcome of that evidence is capped.
    const result = gateDecision({ diagnosisId: 'unknown_failure', action: spawn, history: { agentsAvailable: true, repairs: 5 } });
    expect(result.decision).toBe('investigate');
    const afterRepairBudget = gateDecision({ diagnosisId: 'window_hang', action: restart, history: { repairs: 5 } });
    expect(afterRepairBudget.decision).toBe('escalate');
  });

  it('escalates rather than dispatching when the log tries to instruct the monitor', () => {
    const result = gateDecision({ diagnosisId: 'unknown_failure', action: spawn, injection: true, history: { agentsAvailable: true } });
    expect(result.action.id).toBe(ESCALATE_ACTION.id);
  });
});
