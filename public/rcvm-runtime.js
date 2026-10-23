// RCVM — RunContainer's own user-mode container backend.
//
// Why this exists: Hyper-V needs Windows Pro/Enterprise/Education, firmware
// virtualization, an admin-enabled feature, and a provisioned guest image. Most
// home PCs have none of that. RCVM runs on every Windows 10/11 edition with no
// admin rights and no reboot, so containment works out of the box.
//
// What it honestly is (and is not):
// - REAL: each app launches suspended, is assigned to a Windows Job Object, then
//   resumed. The job enforces kill-on-close (killing the launcher ends the whole
//   app tree), a commit-memory cap, a CPU hard cap, and a process-count cap. The
//   launcher stays alive holding the job, so caps apply for the app's lifetime.
//   The app also gets per-app APPDATA/LOCALAPPDATA/TEMP folders, so well-behaved
//   apps keep their data separate from the user's profile.
// - NOT a hardware VM: same kernel, no copy-on-write filesystem/registry overlay,
//   no network cut-off (that needs AppContainer-without-capabilities or a driver).
//   It is process + resource containment with data separation — marketed as such.
//
// Builders here are pure (unit tested, Windows-verified); the Node side in
// main.js spawns the generated launcher the same way it runs other scripts.

const crypto = require('crypto');

const RCVM_DEFAULTS = {
  memoryMB: 2048,
  cpuCount: 2,
  maxProcesses: 32,
};

const RCVM_LIMITS = {
  memoryMB: { min: 256, max: 32768 },
  cpuCount: { min: 1, max: 16 },
  maxProcesses: { min: 1, max: 256 },
};

// One CPU's worth of compute, in JOBOBJECT_CPU_RATE_CONTROL_INFORMATION units
// (hundredths of a percent of total machine CPU).
function cpuRateForCount(cpuCount, processorCount) {
  const procs = Number.isSafeInteger(processorCount) && processorCount > 0 ? processorCount : 4;
  const count = Math.min(Math.max(Math.round(cpuCount) || RCVM_DEFAULTS.cpuCount, 1), 64);
  return Math.min(Math.max(Math.round((count / procs) * 10000), 100), 10000);
}

function validateRcvmLimits({ memoryMB, cpuCount, maxProcesses, processorCount } = {}) {
  const memory = memoryMB === undefined || memoryMB === null || memoryMB === ''
    ? RCVM_DEFAULTS.memoryMB
    : Number(memoryMB);
  const cpu = cpuCount === undefined || cpuCount === null || cpuCount === ''
    ? RCVM_DEFAULTS.cpuCount
    : Number(cpuCount);
  const procs = maxProcesses === undefined || maxProcesses === null || maxProcesses === ''
    ? RCVM_DEFAULTS.maxProcesses
    : Number(maxProcesses);

  if (!Number.isSafeInteger(memory) || memory < RCVM_LIMITS.memoryMB.min || memory > RCVM_LIMITS.memoryMB.max) {
    return { ok: false, reason: `Memory cap must be ${RCVM_LIMITS.memoryMB.min}–${RCVM_LIMITS.memoryMB.max} MB.` };
  }
  if (!Number.isSafeInteger(cpu) || cpu < RCVM_LIMITS.cpuCount.min || cpu > RCVM_LIMITS.cpuCount.max) {
    return { ok: false, reason: `CPU share must be ${RCVM_LIMITS.cpuCount.min}–${RCVM_LIMITS.cpuCount.max}.` };
  }
  if (!Number.isSafeInteger(procs) || procs < RCVM_LIMITS.maxProcesses.min || procs > RCVM_LIMITS.maxProcesses.max) {
    return { ok: false, reason: `Process limit must be ${RCVM_LIMITS.maxProcesses.min}–${RCVM_LIMITS.maxProcesses.max}.` };
  }
  return {
    ok: true,
    limits: {
      memoryCapBytes: memory * 1024 * 1024,
      cpuRate: cpuRateForCount(cpu, processorCount),
      maxProcesses: procs,
      memoryMB: memory,
      cpuCount: cpu,
    },
  };
}

// Identifies the C# source so a cached assembly can only be reused for the same
// launcher. Change RCVM_CSHARP and the key changes with it.
function rcvmLauncherCacheKey() {
  return crypto.createHash('sha256').update(RCVM_CSHARP).digest('hex').slice(0, 16);
}

function rcvmJobName(appId) {
  const hash = crypto.createHash('sha256').update(String(appId)).digest('hex').slice(0, 12);
  return `RunContainer-RCVM-${hash}`;
}

// Single-quote escaping for PowerShell string literals.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const RCVM_CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class RcvmLauncher {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint INFINITE = 0xFFFFFFFF;
  const uint LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint LIMIT_JOB_MEMORY = 0x00000200;
  const uint LIMIT_ACTIVE_PROCESS = 0x00000008;
  const int INFO_EXTENDED_LIMIT = 9;
  const int INFO_CPU_RATE = 15;
  const int INFO_BASIC_ACCOUNTING = 1;
  const uint CPU_ENABLE = 0x1;
  const uint CPU_HARD_CAP = 0x4;

  static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long JobMemoryLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
    public uint ControlFlags;
    public uint CpuRate;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string appName, StringBuilder cmdLine, IntPtr procAttr,
    IntPtr threadAttr, bool inheritHandles, uint creationFlags, IntPtr env,
    string curDir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  [DllImport("kernel32.dll")]
  static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size, IntPtr retLen);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint size, out uint retLen);

  [DllImport("advapi32.dll")]
  static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

  [DllImport("advapi32.dll")]
  static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint millis);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  static string JsonError(string message) {
    return "{\\"error\\":\\"" + message.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"") + "\\"}";
  }

  public static string Start(string jobName, string exe, string cmdArgs, string workDir,
      long memoryCapBytes, int cpuRate, int maxProcesses, int showState) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return JsonError("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    try {
      var extended = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      extended.BasicLimitInformation.LimitFlags = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_JOB_MEMORY | LIMIT_ACTIVE_PROCESS;
      extended.BasicLimitInformation.JobMemoryLimit = memoryCapBytes;
      extended.BasicLimitInformation.ActiveProcessLimit = (uint)maxProcesses;
      extended.JobMemoryLimit = (UIntPtr)((ulong)memoryCapBytes);
      int extSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr extPtr = Marshal.AllocHGlobal(extSize);
      try {
        Marshal.StructureToPtr(extended, extPtr, false);
        if (!SetInformationJobObject(job, INFO_EXTENDED_LIMIT, extPtr, (uint)extSize))
          return JsonError("Job memory/process limits were refused: " + Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(extPtr); }

      var cpu = new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION();
      cpu.ControlFlags = CPU_ENABLE | CPU_HARD_CAP;
      cpu.CpuRate = (uint)cpuRate;
      int cpuSize = Marshal.SizeOf(typeof(JOBOBJECT_CPU_RATE_CONTROL_INFORMATION));
      IntPtr cpuPtr = Marshal.AllocHGlobal(cpuSize);
      try {
        Marshal.StructureToPtr(cpu, cpuPtr, false);
        if (!SetInformationJobObject(job, INFO_CPU_RATE, cpuPtr, (uint)cpuSize))
          return JsonError("Job CPU cap was refused: " + Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(cpuPtr); }

      var cmd = new StringBuilder();
      cmd.Append('"').Append(exe).Append('"');
      if (!string.IsNullOrEmpty(cmdArgs)) { cmd.Append(' ').Append(cmdArgs); }
      var si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      // showState 0 (SW_HIDE) makes a GUI app create its first window hidden, so the
      // window host can put it inside RunContainer instead of it appearing on the
      // desktop first. Console apps pass -1 and keep Windows' default behaviour.
      if (showState >= 0) { si.dwFlags = 0x00000001; si.wShowWindow = (short)showState; }
      PROCESS_INFORMATION pi;
      bool created = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
        CREATE_SUSPENDED, IntPtr.Zero, workDir, ref si, out pi);
      if (!created) return JsonError("The app could not be started suspended: " + Marshal.GetLastWin32Error());
      try {
        if (!AssignProcessToJobObject(job, pi.hProcess)) {
          TerminateProcess(pi.hProcess, 1);
          return JsonError("The app could not be placed in its job object: " + Marshal.GetLastWin32Error());
        }
        uint prevSuspend = ResumeThread(pi.hThread);
        if (prevSuspend != 1) {
          TerminateProcess(pi.hProcess, 1);
          CloseHandle(pi.hThread);
          CloseHandle(pi.hProcess);
          return JsonError("The app thread did not resume from exactly one suspend count.");
        }
        CloseHandle(pi.hThread);
        // The process handle is intentionally leaked here: WaitForExit closes it.
        // The job handle is kept so limits apply until the launcher exits.
        lock (jobs) { jobs[jobName] = job; }
        JobProcessHandles[jobName] = pi.hProcess;
        return "{\\"pid\\":" + pi.dwProcessId + ",\\"job\\":\\"" + jobName + "\\"}";
      } catch (Exception ex) {
        TerminateProcess(pi.hProcess, 1);
        return JsonError(ex.Message);
      }
    } catch (Exception ex) {
      CloseHandle(job);
      return JsonError(ex.Message);
    }
  }

  static readonly Dictionary<string, IntPtr> JobProcessHandles = new Dictionary<string, IntPtr>();

  // Post-launch verification of the ACTUAL process: job membership against OUR
  // job handle, the enforced limits, and the token integrity level (reported,
  // not forced — this launcher does not change tokens).
  public static string Verify(string jobName, int pid, long memoryCapBytes, int cpuRate, int maxProcesses) {
    try {
      IntPtr job;
      lock (jobs) { jobs.TryGetValue(jobName, out job); }
      if (job == IntPtr.Zero) return JsonError("Job handle is missing for verification.");
      IntPtr proc;
      lock (jobs) { JobProcessHandles.TryGetValue(jobName, out proc); }
      if (proc == IntPtr.Zero) return JsonError("Process handle is missing for verification.");
      bool inJob = false;
      bool inJobOk = IsProcessInJob(proc, job, out inJob);
      bool limitsOk = false;
      bool cpuOk = false;
      int extSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr extPtr = Marshal.AllocHGlobal(extSize);
      try {
        if (QueryInformationJobObject(job, INFO_EXTENDED_LIMIT, extPtr, (uint)extSize, IntPtr.Zero)) {
          var current = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(extPtr, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
          uint need = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_JOB_MEMORY | LIMIT_ACTIVE_PROCESS;
          limitsOk = ((current.BasicLimitInformation.LimitFlags & need) == need)
            && (current.BasicLimitInformation.JobMemoryLimit == memoryCapBytes
              || current.JobMemoryLimit == (UIntPtr)((ulong)memoryCapBytes))
            && current.BasicLimitInformation.ActiveProcessLimit == (uint)maxProcesses;
        }
      } finally { Marshal.FreeHGlobal(extPtr); }
      int cpuSize = Marshal.SizeOf(typeof(JOBOBJECT_CPU_RATE_CONTROL_INFORMATION));
      IntPtr cpuPtr = Marshal.AllocHGlobal(cpuSize);
      try {
        if (QueryInformationJobObject(job, INFO_CPU_RATE, cpuPtr, (uint)cpuSize, IntPtr.Zero)) {
          var currentCpu = (JOBOBJECT_CPU_RATE_CONTROL_INFORMATION)Marshal.PtrToStructure(cpuPtr, typeof(JOBOBJECT_CPU_RATE_CONTROL_INFORMATION));
          cpuOk = ((currentCpu.ControlFlags & (CPU_ENABLE | CPU_HARD_CAP)) == (CPU_ENABLE | CPU_HARD_CAP))
            && currentCpu.CpuRate == (uint)cpuRate;
        }
      } finally { Marshal.FreeHGlobal(cpuPtr); }
      int integrityRid = -1;
      IntPtr token = IntPtr.Zero;
      try {
        if (OpenProcessToken(proc, 0x8 /* TOKEN_QUERY */, out token)) {
          uint need = 0;
          GetTokenInformation(token, 25 /* TokenIntegrityLevel */, IntPtr.Zero, 0, out need);
          if (need > 0) {
            IntPtr buf = Marshal.AllocHGlobal((int)need);
            try {
              uint got = 0;
              if (GetTokenInformation(token, 25, buf, need, out got)) {
                IntPtr sid = Marshal.ReadIntPtr(buf);
                byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count > 0) integrityRid = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
              }
            } finally { Marshal.FreeHGlobal(buf); }
          }
          CloseHandle(token);
        }
      } catch (Exception) { }
      return "{\\\"pid\\\":" + pid
        + ",\\\"verified\\\":{\\\"inJob\\\":" + (inJobOk && inJob ? "true" : "false")
        + ",\\\"limits\\\":" + (limitsOk ? "true" : "false")
        + ",\\\"cpu\\\":" + (cpuOk ? "true" : "false")
        + ",\\\"integrityRid\\\":" + integrityRid + "}}";
    } catch (Exception ex) {
      return JsonError("Verification failed: " + ex.Message);
    }
  }

  // Number of processes still alive in the job. Zero also means the query failed,
  // which ends the wait rather than holding a job open forever.
  static uint ActiveProcesses(IntPtr job) {
    int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, INFO_BASIC_ACCOUNTING, buf, (uint)size, IntPtr.Zero)) return 0;
      var info = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buf, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      return info.ActiveProcesses;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  public static string WaitForExit(string jobName, int pid) {
    try {
      IntPtr proc;
      IntPtr job;
      lock (jobs) {
        JobProcessHandles.TryGetValue(jobName, out proc);
        jobs.TryGetValue(jobName, out job);
      }
      if (proc == IntPtr.Zero) return "{\\"pid\\":" + pid + ",\\"exitCode\\":null,\\"note\\":\\"launcher lost the process handle\\"}";
      WaitForSingleObject(proc, INFINITE);
      uint code;
      GetExitCodeProcess(proc, out code);
      CloseHandle(proc);
      // A bootstrapper (installer, updater, launcher) can exit after handing the
      // real work to a child. Closing the job here would end that child through
      // kill-on-close, so keep the job - and its caps - until the job is empty.
      // Three quiet checks (~450ms) cover a child that is still being created.
      int quiet = 0;
      while (job != IntPtr.Zero) {
        if (ActiveProcesses(job) == 0) {
          quiet += 1;
          if (quiet >= 3) break;
        } else {
          quiet = 0;
        }
        System.Threading.Thread.Sleep(150);
      }
      lock (jobs) {
        IntPtr current;
        if (jobs.TryGetValue(jobName, out current)) { CloseHandle(current); jobs.Remove(jobName); }
        JobProcessHandles.Remove(jobName);
      }
      return "{\\"pid\\":" + pid + ",\\"exitCode\\":" + code + "}";
    } catch (Exception ex) {
      return JsonError(ex.Message);
    }
  }
}
`.trim();

// Builds the .ps1 launcher. Profile dirs must already exist (Node creates them).
// $env: overrides are set AFTER Add-Type so compiler temp files use the real
// profile; the app inherits the redirected profile from the launcher.
//
// Compiling the C# with Add-Type costs roughly as much as starting the app, so
// when launcherCacheDir is given the assembly is compiled once and loaded from
// disk afterwards. launcherCacheKey must change whenever RCVM_CSHARP does, so a
// cached assembly from an older build is never loaded (main.js hashes the
// source). Without a cache dir the launcher compiles in memory every run, which
// is what the unit tests and the verification script exercise.
function buildRcvmLaunchScript({
  jobName,
  executablePath,
  workingDirectory,
  appDataDir,
  localAppDataDir,
  tempDir,
  userProfileDir,
  launchArgs = '',
  memoryCapBytes,
  cpuRate,
  maxProcesses,
  runtimeEnv = {},
  startHidden = false,
  launcherCacheDir,
  launcherCacheKey,
} = {}) {
  if (!jobName || !executablePath || !workingDirectory || !appDataDir || !localAppDataDir || !tempDir || !userProfileDir) {
    throw new Error('RCVM launcher needs a job name, executable, working directory, and profile folders.');
  }
  if (!Number.isSafeInteger(memoryCapBytes) || !Number.isSafeInteger(cpuRate) || !Number.isSafeInteger(maxProcesses)) {
    throw new Error('RCVM launcher needs numeric job limits (validate them first).');
  }
  if (launcherCacheDir && !launcherCacheKey) {
    throw new Error('RCVM launcher cache needs a key so a stale assembly cannot load.');
  }
  // Runtime knobs (currently only documented .NET switches) must be plain
  // NAME=value pairs; anything else is refused instead of reaching PowerShell.
  const runtimeEnvEntries = Object.entries(runtimeEnv || {});
  for (const [key, value] of runtimeEnvEntries) {
    // Variable names keep their documented spelling (DOTNET_TieredPGO), so
    // letters of either case are allowed; values stay to plain tokens.
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !/^[0-9A-Za-z._-]{1,64}$/.test(String(value))) {
      throw new Error(`Refusing to set an unsafe runtime environment entry: ${key}.`);
    }
  }
  // USERPROFILE/HOMEDRIVE/HOMEPATH are set alongside APPDATA so more
  // well-behaved apps resolve into the per-app profile. This is still
  // environment redirection, not Known-Folder redirection: apps using
  // SHGetKnownFolderPath can resolve outside it, which the docs state openly.
  const normalized = String(userProfileDir).replace(/\//g, '\\');
  const driveMatch = normalized.match(/^([A-Za-z]:)(\\.*)?$/);
  const homeDrive = driveMatch ? driveMatch[1] : 'C:';
  const homePath = driveMatch && driveMatch[2] ? driveMatch[2] : '\\';
  const loader = launcherCacheDir
    ? [
      `$cacheDll = ${psQuote(`${launcherCacheDir.replace(/[\\/]+$/, '')}\\RcvmLauncher-${launcherCacheKey}.dll`)}`,
      '$cacheReady = $false',
      'if (Test-Path -LiteralPath $cacheDll) {',
      '  try { Add-Type -Path $cacheDll; $cacheReady = $true } catch { $cacheReady = $false }',
      '}',
      'if (-not $cacheReady) {',
      `  $csharp = @'\n${RCVM_CSHARP}\n'@`,
      '  try {',
      '    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cacheDll)',
      '    Add-Type -TypeDefinition $csharp -Language CSharp -OutputAssembly $cacheDll -OutputType Library',
      '    Add-Type -Path $cacheDll',
      '  } catch {',
      '    Add-Type -TypeDefinition $csharp -Language CSharp',
      '  }',
      '}',
    ]
    : [
      `$csharp = @'\n${RCVM_CSHARP}\n'@`,
      'Add-Type -TypeDefinition $csharp -Language CSharp',
    ];
  return [
    '$ErrorActionPreference = \'Stop\'',
    ...loader,
    `$env:APPDATA = ${psQuote(appDataDir)}`,
    `$env:LOCALAPPDATA = ${psQuote(localAppDataDir)}`,
    `$env:TEMP = ${psQuote(tempDir)}`,
    `$env:TMP = ${psQuote(tempDir)}`,
    `$env:USERPROFILE = ${psQuote(userProfileDir)}`,
    `$env:HOMEDRIVE = ${psQuote(homeDrive)}`,
    `$env:HOMEPATH = ${psQuote(homePath)}`,
    ...runtimeEnvEntries.map(([key, value]) => `$env:${key} = ${psQuote(value)}`),
    `$startJson = [RcvmLauncher]::Start(${psQuote(jobName)}, ${psQuote(executablePath)}, ${psQuote(launchArgs)}, ${psQuote(workingDirectory)}, ${memoryCapBytes}, ${cpuRate}, ${maxProcesses}, ${startHidden ? 0 : -1})`,
    'Write-Output $startJson',
    '[Console]::Out.Flush()',
    '$start = $startJson | ConvertFrom-Json',
    'if ($start.pid) {',
    `  $verifyJson = [RcvmLauncher]::Verify(${psQuote(jobName)}, [int]$start.pid, ${memoryCapBytes}, ${cpuRate}, ${maxProcesses})`,
    '  Write-Output $verifyJson',
    '  [Console]::Out.Flush()',
    `  $exitJson = [RcvmLauncher]::WaitForExit(${psQuote(jobName)}, [int]$start.pid)`,
    '  Write-Output $exitJson',
    '}',
  ].join('\r\n');
}

// Reads the launcher's line-delimited JSON: first {"pid":N}, finally
// {"exitCode":N} or {"error":"..."}. Never throws.
function parseRcvmLauncherOutput(stdout) {
  const result = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }
    if (Number.isSafeInteger(parsed?.pid) && parsed.pid > 0 && result.pid === undefined) {
      result.pid = parsed.pid;
    }
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'exitCode')) {
      result.exitCode = parsed.exitCode;
    }
    if (typeof parsed?.error === 'string' && !result.error) {
      result.error = parsed.error;
    }
    if (typeof parsed?.job === 'string' && !result.job) {
      result.job = parsed.job;
    }
    if (parsed && typeof parsed.verified === 'object' && parsed.verified !== null && result.verified === undefined) {
      result.verified = parsed.verified;
    }
  }
  return result;
}

module.exports = {
  RCVM_DEFAULTS,
  RCVM_LIMITS,
  cpuRateForCount,
  validateRcvmLimits,
  rcvmJobName,
  rcvmLauncherCacheKey,
  buildRcvmLaunchScript,
  parseRcvmLauncherOutput,
};
