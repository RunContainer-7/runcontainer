const {
  RCVM_DEFAULTS,
  cpuRateForCount,
  validateRcvmLimits,
  rcvmJobName,
  buildRcvmLaunchScript,
  parseRcvmLauncherOutput,
} = require('../../public/rcvm-runtime');

const SCRIPT_OPTS = {
  jobName: 'RunContainer-RCVM-test',
  executablePath: 'C:\\apps\\demo\\app.exe',
  workingDirectory: 'C:\\data\\env',
  appDataDir: 'C:\\data\\env\\profile\\Roaming',
  localAppDataDir: 'C:\\data\\env\\profile\\Local',
  tempDir: 'C:\\data\\env\\profile\\Temp',
  userProfileDir: 'C:\\data\\env\\profile',
  launchArgs: '--safe-mode',
  memoryCapBytes: 2048 * 1024 * 1024,
  cpuRate: 2500,
  maxProcesses: 32,
};

describe('RCVM user-mode container backend', () => {
  it('validates limits and maps them to job-object units', () => {
    const good = validateRcvmLimits({ memoryMB: 2048, cpuCount: 2, maxProcesses: 32, processorCount: 8 });
    expect(good.ok).toBe(true);
    expect(good.limits.memoryCapBytes).toBe(2048 * 1024 * 1024);
    // 2 CPUs of 8 = 25% of total machine CPU.
    expect(good.limits.cpuRate).toBe(2500);

    expect(validateRcvmLimits({ memoryMB: 64 }).ok).toBe(false);
    expect(validateRcvmLimits({ cpuCount: 99 }).ok).toBe(false);
    expect(validateRcvmLimits({ maxProcesses: 0 }).ok).toBe(false);
  });

  it('fills defaults for untouched tweaks', () => {
    const filled = validateRcvmLimits({});
    expect(filled.ok).toBe(true);
    expect(filled.limits.memoryMB).toBe(RCVM_DEFAULTS.memoryMB);
    expect(filled.limits.cpuCount).toBe(RCVM_DEFAULTS.cpuCount);
    expect(filled.limits.maxProcesses).toBe(RCVM_DEFAULTS.maxProcesses);
  });

  it('uses stable per-app job names', () => {
    expect(rcvmJobName('abc')).toBe(rcvmJobName('abc'));
    expect(rcvmJobName('abc')).not.toBe(rcvmJobName('abd'));
    expect(rcvmJobName('abc')).toMatch(/^RunContainer-RCVM-[0-9a-f]+$/);
  });

  it('builds a launcher that contains, redirects, and reports', () => {
    const script = buildRcvmLaunchScript(SCRIPT_OPTS);
    // Job containment primitives.
    expect(script).toContain('CreateJobObjectW');
    expect(script).toContain('AssignProcessToJobObject');
    expect(script).toContain('LIMIT_KILL_ON_JOB_CLOSE');
    expect(script).toContain('CREATE_SUSPENDED');
    // Redirected profile (set after Add-Type so compiler temp stays real).
    expect(script.indexOf('Add-Type')).toBeLessThan(script.indexOf('$env:APPDATA'));
    expect(script).toContain('LOCALAPPDATA');
    expect(script).toContain('$env:USERPROFILE');
    expect(script).toContain('$env:HOMEDRIVE');
    expect(script).toContain('$env:HOMEPATH');
    // Post-launch verification of the actual process.
    expect(script).toContain('IsProcessInJob');
    expect(script).toContain('QueryInformationJobObject');
    expect(script).toContain('[RcvmLauncher]::Verify');
    expect(script.indexOf('Write-Output $verifyJson')).toBeLessThan(script.indexOf('[RcvmLauncher]::WaitForExit'));
    // Limits and identity flow through.
    expect(script).toContain(String(2048 * 1024 * 1024));
    expect(script).toContain('RunContainer-RCVM-test');
    expect(script).toContain('--safe-mode');
    // PID is reported before waiting, exit code after.
    expect(script.indexOf('Write-Output $startJson')).toBeLessThan(script.indexOf('[RcvmLauncher]::WaitForExit'));
  });

  it('keeps the job alive until the last process in it exits', () => {
    // A bootstrapper can exit as soon as it has started the real program. If the
    // launcher closed the job at that moment, kill-on-close would end that child.
    const script = buildRcvmLaunchScript(SCRIPT_OPTS);
    expect(script).toContain('INFO_BASIC_ACCOUNTING');
    expect(script).toContain('ActiveProcesses(job)');
    expect(script).toContain('JOBOBJECT_BASIC_ACCOUNTING_INFORMATION');
    // The wait must poll the job after the root process has exited.
    const wait = script.slice(script.indexOf('public static string WaitForExit'));
    expect(wait).toContain('WaitForSingleObject(proc, INFINITE)');
    expect(wait.indexOf('WaitForSingleObject')).toBeLessThan(wait.indexOf('ActiveProcesses(job)'));
    expect(wait.indexOf('ActiveProcesses(job)')).toBeLessThan(wait.indexOf('CloseHandle(current)'));
  });

  it('passes only validated runtime environment entries to the app', () => {
    const script = buildRcvmLaunchScript({ ...SCRIPT_OPTS, runtimeEnv: { DOTNET_TieredPGO: '1' } });
    expect(script).toContain("$env:DOTNET_TieredPGO = '1'");
    expect(() => buildRcvmLaunchScript({ ...SCRIPT_OPTS, runtimeEnv: { PATH: 'C:\\x' } })).toThrow();
    expect(() => buildRcvmLaunchScript({ ...SCRIPT_OPTS, runtimeEnv: { DOTNET_TieredPGO: "1'; Remove-Item C:\\x" } })).toThrow();
  });

  it('requires the profile folder for the launcher', () => {
    expect(() => buildRcvmLaunchScript({ ...SCRIPT_OPTS, userProfileDir: undefined })).toThrow();
  });

  it('refuses to build a launcher without limits or paths', () => {
    expect(() => buildRcvmLaunchScript({})).toThrow();
    expect(() => buildRcvmLaunchScript({ ...SCRIPT_OPTS, memoryCapBytes: undefined })).toThrow();
  });

  it('reports elevation as an actionable code instead of a bare message', () => {
    // Windows refuses CreateProcess for an exe whose manifest asks for administrator
    // rights. The launcher names that reason so the app can relaunch elevated once,
    // instead of showing "could not be started suspended: 740" with no way forward.
    const script = buildRcvmLaunchScript(SCRIPT_OPTS);
    expect(script).toContain('ERROR_ELEVATION_REQUIRED');
    expect(script).toContain('\\"code\\":');
    expect(script).toContain('elevation_required');
  });

  it('writes results to a file and honours a stop file for an elevated launcher', () => {
    // An elevated launcher's stdout cannot be read from RunContainer, and taskkill
    // cannot open it either, so the launcher reports through files.
    const script = buildRcvmLaunchScript({
      ...SCRIPT_OPTS,
      resultFile: 'C:\\data\\state\\app.result.jsonl',
      stopFile: 'C:\\data\\state\\app.stop',
    });
    expect(script).toContain("Add-Content -LiteralPath 'C:\\data\\state\\app.result.jsonl' -Value $startJson");
    expect(script).toContain("Add-Content -LiteralPath 'C:\\data\\state\\app.result.jsonl' -Value $verifyJson");
    expect(script).toContain("WaitForExit('RunContainer-RCVM-test', [int]$start.pid, 'C:\\data\\state\\app.stop')");
    expect(script).toContain('File.Exists(stopFile)');
    // Without those options the launcher neither writes files nor polls one.
    const plain = buildRcvmLaunchScript(SCRIPT_OPTS);
    expect(plain).not.toContain('Add-Content');
    expect(plain).toContain("WaitForExit('RunContainer-RCVM-test', [int]$start.pid, '')");
  });

  it('hosts an elevated app window from inside the elevated launcher', () => {
    // Windows forbids raising an app's window into the medium-integrity RunContainer
    // window, but the elevated launcher shares the app's integrity level, so it opens
    // its own RunContainer-titled window and parents the app window there.
    const script = buildRcvmLaunchScript({
      ...SCRIPT_OPTS,
      stopFile: 'C:\\data\\state\\app.stop',
      hostWindowTitle: 'RunContainer — Demo (administrator approved)',
    });
    expect(script).toContain('public static class RcvmWindowHost');
    expect(script).toContain("Begin('RunContainer — Demo (administrator approved)', [uint32]$start.pid, 'RunContainer-RCVM-test', 'C:\\data\\state\\app.stop', 30000)");
    // The host starts only after containment is verified, and before the wait that holds
    // the job open for the app's lifetime.
    expect(script.indexOf('[RcvmLauncher]::Verify')).toBeLessThan(script.indexOf('[RcvmWindowHost]::Begin'));
    expect(script.indexOf('[RcvmWindowHost]::Begin')).toBeLessThan(script.indexOf('[RcvmLauncher]::WaitForExit'));
    // Closing the window must end the contained tree, not just the window.
    expect(script).toContain('RcvmLauncher.TerminateJob(jobName)');
    expect(script).toContain('SetParent(found, host)');
    // A normal launch keeps using the Electron host window and gets no extra window.
    expect(buildRcvmLaunchScript(SCRIPT_OPTS)).not.toContain('[RcvmWindowHost]::Begin');
  });

  it('quotes the host window title instead of interpolating it', () => {
    const script = buildRcvmLaunchScript({ ...SCRIPT_OPTS, hostWindowTitle: "Bad'); Remove-Item C:\\x; ('" });
    expect(script).toContain("Begin('Bad''); Remove-Item C:\\x; (''");
    // The title stays a single PowerShell argument, so nothing after it executes.
    expect(script).not.toContain("Begin('Bad'); Remove-Item");
  });

  it('reads a result file that begins with a byte-order mark', () => {
    const parsed = parseRcvmLauncherOutput('\uFEFF{"pid":42,"job":"j"}\r\n\uFEFF{"error":"no","code":"elevation_required"}');
    expect(parsed.pid).toBe(42);
    expect(parsed.code).toBe('elevation_required');
  });

  it('parses the launcher pid/verify/exit/error lines without throwing', () => {
    expect(parseRcvmLauncherOutput('{"pid":1234,"job":"j"}\r\n{"pid":1234,"verified":{"inJob":true,"limits":true,"cpu":true,"integrityRid":8192}}\r\n{"pid":1234,"exitCode":0}'))
      .toEqual({ pid: 1234, job: 'j', verified: { inJob: true, limits: true, cpu: true, integrityRid: 8192 }, exitCode: 0 });
    expect(parseRcvmLauncherOutput('noise\n{"error":"boom"}').error).toBe('boom');
    expect(parseRcvmLauncherOutput('')).toEqual({});
    expect(parseRcvmLauncherOutput(null)).toEqual({});
  });
});
