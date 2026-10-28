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
  return crypto.createHash('sha256').update(RCVM_CSHARP + RCVM_HOST_CSHARP).digest('hex').slice(0, 16);
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
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class RcvmLauncher {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint INFINITE = 0xFFFFFFFF;
  const int ERROR_ELEVATION_REQUIRED = 740;
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

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string appName, StringBuilder cmdLine, IntPtr procAttr,
    IntPtr threadAttr, bool inheritHandles, uint creationFlags, IntPtr env,
    string curDir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  [DllImport("kernel32.dll")]
  static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

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
    return "{\\\"error\\\":\\\"" + message.Replace("\\\\", "\\\\\\\\").Replace("\\\"", "\\\\\\\"") + "\\\"}";
  }

  // Win32 failures carry a code so the caller can act on the reason instead of
  // matching an English message. 740 means the executable asks for administrator
  // rights, which a medium-integrity CreateProcess is not allowed to grant.
  static string JsonError(string message, string code) {
    return "{\\\"error\\\":\\\"" + message.Replace("\\\\", "\\\\\\\\").Replace("\\\"", "\\\\\\\"")
      + "\\\",\\\"code\\\":\\\"" + code + "\\\"}";
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
      if (!created) {
        int createError = Marshal.GetLastWin32Error();
        if (createError == ERROR_ELEVATION_REQUIRED) {
          return JsonError("The app could not be started suspended: " + createError, "elevation_required");
        }
        return JsonError("The app could not be started suspended: " + createError, "launch_failed");
      }
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

  // Ends the contained tree through its job. The elevated host window uses this when
  // the user closes it, so the app cannot outlive the window they closed.
  public static void TerminateJob(string jobName)
  {
    IntPtr job;
    lock (jobs) { jobs.TryGetValue(jobName, out job); }
    if (job == IntPtr.Zero) return;
    TerminateJobObject(job, 0);
  }

  // True while the contained tree still has a live process. The host window keeps
  // watching for a window as long as that is true, because an installer that finishes
  // and starts the app it installed is the most common way an elevated app's window
  // appears - well after the launch itself returned.
  public static bool JobActive(string jobName)
  {
    IntPtr job;
    lock (jobs) { jobs.TryGetValue(jobName, out job); }
    if (job == IntPtr.Zero) return false;
    return ActiveProcesses(job) > 0;
  }

  // Job membership is inherited by descendants, so it still identifies the app's window
  // after the installer that started it has exited and left it orphaned in the process
  // list, where the parent chain no longer leads back to the process that was launched.
  public static bool JobHasProcess(string jobName, uint processId)
  {
    IntPtr job;
    lock (jobs) { jobs.TryGetValue(jobName, out job); }
    if (job == IntPtr.Zero) return false;
    IntPtr proc = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, processId);
    if (proc == IntPtr.Zero) return false;
    try
    {
      bool member;
      if (!IsProcessInJob(proc, job, out member)) return false;
      return member;
    }
    finally { CloseHandle(proc); }
  }

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

  public static string WaitForExit(string jobName, int pid, string stopFile) {
    try {
      IntPtr proc;
      IntPtr job;
      lock (jobs) {
        JobProcessHandles.TryGetValue(jobName, out proc);
        jobs.TryGetValue(jobName, out job);
      }
      if (proc == IntPtr.Zero) return "{\\"pid\\":" + pid + ",\\"exitCode\\":null,\\"note\\":\\"launcher lost the process handle\\"}";
      // An elevated launcher cannot be killed by the medium-integrity app, so Stop
      // asks it to finish through a file instead of a taskkill that would fail.
      if (string.IsNullOrEmpty(stopFile)) {
        WaitForSingleObject(proc, INFINITE);
      } else {
        while (WaitForSingleObject(proc, 500) == 0x00000102) {
          // End the whole job, not just the root process: a launcher can have children
          // (installers, bootstrappers) and leaving them behind would make Stop look
          // like it worked while the app kept running.
          if (File.Exists(stopFile)) {
            if (job != IntPtr.Zero) TerminateJobObject(job, 0);
            else TerminateProcess(proc, 0);
            break;
          }
        }
      }
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

// Hosting for apps that needed administrator approval.
//
// Windows refuses to let the medium-integrity RunContainer window re-parent an
// elevated app's window (UIPI: a lower-integrity process cannot manipulate a higher
// one), which is why elevated apps used to open as bare windows on the desktop. The
// elevated launcher runs at the SAME integrity level as the app, so it can host the
// window itself. The result is a RunContainer-titled window that contains the app or
// its installer wizard; closing it ends the contained tree through the job.
// The host class is compiled into the same assembly as the launcher, so it relies on
// RCVM_CSHARP's using directives instead of repeating them (a second using block after
// a class declaration would not compile).
const RCVM_HOST_CSHARP = `
public static class RcvmWindowHost
{
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  struct HostRect { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WndClassEx
  {
    public uint cbSize;
    public uint style;
    public WndProc lpfnWndProc;
    public int cbClsExtra;
    public int cbWndExtra;
    public IntPtr hInstance;
    public IntPtr hIcon;
    public IntPtr hCursor;
    public IntPtr hbrBackground;
    public string lpszMenuName;
    public string lpszClassName;
    public IntPtr hIconSm;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Msg
  {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x;
    public int y;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcEntry
  {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out HostRect rect);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out HostRect rect);
  [DllImport("user32.dll", EntryPoint = "GetWindowLong")] static extern int GetWindowLong32(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLong")] static extern int SetWindowLong32(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassExW(ref WndClassEx cls);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern sbyte GetMessage(out Msg msg, IntPtr hwnd, uint filterMin, uint filterMax);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Msg msg);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint elapse, IntPtr proc);
  [DllImport("user32.dll")] static extern IntPtr SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr LoadCursorW(IntPtr instance, IntPtr name);
  [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(int color);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool Process32First(IntPtr snapshot, ref ProcEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool Process32Next(IntPtr snapshot, ref ProcEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  const int WsChild = 0x40000000;
  const int WsPopup = unchecked((int)0x80000000);
  const int WsExAppWindow = 0x00040000;
  const int GwlStyle = -16;
  const int GwlExStyle = -20;
  const int SwHide = 0;
  const int SwShow = 5;
  const uint Th32csSnapProcess = 0x00000002;
  const uint WmSize = 0x0005;
  const uint WmClose = 0x0010;
  const uint WmDestroy = 0x0002;
  const uint WmTimer = 0x0113;
  const int WsOverlappedWindow = 0x00CF0000;

  static IntPtr host = IntPtr.Zero;
  // Every window of this app that the host has adopted. An installer wizard routinely
  // shows more than one (an unpacking splash, then the wizard, then a progress dialog),
  // and each of them belongs inside the host rather than on the desktop.
  static List<IntPtr> hostedWindows = new List<IntPtr>();
  // The adopted window that fills the host; the others keep their own size, centred.
  static IntPtr primary = IntPtr.Zero;
  static uint appPid;
  static string jobName = "";
  static string stopFile = "";
  static int giveUpAtMs;
  static int startedAtMs;

  // Starts the host window on its own STA thread and returns immediately, so the
  // launcher can keep holding the job (and its caps) while the app runs.
  public static void Begin(string title, uint processId, string job, string stopPath, int timeoutMs)
  {
    appPid = processId;
    jobName = job == null ? "" : job;
    stopFile = stopPath == null ? "" : stopPath;
    giveUpAtMs = timeoutMs > 0 ? timeoutMs : 0;
    startedAtMs = Environment.TickCount;
    System.Threading.Thread thread = new System.Threading.Thread(delegate() { Run(title); });
    thread.IsBackground = true;
    thread.SetApartmentState(System.Threading.ApartmentState.STA);
    thread.Start();
  }

  static void Run(string title)
  {
    IntPtr instance = GetModuleHandleW(null);
    WndClassEx cls = new WndClassEx();
    cls.cbSize = (uint)Marshal.SizeOf(typeof(WndClassEx));
    cls.style = 0x0002;
    cls.lpfnWndProc = WindowProc;
    cls.hInstance = instance;
    cls.hCursor = LoadCursorW(IntPtr.Zero, new IntPtr(32512));
    // Dark background, so the first seconds (before the app draws its window) look like
    // a RunContainer surface rather than an empty white rectangle.
    cls.hbrBackground = CreateSolidBrush(0x00110F0D);
    cls.lpszClassName = "RunContainerAdminHost";
    ushort atom = RegisterClassExW(ref cls);
    if (atom == 0 && Marshal.GetLastWin32Error() != 1410) return;
    host = CreateWindowExW(0, "RunContainerAdminHost", title, WsOverlappedWindow, 140, 90, 1100, 780, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
    if (host == IntPtr.Zero) return;
    ShowWindow(host, SwShow);
    SetForegroundWindow(host);
    SetTimer(host, (UIntPtr)1, 250, IntPtr.Zero);
    Msg msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
    {
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
  }

  static IntPtr WindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
  {
    if (msg == WmTimer) { Tick(); return IntPtr.Zero; }
    if (msg == WmSize) { Fit(); return IntPtr.Zero; }
    if (msg == WmClose)
    {
      // Closing the window closes the app: a window the user dismissed must not
      // leave a contained tree running invisibly behind it.
      RcvmLauncher.TerminateJob(jobName);
      DestroyWindow(hwnd);
      return IntPtr.Zero;
    }
    if (msg == WmDestroy) { PostQuitMessage(0); return IntPtr.Zero; }
    return DefWindowProc(hwnd, msg, wParam, lParam);
  }

  static void Fit()
  {
    if (host == IntPtr.Zero) return;
    HostRect client;
    if (!GetClientRect(host, out client)) return;
    int width = client.Right - client.Left;
    int height = client.Bottom - client.Top;
    if (width <= 0 || height <= 0) return;
    for (int i = 0; i < hostedWindows.Count; i += 1)
    {
      IntPtr window = hostedWindows[i];
      if (!IsWindow(window)) continue;
      if (window == primary)
      {
        MoveWindow(window, 0, 0, width, height, true);
        continue;
      }
      // A second window (a dialog) keeps its own size instead of being stretched
      // edge to edge, which would throw the app's own layout apart.
      HostRect own;
      if (!GetWindowRect(window, out own)) continue;
      int ownWidth = Math.Min(Math.Max(own.Right - own.Left, 320), Math.Max(width - 48, 320));
      int ownHeight = Math.Min(Math.Max(own.Bottom - own.Top, 200), Math.Max(height - 48, 200));
      MoveWindow(window, Math.Max((width - ownWidth) / 2, 0), Math.Max((height - ownHeight) / 2, 0), ownWidth, ownHeight, true);
    }
  }

  // Adopts one window: makes it a real child of the host and shows it inside.
  static bool Adopt(IntPtr found)
  {
    ShowWindow(found, SwHide);
    int style = GetWindowLong32(found, GwlStyle);
    SetParent(found, host);
    // SetParent deliberately keeps WS_POPUP, and a popup still reports its OWNER from
    // GetParent, so the style change has to happen before the result is checked.
    SetWindowLong32(found, GwlStyle, (style | WsChild) & ~WsPopup);
    SetWindowLong32(found, GwlExStyle, GetWindowLong32(found, GwlExStyle) & ~WsExAppWindow);
    if (GetParent(found) != host)
    {
      // Never leave an app invisible: if hosting is refused, put the window back on
      // the desktop exactly as it was.
      SetParent(found, IntPtr.Zero);
      SetWindowLong32(found, GwlStyle, style);
      ShowWindow(found, SwShow);
      return false;
    }
    hostedWindows.Add(found);
    ShowWindow(found, SwShow);
    return true;
  }

  // The largest adopted window is the app's main one: an installer's wizard is bigger
  // than the splash screen or progress dialog beside it.
  static void ChoosePrimary()
  {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    for (int i = 0; i < hostedWindows.Count; i += 1)
    {
      IntPtr window = hostedWindows[i];
      if (!IsWindow(window)) continue;
      HostRect rect;
      if (!GetWindowRect(window, out rect)) continue;
      long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
      if (area > bestArea) { bestArea = area; best = window; }
    }
    primary = best;
  }

  static Dictionary<uint, uint> Parents()
  {
    Dictionary<uint, uint> map = new Dictionary<uint, uint>();
    IntPtr snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
    if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return map;
    try
    {
      ProcEntry entry = new ProcEntry();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(ProcEntry));
      if (!Process32First(snapshot, ref entry)) return map;
      do { map[entry.th32ProcessID] = entry.th32ParentProcessID; }
      while (Process32Next(snapshot, ref entry));
    }
    finally { CloseHandle(snapshot); }
    return map;
  }

  // Installers and launchers routinely show their wizard from a second process, so the
  // started PID and everything below it count as the app.
  static bool InLineage(uint processId, Dictionary<uint, uint> parents)
  {
    uint current = processId;
    for (int depth = 0; depth < 32; depth += 1)
    {
      if (current == appPid) return true;
      uint parent;
      if (!parents.TryGetValue(current, out parent)) return false;
      if (parent == 0 || parent == current) return false;
      current = parent;
    }
    return false;
  }

  static void Tick()
  {
    if (host == IntPtr.Zero) return;
    if (!string.IsNullOrEmpty(stopFile) && File.Exists(stopFile))
    {
      RcvmLauncher.TerminateJob(jobName);
      DestroyWindow(host);
      return;
    }
    // A window the app closed is no longer ours to fit; the list is the only record of
    // what has been adopted, because a hosted window is no longer a top-level one and
    // EnumWindows can no longer see it.
    for (int i = hostedWindows.Count - 1; i >= 0; i -= 1)
    {
      IntPtr window = hostedWindows[i];
      if (!IsWindow(window) || GetParent(window) != host) hostedWindows.RemoveAt(i);
    }
    Dictionary<uint, uint> parents = Parents();
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr param)
    {
      // Top-level owned dialogs have an owner returned by GetParent; they are not
      // child windows and must be considered for hosting too.
      if ((GetWindowLong32(hwnd, GwlStyle) & WsChild) != 0) return true;
      if (!IsWindowVisible(hwnd)) return true;
      if (GetWindowTextLength(hwnd) == 0) return true;
      HostRect rect;
      if (!GetWindowRect(hwnd, out rect)) return true;
      if (rect.Right - rect.Left < 200 || rect.Bottom - rect.Top < 150) return true;
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner == 0) return true;
      // The started process and everything below it, plus every process still inside the
      // job. Membership outlives the parent chain: an installer that exits after starting
      // what it installed leaves the app orphaned in the process list, where the parent
      // chain no longer leads back to the process that was launched.
      if (!InLineage(owner, parents) && !RcvmLauncher.JobHasProcess(jobName, owner)) return true;
      if (hostedWindows.Contains(hwnd)) return true;
      found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    // Every window this app owns is adopted, not just the first one.
    for (int i = 0; i < found.Count; i += 1) Adopt(found[i]);
    if (hostedWindows.Count > 0)
    {
      ChoosePrimary();
      Fit();
      return;
    }
    // A console tool legitimately never opens a window, but a contained tree that is
    // still alive may still be about to: an installer that finishes and starts the app
    // it installed shows a window long after the launch itself. Destroying the host on a
    // timer is what left those windows on the desktop with nothing to be hosted in, so
    // the host only goes once the tree it belongs to is gone.
    if (giveUpAtMs > 0 && unchecked(Environment.TickCount - startedAtMs) > giveUpAtMs && !RcvmLauncher.JobActive(jobName))
    {
      DestroyWindow(host);
    }
  }
}
`;

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
  resultFile = '',
  stopFile = '',
  hostWindowTitle = '',
  hostWindowTimeoutMs = 30000,
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
  const csharpSource = `${RCVM_CSHARP}\n${RCVM_HOST_CSHARP}`;
  const loader = launcherCacheDir
    ? [
      `$cacheDll = ${psQuote(`${launcherCacheDir.replace(/[\\/]+$/, '')}\\RcvmLauncher-${launcherCacheKey}.dll`)}`,
      '$cacheReady = $false',
      'if (Test-Path -LiteralPath $cacheDll) {',
      '  try { Add-Type -Path $cacheDll; $cacheReady = $true } catch { $cacheReady = $false }',
      '}',
      'if (-not $cacheReady) {',
      `  $csharp = @'\n${csharpSource}\n'@`,
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
      `$csharp = @'\n${csharpSource}\n'@`,
      'Add-Type -TypeDefinition $csharp -Language CSharp',
    ];
  // An elevated launcher's stdout cannot be read by the medium-integrity app that
  // started it, so its result lines are also appended to a file the app polls.
  const resultLines = (jsonVar) => (resultFile
    ? [`Add-Content -LiteralPath ${psQuote(resultFile)} -Value ${jsonVar} -Encoding UTF8`]
    : []);
  // WaitForExit ends the app when the stop file appears; that is how Stop reaches
  // an elevated app that taskkill from a medium process cannot open.
  const waitCall = stopFile
    ? `[RcvmLauncher]::WaitForExit(${psQuote(jobName)}, [int]$start.pid, ${psQuote(stopFile)})`
    : `[RcvmLauncher]::WaitForExit(${psQuote(jobName)}, [int]$start.pid, '')`;
  // Apps that needed administrator approval cannot be hosted by the medium-integrity
  // RunContainer window, so this elevated launcher hosts the window itself. The title
  // is the only thing the caller controls; it is quoted, never interpolated.
  const hostLines = hostWindowTitle
    ? [`  [RcvmWindowHost]::Begin(${psQuote(hostWindowTitle)}, [uint32]$start.pid, ${psQuote(jobName)}, ${psQuote(stopFile || '')}, ${Number.isSafeInteger(hostWindowTimeoutMs) && hostWindowTimeoutMs > 0 ? hostWindowTimeoutMs : 30000})`]
    : [];
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
    ...resultLines('$startJson'),
    '$start = $startJson | ConvertFrom-Json',
    'if ($start.pid) {',
    `  $verifyJson = [RcvmLauncher]::Verify(${psQuote(jobName)}, [int]$start.pid, ${memoryCapBytes}, ${cpuRate}, ${maxProcesses})`,
    '  Write-Output $verifyJson',
    '  [Console]::Out.Flush()',
    ...resultLines('$verifyJson').map((line) => `  ${line}`),
    ...hostLines,
    `  $exitJson = ${waitCall}`,
    '  Write-Output $exitJson',
    ...resultLines('$exitJson').map((line) => `  ${line}`),
    '}',
  ].join('\r\n');
}

// Reads the launcher's line-delimited JSON: first {"pid":N}, finally
// {"exitCode":N} or {"error":"..."}. Never throws.
function parseRcvmLauncherOutput(stdout) {
  const result = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    // The elevated launcher appends with -Encoding UTF8, whose first write carries a
    // byte-order mark; PowerShell also emits CRLF. Neither may hide a result line.
    const trimmed = line.trim().replace(/^\uFEFF/, '');
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
      if (typeof parsed.code === 'string') result.code = parsed.code;
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
