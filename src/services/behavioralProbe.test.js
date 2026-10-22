const { buildBehaviorProbeScript, buildBehaviorProbeArgs, parseBehaviorProbeOutput, summarizeProbe } = require('../../public/behavioral-probe');

describe('behavioural probe', () => {
  it('builds a script that asks Win32 for windows and reads CPU/IO counters', () => {
    const script = buildBehaviorProbeScript();
    expect(script).toContain('EnumWindows');
    expect(script).toContain('IsWindowVisible');
    expect(script).toContain('IsHungAppWindow');
    expect(script).toContain('Win32_PerfRawData_PerfProc_Process');
    expect(script).toContain('RCBEHAVE');
  });

  it('passes only positive numeric PIDs to PowerShell', () => {
    const args = buildBehaviorProbeArgs('C:\\probe.ps1', [12, 0, -3, 'abc', 44]);
    expect(args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\probe.ps1', '-Pids', '12,44']);
  });

  it('parses the result line and tolerates damaged rows', () => {
    const stdout = [
      'some noise',
      'RCBEHAVE {"responsive":true,"windows":[{"pid":12,"visible":true,"windows":2,"hung":false},{"pid":"x"}],"perf":[{"pid":12,"cpu":500000,"io":2048}]}',
    ].join('\r\n');
    const parsed = parseBehaviorProbeOutput(stdout);
    expect(parsed.responsive).toBe(true);
    expect(parsed.windows).toEqual([{ pid: 12, visible: true, windows: 2, hung: false }]);
    expect(parsed.perf).toEqual([{ pid: 12, cpu: 500000, io: 2048 }]);
    expect(summarizeProbe(parsed)).toEqual({ windowVisible: true, windowHung: false, cpuMs: 50, ioBytes: 2048 });
  });

  it('refuses unreadable probe output instead of guessing', () => {
    expect(() => parseBehaviorProbeOutput('nothing here')).toThrow(/did not return a result/);
    expect(() => parseBehaviorProbeOutput('RCBEHAVE {broken')).toThrow(/unreadable/);
  });

  it('reports null counters when the probe returned no perf rows', () => {
    const parsed = parseBehaviorProbeOutput('RCBEHAVE {"responsive":true,"windows":[],"perf":[]}');
    expect(summarizeProbe(parsed)).toEqual({ windowVisible: false, windowHung: false, cpuMs: null, ioBytes: null });
  });
});
