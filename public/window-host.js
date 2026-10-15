// Window hosting.
//
// LiveContainer on iOS runs a guest app inside its own process by mapping the guest binary
// and loading it as a library. Windows has no supported in-process loader for an arbitrary
// PE executable (only DLLs can be loaded into a running process), so "running inside
// RunContainer" on Windows means two separate things:
//
//   1. Process isolation  - the app runs in its own process under an AppContainer or a
//      Sandboxie-Plus box. This is what keeps it away from the rest of the system.
//   2. Window hosting     - the app's top-level window is re-parented into RunContainer's
//      window so the app visually appears inside the app. This adds no isolation at all.
//
// This module implements only (2). Hosting is best-effort: Windows can refuse to re-parent a
// window across integrity levels, and some apps misbehave when hosted, so a failure is
// logged and the app keeps running in its own window.
//
// Only text is built and parsed here, so it can be unit tested off Windows.

const RESULT_PREFIX = 'RCWINDOWHOST ';

function buildWindowHostCSharp() {
  return `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class RunContainerWindowHost
{
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr hwnd, uint command);

    [DllImport("user32.dll")]
    static extern IntPtr GetParent(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetParent(IntPtr child, IntPtr parent);

    [DllImport("user32.dll")]
    static extern bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
    static extern int GetWindowLong32(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
    static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
    static extern int SetWindowLong32(IntPtr hwnd, int index, int value);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
    static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int index, IntPtr value);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    const uint GwOwner = 4;
    const int GwlStyle = -16;
    const int GwlExStyle = -20;
    const int SwShow = 5;
    const int SwShowNormal = 1;
    const uint SwpNoZOrder = 0x0004;
    const uint SwpFrameChanged = 0x0020;
    const uint SwpShowWindow = 0x0040;
    const int WsChild = 0x40000000;
    const int WsPopup = unchecked((int)0x80000000);
    const int WsExAppWindow = 0x00040000;

    static List<IntPtr> TopLevelWindowsForProcess(uint processId)
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr param)
        {
            uint ownerPid;
            GetWindowThreadProcessId(hwnd, out ownerPid);
            if (ownerPid != processId) return true;
            if (!IsWindowVisible(hwnd)) return true;
            if (GetParent(hwnd) != IntPtr.Zero) return true;
            if (GetWindow(hwnd, GwOwner) != IntPtr.Zero) return true;
            found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // Waits for the app to create its main window. Launching is asynchronous, and installers
    // often show their window a few seconds after the process starts.
    public static long FindMainWindow(uint processId, int timeoutMs)
    {
        Stopwatch clock = Stopwatch.StartNew();
        while (true)
        {
            List<IntPtr> windows = TopLevelWindowsForProcess(processId);
            if (windows.Count > 0) return windows[0].ToInt64();
            if (clock.ElapsedMilliseconds >= timeoutMs) return 0;
            System.Threading.Thread.Sleep(250);
        }
    }

    public static bool Embed(long childHandle, long parentHandle)
    {
        IntPtr child = new IntPtr(childHandle);
        IntPtr parent = new IntPtr(parentHandle);
        if (!IsWindow(child) || !IsWindow(parent)) return false;
        if (Convert.ToInt64(SetParent(child, parent)) == 0 && Marshal.GetLastWin32Error() != 0) return false;

        RECT client;
        if (GetClientRect(parent, out client))
        {
            int width = client.Right - client.Left;
            int height = client.Bottom - client.Top;
            if (width > 0 && height > 0) MoveWindow(child, 0, 0, width, height, true);
        }
        ShowWindow(child, SwShow);
        return GetParent(child) == parent;
    }

    // Puts the window back on the desktop before the app is stopped or deleted, so nothing
    // is left parented to a window that is about to disappear.
    public static int ReleaseProcessWindows(uint processId, long parentHandle)
    {
        IntPtr parent = new IntPtr(parentHandle);
        int released = 0;
        foreach (IntPtr hwnd in TopLevelWindowsForProcess(processId))
        {
            if (GetParent(hwnd) != parent) continue;
            SetParent(hwnd, IntPtr.Zero);
            int style = GetWindowLong32(hwnd, GwlStyle);
            style = (style & ~WsChild) | WsPopup;
            SetWindowLong32(hwnd, GwlStyle, style);
            SetWindowLong32(hwnd, GwlExStyle, GetWindowLong32(hwnd, GwlExStyle) | WsExAppWindow);
            SetWindowPos(hwnd, IntPtr.Zero, 80, 80, 1024, 768, SwpNoZOrder | SwpFrameChanged | SwpShowWindow);
            ShowWindow(hwnd, SwShowNormal);
            released += 1;
        }
        return released;
    }
}
`;
}

function buildWindowHostScript() {
  return [
    'param([string]$Mode, [int]$ProcessId, [string]$Parent, [int]$TimeoutMs = 12000)',
    "$ErrorActionPreference = 'Stop'",
    "$source = @'",
    buildWindowHostCSharp(),
    "'@",
    'Add-Type -TypeDefinition $source -Language CSharp',
    'try {',
    "  if ($Mode -eq 'release') {",
    '    $count = [RunContainerWindowHost]::ReleaseProcessWindows([uint32]$ProcessId, [int64]$Parent)',
    `    Write-Output ('${RESULT_PREFIX}' + (@{ released = $count } | ConvertTo-Json -Compress))`,
    '  } else {',
    '    $child = [RunContainerWindowHost]::FindMainWindow([uint32]$ProcessId, $TimeoutMs)',
    '    if ($child -eq 0) {',
    `      Write-Output ('${RESULT_PREFIX}' + (@{ embedded = $false; reason = 'the app did not open a window RunContainer could host' } | ConvertTo-Json -Compress))`,
    '    } else {',
    '      $embedded = [RunContainerWindowHost]::Embed($child, [int64]$Parent)',
    `      Write-Output ('${RESULT_PREFIX}' + (@{ embedded = $embedded; child = $child; reason = $(if ($embedded) { 'hosted' } else { 'Windows refused to re-parent the app window (this is expected for windows at a lower integrity level)' }) } | ConvertTo-Json -Compress))`,
    '    }',
    '  }',
    '} catch {',
    `  Write-Output ('${RESULT_PREFIX}' + (@{ embedded = $false; released = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress))`,
    '}',
  ].join('\n');
}

function buildWindowHostScriptArgs(scriptPath, { mode, processId, parentHandle, timeoutMs = 12000 }) {
  return [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-Mode', mode,
    '-ProcessId', String(processId),
    '-Parent', String(parentHandle),
    '-TimeoutMs', String(timeoutMs),
  ];
}

function parseWindowHostOutput(stdout) {
  const text = String(stdout || '');
  const line = text.split(/\r?\n/).reverse().find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) throw new Error('The window host did not return a result.');
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch (error) {
    throw new Error('The window host returned an unreadable result.');
  }
}

// Electron hands back the native window handle as a little-endian buffer on Windows; the
// Win32 handle is the 32-bit value stored in the first four bytes on 64-bit Electron too.
function nativeHandleToInt(handle) {
  if (handle === null || handle === undefined) return 0;
  if (typeof handle === 'number') return handle;
  const buffer = Buffer.isBuffer(handle) ? handle : Buffer.from(handle);
  if (buffer.length >= 8) {
    const value = buffer.readBigUInt64LE(0);
    return Number(value);
  }
  if (buffer.length >= 4) return buffer.readUInt32LE(0);
  return 0;
}

module.exports = {
  RESULT_PREFIX,
  buildWindowHostCSharp,
  buildWindowHostScript,
  buildWindowHostScriptArgs,
  parseWindowHostOutput,
  nativeHandleToInt,
};
