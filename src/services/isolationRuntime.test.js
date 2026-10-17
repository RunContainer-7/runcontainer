const {
  appContainerName,
  isAppContainerSupported,
  buildAppContainerFolderAclArgs,
  buildAppContainerAncestorAclArgs,
  listAncestorDirectories,
  buildAppContainerCapabilities,
  buildAppContainerCSharp,
  buildAppContainerScript,
  buildAppContainerScriptArgs,
  parseAppContainerOutput,
  RESULT_PREFIX,
} = require("../../public/isolation-runtime");

describe("app container identity", () => {
  it("derives a stable, Windows-legal container name per app", () => {
    const name = appContainerName("8c1e2f44-1a2b/3c");
    expect(name).toBe("RunContainer.App.8c1e2f44-1a2b-3c");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[-_.A-Za-z0-9]+$/);
    expect(appContainerName("8c1e2f44-1a2b/3c")).toBe(name);
    expect(appContainerName("")).toBe("RunContainer.App.app");
  });

  it("only claims container support on Windows", () => {
    expect(isAppContainerSupported("win32")).toBe(true);
    expect(isAppContainerSupported("darwin")).toBe(false);
    expect(isAppContainerSupported("linux")).toBe(false);
  });
});

describe("container access grants", () => {
  const sandboxRoot = "C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes\\app-1";

  it("grants the container read/execute on the chain inside RunContainer's own folder only", () => {
    const managedRoot = "C:\\Users\\me\\AppData\\Roaming\\RunContainer";
    expect(listAncestorDirectories(sandboxRoot, managedRoot)).toEqual([
      "C:\\Users\\me\\AppData\\Roaming\\RunContainer",
      "C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes",
    ]);
    // Outside its managed root RunContainer grants nothing at all, so neither the profile
    // folders nor the drive root can ever appear in the list.
    expect(listAncestorDirectories(sandboxRoot)).toEqual([]);
    expect(listAncestorDirectories(sandboxRoot, "D:\\Elsewhere")).toEqual([]);
    const outside = listAncestorDirectories("D:\\Elsewhere\\app-1", "D:\\Elsewhere");
    expect(outside).toEqual(["D:\\Elsewhere"]);
  });

  it("grants modify on the app folder and read/execute on its ancestors", () => {
    expect(buildAppContainerFolderAclArgs(sandboxRoot, "S-1-15-2-1")).toEqual([
      sandboxRoot, "/grant", "*S-1-15-2-1:(OI)(CI)M", "/T", "/C", "/Q",
    ]);
    expect(buildAppContainerAncestorAclArgs("C:\\parent", "S-1-15-2-1")).toEqual([
      "C:\\parent", "/grant", "*S-1-15-2-1:(RX)", "/C", "/Q",
    ]);
  });
});

describe("container capabilities", () => {
  it("only requests capabilities Windows documents", () => {
    expect(buildAppContainerCapabilities(["internetClient", "notARealOne"])).toEqual(["internetClient"]);
    expect(buildAppContainerCapabilities([])).toEqual(["internetClient"]);
    expect(buildAppContainerCapabilities("internetClient")).toEqual(["internetClient"]);
    expect(buildAppContainerCapabilities(["internetClient", "internetClient"])).toEqual(["internetClient"]);
  });
});

describe("generated isolation launcher", () => {
  it("uses the documented native calls and constants", () => {
    const csharp = buildAppContainerCSharp();
    expect(csharp).toContain("CreateAppContainerProfile");
    expect(csharp).toContain("DeriveAppContainerSidFromAppContainerName");
    expect(csharp).toContain("DeriveCapabilitySidsFromName");
    expect(csharp).toContain("UpdateProcThreadAttribute");
    expect(csharp).toContain("CreateProcess");
    // PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES and EXTENDED_STARTUPINFO_PRESENT.
    expect(csharp).toContain("0x00020009");
    expect(csharp).toContain("0x00080000");
    // The profile SID is read back from the new process token, so isolation is verified.
    expect(csharp).toContain("TokenAppContainerSid = 31");
    // Both the AppContainer flag and the SID must agree, so a plain process can never be
    // reported as isolated.
    expect(csharp).toContain("TokenIsAppContainer = 29");
    expect(csharp).toContain("ReadAppContainerSid");
  });

  it("treats an existing profile as reusable and reports the failure otherwise", () => {
    const csharp = buildAppContainerCSharp();
    expect(csharp).toContain("ErrorAlreadyExists");
    expect(csharp).toContain("0x800700B7");
    expect(csharp).toContain("throw new InvalidOperationException");
  });

  it("emits a script that never falls back to a plain launch", () => {
    const script = buildAppContainerScript();
    expect(script).toContain("param([string]$Mode");
    expect(script).not.toContain("Start-Process");
    expect(script).toContain(RESULT_PREFIX.trim());
  });

  it("passes the app path only when launching, not when asking for the container SID", () => {
    const sidArgs = buildAppContainerScriptArgs("C:\\s.ps1", { mode: "sid", containerName: "RunContainer.App.x" });
    expect(sidArgs).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\s.ps1", "-Mode", "sid", "-Name", "RunContainer.App.x"]);
    const launchArgs = buildAppContainerScriptArgs("C:\\s.ps1", {
      mode: "launch", containerName: "RunContainer.App.x", executablePath: "C:\\a\\b.exe", workingDirectory: "C:\\a",
    });
    expect(launchArgs).toContain("-Exe");
    expect(launchArgs).toContain("C:\\a\\b.exe");
  });

  it("can delete a profile and never passes an executable in that mode", () => {
    const deleteArgs = buildAppContainerScriptArgs("C:\\s.ps1", { mode: "delete", containerName: "RunContainer.App.x" });
    expect(deleteArgs).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\s.ps1", "-Mode", "delete", "-Name", "RunContainer.App.x"]);
    expect(deleteArgs).not.toContain("-Exe");
    const script = buildAppContainerScript();
    expect(script).toContain("DeleteProfile($Name)");
    expect(buildAppContainerCSharp()).toContain("DeleteAppContainerProfile");
    expect(parseAppContainerOutput(`${RESULT_PREFIX}{"deleted":true}`)).toEqual({ deleted: true });
  });
});

describe("isolation launcher results", () => {
  it("reads the JSON result from the launcher's output", () => {
    const output = `warning line\n${RESULT_PREFIX}{"pid":123,"containerSid":"S-1-15-2-9","processSid":"S-1-15-2-9","verified":true}\n`;
    expect(parseAppContainerOutput(output)).toMatchObject({ pid: 123, verified: true });
  });

  it("surfaces the launcher's error instead of pretending the app started", () => {
    expect(() => parseAppContainerOutput(`${RESULT_PREFIX}{"error":"The AppContainer profile could not be created (HRESULT 0x80070005)."}`))
      .toThrow("HRESULT 0x80070005");
  });

  it("rejects output with no result line or unreadable JSON", () => {
    expect(() => parseAppContainerOutput("")).toThrow("did not return a result");
    expect(() => parseAppContainerOutput(`${RESULT_PREFIX}not-json`)).toThrow("unreadable");
  });
});

describe("per-app capabilities and launch args", () => {
  const {
    buildAppContainerScript: buildScript,
    buildAppContainerScriptArgs: buildArgs,
  } = require("../../public/isolation-runtime");
  it("passes capabilities and args as launch parameters, never for sid/delete", () => {
    const launch = buildArgs("C:\\s.ps1", { mode: "launch", containerName: "N", executablePath: "C:\\a\\b.exe", workingDirectory: "C:\\a", capabilities: [], appArgs: "--safe" });
    expect(launch).toContain("-Caps");
    expect(launch[launch.indexOf("-Caps") + 1]).toBe("");
    expect(launch).toContain("-Args");
    expect(launch).toContain("--safe");
    const sid = buildArgs("C:\\s.ps1", { mode: "sid", containerName: "N" });
    expect(sid).not.toContain("-Caps");
    expect(sid).not.toContain("-Args");
    expect(sid).not.toContain("-Exe");
  });
  it("rejects unknown capability names inside the guest launcher", () => {
    expect(buildScript()).toContain("Unknown AppContainer capability");
    expect(buildScript()).toContain("$Args");
    expect(buildScript()).toContain("$Caps");
  });
});
