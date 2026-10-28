const {
  buildWindowHostCSharp,
  buildWindowHostProgram,
  buildWindowHostScript,
  buildWindowHostProgramArgs,
  buildWindowHostScriptArgs,
  launchShowState,
  parseWindowHostOutput,
  parseWindowHostEvents,
  nativeHandleToInt,
  RESULT_PREFIX,
} = require("../../public/window-host");

describe("window host launcher", () => {
  it("embeds the C# in a here-string so the script parses as PowerShell", () => {
    const script = buildWindowHostScript();
    expect(script).toContain("$source = @'");
    expect(script).toContain("'@");
    expect(script).toContain("Add-Type -TypeDefinition $source -Language CSharp");
    // Bare C# outside the here-string is what broke the isolation launcher once.
    const outside = script.split("$source = @'")[1].split("'@")[1];
    expect(outside).not.toContain("DllImport");
    expect(outside).not.toContain("using System");
  });

  it("uses only documented window APIs", () => {
    const csharp = buildWindowHostCSharp();
    for (const api of ["EnumWindows", "GetWindowThreadProcessId", "IsWindowVisible", "SetParent", "MoveWindow", "GetClientRect", "SetWindowPos", "ShowWindow"]) {
      expect(csharp).toContain(api);
    }
    expect(csharp).toContain("WsChild");
    expect(csharp).toContain("WsPopup");
  });

  it("makes the hosted window a real child and finds it again for release", () => {
    const csharp = buildWindowHostCSharp();
    // SetParent returns the previous parent handle; converting it to a number threw
    // on every hosting attempt, which is why hosting never visibly worked.
    expect(csharp).not.toContain("Convert.ToInt64(SetParent");
    expect(csharp).toContain("SetLastError(0)");
    expect(csharp).toContain("(style | WsChild) & ~WsPopup");
    // A hosted window is no longer top-level, so release must search the host's children.
    expect(csharp).toContain("EnumChildWindows");
  });

  it("hosts only top-level app windows, including a hidden first window", () => {
    const csharp = buildWindowHostCSharp();
    expect(csharp).toContain("if (IsIconic(hwnd)) return false;");
    // A GUI app is launched with a hidden first window so it is hosted before it is ever
    // drawn on the desktop. Hidden windows are only matched when they look like the main
    // window; tool palettes and helper windows must never be pulled on screen.
    expect(csharp).toContain("if (!IsWindowVisible(hwnd))");
    expect(csharp).toContain("if (!LooksLikeMain(hwnd)) return false;");
    expect(csharp).toContain("(GetWindowLong32(hwnd, GwlExStyle) & WsExToolWindow) != 0");
    expect(csharp).toContain("GetWindow(hwnd, GwOwner) != IntPtr.Zero");
    // An OWNER is normal for an installer wizard. Only a real child control is excluded,
    // otherwise a hidden owned wizard could never be adopted or revealed.
    const looksLikeMain = csharp.slice(csharp.indexOf("static bool LooksLikeMain("), csharp.indexOf("static bool IsAppWindow("));
    expect(looksLikeMain).toContain("(GetWindowLong32(hwnd, GwlStyle) & WsChild) != 0 && GetParent(hwnd) != GetDesktopWindow()");
    expect(looksLikeMain).not.toContain("if (GetParent(hwnd) != IntPtr.Zero) return false;");
  });

  it("includes visible owned installer dialogs without adopting child controls", () => {
    const csharp = buildWindowHostCSharp();
    const visibleCheck = csharp.slice(csharp.indexOf("static bool IsAppWindow("), csharp.indexOf("static int RevealHiddenWindows("));
    expect(visibleCheck).toContain("(GetWindowLong32(hwnd, GwlStyle) & WsChild) != 0 && GetParent(hwnd) != GetDesktopWindow()");
    expect(visibleCheck).not.toContain("if (GetParent(hwnd) != IntPtr.Zero) return false;");
    expect(csharp).toContain("if (mainWindow != 0 && (!IsWindow(new IntPtr(mainWindow)) || GetParent(new IntPtr(mainWindow)) != parent))");
    expect(csharp).toContain("hostedWindows.RemoveAll");
    expect(csharp).toContain("if (mainWindow != 0) FitMainWindow(mainWindow, parentHandle, topInset)");
  });

  it("reveals the app window if hosting never succeeds", () => {
    const csharp = buildWindowHostCSharp();
    // A hidden launch with no hosting would leave the app invisible, so the watcher
    // shows the window on the desktop instead and keeps trying.
    expect(csharp).toContain("static int RevealHiddenWindows(");
    expect(csharp).toContain("ReportShown(shown)");
    expect(csharp).toContain("if (mainWindow == 0 && !revealed && clock.ElapsedMilliseconds >= revealAt)");
    expect(buildWindowHostScriptArgs("C:\\w.ps1", { mode: "watch", parentHandle: 9, revealAfterMs: 9000 }).join(" ")).toContain("-RevealAfterMs 9000");
  });

  it("only moves the hosted window itself when the host resizes", () => {
    const csharp = buildWindowHostCSharp();
    const resize = csharp.slice(csharp.indexOf("public static int ResizeProcessWindows"));
    const body = resize.slice(0, resize.indexOf("public static int ReleaseProcessWindows"));
    // EnumChildWindows returns every descendant, including the app's own buttons and
    // panels. Moving those threw the app's inner layout apart.
    expect(body).toContain("if (GetParent(hwnd) != parent) return true;");
    expect(body.match(/if \(GetParent\(hwnd\) != parent\) return true;/g)).toHaveLength(1);
  });

  it("keeps watching for windows that appear after launch", () => {
    const csharp = buildWindowHostCSharp();
    // Installers re-launch themselves from %TEMP%, so a window's own PID is often not
    // the PID that was started. Matching the process lineage is what finds those.
    expect(csharp).toContain("ProcessParents()");
    expect(csharp).toContain("InProcessLineage");
    expect(csharp).toContain("CreateToolhelp32Snapshot");
    expect(csharp).toContain("public static void Watch(long parentHandle, int topInset, string pidFilePath, string sandboxRoot, string stopFilePath, int revealAfterMs)");
    expect(csharp).toContain("File.Exists(stopFilePath)");
    expect(csharp).toContain("IsAppWindow(hwnd, seeds, parents, sandboxRoot)");
    // Fast polling while a launch is settling, then a cheaper steady tick.
    expect(csharp).toContain("WatchTickFastMs = 120");
    expect(csharp).toContain("clock.ElapsedMilliseconds < FastWatchMs ? WatchTickFastMs : WatchTickMs");
    // A second (dialog) window keeps its own size instead of filling the host.
    expect(csharp).toContain("public static bool EmbedCentered(long childHandle, long parentHandle, int topInset)");
    expect(csharp).toContain("ShowWindow(child, SwHide)");
    expect(csharp).toContain("if (IsZoomed(child)) ShowWindow(child, SwRestore)");
  });

  it("compares sandbox folders by whole path segments", () => {
    const csharp = buildWindowHostCSharp();
    expect(csharp).toContain("static bool PathIsInside(string path, string root)");
    expect(csharp).toContain("System.IO.Path.DirectorySeparatorChar");
    expect(csharp).toContain("System.IO.Path.AltDirectorySeparatorChar");
  });

  it("starts a watcher without a one-shot timeout and with its state files", () => {
    const args = buildWindowHostScriptArgs("C:\\w.ps1", {
      mode: "watch",
      parentHandle: 1234,
      insetTop: 56,
      pidFile: "C:\\state\\app.pids",
      sandboxRoot: "C:\\apps\\a1",
      stopFile: "C:\\state\\app.stop",
    });
    expect(args).toContain("watch");
    expect(args).not.toContain("-TimeoutMs");
    expect(args.join(" ")).toContain("-PidFile C:\\state\\app.pids");
    expect(args.join(" ")).toContain("-StopFile C:\\state\\app.stop");
    expect(args.join(" ")).toContain("-SandboxRoot C:\\apps\\a1");
    expect(args.join(" ")).toContain("-InsetTop 56");
    expect(buildWindowHostScript()).toContain("[RunContainerWindowHost]::Watch");
  });

  it("loads a compiled host instead of recompiling it on every launch", () => {
    const script = buildWindowHostScript();
    expect(script).toContain("[string]$CachePath = ''");
    expect(script).toContain("Add-Type -Path $CachePath");
    expect(script).toContain("-OutputAssembly $CachePath -OutputType Library");
    expect(script).toContain("$Mode -eq 'prewarm'");
    const args = buildWindowHostScriptArgs("C:\\w.ps1", { mode: "prewarm", parentHandle: 0, cachePath: "C:\\c\\host.dll" });
    expect(args.join(" ")).toContain("-CachePath C:\\c\\host.dll");
  });

  it("builds a native helper that speaks the same protocol as the script", () => {
    const program = buildWindowHostProgram();
    // The helper is compiled as a console application, so it needs an entry point.
    expect(program).toContain("public static class RunContainerWindowHostProgram");
    expect(program).toContain("public static int Main(string[] args)");
    // The watcher signals readiness itself, exactly like the script does, and only
    // then starts the watch loop: a caller may not hide an app's first window before
    // something is watching for it.
    const watchBranch = program.slice(program.indexOf("mode == \"watch\""), program.indexOf("RunContainerWindowHost.Watch"));
    expect(watchBranch).toContain("Quote(\"watching\")");
    expect(program).toContain("Quote(\"ready\")");
    expect(program).toContain("RunContainerWindowHost.ReleaseProcessWindows");
    expect(program).toContain("RunContainerWindowHost.FindMainWindow");
    // Results go out on the same machine-readable channel the parser reads.
    expect(parseWindowHostEvents(`${RESULT_PREFIX}{"event":"watching"}`)).toEqual([{ event: "watching" }]);
    // Quotes are built from character codes so the JSON stays valid without layers of
    // escaping in the generated source.
    expect(program).toContain("((char)34)");
  });

  it("gives the native helper the host arguments without the PowerShell preamble", () => {
    const options = {
      mode: "watch",
      parentHandle: 1234,
      insetTop: 56,
      pidFile: "C:\\state\\app.pids",
      sandboxRoot: "C:\\apps\\a1",
      stopFile: "C:\\state\\app.stop",
      revealAfterMs: 9000,
    };
    const programArgs = buildWindowHostProgramArgs(options);
    expect(programArgs[0]).toBe("-Mode");
    expect(programArgs).not.toContain("-NoProfile");
    expect(programArgs).not.toContain("-File");
    expect(programArgs.join(" ")).toContain("-PidFile C:\\state\\app.pids");
    expect(programArgs.join(" ")).toContain("-RevealAfterMs 9000");
    // The PowerShell wrapper is the same list with its own preamble in front, so the two
    // hosts can never disagree about an argument.
    const scriptArgs = buildWindowHostScriptArgs("C:\\w.ps1", options);
    expect(scriptArgs.slice(5)).toEqual(programArgs);
    expect(scriptArgs.slice(0, 5)).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\w.ps1"]);
  });

  it("passes the process, the parent handle and a timeout", () => {
    expect(buildWindowHostScriptArgs("C:\\w.ps1", { mode: "embed", processId: 42, parentHandle: 1234 })).toEqual([
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\w.ps1",
      "-Mode", "embed", "-ProcessId", "42", "-Parent", "1234", "-TimeoutMs", "12000",
    ]);
    expect(buildWindowHostScriptArgs("C:\\w.ps1", { mode: "release", processId: 42, parentHandle: 1, timeoutMs: 500 })).toContain("release");
  });

  it("leaves room for RunContainer's own header in a second window", () => {
    const args = buildWindowHostScriptArgs("C:\\w.ps1", { mode: "embed", processId: 7, parentHandle: 9, insetTop: 56 });
    expect(args.slice(-2)).toEqual(["-InsetTop", "56"]);
    expect(buildWindowHostScript().length).toBeGreaterThan(0);
    expect(buildWindowHostScriptArgs("C:\\w.ps1", { mode: "embed", processId: 7, parentHandle: 9 })).not.toContain("-InsetTop");
    const csharp = buildWindowHostCSharp();
    expect(csharp).toContain("public static bool Embed(long childHandle, long parentHandle, int topInset)");
    expect(csharp).toContain("MoveWindow(child, 0, inset, width, height, true)");
  });

  it("says it is watching only once the host assembly has loaded", () => {
    // The caller waits for this event before allowing a hidden launch. Without it, the
    // only way to know the host exists would be to assume it does.
    const script = buildWindowHostScript();
    expect(script).toContain("event = 'watching'");
    const watchBranch = script.slice(script.indexOf("$Mode -eq 'watch'"), script.indexOf("[RunContainerWindowHost]::Watch"));
    expect(watchBranch).toContain("event = 'watching'");
    // It is emitted through the same machine-readable channel as every other event.
    expect(parseWindowHostEvents(`${RESULT_PREFIX}{"event":"watching"}`)).toEqual([{ event: "watching" }]);
    // And the prewarm path keeps its own readiness signal.
    expect(script).toContain("event = 'ready'");
  });

  it("starts a graphical app hidden only when a watching host will adopt it", () => {
    const watching = { ready: true, error: null, exited: false };
    // The one case where hiding is safe.
    expect(launchShowState({ isGui: true, platform: "win32", windowHosting: true, host: watching })).toBe(0);
    // Every other case starts the app visibly, because a hidden window nobody adopts is
    // an app that never appears: no host at all, one that has not reported watching, one
    // that failed or exited, hosting switched off for the app, and non-Windows.
    expect(launchShowState({ isGui: true, platform: "win32", windowHosting: true, host: null })).toBe(-1);
    expect(launchShowState({ isGui: true, platform: "win32", windowHosting: true, host: { ready: false } })).toBe(-1);
    expect(launchShowState({ isGui: true, platform: "win32", windowHosting: true, host: { ready: true, error: "host failed" } })).toBe(-1);
    expect(launchShowState({ isGui: true, platform: "win32", windowHosting: true, host: { ready: true, exited: true } })).toBe(-1);
    expect(launchShowState({ isGui: true, platform: "win32", windowHosting: false, host: watching })).toBe(-1);
    expect(launchShowState({ isGui: true, platform: "linux", windowHosting: true, host: watching })).toBe(-1);
    // A console app has no window to host, so it never starts hidden.
    expect(launchShowState({ isGui: false, platform: "win32", windowHosting: true, host: watching })).toBe(-1);
    expect(launchShowState()).toBe(-1);
  });

  it("splits watcher output into one event per line", () => {
    const chunk = `${RESULT_PREFIX}{"event":"embedded","pid":42,"child":7}\r\n${RESULT_PREFIX}{"event":"refused","pid":43,"child":8}\r\nnot a result\n`;
    expect(parseWindowHostEvents(chunk)).toEqual([
      { event: "embedded", pid: 42, child: 7 },
      { event: "refused", pid: 43, child: 8 },
    ]);
    expect(parseWindowHostEvents("nothing")).toEqual([]);
  });

  it("reads the result, including a refusal that must not be treated as success", () => {
    expect(parseWindowHostOutput(`${RESULT_PREFIX}{"embedded":true,"child":99}`)).toMatchObject({ embedded: true });
    expect(parseWindowHostOutput(`${RESULT_PREFIX}{"embedded":false,"reason":"refused"}`)).toMatchObject({ embedded: false });
    expect(() => parseWindowHostOutput("no result")).toThrow("did not return a result");
  });

  it("converts Electron's native window handle", () => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(0x00123456n, 0);
    expect(nativeHandleToInt(buffer)).toBe(0x00123456);
    expect(nativeHandleToInt(null)).toBe(0);
    expect(nativeHandleToInt(77)).toBe(77);
  });
});
