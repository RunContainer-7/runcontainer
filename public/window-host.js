// Window hosting.
//
// LiveContainer on iOS runs a guest app inside its own process by mapping the guest binary
// and loading it as a library. Windows has no supported in-process loader for an arbitrary
// PE executable (only DLLs can be loaded into a running process), so "running inside
// RunContainer" on Windows means two separate things:
//
//   1. Process isolation  - the app runs in its own process under an AppContainer or a
//      Job Object (RCVM). This is what keeps it away from the rest of the system.
//   2. Window hosting     - the app's top-level window is re-parented into a RunContainer
//      window so the app visually appears inside the app. This adds no isolation at all.
//
// This module implements only (2). Hosting is best-effort: Windows can refuse to re-parent a
// window across integrity levels, and some apps misbehave when hosted, so a failure is
// reported and the app keeps running in its own window.
//
// Two things make hosting feel seamless rather than glitchy:
//   - A watcher (Watch mode) keeps looking while the app runs, instead of one blocking
//     look at launch. Installers and launchers routinely create their real window in a
//     second (or third) process, seconds after the process we started; one-shot hosting
//     missed those windows and left them on the desktop.
//   - Only the window that was actually parented is moved when the host resizes.
//     EnumChildWindows walks every descendant, including the app's own buttons and panels,
//     so resizing "all windows of this process" used to throw the app's inner layout apart.
//
// Only text is built and parsed here, so it can be unit tested off Windows.

const RESULT_PREFIX = 'RCWINDOWHOST ';

function buildWindowHostCSharp() {
  return `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RunContainerWindowHost
{
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr hwnd, uint command);

    [DllImport("user32.dll")]
    static extern IntPtr GetParent(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern IntPtr GetDesktopWindow();

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

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr hwnd);

    [DllImport("kernel32.dll")]
    static extern void SetLastError(uint errorCode);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
    static extern int GetWindowLong32(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
    static extern int SetWindowLong32(IntPtr hwnd, int index, int value);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
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

    const uint GwOwner = 4;
    const uint Th32csSnapProcess = 0x00000002;
    const int GwlStyle = -16;
    const int GwlExStyle = -20;
    const int SwHide = 0;
    const int SwShow = 5;
    const int SwRestore = 9;
    const uint SwpNoSize = 0x0001;
    const uint SwpNoMove = 0x0002;
    const uint SwpNoZOrder = 0x0004;
    const uint SwpNoActivate = 0x0010;
    const uint SwpFrameChanged = 0x0020;
    const uint SwpShowWindow = 0x0040;
    const int WsChild = 0x40000000;
    const int WsPopup = unchecked((int)0x80000000);
    const int WsExAppWindow = 0x00040000;
    const int WsExToolWindow = 0x00000080;
    // A launch started with a hidden window has no window to host until the app creates
    // one, and that first window must be found before it ever reaches the desktop.
    // Polling fast for the first seconds costs little and closes the gap.
    const int WatchTickFastMs = 120;
    const int WatchTickMs = 400;
    const int FastWatchMs = 6000;
    const int WatchMaxHours = 8;

    static void Report(string kind, uint processId, long child)
    {
        StringBuilder line = new StringBuilder();
        line.Append("${RESULT_PREFIX}{");
        line.Append("\\"event\\":\\"").Append(kind).Append("\\"");
        line.Append(",\\"pid\\":").Append(processId);
        line.Append(",\\"child\\":").Append(child);
        line.Append("}");
        Console.WriteLine(line.ToString());
        Console.Out.Flush();
    }

    static void ReportShown(int shown)
    {
        StringBuilder line = new StringBuilder();
        line.Append("${RESULT_PREFIX}{");
        line.Append("\\"event\\":\\"revealed\\"");
        line.Append(",\\"shown\\":").Append(shown);
        line.Append("}");
        Console.WriteLine(line.ToString());
        Console.Out.Flush();
    }

    static void ReportEnd(string reason)
    {
        StringBuilder line = new StringBuilder();
        line.Append("${RESULT_PREFIX}{");
        line.Append("\\"event\\":\\"end\\"");
        line.Append(",\\"reason\\":\\"").Append(reason).Append("\\"");
        line.Append("}");
        Console.WriteLine(line.ToString());
        Console.Out.Flush();
    }

    static List<IntPtr> TopLevelWindowsForProcess(uint processId)
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr param)
        {
            uint ownerPid;
            GetWindowThreadProcessId(hwnd, out ownerPid);
            if (ownerPid != processId) return true;
            if (!IsWindowVisible(hwnd)) return true;
            if (IsIconic(hwnd)) return true;
            if (GetParent(hwnd) != IntPtr.Zero) return true;
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

    static int InsetFor(IntPtr parent, int topInset)
    {
        int inset = topInset > 0 ? topInset : 0;
        RECT client;
        if (!GetClientRect(parent, out client)) return -1;
        int width = client.Right - client.Left;
        int height = (client.Bottom - client.Top) - inset;
        if (width <= 0 || height <= 0) return -1;
        return inset;
    }

    // Re-parents one window. topInset leaves that many pixels of the host uncovered, so a
    // window that RunContainer owns can keep its own header visible above the hosted app.
    // fill=true makes the window take the whole area (the app's main window); fill=false
    // keeps a dialog at its own size, centred, instead of stretching it edge to edge.
    static bool EmbedWindow(IntPtr child, IntPtr parent, int topInset, bool fill)
    {
        if (!IsWindow(child) || !IsWindow(parent)) return false;
        // Hide first: re-parenting a visible window makes it jump across the screen.
        ShowWindow(child, SwHide);
        // A maximized window makes a poor child; restore it so it fits the host area.
        if (IsZoomed(child)) ShowWindow(child, SwRestore);
        SetLastError(0);
        IntPtr previous = SetParent(child, parent);
        if (previous == IntPtr.Zero && Marshal.GetLastWin32Error() != 0)
        {
            ShowWindow(child, SwShow);
            return false;
        }

        // SetParent deliberately leaves the WS_CHILD / WS_POPUP styles alone, and a
        // window that is still WS_POPUP is not drawn inside its new parent. Make it a
        // child window, then place it inside the host area.
        int style = GetWindowLong32(child, GwlStyle);
        SetWindowLong32(child, GwlStyle, (style | WsChild) & ~WsPopup);
        SetWindowLong32(child, GwlExStyle, GetWindowLong32(child, GwlExStyle) & ~WsExAppWindow);

        int inset = InsetFor(parent, topInset);
        if (inset < 0) return false;
        RECT client;
        GetClientRect(parent, out client);
        int width = client.Right - client.Left;
        int height = (client.Bottom - client.Top) - inset;
        if (fill)
        {
            MoveWindow(child, 0, inset, width, height, true);
        }
        else
        {
            RECT own;
            GetWindowRect(child, out own);
            int ownWidth = Math.Min(Math.Max(own.Right - own.Left, 320), Math.Max(width - 48, 320));
            int ownHeight = Math.Min(Math.Max(own.Bottom - own.Top, 200), Math.Max(height - 48, 200));
            int left = Math.Max((width - ownWidth) / 2, 0);
            int top = inset + Math.Max((height - ownHeight) / 2, 0);
            MoveWindow(child, left, top, ownWidth, ownHeight, true);
        }
        SetWindowPos(child, IntPtr.Zero, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate | SwpShowWindow);
        ShowWindow(child, SwShow);
        return GetParent(child) == parent;
    }

    // Kept as the single-window entry point (tests and one-shot callers).
    public static bool Embed(long childHandle, long parentHandle, int topInset)
    {
        return EmbedWindow(new IntPtr(childHandle), new IntPtr(parentHandle), topInset, true);
    }

    public static bool EmbedCentered(long childHandle, long parentHandle, int topInset)
    {
        return EmbedWindow(new IntPtr(childHandle), new IntPtr(parentHandle), topInset, false);
    }

    // Diagnostics for a refused embed: the Win32 error and where the window ended up.
    public static int LastError()
    {
        return Marshal.GetLastWin32Error();
    }

    public static string EmbedSteps(long childHandle, long parentHandle)
    {
        IntPtr child = new IntPtr(childHandle);
        IntPtr parent = new IntPtr(parentHandle);
        StringBuilder log = new StringBuilder();
        log.Append("childWindow=").Append(IsWindow(child));
        log.Append(" parentWindow=").Append(IsWindow(parent));
        log.Append(" childParent=").Append(GetParent(child).ToInt64());
        SetLastError(0);
        IntPtr previous = SetParent(child, parent);
        log.Append(" previous=").Append(previous.ToInt64());
        log.Append(" error=").Append(Marshal.GetLastWin32Error());
        log.Append(" parentNow=").Append(GetParent(child).ToInt64());
        return log.ToString();
    }

    public static long ParentOf(long handle)
    {
        return GetParent(new IntPtr(handle)).ToInt64();
    }

    // Fits the app's main window to a resized host. Only this window is moved: the app's
    // own controls keep the layout its own code gave them.
    public static bool FitMainWindow(long childHandle, long parentHandle, int topInset)
    {
        IntPtr child = new IntPtr(childHandle);
        IntPtr parent = new IntPtr(parentHandle);
        if (!IsWindow(child) || !IsWindow(parent)) return false;
        if (GetParent(child) != parent) return false;
        int inset = InsetFor(parent, topInset);
        if (inset < 0) return false;
        RECT client;
        GetClientRect(parent, out client);
        return MoveWindow(child, 0, inset, client.Right - client.Left, (client.Bottom - client.Top) - inset, true);
    }

    // Fits an already-hosted window to a resized host.
    public static int ResizeProcessWindows(uint processId, long parentHandle, int topInset)
    {
        IntPtr parent = new IntPtr(parentHandle);
        int inset = InsetFor(parent, topInset);
        if (inset < 0) return 0;
        RECT client;
        GetClientRect(parent, out client);
        int width = client.Right - client.Left;
        int height = (client.Bottom - client.Top) - inset;
        int resized = 0;
        EnumChildWindows(parent, delegate(IntPtr hwnd, IntPtr param)
        {
            // Direct children only. Every button, edit and panel inside the app is also a
            // descendant of the host, and moving those destroyed the app's inner layout.
            if (GetParent(hwnd) != parent) return true;
            uint ownerPid;
            GetWindowThreadProcessId(hwnd, out ownerPid);
            if (ownerPid != processId) return true;
            MoveWindow(hwnd, 0, inset, width, height, true);
            resized += 1;
            return true;
        }, IntPtr.Zero);
        return resized;
    }

    // Puts the window back on the desktop before the app is stopped or deleted, so nothing
    // is left parented to a window that is about to disappear.
    public static int ReleaseProcessWindows(uint processId, long parentHandle)
    {
        IntPtr parent = new IntPtr(parentHandle);
        int released = 0;
        // A hosted window is a child of the host, so EnumWindows no longer sees it:
        // the direct children of the host window are enumerated instead.
        EnumChildWindows(parent, delegate(IntPtr hwnd, IntPtr param)
        {
            if (GetParent(hwnd) != parent) return true;
            uint ownerPid;
            GetWindowThreadProcessId(hwnd, out ownerPid);
            if (ownerPid != processId) return true;
            SetParent(hwnd, IntPtr.Zero);
            int style = GetWindowLong32(hwnd, GwlStyle);
            style = (style & ~WsChild) | WsPopup;
            SetWindowLong32(hwnd, GwlStyle, style);
            SetWindowLong32(hwnd, GwlExStyle, GetWindowLong32(hwnd, GwlExStyle) | WsExAppWindow);
            SetWindowPos(hwnd, IntPtr.Zero, 80, 80, 1024, 768, SwpNoZOrder | SwpFrameChanged | SwpShowWindow);
            ShowWindow(hwnd, SwRestore);
            released += 1;
            return true;
        }, IntPtr.Zero);
        return released;
    }

    // The process table is what makes late windows discoverable: an installer that
    // re-launches itself from %TEMP%, or an app that starts a second process for its real
    // UI, still names one of the launched PIDs as an ancestor.
    public static Dictionary<uint, uint> ProcessParents()
    {
        Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return parents;
        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref entry)) return parents;
            do
            {
                parents[entry.th32ProcessID] = entry.th32ParentProcessID;
            }
            while (Process32Next(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return parents;
    }

    static bool InProcessLineage(uint processId, HashSet<uint> seeds, Dictionary<uint, uint> parents)
    {
        if (seeds == null || seeds.Count == 0) return false;
        uint current = processId;
        for (int depth = 0; depth < 32; depth += 1)
        {
            if (seeds.Contains(current)) return true;
            uint parent;
            if (!parents.TryGetValue(current, out parent)) return false;
            if (parent == 0 || parent == current) return false;
            current = parent;
        }
        return false;
    }

    // Compares whole path segments, so one app's folder cannot be a prefix of another's.
    static bool PathIsInside(string path, string root)
    {
        if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(root)) return false;
        string normalized = root.TrimEnd(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar);
        if (path.Length < normalized.Length) return false;
        if (string.Compare(path, 0, normalized, 0, normalized.Length, StringComparison.OrdinalIgnoreCase) != 0) return false;
        return path.Length == normalized.Length
            || path[normalized.Length] == System.IO.Path.DirectorySeparatorChar
            || path[normalized.Length] == System.IO.Path.AltDirectorySeparatorChar;
    }

    // Opening another process to read its image path is not free, and the watcher runs
    // four times a second. Results are cached briefly: long enough to keep the loop cheap,
    // short enough that a reused PID cannot keep an unrelated window matched for long.
    static Dictionary<uint, bool> sandboxMatches = new Dictionary<uint, bool>();
    static DateTime sandboxCacheReset = DateTime.UtcNow;

    static bool MatchesSandbox(uint processId, string sandboxRoot)
    {
        if (string.IsNullOrEmpty(sandboxRoot)) return false;
        if ((DateTime.UtcNow - sandboxCacheReset).TotalSeconds > 30)
        {
            sandboxMatches.Clear();
            sandboxCacheReset = DateTime.UtcNow;
        }
        bool cached;
        if (sandboxMatches.TryGetValue(processId, out cached)) return cached;
        bool matches = false;
        try
        {
            string executable = Process.GetProcessById((int)processId).MainModule.FileName;
            matches = PathIsInside(executable, sandboxRoot);
        }
        catch (Exception)
        {
            matches = false;
        }
        sandboxMatches[processId] = matches;
        return matches;
    }

    // Owned by this app's process tree, or by a process running from its environment folder.
    static bool OwnedByApp(IntPtr hwnd, HashSet<uint> seeds, Dictionary<uint, uint> parents, string sandboxRoot)
    {
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        if (processId == 0) return false;
        if (InProcessLineage(processId, seeds, parents)) return true;
        return MatchesSandbox(processId, sandboxRoot);
    }

    // A window the user would recognise as the app: titled, top-level, and not a helper.
    static bool LooksLikeMain(IntPtr hwnd)
    {
        if (GetParent(hwnd) != IntPtr.Zero) return false;
        if (GetWindowTextLength(hwnd) == 0) return false;
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) return false;
        if (rect.Right - rect.Left < 200 || rect.Bottom - rect.Top < 150) return false;
        return true;
    }

    // A window worth hosting: visible, top-level, not a tiny helper, and owned by this
    // app. Hidden main windows are included: an app started with a hidden window has to
    // be hosted before it is ever shown, or it would flash onto the desktop first.
    static bool IsAppWindow(IntPtr hwnd, HashSet<uint> seeds, Dictionary<uint, uint> parents, string sandboxRoot)
    {
        if (IsIconic(hwnd)) return false;
        if (!OwnedByApp(hwnd, seeds, parents, sandboxRoot)) return false;
        if (!IsWindowVisible(hwnd))
        {
            // Hidden windows are only matched when they look like the app's main window:
            // a hidden 0x0 helper or a tool palette must never be pulled on screen.
            if (!LooksLikeMain(hwnd)) return false;
            if ((GetWindowLong32(hwnd, GwlExStyle) & WsExToolWindow) != 0) return false;
            if (GetWindow(hwnd, GwOwner) != IntPtr.Zero) return false;
            return true;
        }
        // GetParent returns an owner for top-level popups, not just a parent. An
        // installer dialog can therefore have an owner while still being top-level.
        // Some UI frameworks move an adopted window back under the desktop while
        // leaving WS_CHILD set. EnumWindows can see it there; allow re-adoption.
        if ((GetWindowLong32(hwnd, GwlStyle) & WsChild) != 0 && GetParent(hwnd) != GetDesktopWindow()) return false;
        if (GetWindowTextLength(hwnd) == 0) return false;
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) return false;
        if (rect.Right - rect.Left < 24 || rect.Bottom - rect.Top < 24) return false;
        return true;
    }

    // If hosting never happens, a hidden launch would leave the app invisible. Showing
    // the windows that still look like its main window keeps a failure recoverable
    // instead of hiding the app entirely.
    static int RevealHiddenWindows(HashSet<uint> seeds, Dictionary<uint, uint> parents, string sandboxRoot)
    {
        int shown = 0;
        EnumWindows(delegate(IntPtr hwnd, IntPtr param)
        {
            if (IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
            if (!LooksLikeMain(hwnd)) return true;
            if ((GetWindowLong32(hwnd, GwlExStyle) & WsExToolWindow) != 0) return true;
            if (GetWindow(hwnd, GwOwner) != IntPtr.Zero) return true;
            if (!OwnedByApp(hwnd, seeds, parents, sandboxRoot)) return true;
            ShowWindow(hwnd, SwShow);
            shown += 1;
            return true;
        }, IntPtr.Zero);
        return shown;
    }

    static HashSet<uint> ReadSeeds(string pidFilePath)
    {
        HashSet<uint> seeds = new HashSet<uint>();
        if (string.IsNullOrEmpty(pidFilePath) || !File.Exists(pidFilePath)) return seeds;
        try
        {
            foreach (string line in File.ReadAllLines(pidFilePath))
            {
                uint value;
                if (uint.TryParse(line.Trim(), out value) && value > 0) seeds.Add(value);
            }
        }
        catch (Exception)
        {
            // A refresh can be mid-write; the next tick reads it again.
        }
        return seeds;
    }

    // Hosts windows as they appear, keeps the main one fitted, and stops when RunContainer
    // closes the host window, asks it to stop (stop file), or the safety limit is reached.
    public static void Watch(long parentHandle, int topInset, string pidFilePath, string sandboxRoot, string stopFilePath, int revealAfterMs)
    {
        IntPtr parent = new IntPtr(parentHandle);
        long mainWindow = 0;
        List<IntPtr> hostedWindows = new List<IntPtr>();
        HashSet<long> ownedDialogs = new HashSet<long>();
        int lastWidth = 0;
        int lastHeight = 0;
        HashSet<long> refused = new HashSet<long>();
        bool revealed = false;
        int revealAt = revealAfterMs > 0 ? revealAfterMs : 9000;
        Stopwatch clock = Stopwatch.StartNew();
        string reason = "ended";
        while (true)
        {
            if (!IsWindow(parent)) { reason = "host-window-gone"; break; }
            if (!string.IsNullOrEmpty(stopFilePath) && File.Exists(stopFilePath)) { reason = "stop-requested"; break; }
            if (clock.Elapsed.TotalHours > WatchMaxHours) { reason = "time-limit"; break; }
            int tick = clock.ElapsedMilliseconds < FastWatchMs ? WatchTickFastMs : WatchTickMs;

            HashSet<uint> seeds = ReadSeeds(pidFilePath);
            Dictionary<uint, uint> parents = ProcessParents();
            RECT client;
            if (!GetClientRect(parent, out client)) { reason = "host-window-unreadable"; break; }
            int inset = topInset > 0 ? topInset : 0;
            int width = client.Right - client.Left;
            int height = (client.Bottom - client.Top) - inset;
            if (width <= 0 || height <= 0)
            {
                Thread.Sleep(tick);
                continue;
            }

            // A wizard or app may appear before its splash closes. Keep track of
            // already-hosted windows so the surviving window can replace the splash.
            hostedWindows.RemoveAll(delegate(IntPtr hwnd) { return !IsWindow(hwnd) || GetParent(hwnd) != parent; });
            if (mainWindow != 0 && (!IsWindow(new IntPtr(mainWindow)) || GetParent(new IntPtr(mainWindow)) != parent))
            {
                mainWindow = 0;
                long largestArea = 0;
                foreach (IntPtr hwnd in hostedWindows)
                {
                    RECT bounds;
                    if (!IsWindowVisible(hwnd) || !GetWindowRect(hwnd, out bounds)) continue;
                    if (ownedDialogs.Contains(hwnd.ToInt64()) && hostedWindows.Exists(delegate(IntPtr other) { return IsWindowVisible(other) && !ownedDialogs.Contains(other.ToInt64()); })) continue;
                    long area = (long)(bounds.Right - bounds.Left) * (bounds.Bottom - bounds.Top);
                    // Prefer the most recently adopted window if sizes are equal.
                    if (area >= largestArea) { largestArea = area; mainWindow = hwnd.ToInt64(); }
                }
                if (mainWindow != 0) FitMainWindow(mainWindow, parentHandle, topInset);
            }

            List<IntPtr> found = new List<IntPtr>();
            EnumWindows(delegate(IntPtr hwnd, IntPtr param)
            {
                if (refused.Contains(hwnd.ToInt64())) return true;
                if (IsAppWindow(hwnd, seeds, parents, sandboxRoot)) found.Add(hwnd);
                return true;
            }, IntPtr.Zero);

            foreach (IntPtr hwnd in found)
            {
                uint processId;
                GetWindowThreadProcessId(hwnd, out processId);
                bool fills = mainWindow == 0;
                bool wasOwnedDialog = GetWindow(hwnd, GwOwner) != IntPtr.Zero || ownedDialogs.Contains(hwnd.ToInt64());
                bool embedded = fills
                    ? Embed(hwnd.ToInt64(), parentHandle, topInset)
                    : EmbedCentered(hwnd.ToInt64(), parentHandle, topInset);
                if (embedded)
                {
                    // A framework may later reset the parent of its own window.
                    // Avoid duplicates when the watcher adopts that window again.
                    if (!hostedWindows.Contains(hwnd)) hostedWindows.Add(hwnd);
                    if (wasOwnedDialog) ownedDialogs.Add(hwnd.ToInt64());
                    if (fills) mainWindow = hwnd.ToInt64();
                    Report("embedded", processId, hwnd.ToInt64());
                }
                else
                {
                    refused.Add(hwnd.ToInt64());
                    // A hidden window that cannot be hosted must not stay invisible.
                    ShowWindow(hwnd, SwShow);
                    Report("refused", processId, hwnd.ToInt64());
                }
            }

            // The safety net for a hidden launch: if nothing could be hosted in time,
            // show the app's window on the desktop rather than leaving it invisibly running.
            if (mainWindow == 0 && !revealed && clock.ElapsedMilliseconds >= revealAt)
            {
                int shown = RevealHiddenWindows(seeds, parents, sandboxRoot);
                revealed = true;
                ReportShown(shown);
            }

            if (mainWindow != 0)
            {
                IntPtr main = new IntPtr(mainWindow);
                if (!IsWindow(main) || GetParent(main) != parent)
                {
                    // The app closed its window; the next one it opens becomes the main one.
                    mainWindow = 0;
                }
                else if (width != lastWidth || height != lastHeight)
                {
                    FitMainWindow(mainWindow, parentHandle, topInset);
                }
            }
            lastWidth = width;
            lastHeight = height;
            Thread.Sleep(tick);
        }
        ReportEnd(reason);
        Console.Out.Flush();
    }
}
`;
}

function buildWindowHostScript() {
  return [
    "param([string]$Mode, [int]$ProcessId, [string]$Parent, [int]$TimeoutMs = 12000, [int]$InsetTop = 0, [string]$PidFile = '', [string]$SandboxRoot = '', [string]$StopFile = '', [string]$CachePath = '', [int]$RevealAfterMs = 9000)",
    "$ErrorActionPreference = 'Stop'",
    // Compiling the Win32 host dominated the time between pressing Run and the app's
    // window moving inside RunContainer. The compiled assembly is cached per source
    // version, so a warm cache loads in about a tenth of the compile time.
    '$loaded = $false',
    'if ($CachePath -and (Test-Path $CachePath)) {',
    '  try { Add-Type -Path $CachePath -ErrorAction Stop; $loaded = $true } catch { $loaded = $false }',
    '}',
    'if (-not $loaded) {',
    "  $source = @'",
    buildWindowHostCSharp(),
    "'@",
    '  if ($CachePath) {',
    '    try {',
    '      if (Test-Path $CachePath) { Remove-Item $CachePath -Force }',
    '      Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $CachePath -OutputType Library -ErrorAction Stop',
    '      Add-Type -Path $CachePath -ErrorAction Stop',
    '    } catch { Add-Type -TypeDefinition $source -Language CSharp }',
    '  } else {',
    '    Add-Type -TypeDefinition $source -Language CSharp',
    '  }',
    '}',
    'try {',
    "  if ($Mode -eq 'prewarm') {",
    `    Write-Output ('${RESULT_PREFIX}' + (@{ event = 'ready' } | ConvertTo-Json -Compress))`,
    "  } elseif ($Mode -eq 'embeddebug') {",
    '    Write-Output ([RunContainerWindowHost]::EmbedSteps([int64]$ProcessId, [int64]$Parent))',
    "  } elseif ($Mode -eq 'watch') {",
    // A positive signal that the host really is watching, emitted after the host
    // assembly has loaded and before the watch loop starts. A caller that gets it
    // knows a window created later will be adopted, so an app may be started with a
    // hidden first window. Without it, starting hidden would mean starting invisible.
    `    Write-Output ('${RESULT_PREFIX}' + (@{ event = 'watching' } | ConvertTo-Json -Compress))`,
    '    [RunContainerWindowHost]::Watch([int64]$Parent, $InsetTop, $PidFile, $SandboxRoot, $StopFile, $RevealAfterMs)',
    "  } elseif ($Mode -eq 'release') {",
    '    $count = [RunContainerWindowHost]::ReleaseProcessWindows([uint32]$ProcessId, [int64]$Parent)',
    `    Write-Output ('${RESULT_PREFIX}' + (@{ released = $count } | ConvertTo-Json -Compress))`,
    "  } elseif ($Mode -eq 'resize') {",
    '    $count = [RunContainerWindowHost]::ResizeProcessWindows([uint32]$ProcessId, [int64]$Parent, $InsetTop)',
    `    Write-Output ('${RESULT_PREFIX}' + (@{ resized = $count } | ConvertTo-Json -Compress))`,
    '  } else {',
    '    $child = [RunContainerWindowHost]::FindMainWindow([uint32]$ProcessId, $TimeoutMs)',
    '    if ($child -eq 0) {',
    `      Write-Output ('${RESULT_PREFIX}' + (@{ embedded = $false; reason = 'the app did not open a window RunContainer could host' } | ConvertTo-Json -Compress))`,
    '    } else {',
    '      $embedded = [RunContainerWindowHost]::Embed($child, [int64]$Parent, $InsetTop)',
    `      Write-Output ('${RESULT_PREFIX}' + (@{ embedded = $embedded; child = $child; parentAfter = [RunContainerWindowHost]::ParentOf($child); win32Error = [RunContainerWindowHost]::LastError(); reason = $(if ($embedded) { 'hosted' } else { 'Windows refused to re-parent the app window (this is expected for windows at a lower integrity level)' }) } | ConvertTo-Json -Compress))`,
    '    }',
    '  }',
    '} catch {',
    `  Write-Output ('${RESULT_PREFIX}' + (@{ embedded = $false; released = 0; event = 'error'; error = $_.Exception.Message } | ConvertTo-Json -Compress))`,
    '}',
  ].join('\n');
}

function buildWindowHostScriptArgs(scriptPath, {
  mode,
  processId,
  parentHandle,
  timeoutMs = 12000,
  insetTop = 0,
  pidFile,
  sandboxRoot,
  stopFile,
  cachePath,
  revealAfterMs = 0,
} = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', mode];
  if (Number.isSafeInteger(processId) && processId > 0) args.push('-ProcessId', String(processId));
  args.push('-Parent', String(parentHandle));
  // Watch mode has no timeout of its own: it lives as long as the host window.
  if (mode !== 'watch') args.push('-TimeoutMs', String(timeoutMs));
  // Only sent when a caller asks for a header strip, so existing calls stay identical.
  if (insetTop > 0) args.push('-InsetTop', String(insetTop));
  if (cachePath) args.push('-CachePath', cachePath);
  if (revealAfterMs > 0) args.push('-RevealAfterMs', String(revealAfterMs));
  if (pidFile) args.push('-PidFile', pidFile);
  if (sandboxRoot) args.push('-SandboxRoot', sandboxRoot);
  if (stopFile) args.push('-StopFile', stopFile);
  return args;
}

// The show-state an app is actually launched with.
//
// A GUI app is started with a hidden first window so it can be hosted before it is ever
// drawn on the desktop. That only works if a watching host will adopt that window the
// moment it exists. Hide it and nobody adopts it and the app runs invisibly, which looks
// exactly like a window that never appeared — and is how a working app was diagnosed as a
// window hang and restarted. So: hidden only on a positive `watching` event from a host
// with no error, otherwise visible. -1 means "Windows' default", which is visible.
function launchShowState({ isGui, platform = process.platform, windowHosting = true, host = null } = {}) {
  if (!isGui) return -1;
  if (platform !== 'win32') return -1;
  if (windowHosting === false) return -1;
  if (!host || host.ready !== true || host.error || host.exited) return -1;
  return 0;
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

// A watcher prints one result per event; this splits whatever arrived on stdout into them.
function parseWindowHostEvents(chunk) {
  return String(chunk || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(RESULT_PREFIX))
    .map((line) => {
      try {
        return JSON.parse(line.slice(RESULT_PREFIX.length));
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
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
  launchShowState,
  parseWindowHostOutput,
  parseWindowHostEvents,
  nativeHandleToInt,
};
