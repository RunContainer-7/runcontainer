// The model's two tools: the hard-coded Runbook, the three reasoning agents, and
// the round they run in inside the behavioural monitor.
//
// These tests are deliberately about BEHAVIOUR that a user would notice: an exact
// documented signature gets the documented answer, a failed app is never called
// normal, a disagreement has a stated resolution, arbitration cannot reach for the
// user's data, and investigation happens once per incident.

const knowledge = require('./knowledge.json');
const { RULES, consult, agreesWith } = require('./runbook');
const { createResearcher, createExpert, createHarmony, riskOf, isDestructive } = require('./specialists');
const { createBrain, createAgentCoordinator } = require('./engine');
const { createBehavioralSupervisor } = require('../utils/behavioralMonitor');

const DIAGNOSIS_IDS = new Set(knowledge.diagnoses.map((entry) => entry.id));
const ACTION_IDS = new Set(knowledge.actions.map((entry) => entry.id));

function observation(overrides = {}) {
  return {
    // Agent measurements are part of the observation the Runbook and the expert
    // read, so they are passed through like any other evidence.
    ...(overrides.agents ? { agents: overrides.agents } : {}),
    app: { name: 'App', engine: 'rcvm', status: 'Running', ...(overrides.app || {}) },
    process: {
      alive: true,
      pidCount: 1,
      windowExpected: true,
      windowVisible: false,
      windowAgeMs: 3000,
      hung: false,
      cpuPercent: 5,
      ioIdle: false,
      engineResponsive: true,
      ...(overrides.process || {}),
    },
    launch: { ageMs: 3000, exitCode: null, previousLaunchFailed: false, ...(overrides.launch || {}) },
    logLines: overrides.logLines || [],
    environment: overrides.environment || {},
    history: { repairs: 0, lastRepairFailed: false, sameDiagnosisRepeats: 0, approvalDenied: false, ...(overrides.history || {}) },
  };
}

describe('the Runbook (hard-coded tool)', () => {
  it('every rule cites its basis and names a real diagnosis and action', () => {
    expect(RULES.length).toBeGreaterThan(8);
    for (const rule of RULES) {
      expect(rule.basis).toBeTruthy();
      expect(rule.why.length).toBeGreaterThan(30);
      expect(DIAGNOSIS_IDS.has(rule.diagnosis)).toBe(true);
      expect(ACTION_IDS.has(rule.action)).toBe(true);
      // A lookup table never touches the app, so no rule may propose an action
      // that needs approval on its own.
      const action = knowledge.actions.find((entry) => entry.id === rule.action);
      expect(Boolean(action.requiresApproval)).toBe(false);
    }
  });

  it('answers an exact documented signature', () => {
    const missing = consult({ observation: observation({ logLines: ['The code execution cannot proceed because VCRUNTIME140.dll was not found'] }) });
    expect(missing.matched).toBe(true);
    expect(missing.rule.id).toBe('missing_runtime');
    expect(missing.rule.action).toBe('advise_runtime_install');

    const elevation = consult({ observation: observation({ launch: { exitCode: 740 }, logLines: ['CreateProcess failed with 740'] }) });
    expect(elevation.rule.id).toBe('elevation_required');

    const bridge = consult({ observation: observation({ logLines: ['RunContainer: this download is a ms-windows-store: bridge, not an application'] }) });
    expect(bridge.rule.id).toBe('store_bridge');

    const junction = consult({ observation: observation({ logLines: ['The path cannot be traversed because it contains an untrusted mount point.'] }) });
    expect(junction.rule.id).toBe('untrusted_mount_point');

    const reboot = consult({ observation: observation({ launch: { exitCode: 3010 }, logLines: ['Setup completed; a restart is required'] }) });
    expect(reboot.rule.id).toBe('installer_reboot_pending');

    const crash = consult({ observation: observation({ launch: { exitCode: -1073741819 }, logLines: ['Fatal error'] }) });
    expect(crash.rule.id).toBe('access_violation');
  });

  it('says nothing rather than guessing when no signature matches', () => {
    const result = consult({ observation: observation({ logLines: ['Starting up', 'still loading'] }) });
    expect(result.matched).toBe(false);
    expect(result.rule).toBeNull();
    expect(result.summary).toMatch(/No documented signature/);
  });

  it('refuses a consultation when equally specific rules disagree', () => {
    // A missing runtime AND an access violation are both exact errors at the same
    // tier with different meanings: the table reports the conflict instead of
    // choosing one.
    const result = consult({
      observation: observation({
        launch: { exitCode: 0xc0000135 },
        logLines: ['VCRUNTIME140.dll was not found', 'Fatal error 0xC0000005'],
      }),
    });
    expect(result.matched).toBe(false);
    expect(result.ambiguous.length).toBeGreaterThan(1);
    expect(result.summary).toMatch(/disagree/);
  });

  it('uses what the evidence agents measured', () => {
    const denied = consult({ observation: observation({ agents: { aclDenied: true } }) });
    expect(denied.rule.id).toBe('profile_denied_write');
    const dead = consult({ observation: observation({ agents: { engineDead: true } }) });
    expect(dead.rule.id).toBe('engine_no_longer_answering');
    const setup = consult({ observation: observation({ agents: { installerRunning: true } }) });
    expect(setup.rule.id).toBe('setup_still_running');
    // A measured failure outranks a word in the log.
    const both = consult({ observation: observation({ agents: { engineDead: true }, logLines: ['error: something happened'] }) });
    expect(both.rule.id).toBe('engine_no_longer_answering');
  });

  it('reads agent measurements before text and agrees only on the action', () => {
    const runbook = consult({ observation: observation({ agents: { engineDead: true } }) });
    expect(agreesWith(runbook, 'restart_engine')).toBe(true);
    expect(agreesWith(runbook, 'observe')).toBe(false);
    expect(agreesWith(null, 'observe')).toBe(false);
  });
});

describe('the reasoning agents', () => {
  const researcher = createResearcher({ knowledge });
  const expert = createExpert({ knowledge });
  const harmony = createHarmony({ knowledge });

  it('the research agent searches the bundled documentation offline', () => {
    const found = researcher.search({ signals: { missingRuntime: true } });
    expect(found.online).toBe(false);
    expect(found.matches.length).toBeGreaterThan(0);
    expect(found.matches.every((match) => match.source && match.text)).toBe(true);
    expect(found.searched).toContain('knowledge.failureDefinitions');
    // It says so plainly when the documentation has nothing.
    const nothing = researcher.search({ signals: {} });
    expect(nothing.matches).toEqual([]);
    expect(nothing.summary).toMatch(/nothing/);
  });

  it('the research agent uses previously verified incidents from this machine', () => {
    const similar = researcher.search({
      signals: { accessDenied: true },
      diagnosisId: 'permission_denied',
      experiences: [{ id: 'e1', diagnosis: { id: 'permission_denied' }, action: { id: 'repair_permissions' }, outcome: 'success', evidence: ['writing inside the app folder was denied'] }],
    });
    expect(similar.similar.length).toBe(1);
    expect(similar.similar[0].diagnosis).toBe('permission_denied');
    expect(similar.similar[0].verified).toBe(true);
  });

  it('the expert calls documented normal behaviour normal', () => {
    const verdict = expert.assess({
      observation: observation({ process: { windowExpected: false, alive: true } }),
      signals: {},
      modelAction: 'restart_same_profile',
    });
    expect(verdict.diagnosis).toBe('console_headless');
    expect(verdict.action).toBe('none');
    expect(verdict.confidence).toBe('documented');
    expect(verdict.disagrees).toBe(true);
    expect(verdict.conflictReason).toMatch(/restart_same_profile/);
  });

  it('the expert does not call a failed launch normal, however young it is', () => {
    const verdict = expert.assess({
      observation: observation({ logLines: ['VCRUNTIME140.dll was not found'] }),
      signals: { missingRuntime: true, present: true },
      modelAction: 'spawn_agents',
    });
    expect(verdict.diagnosis).not.toBe('starting_slow');
    expect(verdict.diagnosis).not.toBe('healthy');
    expect(verdict.confidence).not.toBe('documented');
  });

  it('the expert speaks from the agents\u2019 own measurements', () => {
    const dead = expert.assess({ observation: observation(), signals: {}, agentSignals: { engineDead: true }, modelAction: 'spawn_agents' });
    expect(`${dead.diagnosis}/${dead.action}`).toBe('engine_unresponsive/restart_engine');
    expect(dead.confidence).toBe('documented');
    const denied = expert.assess({ observation: observation(), signals: {}, agentSignals: { aclDenied: true }, modelAction: 'spawn_agents' });
    expect(`${denied.diagnosis}/${denied.action}`).toBe('permission_denied/repair_permissions');
  });

  it('the expert names the measurement it is missing instead of guessing', () => {
    const verdict = expert.assess({
      observation: observation({ process: { windowVisible: false, windowAgeMs: 20000 }, logLines: [] }),
      signals: { present: false },
      modelAction: 'observe',
    });
    expect(verdict.confidence).toBe('none');
    expect(verdict.diagnosis).toBeNull();
    expect(verdict.unknowns.length).toBeGreaterThan(0);
    // Asking for help is always a named measurement, never a vague request.
    expect(verdict.wantsMeasurements.every((id) => ['engine', 'window', 'process', 'logs', 'filesystem', 'setup'].includes(id))).toBe(true);
    expect(verdict.wantsMeasurements.length).toBeGreaterThan(0);
  });

  it('harmony resolves a disagreement in the documented direction', () => {
    const expertVerdict = { agent: 'expert', confidence: 'documented', diagnosis: 'engine_unresponsive', action: 'restart_engine', reasons: ['an agent measured that the engine is gone'], unknowns: [], disagrees: true };
    const resolved = harmony.resolve({
      model: { diagnosis: 'unknown_failure', action: 'observe', uncertain: true },
      expert: expertVerdict,
    });
    expect(resolved.verdict).toBe('expert');
    expect(resolved.action).toBe('restart_engine');
    expect(resolved.rules).toContain('documented_beats_uncertain');
  });

  it('lets a documented signature outrank a guess, whichever tool was asked for', () => {
    // The table is consulted in both rounds, because a quoted signature is
    // evidence rather than an inference. `authoritative` says the model asked the
    // table directly, which is worth stating in the reason - it does not change
    // who wins.
    const runbook = consult({ observation: observation({ agents: { engineDead: true } }) });
    const expertWithoutAnswer = { confidence: 'none', diagnosis: null, action: null, unknowns: ['nothing applied'], disagrees: false };

    const agentsRound = harmony.resolve({
      model: { diagnosis: 'unknown_failure', action: 'observe', uncertain: true },
      expert: expertWithoutAnswer,
      runbook,
      authoritative: false,
    });
    expect(agentsRound.verdict).toBe('runbook');
    expect(agentsRound.action).toBe('restart_engine');

    const asked = harmony.resolve({
      model: { diagnosis: 'unknown_failure', action: 'observe', uncertain: true },
      expert: expertWithoutAnswer,
      runbook,
      authoritative: true,
    });
    expect(asked.verdict).toBe('runbook');
    expect(asked.action).toBe('restart_engine');
  });

  it('harmony refuses to pick a side, and reports that instead, when both are equally documented', () => {
    const resolved = harmony.resolve({
      model: { diagnosis: 'window_hang', action: 'restart_same_profile', uncertain: false },
      expert: { confidence: 'documented', diagnosis: 'permission_denied', action: 'repair_permissions', reasons: ['documented'], unknowns: [], disagrees: true },
    });
    expect(resolved.verdict).toBe('unresolved');
    expect(resolved.action).toBe('escalate');
    expect(resolved.reason).toMatch(/no conclusion was forced/i);
  });

  it('harmony can never reach for the app\u2019s data that the model did not propose to touch', () => {
    const resolved = harmony.resolve({
      model: { diagnosis: 'corrupt_profile', action: 'observe', uncertain: true },
      expert: { confidence: 'documented', diagnosis: 'corrupt_profile', action: 'restart_clean_profile', reasons: ['documented'], unknowns: [], disagrees: true },
    });
    expect(isDestructive(knowledge, 'restart_clean_profile')).toBe(true);
    expect(resolved.action).not.toBe('restart_clean_profile');
    expect(resolved.conflicts).toContain('destructive_upgrade_refused');
    expect(riskOf(knowledge, resolved.action)).toBeLessThanOrEqual(riskOf(knowledge, 'restart_clean_profile'));
  });
});

describe('the tool round inside the behavioural monitor', () => {
  function probeStub(sample = {}) {
    return async () => ({
      running: true,
      pidCount: 1,
      windowExpected: true,
      windowVisible: false,
      windowAgeMs: 12000,
      windowHung: false,
      cpuPercent: 3,
      ioIdle: true,
      engineResponsive: true,
      ageMs: 12000,
      exitCode: null,
      logLines: sample.logLines || [],
      environment: {},
    });
  }

  function supervisor({ brain, agents, decisions }) {
    return createBehavioralSupervisor({
      brain,
      listApps: async () => [{ id: 'app-1', name: 'App', status: 'Running', engine: 'rcvm', activeEngine: 'rcvm' }],
      probe: probeStub({ logLines: ['VCRUNTIME140.dll was not found'] }),
      agents,
      onDecision: (notice) => decisions.push(notice),
      intervalMs: 100000,
    });
  }

  function coordinator(probes, calls) {
    return createAgentCoordinator({
      probes: {
        engine: () => { calls.push('engine'); return { signals: { engine_dead: false }, facts: ['the launcher is running'] }; },
        logs: () => { calls.push('logs'); return { signals: {}, facts: ['the log holds one line'] }; },
        ...probes,
      },
    });
  }

  // The monitor's contract is what is under test here, not the model's accuracy
  // (engine.test.js covers that), so the model is a stub that asks for a named
  // tool. This keeps the round's behaviour - one round per incident, the answer
  // applied through the policy, everything reported - testable on its own.
  function stubBrain({ action = 'spawn_agents', diagnosis = 'unknown_failure' } = {}) {
    return {
      available: true,
      error: null,
      analyze: () => ({
        available: true,
        model: { id: 'stub-model' },
        diagnosis: { id: diagnosis, summary: 'not recognised from the evidence', confidence: 0.31, confidenceText: '31%' },
        action: { id: action, label: 'Ask for help', description: 'gather more evidence', risk: 'none', autonomous: true, requiresApproval: false },
        decision: action === 'consult_runbook' ? 'investigate' : 'investigate',
        reason: 'the evidence is incomplete',
        explanation: 'the evidence is incomplete',
        evidence: ['state: Running'],
        uncertain: true,
      }),
      applyArbitration: (decision, arbitration) => ({
        ...decision,
        diagnosis: { ...decision.diagnosis, id: arbitration.diagnosis || decision.diagnosis.id },
        action: { ...decision.action, id: arbitration.action },
        decision: 'execute',
        arbitration: { verdict: arbitration.verdict, outcome: 'applied:execute' },
      }),
    };
  }

  it('runs the tools once per incident and applies the documented answer through the policy', async () => {
    const calls = [];
    const decisions = [];
    const brain = stubBrain({ action: 'spawn_agents' });
    const agents = coordinator({}, calls);
    const supervisorUnderTest = supervisor({ brain, agents, decisions });

    await supervisorUnderTest.tick();
    const first = decisions[0];
    expect(first).toBeTruthy();
    expect(first.agents).toBeTruthy();
    expect(first.agents.tool).toBe('spawn_agents');
    expect(first.agents.spawned.length).toBeGreaterThan(0);
    // The round's conclusion reached the decision through the policy, and the
    // reported action is a real catalogue action, never the tool call itself.
    expect(first.action.id).not.toBe('spawn_agents');
    expect(ACTION_IDS.has(first.action.id)).toBe(true);

    // A second tick must not investigate again: the budget is one round per
    // incident. What the model concludes on its own afterwards is its business;
    // no second tool call may happen.
    const rounds = calls.length;
    await supervisorUnderTest.tick();
    expect(calls.length).toBe(rounds);
    // Only the first notice came from a round; a later one, if any, is the model
    // deciding on its own with the investigation already spent.
    expect(decisions[0].agents.tool).toBe('spawn_agents');
    expect(decisions.slice(1).every((notice) => notice.agents === null)).toBe(true);
  });

  it('reports what was consulted, including the Runbook match, to the interface', async () => {
    const calls = [];
    const decisions = [];
    const brain = stubBrain({ action: 'consult_runbook' });
    // Force the Runbook tool by answering every measurement with "nothing".
    const forced = createAgentCoordinator({
      probes: Object.fromEntries(['engine', 'window', 'process', 'filesystem', 'logs', 'setup'].map((id) => [id, () => ({ signals: {}, facts: [] })])),
    });
    const supervisorUnderTest = supervisor({ brain, agents: forced, decisions });
    await supervisorUnderTest.tick();
    const notice = decisions[0];
    expect(notice.agents.tool).toBe('consult_runbook');
    // The probe stub's log line names a missing runtime, which is an exact
    // documented signature, so the table answered and nothing needed measuring.
    expect(notice.agents.runbook.matched).toBe(true);
    expect(notice.agents.runbook.rule.id).toBe('missing_runtime');
    expect(notice.agents.facts.length).toBeGreaterThan(0);
    expect(notice.agents.arbitration.verdict).toBe('runbook');
    expect(notice.action.id).toBe('advise_runtime_install');
    expect(calls.length).toBe(0);
  });
});
