const {
  sandboxBoxName,
  findSandboxieTools,
  buildLaunchArgs,
  buildListPidsArgs,
  buildTerminateArgs,
  buildDeleteSandboxArgs,
  buildConfigureBoxArgs,
  buildRemoveBoxArgs,
  parseSandboxPids,
  isWithinDirectory,
  configureSandboxieBox,
  launchInSandboxie,
  terminateSandboxieBox,
  deleteSandboxieBox,
  deleteContainerResources,
} = require("../../public/sandboxie-runtime");

describe("Sandboxie runtime helpers", () => {
  it("creates stable alphanumeric box names within Sandboxie limits", () => {
    const first = sandboxBoxName("app-123");
    expect(first).toBe(sandboxBoxName("app-123"));
    expect(first).toMatch(/^[A-Za-z0-9]{1,32}$/);
    expect(first).not.toBe(sandboxBoxName("app-456"));
  });

  it("finds Sandboxie only when both required executables exist", () => {
    const found = findSandboxieTools(
      { RUNCONTAINER_SANDBOXIE_DIR: "C:\\Sandboxie" },
      (filePath) => filePath.endsWith("Start.exe") || filePath.endsWith("SbieIni.exe")
    );
    expect(found).toEqual({
      root: "C:\\Sandboxie",
      startExe: "C:\\Sandboxie\\Start.exe",
      sbieIniExe: "C:\\Sandboxie\\SbieIni.exe",
    });
    expect(findSandboxieTools({ RUNCONTAINER_SANDBOXIE_DIR: "C:\\Sandboxie" }, () => false)).toBeNull();
  });

  it("builds per-box launch, monitoring, termination, and deletion arguments", () => {
    const box = "RunContainer0123456789abcdef0123";
    expect(buildLaunchArgs(box, "C:\\Apps\\sample.exe")).toEqual([`/box:${box}`, "C:\\Apps\\sample.exe"]);
    expect(buildListPidsArgs(box)).toEqual([`/box:${box}`, "/listpids"]);
    expect(buildTerminateArgs(box)).toEqual([`/box:${box}`, "/terminate"]);
    expect(buildDeleteSandboxArgs(box)).toEqual([`/box:${box}`, "delete_sandbox_silent"]);
    expect(buildConfigureBoxArgs(box, "Enabled", "y")).toEqual(["set", "/drv", box, "Enabled", "y"]);
    expect(buildRemoveBoxArgs(box)).toEqual(["set", "/drv", box, "*", ""]);
  });

  it("parses Sandboxie PID output and rejects malformed output", () => {
    expect(parseSandboxPids("0\r\n")).toEqual([]);
    expect(parseSandboxPids("2\r\n123\r\n456\r\n")).toEqual([123, 456]);
    expect(parseSandboxPids("2\n123\n")).toBeNull();
    expect(parseSandboxPids("not pids")).toBeNull();
  });

  it("does not allow a sandbox path outside the app-owned root", () => {
    expect(isWithinDirectory("C:\\Data\\Sandboxes", "C:\\Data\\Sandboxes\\app\\app.exe")).toBe(true);
    expect(isWithinDirectory("C:\\Data\\Sandboxes", "C:\\Data\\Other\\app.exe")).toBe(false);
  });

  it("launches through the Sandboxie runtime and confirms a PID exists", async () => {
    const calls = [];
    const execute = async (exe, args) => {
      calls.push([exe, args]);
      if (args.includes("/listpids")) return { stdout: "1\r\n321\r\n" };
      if (args[0] === "query" && args[2] === "Enabled") return { stdout: "y\r\n" };
      if (args[0] === "query") return { stdout: "C:\\Data\\Sandboxes\\box1\r\n" };
      return { stdout: "" };
    };
    const result = await launchInSandboxie({
      tools: { startExe: "C:\\Sandboxie\\Start.exe", sbieIniExe: "C:\\Sandboxie\\SbieIni.exe" },
      boxName: "RunContainerbox1",
      executablePath: "C:\\Data\\app.exe",
      fileRootPath: "C:\\Data\\Sandboxes\\box1",
      execute,
      onConfigured: async () => {},
      wait: async () => {},
    });
    expect(result).toEqual({ pids: [321], boxName: "RunContainerbox1" });
    expect(calls).toContainEqual(["C:\\Sandboxie\\SbieIni.exe", ["set", "/drv", "RunContainerbox1", "Enabled", "y"]]);
    expect(calls).toContainEqual(["C:\\Sandboxie\\SbieIni.exe", ["set", "/drv", "RunContainerbox1", "FileRootPath", "C:\\Data\\Sandboxes\\box1"]]);
    expect(calls).toContainEqual(["C:\\Sandboxie\\SbieIni.exe", ["query", "RunContainerbox1", "Enabled"]]);
    expect(calls).toContainEqual(["C:\\Sandboxie\\Start.exe", ["/box:RunContainerbox1", "C:\\Data\\app.exe"]]);
  });

  it("fails closed when SbieIni does not enable the box", async () => {
    const calls = [];
    const execute = async (_exe, args) => {
      calls.push(args);
      if (args[0] === "query" && args[2] === "Enabled") return { stdout: "n\r\n" };
      if (args[0] === "query") return { stdout: "C:\\Data\\Sandboxes\\box1\r\n" };
      return { stdout: "" };
    };
    await expect(launchInSandboxie({
      tools: { startExe: "Start.exe", sbieIniExe: "SbieIni.exe" },
      boxName: "RunContainerbox1",
      executablePath: "C:\\Data\\app.exe",
      fileRootPath: "C:\\Data\\Sandboxes\\box1",
      execute,
      wait: async () => {},
    })).rejects.toThrow("did not enable box");
    expect(calls.some((args) => args[0] === "/box:RunContainerbox1")).toBe(false);
  });

  it("fails when launch cannot be confirmed by Sandboxie", async () => {
    const execute = async (_exe, args) => {
      if (args.includes("/listpids")) return { stdout: "0\r\n" };
      if (args[0] === "query" && args[2] === "Enabled") return { stdout: "y\r\n" };
      if (args[0] === "query") return { stdout: "C:\\Data\\Sandboxes\\box1\r\n" };
      return { stdout: "" };
    };
    await expect(launchInSandboxie({
      tools: { startExe: "Start.exe", sbieIniExe: "SbieIni.exe" },
      boxName: "RunContainerbox1",
      executablePath: "C:\\Data\\app.exe",
      fileRootPath: "C:\\Data\\Sandboxes\\box1",
      execute,
      wait: async () => {},
      pollAttempts: 2,
    })).rejects.toThrow("did not confirm a running process");
  });

  it("deletes Sandboxie before stopping remaining processes and removing the app folder", async () => {
    const order = [];
    const execute = async (_exe, args) => {
      if (args.includes("/listpids")) return { stdout: "0\r\n" };
      order.push(args.join(" "));
      return { stdout: "" };
    };
    await deleteContainerResources({
      appRecord: { sandboxRoot: "C:\\Data\\app", sandboxPids: [321], sandboxieInitialized: true, sandboxieBox: "RunContainerbox1" },
      tools: { startExe: "Start.exe", sbieIniExe: "SbieIni.exe" },
      execute,
      wait: async () => {},
      stopProcesses: async (_root, pids) => { order.push(`stop:${pids.join(",")}`); },
      removeDirectory: async () => { order.push("remove-folder"); },
    });
    expect(order).toContain("/box:RunContainerbox1 delete_sandbox_silent");
    expect(order.indexOf("/box:RunContainerbox1 delete_sandbox_silent")).toBeLessThan(order.indexOf("stop:321"));
    expect(order.indexOf("stop:321")).toBeLessThan(order.indexOf("remove-folder"));
  });

  it("stops processes and retries Sandboxie cleanup after its first delete attempt fails", async () => {
    const order = [];
    let deleteCalls = 0;
    const execute = async (_exe, args) => {
      if (args.includes("/listpids")) return { stdout: "0\r\n" };
      if (args.includes("delete_sandbox_silent") && ++deleteCalls === 1) throw new Error("sharing violation");
      if (args.includes("delete_sandbox_silent")) order.push("sandbox-delete-retry");
      return { stdout: "" };
    };
    await deleteContainerResources({
      appRecord: { sandboxRoot: "C:\\Data\\app", sandboxieInitialized: true, sandboxieBox: "RunContainerbox1" },
      tools: { startExe: "Start.exe", sbieIniExe: "SbieIni.exe" },
      execute,
      wait: async () => {},
      stopProcesses: async () => { order.push("stop"); },
      removeDirectory: async () => { order.push("remove-folder"); },
    });
    expect(order).toEqual(["stop", "sandbox-delete-retry", "remove-folder"]);
  });

  it("waits for termination and deletes box contents/config", async () => {
    const calls = [];
    const execute = async (exe, args) => {
      calls.push([exe, args]);
      if (args.includes("/listpids")) return { stdout: "0\r\n" };
      return { stdout: "" };
    };
    await deleteSandboxieBox({
      tools: { startExe: "Start.exe", sbieIniExe: "SbieIni.exe" },
      boxName: "RunContainerbox1",
      execute,
      wait: async () => {},
    });
    expect(calls).toContainEqual(["Start.exe", ["/box:RunContainerbox1", "/terminate"]]);
    expect(calls).toContainEqual(["Start.exe", ["/box:RunContainerbox1", "delete_sandbox_silent"]]);
    expect(calls).toContainEqual(["SbieIni.exe", ["set", "/drv", "RunContainerbox1", "*", ""]]);
  });
});
