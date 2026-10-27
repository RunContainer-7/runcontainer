const fs = require('fs');
const os = require('os');
const path = require('path');

const monitor = require('./behavioralMonitor');

function sample(overrides = {}) {
  return {
    now: Date.now(),
    running: true,
    engine: 'rcvm',
    pidCount: 1,
    windowExpected: true,
    windowVisible: true,
    windowAgeMs: 3000,
    ageMs: 3000,
    windowHung: false,
    engineResponsive: true,
    cpuPercent: 4,
    ioIdle: false,
    logLines: [],
    environment: {},
    ...overrides,
  };
}

function fakeBrain(decisionFactory) {
  return {
    available: true,
    model: { id: 'rc-brain-1' },
    analyze: (observation, history) => decisionFactory(observation, history),
  };
}

function decision(overrides = {}) {
  return {
    available: true,
    diagnosis: { id: 'window_hang', summary: 'The process is alive but has produced no visible window in time.', confidence: 0.97, confidenceText: '97%' },
    action: { id: 'restart_same_profile', label: 'Restart the app', requiresApproval: false, autonomous: true },
    decision: 'execute',
    reason: 'Restart',
    explanation: 'No window appeared.',
    evidence: ['no visible window after 12.0s'],
    uncertain: false,
    model: { id: 'rc-brain-1' },
    ...overrides,
  };
}

describe('tool use, said out loud', () => {
  // A notice that says nothing about tools used to read as "it did something and did
  // not say", which is the ambiguity this removes: not using a tool is stated as
  // plainly as using one.
  it('states that no tool was used instead of leaving it to be inferred', () => {
    const summary = monitor.describeToolUse(null, null);
    expect(summary.used).toBe(false);
    expect(summary.tool).toBeNull();
    expect(summary.label).toBe('No tool was used on this incident: RC-Brain did not dispatch specialist agents and did not consult the Runbook.');
  });

  it('names the tool, the agents and the reasoning agents that actually ran', () => {
    const summary = monitor.describeToolUse({
      toolId: 'spawn_agents',
      agents: [{ id: 'engine', label: 'Engine agent', ok: true }],
      specialist: { research: {}, expert: {}, harmony: null },
    }, null);
    expect(summary.used).toBe(true);
    expect(summary.toolLabel).toBe('Dispatch specialist agents');
    expect(summary.agents).toEqual([{ id: 'engine', label: 'Engine agent' }]);
    expect(summary.label).toContain('Tool used on this incident: Dispatch specialist agents');
    expect(summary.label).toContain('agents: Engine agent');
  });

  it('describes a Runbook lookup, matched or not, and a dispatch recorded earlier', () => {
    const matched = monitor.describeToolUse({
      toolId: 'consult_runbook',
      agents: [],
      runbook: { matched: true, rule: { id: 'dll_missing' } },
    }, null);
    expect(matched.runbook).toBe('dll_missing');
    expect(matched.label).toContain('matched the documented signature dll_missing');

    const unmatched = monitor.describeToolUse({ toolId: 'consult_runbook', agents: [], runbook: { matched: false } }, null);
    expect(unmatched.runbook).toBeNull();
    expect(unmatched.label).toContain('no exact documented signature matched');

    // A dispatch from earlier in the same incident is described with the same labels.
    const earlier = monitor.describeToolUse(null, { toolId: 'spawn_agents', spawned: ['window'], reasoning: ['expert'] });
    expect(earlier.used).toBe(true);
    expect(earlier.agents).toEqual([{ id: 'window', label: 'Window agent' }]);
    expect(earlier.specialists).toEqual([{ id: 'expert', label: 'Expert agent' }]);
  });
});

describe('behavioural observation helpers', () => {
  it('reads only the tail of a log file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-behavior-'));
    const logPath = path.join(dir, 'app.log');
    fs.writeFileSync(logPath, Array.from({ length: 100 }, (_value, index) => `line-${index}`).join('\n'), 'utf8');
    expect(monitor.readLogTail(logPath, { maxLines: 5 })).toEqual(['line-95', 'line-96', 'line-97', 'line-98', 'line-99']);
    expect(monitor.readLogTail(path.join(dir, 'missing.log'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a bounded in-memory stdout/stderr buffer', () => {
    const buffer = monitor.createLiveLogBuffer({ maxLines: 3 });
    buffer.push('first\nsecond');
    buffer.push('third\nfourth\n');
    expect(buffer.lines()).toEqual(['second', 'third', 'fourth']);
    buffer.clear();
    expect(buffer.lines()).toEqual([]);
  });

  it('maps only catalogue actions to executable plans', () => {
    expect(monitor.repairPlanFor('restart_same_profile')).toEqual({ action: 'restart_same_profile', resetProfile: false, restartEngine: false, repairAcl: false, requiresApproval: false });
    expect(monitor.repairPlanFor('restart_engine').restartEngine).toBe(true);
    expect(monitor.repairPlanFor('repair_permissions').repairAcl).toBe(true);
    expect(monitor.repairPlanFor('restart_clean_profile').requiresApproval).toBe(true);
    expect(monitor.repairPlanFor('reset_requires_approval')).toBeNull();
    expect(monitor.repairPlanFor('delete_everything')).toBeNull();
  });
});

describe('behavioural supervisor (AI-led)', () => {
  it('passes structured observations to the model and reports its decision once', async () => {
    const seen = [];
    const decisions = [];
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain((observation) => {
        seen.push(observation);
        return decision();
      }),
      listApps: async () => [{ id: 'app-1', name: 'Editor', status: 'Running', engine: 'rcvm', sandboxPids: [42] }],
      probe: async () => sample(),
      onDecision: (notice) => decisions.push(notice),
    });

    await supervisor.tick();
    await supervisor.tick();
    expect(seen[0].app.status).toBe('Running');
    expect(seen[0].process.windowVisible).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].diagnosis.id).toBe('window_hang');
    expect(decisions[0].diagnosis.confidenceText).toBe('97%');
    expect(decisions[0].action.id).toBe('restart_same_profile');
    expect(decisions[0].autoExecute).toBe(true);
  });

  it('keeps observing on its own timer for as long as the app is open', async () => {
    jest.useFakeTimers();
    try {
      let probes = 0;
      const supervisor = monitor.createBehavioralSupervisor({
        brain: fakeBrain(() => decision({ diagnosis: { id: 'healthy', summary: 'Normal', confidence: 0.99, confidenceText: '99%' }, action: { id: 'none', label: 'No action', requiresApproval: false, autonomous: true }, decision: 'monitor' })),
        listApps: async () => [{ id: 'app-1', status: 'Running' }],
        probe: async () => { probes += 1; return sample(); },
        intervalMs: 5000,
      });
      supervisor.start();
      expect(probes).toBe(0);
      expect(supervisor.status().running).toBe(true);
      for (let tick = 1; tick <= 3; tick += 1) {
        jest.advanceTimersByTime(5000);
        for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();
        expect(probes).toBe(tick);
      }
      expect(supervisor.status().ticks).toBe(3);
      expect(supervisor.status().lastTickAt).toBeGreaterThan(0);
      supervisor.stop();
      jest.advanceTimersByTime(20000);
      for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();
      expect(probes).toBe(3);
      expect(supervisor.status().running).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does nothing while the model says the app is normal', async () => {
    const decisions = [];
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain(() => decision({ diagnosis: { id: 'healthy', summary: 'Normal', confidence: 0.99, confidenceText: '99%' }, action: { id: 'none', label: 'No action', requiresApproval: false, autonomous: true }, decision: 'monitor' })),
      listApps: async () => [{ id: 'app-1', status: 'Running' }],
      probe: async () => sample(),
      onDecision: (notice) => decisions.push(notice),
    });
    await supervisor.tick();
    await supervisor.tick();
    expect(decisions).toEqual([]);
    expect(supervisor.getState('app-1').state).toBe('HEALTHY');
  });

  it('clears an active diagnosis after two healthy observations', async () => {
    let healthy = false;
    const recovered = [];
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain(() => (healthy
        ? decision({ diagnosis: { id: 'healthy', summary: 'Normal', confidence: 0.99, confidenceText: '99%' }, action: { id: 'none', label: 'No action', requiresApproval: false, autonomous: true }, decision: 'monitor' })
        : decision())),
      listApps: async () => [{ id: 'app-1', name: 'Editor', status: 'Running' }],
      probe: async () => sample(),
      onRecovered: (payload) => recovered.push(payload),
    });
    await supervisor.tick();
    healthy = true;
    await supervisor.tick();
    expect(recovered).toEqual([]);
    await supervisor.tick();
    expect(recovered).toEqual([{ id: 'app-1' }]);
    expect(supervisor.getState('app-1').state).toBe('HEALTHY');
  });

  it('reports an unavailable model and makes no decisions', async () => {
    const unavailable = [];
    const decisions = [];
    const supervisor = monitor.createBehavioralSupervisor({
      brain: { available: false, error: 'The RC-Brain model file is missing.' },
      listApps: async () => [{ id: 'app-1', status: 'Running' }],
      probe: async () => sample(),
      onDecision: (notice) => decisions.push(notice),
      onUnavailable: (payload) => unavailable.push(payload),
    });
    await supervisor.tick();
    await supervisor.tick();
    expect(decisions).toEqual([]);
    expect(unavailable).toEqual([{ error: 'The RC-Brain model file is missing.' }]);
  });

  it('never marks an approval-only action for automatic execution', async () => {
    const decisions = [];
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain(() => decision({
        diagnosis: { id: 'corrupt_profile', summary: 'Profile looks corrupt', confidence: 0.95, confidenceText: '95%' },
        action: { id: 'restart_clean_profile', label: 'Restart with a clean profile', requiresApproval: true, autonomous: false },
        decision: 'awaiting_approval',
      })),
      listApps: async () => [{ id: 'app-1', status: 'Running' }],
      probe: async () => sample(),
      onDecision: (notice) => decisions.push(notice),
    });
    await supervisor.tick();
    expect(decisions[0].autoExecute).toBe(false);
    expect(decisions[0].action.requiresApproval).toBe(true);
  });

  it('enforces the repair budget before automatic execution', async () => {
    const decisions = [];
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain(() => decision()),
      listApps: async () => [{ id: 'app-1', status: 'Running' }],
      probe: async () => sample(),
      onDecision: (notice) => decisions.push(notice),
      now: () => 1000,
    });
    await supervisor.tick();
    supervisor.recordRepair('app-1', { diagnosis: 'window_hang', outcome: 'failed' });
    supervisor.recordRepair('app-1', { diagnosis: 'window_hang', outcome: 'failed' });
    supervisor.clearActive('app-1');
    await supervisor.tick();
    expect(decisions[1].canRepair).toBe(false);
    expect(decisions[1].autoExecute).toBe(false);
  });

  it('dispatches the specialist agents when the model says the evidence is incomplete', async () => {
    const dispatched = [];
    const decisions = [];
    const observations = [];
    const agents = {
      catalogue: [{ id: 'engine', label: 'Engine agent', purpose: 'check the engine' }],
      dispatch: async (args) => {
        dispatched.push(args);
        return {
          dispatchedAt: 'now',
          durationMs: 12,
          agents: [{ id: 'engine', label: 'Engine agent', ok: true, facts: ['the launcher has exited'], durationMs: 12 }],
          report: { facts: ['Engine agent: the launcher has exited'] },
          facts: ['Engine agent: the launcher has exited'],
          features: {},
          signals: { engineDead: true, foundNew: true },
          observationPatch: {},
        };
      },
    };
    let call = 0;
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain((observation) => {
        observations.push(observation);
        call += 1;
        return call === 1
          ? decision({
            diagnosis: { id: 'unknown_failure', summary: 'Not recognised', confidence: 0.4, confidenceText: '40%' },
            action: { id: 'spawn_agents', label: 'Dispatch specialist agents', requiresApproval: false, autonomous: true, risk: 'none' },
            decision: 'investigate',
          })
          : decision({
            diagnosis: { id: 'engine_unresponsive', summary: 'Engine gone', confidence: 0.93, confidenceText: '93%' },
            action: { id: 'restart_engine', label: 'Restart the isolation engine', requiresApproval: false, autonomous: true, risk: 'low' },
            decision: 'execute',
          });
      }),
      listApps: async () => [{ id: 'app-1', name: 'Editor', status: 'Running', engine: 'rcvm' }],
      probe: async () => sample({ windowVisible: false, windowAgeMs: 30000 }),
      agents,
      onDecision: (notice) => decisions.push(notice),
    });

    await supervisor.tick();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].diagnosisId).toBe('unknown_failure');
    // The second analysis receives the agent measurements, and the first does not.
    expect(observations[0].agents.dispatched).toBeUndefined();
    expect(observations[1].agents.dispatched).toBe(true);
    expect(observations[1].agents.engineDead).toBe(true);
    expect(observations[1].environment.agentFindings).toEqual(['Engine agent: the launcher has exited']);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action.id).toBe('restart_engine');
    expect(decisions[0].agents.spawned).toEqual([{ id: 'engine', label: 'Engine agent', ok: true, reason: null, durationMs: 12, facts: ['the launcher has exited'] }]);
    expect(decisions[0].agents.facts).toEqual(['Engine agent: the launcher has exited']);
    expect(supervisor.agentReport('app-1').spawned).toEqual(['engine']);

    // A second tick never dispatches again for the same incident.
    await supervisor.tick();
    expect(dispatched).toHaveLength(1);
  });

  it('measures once, even when the model abstains on an unfamiliar failure', async () => {
    let dispatches = 0;
    const agents = {
      catalogue: [],
      dispatch: async () => {
        dispatches += 1;
        return { dispatchedAt: 'now', durationMs: 1, agents: [], report: { facts: [] }, facts: [], features: {}, signals: {}, observationPatch: {} };
      },
    };
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain(() => decision({
        diagnosis: { id: 'unknown_failure', summary: 'Not recognised', confidence: 0.33, confidenceText: '33%' },
        action: { id: 'observe', label: 'Gather more evidence', requiresApproval: false, autonomous: true, risk: 'none' },
        decision: 'abstain',
      })),
      listApps: async () => [{ id: 'app-1', status: 'Running' }],
      probe: async () => sample(),
      agents,
    });
    await supervisor.tick();
    await supervisor.tick();
    await supervisor.tick();
    expect(dispatches).toBe(1);
  });

  it('never dispatches agents for an app the model called normal', async () => {
    let dispatches = 0;
    const agents = { catalogue: [], dispatch: async () => { dispatches += 1; return null; } };
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain(() => decision({
        diagnosis: { id: 'healthy', summary: 'Normal', confidence: 0.99, confidenceText: '99%' },
        action: { id: 'none', label: 'No action', requiresApproval: false, autonomous: true },
        decision: 'monitor',
      })),
      listApps: async () => [{ id: 'app-1', status: 'Running' }],
      probe: async () => sample(),
      agents,
    });
    await supervisor.tick();
    await supervisor.tick();
    expect(dispatches).toBe(0);
  });

  it('keeps the plain observation path when no agents are registered', async () => {
    const decisions = [];
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain(() => decision({
        diagnosis: { id: 'unknown_failure', summary: 'Not recognised', confidence: 0.4, confidenceText: '40%' },
        action: { id: 'spawn_agents', label: 'Dispatch specialist agents', requiresApproval: false, autonomous: true },
        decision: 'investigate',
      })),
      listApps: async () => [{ id: 'app-1', status: 'Running' }],
      probe: async () => sample(),
      onDecision: (notice) => decisions.push(notice),
    });
    await supervisor.tick();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].agents).toBeNull();
  });

  it('stops tracking an app once it is no longer running', async () => {
    let running = true;
    const supervisor = monitor.createBehavioralSupervisor({
      brain: fakeBrain(() => decision({ decision: 'monitor', diagnosis: { id: 'healthy', summary: 'Normal', confidence: 1, confidenceText: '100%' }, action: { id: 'none', label: 'No action', requiresApproval: false } })),
      listApps: async () => (running ? [{ id: 'app-1', status: 'Running' }] : []),
      probe: async () => sample(),
    });
    await supervisor.tick();
    expect(supervisor.getState('app-1')).not.toBeNull();
    running = false;
    await supervisor.tick();
    expect(supervisor.getState('app-1')).toBeNull();
  });
});
