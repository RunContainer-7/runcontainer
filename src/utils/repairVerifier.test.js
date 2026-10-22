const { createRepairVerifier, checksFor, STATUS } = require('./repairVerifier');

function observation(overrides = {}) {
  return {
    process: {
      alive: true,
      windowExpected: true,
      windowVisible: true,
      hung: false,
      cpuPercent: 5,
      ioIdle: false,
      engineResponsive: true,
      ...(overrides.process || {}),
    },
    logLines: overrides.logLines || ['Window created', 'Ready'],
  };
}

describe('repair verification', () => {
  it('verifies a window hang only after the window is actually visible, repeatedly', () => {
    let clock = 0;
    const verifier = createRepairVerifier({ minObservations: 3, now: () => clock });
    verifier.start({ appId: 'a', diagnosisId: 'window_hang', actionId: 'restart_same_profile', before: observation({ process: { windowVisible: false } }) });
    expect(verifier.observe('a', observation())).toBeNull();
    clock += 5000;
    expect(verifier.observe('a', observation())).toBeNull();
    clock += 5000;
    const verdict = verifier.observe('a', observation());
    expect(verdict.status).toBe(STATUS.VERIFIED);
    expect(verdict.observedChecks).toBe(3);
  });

  it('reports the original problem as unresolved instead of trusting the restart', () => {
    let clock = 0;
    const verifier = createRepairVerifier({ minObservations: 3, now: () => clock });
    verifier.start({ appId: 'b', diagnosisId: 'window_hang', actionId: 'restart_same_profile', before: observation({ process: { windowVisible: false } }) });
    const verdict = verifier.observe('b', observation({ process: { windowVisible: false }, logLines: [] }));
    expect(verdict.status).toBe(STATUS.UNRESOLVED);
    expect(verdict.checks.find((check) => check.name === 'window-present').ok).toBe(false);
  });

  it('reports inconclusive when too little was observed', () => {
    let clock = 0;
    const verifier = createRepairVerifier({ minObservations: 3, timeoutMs: 1000, now: () => clock });
    verifier.start({ appId: 'c', diagnosisId: 'window_hang', actionId: 'restart_same_profile', before: observation() });
    verifier.observe('c', observation());
    clock += 2000;
    const verdict = verifier.observe('c', observation());
    expect(verdict.status).toBe(STATUS.INCONCLUSIVE);
  });

  it('marks advice and escalation as not applicable rather than successful', () => {
    const result = checksFor({ diagnosisId: 'disk_exhausted', actionId: 'advise_configuration', before: observation(), after: observation() });
    expect(result.status).toBe(STATUS.NOT_APPLICABLE);
  });

  it('checks the engine, not just the app process, for an engine failure', () => {
    const stillDead = checksFor({
      diagnosisId: 'engine_unresponsive',
      actionId: 'restart_engine',
      before: observation({ process: { engineResponsive: false } }),
      after: observation({ process: { engineResponsive: false } }),
    });
    expect(stillDead.checks.find((check) => check.name === 'engine-answering').ok).toBe(false);
    const healed = checksFor({
      diagnosisId: 'engine_unresponsive',
      actionId: 'restart_engine',
      before: observation({ process: { engineResponsive: false } }),
      after: observation({ process: { engineResponsive: true } }),
    });
    expect(healed.checks.every((check) => check.ok)).toBe(true);
  });

  it('needs new evidence for permissions, not just a running process', () => {
    const result = checksFor({
      diagnosisId: 'permission_denied',
      actionId: 'repair_permissions',
      before: observation(),
      after: observation({ logLines: ['Access is denied writing to cache'] }),
    });
    expect(result.checks.find((check) => check.name === 'access-restored').ok).toBe(false);
  });
});
