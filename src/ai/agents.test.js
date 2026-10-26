const {
  AGENT_CATALOGUE,
  AGENT_IDS,
  AGENT_FEATURES,
  routeAgents,
  normalizeFinding,
  agentFeatureValues,
  createAgentCoordinator,
} = require('./agents');
const { FEATURE_NAMES } = require('./features');

function observation(overrides = {}) {
  return {
    app: { status: 'Running', ...(overrides.app || {}) },
    process: {
      alive: true,
      pidCount: 1,
      windowExpected: true,
      windowVisible: false,
      hung: false,
      engineResponsive: true,
      ...(overrides.process || {}),
    },
    logLines: overrides.logLines || [],
    environment: overrides.environment || {},
    history: overrides.history || {},
  };
}

describe('specialist evidence agents', () => {
  it('declares each agent signal as a feature the model was trained on', () => {
    for (const agent of AGENT_CATALOGUE) {
      for (const key of agent.signalKeys) {
        expect(FEATURE_NAMES).toContain(`agent_${key}`);
      }
      expect(agent.basis).toBeTruthy();
      expect(agent.purpose).toBeTruthy();
      expect(agent.risk || 'none').toBe('none');
    }
    expect(AGENT_FEATURES.every((name) => FEATURE_NAMES.includes(name))).toBe(true);
    expect(AGENT_IDS).toEqual(['engine', 'window', 'process', 'filesystem', 'logs', 'setup']);
  });

  it('routes agents by the evidence that is missing, not by a guess', () => {
    expect(routeAgents({ observation: observation({ logLines: [] }) })).toEqual(['window', 'process', 'logs']);
    expect(routeAgents({
      observation: observation({ process: { engineResponsive: false, windowVisible: true } }),
    })).toContain('engine');
    expect(routeAgents({
      observation: observation({ app: { status: 'Launching' }, logLines: ['Copying installer'] }),
    })).toContain('setup');
    expect(routeAgents({
      observation: observation({ logLines: ['something odd happened'] }),
      diagnosisId: 'unknown_failure',
    })).toContain('filesystem');
    // A healthy, windowed app with log output needs no agent at all.
    expect(routeAgents({
      observation: observation({ process: { windowVisible: true }, logLines: ['Window created'] }),
      diagnosisId: 'healthy',
    })).toEqual([]);
  });

  it('caps how many agents one dispatch may spawn', () => {
    const routed = routeAgents({
      observation: observation({ process: { hung: true, engineResponsive: false }, logLines: [] }),
      diagnosisId: 'unknown_failure',
      maxAgents: 2,
    });
    expect(routed.length).toBe(2);
  });

  it('ignores a signal an agent does not own and says so as evidence', () => {
    const engineAgent = AGENT_CATALOGUE.find((agent) => agent.id === 'engine');
    const normalized = normalizeFinding(engineAgent, {
      signals: { engine_dead: true, acl_denied: true, engine_dead_guess: 'yes' },
      facts: ['the launcher process has exited'],
    });
    expect(normalized.signals).toEqual({ engine_dead: true });
    expect(normalized.facts).toContain('the launcher process has exited');
    expect(normalized.facts.join(' ')).toContain('outside its declared signals');
    expect(normalized.facts.join(' ')).toContain('acl_denied');
  });

  it('turns measurements into exactly the feature names the model expects', () => {
    const values = agentFeatureValues([
      { id: 'engine', ok: true, signals: { engine_dead: true } },
      { id: 'filesystem', ok: true, signals: { acl_denied: true, reparse_link: true } },
      { id: 'logs', ok: false, signals: {} },
    ], { dispatched: true, available: true });
    expect(values.agents_available).toBe(1);
    expect(values.agents_dispatched).toBe(1);
    expect(values.agents_found_new).toBe(1);
    expect(values.agent_engine_dead).toBe(1);
    expect(values.agent_acl_denied).toBe(1);
    expect(values.agent_reparse_link).toBe(1);
    expect(values.agent_window_elsewhere).toBe(0);
    expect(Object.keys(values).sort()).toEqual([...AGENT_FEATURES].sort());
  });

  it('dispatches the named agents in parallel and merges their findings', async () => {
    const calls = [];
    const coordinator = createAgentCoordinator({
      probes: {
        engine: (args) => {
          calls.push(Object.keys(args).sort());
          return { signals: { engine_dead: true }, facts: ['the RCVM launcher has exited'] };
        },
        logs: () => ({ signals: {}, facts: ['the log is empty'] }),
        window: () => { throw new Error('EnumWindows failed'); },
      },
    });
    const result = await coordinator.dispatch({
      observation: observation({ process: { engineResponsive: false }, logLines: [] }),
    });
    expect(result.agents.map((agent) => agent.id)).toEqual(['engine', 'window', 'process']);
    const engineResult = result.agents.find((agent) => agent.id === 'engine');
    expect(engineResult.ok).toBe(true);
    expect(result.signals.engineDead).toBe(true);
    expect(result.features.agent_engine_dead).toBe(1);
    const windowResult = result.agents.find((agent) => agent.id === 'window');
    expect(windowResult.ok).toBe(false);
    expect(windowResult.reason).toBe('EnumWindows failed');
    expect(result.facts).toContain('Engine agent: the RCVM launcher has exited');
    expect(result.facts.join(' ')).toContain('Window agent could not report: EnumWindows failed');
    expect(result.facts.join(' ')).toContain('Process agent could not report');
    // Probes receive evidence only — never a command, an argument list or a handle.
    for (const keys of calls) expect(keys).toEqual(['diagnosisId', 'history', 'observation']);
  });

  it('reports a missing probe honestly instead of pretending it measured something', async () => {
    const coordinator = createAgentCoordinator({ probes: {} });
    const result = await coordinator.dispatch({
      observation: observation({ process: { engineResponsive: false }, logLines: ['x'] }),
    });
    expect(result.agents.every((agent) => agent.ok === false)).toBe(true);
    expect(result.facts.join(' ')).toContain('no probe is registered in this build');
    expect(result.features.agents_found_new).toBe(0);
  });

  it('boxes a probe that never answers', async () => {
    const coordinator = createAgentCoordinator({
      probes: { engine: () => new Promise(() => {}) },
      timeoutMs: 40,
    });
    const result = await coordinator.dispatch({
      observation: observation({ logLines: ['still working'], process: { engineResponsive: false, windowVisible: true } }),
    });
    expect(result.agents.map((agent) => agent.id)).toEqual(['engine']);
    const engineResult = result.agents[0];
    expect(engineResult.ok).toBe(false);
    expect(engineResult.reason).toMatch(/did not answer/);
    expect(result.signals.engineDead).toBe(false);
    expect(result.features.agent_engine_dead).toBe(0);
  });

  it('labels the catalogue for the interface', async () => {
    const coordinator = createAgentCoordinator({ probes: { logs: () => ({ signals: {}, facts: ['nothing unusual'] }) } });
    expect(coordinator.catalogue.map((agent) => agent.id)).toEqual(AGENT_IDS);
    expect(coordinator.catalogue.find((agent) => agent.id === 'logs').available).toBe(true);
    expect(coordinator.catalogue.find((agent) => agent.id === 'engine').available).toBe(false);
  });
});
