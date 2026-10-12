const {
  buildIsolatedEnvironment,
  buildProcessListArgs,
  parseProcessIds,
  buildTaskkillArgs,
} = require("../../public/isolated-launch");

describe("isolated app container helpers", () => {
  it("redirects app data and temp folders into the app's own container", () => {
    const layout = { appData: "C:\\RC\\app-1\\AppData", temp: "C:\\RC\\app-1\\Temp" };
    const env = buildIsolatedEnvironment({ PATH: "x", APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\RC\\app-1", layout);
    expect(env.APPDATA).toBe(layout.appData);
    expect(env.LOCALAPPDATA).toBe(layout.appData);
    expect(env.TEMP).toBe(layout.temp);
    expect(env.TMP).toBe(layout.temp);
    expect(env.PATH).toBe("x");
    expect(env.RUNCONTAINER_SANDBOX_ROOT).toBe("C:\\RC\\app-1");
  });

  it("scopes process lookup to the container directory with a trailing separator", () => {
    const args = buildProcessListArgs("C:\\RC\\app-1");
    const script = args[args.length - 1];
    expect(script).toContain("StartsWith('C:\\RC\\app-1\\'");
    expect(buildProcessListArgs("C:\\O'Brien\\app")[3]).toBe("-Command");
    expect(buildProcessListArgs("C:\\O'Brien\\app").slice(-1)[0]).toContain("O''Brien");
  });

  it("parses PID output and ignores noise", () => {
    expect(parseProcessIds("")).toEqual([]);
    expect(parseProcessIds("123\r\n456\r\n")).toEqual([123, 456]);
    expect(parseProcessIds("warning\n789\n0\n")).toEqual([789]);
  });

  it("builds forced tree kill arguments", () => {
    expect(buildTaskkillArgs(42)).toEqual(["/PID", "42", "/T", "/F"]);
  });
});

describe("app store and download helpers", () => {
  const {
    mergeStatusUpdates,
    resolveDownloadRedirect,
    resetLaunchState,
  } = require("../../public/isolated-launch");

  it("does not resurrect or drop records that changed while status was being checked", () => {
    const latest = [
      { id: "a", status: "Running", pid: 1 },
      { id: "new", status: "Installed" },
    ];
    const updates = new Map([["a", { status: "Stopped", pid: null }]]);
    const merged = mergeStatusUpdates(latest, updates);
    expect(merged).toEqual([
      { id: "a", status: "Stopped", pid: null },
      { id: "new", status: "Installed" },
    ]);
    // A record deleted during the check is absent from the latest store, so it stays absent.
    expect(mergeStatusUpdates([], new Map([["gone", { status: "Stopped" }]]))).toEqual([]);
  });

  it("follows relative and absolute HTTPS redirects", () => {
    expect(resolveDownloadRedirect("https://a.test/x.exe", "/files/app.exe")).toBe("https://a.test/files/app.exe");
    expect(resolveDownloadRedirect("https://a.test/x.exe", "https://cdn.test/app.exe")).toBe("https://cdn.test/app.exe");
  });

  it("refuses redirects to non-HTTPS addresses", () => {
    expect(() => resolveDownloadRedirect("https://a.test/x.exe", "http://a.test/app.exe")).toThrow("non-HTTPS");
  });

  it("resets runtime state so a duplicate never inherits the original launch mode", () => {
    const copy = resetLaunchState({
      id: "copy",
      status: "Running",
      pid: 42,
      sandboxPids: [42],
      launchMode: "sandboxie",
      lastLaunchedAt: "2026-01-01T00:00:00.000Z",
      lastExitAt: "2026-01-01T00:01:00.000Z",
      name: "App Copy",
    });
    expect(copy).toMatchObject({
      id: "copy",
      name: "App Copy",
      status: "Installed",
      pid: null,
      sandboxPids: [],
      launchMode: null,
      lastLaunchedAt: null,
      lastExitAt: null,
    });
  });
});
