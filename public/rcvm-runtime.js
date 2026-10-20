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
  const uint LIMIT_JOB_MEMORY = 0x00000100;
  const uint LIMIT_ACTIVE_PROCESS = 0x00000008;
  const int INFO_EXTENDED_LIMIT = 9;
  const int INFO_CPU_RATE = 15;
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
      long memoryCapBytes, int cpuRate, int maxProcesses) {
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
      PROCESS_INFORMATION pi;
      bool created = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
        CREATE_SUSPENDED, IntPtr.Zero, workDir, ref si, out pi);
      if (!created) return JsonError("The app could not be started suspended: " + Marshal.GetLastWin32Error());
      try {
        if (!AssignProcessToJobObject(job, pi.hProcess)) {
          TerminateProcess(pi.hProcess, 1);
          return JsonError("The app could not be placed in its job object: " + Marshal.GetLastWin32Error());
        }
        ResumeThread(pi.hThread);
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

  public static string WaitForExit(string jobName, int pid) {
    try {
      IntPtr proc;
      lock (jobs) { JobProcessHandles.TryGetValue(jobName, out proc); }
      if (proc == IntPtr.Zero) return "{\\"pid\\":" + pid + ",\\"exitCode\\":null,\\"note\\":\\"launcher lost the process handle\\"}";
      WaitForSingleObject(proc, INFINITE);
      uint code;
      GetExitCodeProcess(proc, out code);
      CloseHandle(proc);
      lock (jobs) {
        IntPtr job;
        if (jobs.TryGetValue(jobName, out job)) { CloseHandle(job); jobs.Remove(jobName); }
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
function buildRcvmLaunchScript({
  jobName,
  executablePath,
  workingDirectory,
  appDataDir,
  localAppDataDir,
  tempDir,
  launchArgs = '',
  memoryCapBytes,
  cpuRate,
  maxProcesses,
} = {}) {
  if (!jobName || !executablePath || !workingDirectory || !appDataDir || !localAppDataDir || !tempDir) {
    throw new Error('RCVM launcher needs a job name, executable, working directory, and profile folders.');
  }
  if (!Number.isSafeInteger(memoryCapBytes) || !Number.isSafeInteger(cpuRate) || !Number.isSafeInteger(maxProcesses)) {
    throw new Error('RCVM launcher needs numeric job limits (validate them first).');
  }
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$csharp = @'\n${RCVM_CSHARP}\n'@`,
    'Add-Type -TypeDefinition $csharp -Language CSharp',
    `$env:APPDATA = ${psQuote(appDataDir)}`,
    `$env:LOCALAPPDATA = ${psQuote(localAppDataDir)}`,
    `$env:TEMP = ${psQuote(tempDir)}`,
    `$env:TMP = ${psQuote(tempDir)}`,
    `$startJson = [RcvmLauncher]::Start(${psQuote(jobName)}, ${psQuote(executablePath)}, ${psQuote(launchArgs)}, ${psQuote(workingDirectory)}, ${memoryCapBytes}, ${cpuRate}, ${maxProcesses})`,
    'Write-Output $startJson',
    '[Console]::Out.Flush()',
    '$start = $startJson | ConvertFrom-Json',
    'if ($start.pid) {',
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
  }
  return result;
}

module.exports = {
  RCVM_DEFAULTS,
  RCVM_LIMITS,
  cpuRateForCount,
  validateRcvmLimits,
  rcvmJobName,
  buildRcvmLaunchScript,
  parseRcvmLauncherOutput,
};
