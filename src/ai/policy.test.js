const { gateDecision, OBSERVE_ACTION, ESCALATE_ACTION } = require('./policy');

const restart = { id: 'restart_same_profile', label: 'Restart', risk: 'low', autonomous: true, requiresApproval: false };
const clean = { id: 'restart_clean_profile', label: 'Clean profile', risk: 'medium', autonomous: false, requiresApproval: true };
const escalate = { id: 'escalate', label: 'Ask for help', risk: 'none', autonomous: false, requiresApproval: false };

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
});
