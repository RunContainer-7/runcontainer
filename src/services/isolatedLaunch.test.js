const {
  buildProcessTableArgs,
  parseProcessTable,
  findAppProcessIds,
  buildTaskkillArgs,
} = require("../../public/isolated-launch");

describe("process tree helpers", () => {
  const table = [
    { pid: 10, ppid: 1, path: "C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes\\app-1\\ScreenRec.exe" },
    { pid: 11, ppid: 10, path: "C:\\Program Files\\ScreenRec\\helper.exe" },
    { pid: 12, ppid: 11, path: "" },
    { pid: 20, ppid: 1, path: "C:\\Windows\\explorer.exe" },
    { pid: 30, ppid: 1, path: "C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes\\app-10\\Other.exe" },
  ];
  const root = "C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes\\app-1";

  it("finds processes running from the app folder and all their descendants", () => {
    expect(findAppProcessIds(table, root).sort()).toEqual([10, 11, 12]);
  });

  it("matches the folder with a trailing separator so sibling app folders are not caught", () => {
    expect(findAppProcessIds(table, root)).not.toContain(30);
  });

  it("includes live seed PIDs (launched PIDs) and their children, ignoring dead ones", () => {
    const withoutPathMatch = table.map((row) => ({ ...row, path: "" }));
    expect(findAppProcessIds(withoutPathMatch, root, [10, 999]).sort()).toEqual([10, 11, 12]);
  });

  it("returns nothing when no process belongs to the app", () => {
    expect(findAppProcessIds([{ pid: 20, ppid: 1, path: "C:\\Windows\\explorer.exe" }], root)).toEqual([]);
  });

  it("parses the process table JSON, including single-row and empty output", () => {
    expect(parseProcessTable("")).toEqual([]);
    expect(parseProcessTable('{"ProcessId":5,"ParentProcessId":1,"ExecutablePath":null}')).toEqual([
      { pid: 5, ppid: 1, path: "" },
    ]);
    expect(parseProcessTable('[{"ProcessId":7,"ParentProcessId":2,"ExecutablePath":"C:\\\\a.exe"}]')).toEqual([
      { pid: 7, ppid: 2, path: "C:\\a.exe" },
    ]);
    expect(() => parseProcessTable("not json")).toThrow("unreadable");
  });

  it("queries the process table through PowerShell CIM", () => {
    const args = buildProcessTableArgs();
    expect(args[3]).toBe("-Command");
    expect(args[args.length - 1]).toContain("Win32_Process");
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
