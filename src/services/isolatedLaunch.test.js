const {
  buildIsolatedEnvironment,
  buildClearReadOnlyArgs,
  buildTakeOwnershipArgs,
  buildResetAclArgs,
  buildGrantFullControlArgs,
  buildAclRepairPlan,
  toExtendedLengthPath,
  CleanupCancelledError,
  removeDirectoryWithRetries,
  buildProcessTableArgs,
  parseProcessTable,
  findAppProcessIds,
  commandLineExecutable,
  buildTaskkillArgs,
  buildGracefulTaskkillArgs,
  buildBlockingProcessArgs,
  parseBlockingProcesses,
  describeCleanupFailure,
  stopAppProcesses,
} = require("../../public/isolated-launch");

describe("per-app profile environment", () => {
  it("redirects conventional data and temp paths to the app's own directories", () => {
    const env = buildIsolatedEnvironment({ PATH: "C:\\Windows", APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\RunContainer\\app1", {
      appData: "C:\\RunContainer\\app1\\AppData",
      temp: "C:\\RunContainer\\app1\\Temp",
    });
    expect(env).toMatchObject({
      PATH: "C:\\Windows",
      APPDATA: "C:\\RunContainer\\app1\\AppData",
      LOCALAPPDATA: "C:\\RunContainer\\app1\\AppData",
      TEMP: "C:\\RunContainer\\app1\\Temp",
      TMP: "C:\\RunContainer\\app1\\Temp",
      RUNCONTAINER_SANDBOX_ROOT: "C:\\RunContainer\\app1",
    });
  });
});

describe("per-app directory cleanup", () => {
  it("clears read-only attributes recursively before removing a directory", () => {
    expect(buildClearReadOnlyArgs("C:\\RunContainer\\app1")).toEqual(["-R", "C:\\RunContainer\\app1\\*", "/S", "/D"]);
  });

  it("reports the actual final Windows deletion error after bounded retries", async () => {
    await expect(removeDirectoryWithRetries({
      directory: "C:\\RunContainer\\locked",
      existsSync: () => true,
      removeSync: () => {
        const error = new Error("Access denied by another process");
        error.code = "EPERM";
        throw error;
      },
      wait: async () => {},
      attempts: 2,
    })).rejects.toThrow("Could not remove C:\\RunContainer\\locked after 2 attempts (EPERM): Access denied by another process");
  });

  it("retries transient Windows removal errors and resolves when the directory disappears", async () => {
    let exists = true;
    let attempts = 0;
    const clearReadOnly = jest.fn(async () => {});
    await expect(removeDirectoryWithRetries({
      directory: "C:\\RunContainer\\app1",
      existsSync: () => exists,
      removeSync: () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("sharing violation");
          error.code = "EPERM";
          throw error;
        }
        exists = false;
      },
      clearReadOnly,
      wait: async () => {},
    })).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(clearReadOnly).toHaveBeenCalledTimes(1);
  });
});

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

  it("finds a process by its command line when Windows denies executable-path access", () => {
    const hiddenPath = [{ pid: 41, ppid: 1, path: "", commandLine: `"${root}\\ScreenRec.exe" /quiet` }];
    expect(findAppProcessIds(hiddenPath, root)).toEqual([41]);
    expect(findAppProcessIds([{ ...hiddenPath[0], commandLine: `${root}-other\\ScreenRec.exe` }], root)).toEqual([]);
  });

  it("never matches a process that only mentions the sandbox path as an argument", () => {
    // Explorer with the folder open, an editor holding a file from it, and RunContainer's
    // own helper scripts all name the path. Their executable is not inside the sandbox, so
    // they must never be selected for termination.
    const bystanders = [
      { pid: 61, ppid: 1, path: "C:\\Windows\\explorer.exe", commandLine: `explorer.exe "${root}"` },
      { pid: 62, ppid: 1, path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", commandLine: `powershell.exe -File C:\\rc\\launcher.ps1 -Dir ${root}` },
      { pid: 63, ppid: 1, path: "C:\\Program Files\\Notepad++\\notepad++.exe", commandLine: `"C:\\Program Files\\Notepad++\\notepad++.exe" "${root}\\readme.txt"` },
    ];
    expect(findAppProcessIds(bystanders, root)).toEqual([]);
    expect(findAppProcessIds(bystanders, root, [61, 62, 63])).toEqual([]);
  });

  it("reads only the executable from a command line", () => {
    expect(commandLineExecutable(`"${root}\\a b.exe" /quiet`)).toBe(`${root}\\a b.exe`);
    expect(commandLineExecutable(`${root}\\a.exe -x`)).toBe(`${root}\\a.exe`);
    expect(commandLineExecutable("")).toBe("");
    expect(commandLineExecutable('"unterminated')).toBe("");
  });

  it("matches the folder with a trailing separator so sibling app folders are not caught", () => {
    expect(findAppProcessIds(table, root)).not.toContain(30);
  });

  it("uses app-folder command lines as seeds and ignores stale PIDs", () => {
    const hiddenPaths = table.map((row) => ({ ...row, path: "", commandLine: row.pid === 10 ? `${root}\\ScreenRec.exe` : "" }));
    expect(findAppProcessIds(hiddenPaths, root, [10, 999]).sort()).toEqual([10, 11, 12]);
  });

  it("finds surviving descendants after the original app process has exited", () => {
    const exitedParentTable = [
      { pid: 51, ppid: 10, path: "C:\\\\Program Files\\\\ScreenRec\\\\worker.exe", commandLine: "" },
      { pid: 52, ppid: 51, path: "", commandLine: "" },
    ];
    expect(findAppProcessIds(exitedParentTable, root, [10]).sort()).toEqual([51, 52]);
  });

  it("does not kill an unrelated process just because Windows reused a stored PID", () => {
    const unrelated = [{ pid: 10, ppid: 1, path: "C:\\\\Windows\\\\notepad.exe", commandLine: "notepad.exe" }];
    expect(findAppProcessIds(unrelated, root, [10])).toEqual([]);
  });

  it("returns nothing when no process belongs to the app", () => {
    expect(findAppProcessIds([{ pid: 20, ppid: 1, path: "C:\\Windows\\explorer.exe" }], root)).toEqual([]);
  });

  it("parses the process table JSON, including single-row and empty output", () => {
    expect(parseProcessTable("")).toEqual([]);
    expect(parseProcessTable('{"ProcessId":5,"ParentProcessId":1,"ExecutablePath":null,"CommandLine":"C:\\\\\\\\app.exe"}')).toEqual([
      { pid: 5, ppid: 1, path: "", commandLine: "C:\\\\app.exe", name: "" },
    ]);
    expect(parseProcessTable('[{"ProcessId":7,"ParentProcessId":2,"ExecutablePath":"C:\\\\a.exe","Name":"a.exe"}]')).toEqual([
      { pid: 7, ppid: 2, path: "C:\\a.exe", commandLine: "", name: "a.exe" },
    ]);
    expect(() => parseProcessTable("not json")).toThrow("unreadable");
  });

  it("queries process paths, command lines, and parent PIDs through PowerShell CIM", () => {
    const args = buildProcessTableArgs();
    expect(args[3]).toBe("-Command");
    expect(args[args.length - 1]).toContain("Win32_Process");
    expect(args[args.length - 1]).toContain("ParentProcessId");
    expect(args[args.length - 1]).toContain("CommandLine");
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

  it("never inherits a previous isolation state in a duplicate", () => {
    const copy = resetLaunchState({
      id: "copy",
      name: "App Copy",
      status: "Running",
      pid: 42,
      sandboxPids: [42],
      knownPids: [7, 8],
      launchMode: "sandboxie",
      activeEngine: "sandboxie",
      isolated: true,
      lastLaunchedAt: "2026-01-01T00:00:00.000Z",
      lastExitAt: "2026-01-01T00:01:00.000Z",
      sandboxieInitialized: true,
      sandboxieCleanupPending: true,
      launchCleanupPending: true,
    });
    expect(copy).toMatchObject({
      id: "copy",
      name: "App Copy",
      status: "Installed",
      pid: null,
      sandboxPids: [],
      knownPids: [],
      launchMode: null,
      activeEngine: null,
      isolated: false,
      lastLaunchedAt: null,
      lastExitAt: null,
      sandboxieInitialized: false,
      sandboxieCleanupPending: false,
      launchCleanupPending: false,
    });
  });
});

describe("sandbox removal repair", () => {
  it("targets the extended-length path so deep installer trees are removable", () => {
    expect(toExtendedLengthPath("C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes\\app-1", "win32"))
      .toBe("\\\\?\\C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes\\app-1");
    expect(toExtendedLengthPath("\\\\?\\C:\\already", "win32")).toBe("\\\\?\\C:\\already");
    expect(toExtendedLengthPath("\\\\server\\share\\a", "win32")).toBe("\\\\?\\UNC\\server\\share\\a");
    // Off Windows the path is left exactly as given.
    expect(toExtendedLengthPath("C:\\a", "linux")).toBe("C:\\a");
  });

  it("resets the root ACL before taking ownership, because a DENY also denies traversal", () => {
    const plan = buildAclRepairPlan("C:\\sb", "me");
    expect(plan.map((step) => step.command)).toEqual(["icacls.exe", "takeown.exe", "icacls.exe", "icacls.exe"]);
    expect(plan[0].args).toEqual(["C:\\sb", "/reset", "/C", "/Q"]);
    expect(plan[1].args).toEqual(["/F", "C:\\sb", "/R", "/D", "Y"]);
    expect(plan[3].args).toEqual(["C:\\sb", "/grant:r", "me:(OI)(CI)F", "/T", "/C", "/Q"]);
  });

  it("builds ownership and ACL repair commands for the app's own folder", () => {
    expect(buildTakeOwnershipArgs("C:\\sb")).toEqual(["/F", "C:\\sb", "/R", "/D", "Y"]);
    expect(buildResetAclArgs("C:\\sb")).toEqual(["C:\\sb", "/reset", "/T", "/C", "/Q"]);
    expect(buildGrantFullControlArgs("C:\\sb", "me")).toEqual(["C:\\sb", "/grant:r", "me:(OI)(CI)F", "/T", "/C", "/Q"]);
  });

  it("gives icacls the folder before its switches, which it rejects otherwise", () => {
    // icacls parses `icacls /reset <dir>` as an invalid parameter (exit 87) and prints
    // its usage text, so a repair that ordered the arguments that way did nothing and
    // left DENY-ACL sandboxes undeletable. Every icacls invocation must start with the object.
    const icaclsCalls = [
      ...buildAclRepairPlan("C:\\sb", "me").filter((step) => step.command === "icacls.exe").map((step) => step.args),
      buildResetAclArgs("C:\\sb"),
      buildGrantFullControlArgs("C:\\sb", "me"),
    ];
    for (const args of icaclsCalls) {
      expect(args[0].startsWith("/")).toBe(false);
      expect(args.slice(1).some((arg) => arg.startsWith("/"))).toBe(true);
    }
  });

  it("repairs permissions once after a denial and then succeeds without escalating further", async () => {
    let exists = true;
    let attempts = 0;
    const repair = jest.fn(async () => {});
    await removeDirectoryWithRetries({
      directory: "C:\\sb",
      existsSync: () => exists,
      removeSync: () => {
        attempts += 1;
        if (attempts <= 2) {
          const error = new Error("Access is denied");
          error.code = "EPERM";
          throw error;
        }
        exists = false;
      },
      prepareForRemoval: repair,
      wait: async () => {},
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(3);
  });

  it("can be cancelled between attempts instead of hammering a locked folder", async () => {
    let aborted = false;
    const promise = removeDirectoryWithRetries({
      directory: "C:\\sb",
      existsSync: () => true,
      removeSync: () => {
        const error = new Error("Access is denied");
        error.code = "EPERM";
        throw error;
      },
      shouldAbort: () => aborted,
      wait: async () => { aborted = true; },
      attempts: 5,
    });
    await expect(promise).rejects.toBeInstanceOf(CleanupCancelledError);
  });
});

describe("scoped process termination", () => {
  const directory = "C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes\\app-1";
  const table = [
    { pid: 10, ppid: 1, path: `${directory}\\webinstall.exe`, commandLine: "" },
    { pid: 11, ppid: 10, path: "C:\\Program Files\\ScreenRec\\ScreenRec.exe", commandLine: "" },
    { pid: 20, ppid: 1, path: "C:\\Users\\me\\AppData\\Roaming\\RunContainer\\sandboxes\\app-2\\Other.exe", commandLine: "" },
    { pid: 30, ppid: 1, path: "C:\\Windows\\explorer.exe", commandLine: "" },
  ];

  it("asks the app to close first, then forces only app-owned processes", async () => {
    const calls = [];
    const stopped = [];
    const remaining = await stopAppProcesses({
      directory,
      seedPids: [10],
      listProcesses: async () => table.filter((row) => !stopped.includes(row.pid)),
      terminate: async (pid, { force }) => {
        calls.push({ pid, force });
        // A graceful close is ignored here on purpose: the app only stops when forced.
        if (force) stopped.push(pid);
      },
      wait: async () => {},
      forceAfterGracefulMs: 1,
    });
    expect(calls.slice(0, 2).every((call) => call.force === false)).toBe(true);
    expect(stopped.sort()).toEqual([10, 11]);
    expect(stopped).not.toContain(20);
    expect(stopped).not.toContain(30);
    expect(remaining).toEqual([]);
  });

  it("reports processes it could not stop instead of claiming success", async () => {
    const remaining = await stopAppProcesses({
      directory,
      seedPids: [10],
      listProcesses: async () => table,
      terminate: async () => {},
      wait: async () => {},
      attempts: 2,
    });
    expect(remaining).toEqual([10, 11]);
  });

  it("leaves a sandbox alone when no process belongs to it", async () => {
    const killed = [];
    const remaining = await stopAppProcesses({
      directory,
      seedPids: [],
      listProcesses: async () => [{ pid: 30, ppid: 1, path: "C:\\Windows\\explorer.exe", commandLine: "" }],
      terminate: async (pid) => killed.push(pid),
      wait: async () => {},
    });
    expect(killed).toEqual([]);
    expect(remaining).toEqual([]);
  });
});

describe("cleanup diagnostics", () => {
  it("names the process that still holds files instead of returning a bare EPERM", () => {
    const message = describeCleanupFailure({
      directory: "C:\\sb",
      error: new Error("Access is denied"),
      blockers: [{ pid: 4242, name: "ScreenRec", imagePath: "C:\\Program Files\\ScreenRec\\ScreenRec.exe", loadedFrom: [] }],
    });
    expect(message).toContain("C:\\sb");
    expect(message).toContain("ScreenRec (PID 4242)");
  });

  it("explains that an unkillable process needs to be closed by the user", () => {
    const message = describeCleanupFailure({
      directory: "C:\\sb",
      error: new Error("Access is denied"),
      remainingPids: [77],
    });
    expect(message).toContain("PIDs 77");
  });

  it("parses the blocking-process query, including empty and single results", () => {
    expect(parseBlockingProcesses("")).toEqual([]);
    expect(parseBlockingProcesses("not json")).toEqual([]);
    expect(parseBlockingProcesses('{"ProcessId":5,"ProcessName":"a","ImagePath":null,"LoadedFrom":"C:\\\\x\\\\a.dll"}')).toEqual([
      { pid: 5, name: "a", imagePath: "", loadedFrom: ["C:\\x\\a.dll"] },
    ]);
    expect(buildBlockingProcessArgs("C:\\sb").join(" ")).toContain("C:\\sb");
  });

  it("builds a graceful tree kill without the force flag", () => {
    expect(buildGracefulTaskkillArgs(9)).toEqual(["/PID", "9", "/T"]);
  });
});
