param(
  [Parameter(Mandatory = $true)] [string] $ExePath,
  [Parameter(Mandatory = $true)] [string] $SandboxRoot,
  [Parameter(Mandatory = $true)] [string] $RuntimeRoot,
  [Parameter(Mandatory = $true)] [string] $AppDataRoot,
  [Parameter(Mandatory = $true)] [string] $TempRoot,
  [Parameter(Mandatory = $true)] [string] $LogsRoot,
  [string] $ParentHwnd
)

$ErrorActionPreference = 'Stop'

$env:APPDATA = $AppDataRoot
$env:LOCALAPPDATA = $AppDataRoot
$env:USERPROFILE = $SandboxRoot
$env:HOME = $SandboxRoot
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:DESKTOP = Join-Path $SandboxRoot 'Desktop'
$env:Desktop = $env:DESKTOP
$env:DOCUMENTS = Join-Path $SandboxRoot 'Documents'
$env:Documents = $env:DOCUMENTS
$env:DOWNLOADS = Join-Path $SandboxRoot 'Downloads'
$env:Downloads = $env:DOWNLOADS
$env:PICTURES = Join-Path $SandboxRoot 'Pictures'
$env:Pictures = $env:PICTURES
$env:MUSIC = Join-Path $SandboxRoot 'Music'
$env:Music = $env:MUSIC
$env:VIDEOS = Join-Path $SandboxRoot 'Videos'
$env:Videos = $env:VIDEOS
$env:PROGRAMFILES = Join-Path $SandboxRoot 'Program Files'
$env:ProgramFiles = $env:PROGRAMFILES
$env:PROGRAMDATA = Join-Path $SandboxRoot 'ProgramData'
$env:ProgramData = $env:PROGRAMDATA
$env:PUBLIC = Join-Path $SandboxRoot 'Public'
$env:Public = $env:PUBLIC
$env:RUNCONTAINER_SANDBOX_ROOT = $SandboxRoot
$env:RUNCONTAINER_RUNTIME_ROOT = $RuntimeRoot
$env:RUNCONTAINER_APPDATA_ROOT = $AppDataRoot
$env:RUNCONTAINER_LOGS_ROOT = $LogsRoot

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class Win32Job
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll")]
    public static extern bool SetInformationJobObject(IntPtr hJob, JobObjectInfoType infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    public enum JobObjectInfoType { ExtendedLimitInformation = 9 }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public const int JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const int JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x4;

    public static IntPtr CreateAndConfigureJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) { throw new Exception("CreateJobObject failed."); }

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr infoPtr = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(info, infoPtr, false);
        bool ok = SetInformationJobObject(job, JobObjectInfoType.ExtendedLimitInformation, infoPtr, (uint)size);
        Marshal.FreeHGlobal(infoPtr);
        if (!ok) { throw new Exception("SetInformationJobObject failed."); }
        return job;
    }
}

public class User32
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
}
"@

$job = [Win32Job]::CreateAndConfigureJob()
$process = Start-Process -FilePath $ExePath -WorkingDirectory $RuntimeRoot -PassThru
[void][Win32Job]::AssignProcessToJobObject($job, $process.Handle)

$embedded = $false
$needsDesktopChoice = $false
if ($ParentHwnd) {
  try {
    $parentHandle = [IntPtr]::Parse($ParentHwnd, [System.Globalization.NumberStyles]::HexNumber)
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
      $process.Refresh()
      if ($process.HasExited) { break }

      $candidateHandles = New-Object System.Collections.Generic.List[System.IntPtr]
      $enumCallback = {
        param($hWnd, $lParam)
        $pid = 0
        [void][User32]::GetWindowThreadProcessId($hWnd, [ref]$pid)
        if ($pid -eq $process.Id -and [User32]::IsWindowVisible($hWnd)) {
          $script:candidateHandles.Add($hWnd)
        }
        return $true
      }

      $script:candidateHandles = $candidateHandles
      [void][User32]::EnumWindows([User32+EnumWindowsProc]$enumCallback, [IntPtr]::Zero)

      foreach ($candidateHandle in $candidateHandles) {
        if ($candidateHandle -eq [IntPtr]::Zero) { continue }
        try {
          $style = [User32]::GetWindowLongPtr($candidateHandle, -16)
          $updatedStyle = $style -band (-bnot [IntPtr]0x80000000)
          $updatedStyle = $updatedStyle -bor [IntPtr]0x40000000 -bor [IntPtr]0x04000000 -bor [IntPtr]0x02000000
          [void][User32]::SetWindowLongPtr($candidateHandle, -16, $updatedStyle)
          [void][User32]::SetParent($candidateHandle, $parentHandle)
          [void][User32]::SetWindowPos($candidateHandle, [IntPtr](-1), 0, 0, 1280, 840, 0x0040 -bor 0x0002)
          [void][User32]::ShowWindow($candidateHandle, 1)
          $embedded = $true
          break
        } catch {
          continue
        }
      }

      if ($embedded) { break }
      Start-Sleep -Milliseconds(100)
    }
  } catch {
    $embedded = $false
  }
}

$reason = $null
if (-not $embedded) {
  $needsDesktopChoice = $true
  if (-not $ParentHwnd) {
    $reason = 'No RunContainer host window was available for embedding.'
  } elseif ($process.HasExited) {
    $reason = 'The process exited before a window could be attached.'
  } else {
    $reason = 'The executable launched in the sandbox, but RunContainer could not attach its window into the host surface.'
  }
}

$result = [PSCustomObject]@{
  pid = $process.Id
  name = $process.ProcessName
  embedded = $embedded
  needsDesktopChoice = $needsDesktopChoice
  reason = $reason
}
$result | ConvertTo-Json -Compress
