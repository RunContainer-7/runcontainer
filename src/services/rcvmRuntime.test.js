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

  it('requires the profile folder for the launcher', () => {
    expect(() => buildRcvmLaunchScript({ ...SCRIPT_OPTS, userProfileDir: undefined })).toThrow();
  });

  it('refuses to build a launcher without limits or paths', () => {
    expect(() => buildRcvmLaunchScript({})).toThrow();
    expect(() => buildRcvmLaunchScript({ ...SCRIPT_OPTS, memoryCapBytes: undefined })).toThrow();
  });

  it('parses the launcher pid/verify/exit/error lines without throwing', () => {
    expect(parseRcvmLauncherOutput('{"pid":1234,"job":"j"}\r\n{"pid":1234,"verified":{"inJob":true,"limits":true,"cpu":true,"integrityRid":8192}}\r\n{"pid":1234,"exitCode":0}'))
      .toEqual({ pid: 1234, job: 'j', verified: { inJob: true, limits: true, cpu: true, integrityRid: 8192 }, exitCode: 0 });
    expect(parseRcvmLauncherOutput('noise\n{"error":"boom"}').error).toBe('boom');
    expect(parseRcvmLauncherOutput('')).toEqual({});
    expect(parseRcvmLauncherOutput(null)).toEqual({});
  });
});
