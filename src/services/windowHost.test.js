const {
  buildWindowHostCSharp,
  buildWindowHostScript,
  buildWindowHostScriptArgs,
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
    expect(csharp).toContain("GetParent(hwnd) != IntPtr.Zero");
    expect(csharp).toContain("if (IsIconic(hwnd)) return false;");
    // A GUI app is launched with a hidden first window so it is hosted before it is ever
    // drawn on the desktop. Hidden windows are only matched when they look like the main
    // window; helpers, tool palettes and owned windows must never be pulled on screen.
    expect(csharp).toContain("if (!IsWindowVisible(hwnd))");
    expect(csharp).toContain("if (!LooksLikeMain(hwnd)) return false;");
    expect(csharp).toContain("(GetWindowLong32(hwnd, GwlExStyle) & WsExToolWindow) != 0");
    expect(csharp).toContain("GetWindow(hwnd, GwOwner) != IntPtr.Zero");
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
