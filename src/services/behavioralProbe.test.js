const { buildProbeCSharp, buildBehaviorProbeScript, buildBehaviorProbeArgs, parseBehaviorProbeOutput, summarizeProbe } = require('../../public/behavioral-probe');

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

  it('counts a window hosted inside RunContainer as the app window', () => {
    // A hosted window is a child of RunContainer's host window. An EnumWindows-only
    // probe reported it as missing, so the supervisor restarted an app that was visible.
    const csharp = buildProbeCSharp();
    expect(csharp).toContain('EnumChildWindows');
    expect(csharp).toContain('parentOwner == tally.HostProcessId');
    expect(csharp).toContain('Visit(hwnd, tally)');
    expect(csharp).toContain('tally.Count += 1');
    expect(buildBehaviorProbeScript()).toContain('VisibleWindowCount($procId, $hostId)');
    expect(buildBehaviorProbeArgs('C:\\probe.ps1', [12], 4242)).toEqual([
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\probe.ps1', '-Pids', '12', '-HostPid', '4242',
    ]);
  });

  it('parses the result line and tolerates damaged rows', () => {
    const stdout = [
      'some noise',
      'RCBEHAVE {"responsive":true,"windows":[{"pid":12,"visible":true,"windows":2,"hung":false},{"pid":"x"}],"perf":[{"pid":12,"cpu":500000,"io":2048}]}',
    ].join('\r\n');
    const parsed = parseBehaviorProbeOutput(stdout);
    expect(parsed.responsive).toBe(true);
    expect(parsed.windows).toEqual([{ pid: 12, visible: true, windows: 2, foreign: 0, hung: false }]);
    expect(parsed.perf).toEqual([{ pid: 12, cpu: 500000, io: 2048 }]);
    expect(summarizeProbe(parsed)).toEqual({
      windowVisible: true, windowForeign: 0, windowCount: 2, windowHung: false, cpuMs: 50, ioBytes: 2048,
    });
  });

  it('reports a window that exists but cannot be attributed to the host', () => {
    // This is the measurement the window agent dispatches for: the app has a visible
    // window, but it is a child of a process that is neither the app nor the host the
    // probe was given, so a windowless reading would be a measurement error.
    expect(buildProbeCSharp()).toContain('ForeignWindowCount');
    const parsed = parseBehaviorProbeOutput('RCBEHAVE {"responsive":true,"windows":[{"pid":12,"visible":false,"windows":0,"foreign":1,"hung":false}],"perf":[]}');
    const summary = summarizeProbe(parsed);
    expect(summary.windowVisible).toBe(false);
    expect(summary.windowForeign).toBe(1);
  });

  it('refuses unreadable probe output instead of guessing', () => {
    expect(() => parseBehaviorProbeOutput('nothing here')).toThrow(/did not return a result/);
    expect(() => parseBehaviorProbeOutput('RCBEHAVE {broken')).toThrow(/unreadable/);
  });

  it('reports null counters when the probe returned no perf rows', () => {
    const parsed = parseBehaviorProbeOutput('RCBEHAVE {"responsive":true,"windows":[],"perf":[]}');
    expect(summarizeProbe(parsed)).toEqual({ windowVisible: false, windowForeign: 0, windowCount: 0, windowHung: false, cpuMs: null, ioBytes: null });
  });
});
