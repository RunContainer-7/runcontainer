const { selectIsolationEngine } = require("../../public/engine-select");

describe("VM-required engine selection", () => {
  it("never selects an unguarded profile launch, even when requested", () => {
    const d = selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "profile" }, hypervReady: true });
    expect(d.engine).toBe("refused");
    expect(d.reason).toContain("Nothing was launched");
  });

  it("never selects sandboxie, even for legacy records", () => {
    expect(selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "sandboxie" }, hypervReady: true }).engine).toBe("refused");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { launchMode: "sandboxie" }, hypervReady: true }).engine).toBe("refused");
  });

  it("refuses isolation off windows instead of launching", () => {
    expect(selectIsolationEngine({ platform: "linux", appRecord: {}, hypervReady: false }).engine).toBe("unavailable");
  });

  it("defaults to the VM path, failing closed when Hyper-V is not ready", () => {
    const cold = selectIsolationEngine({ platform: "win32", appRecord: {}, hypervReady: false });
    expect(cold.engine).toBe("hyperv-unavailable");
    expect(cold.reason).toContain("did not fall back");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "auto" }, hypervReady: true }).engine).toBe("hyperv");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { requiresVm: true }, hypervReady: false }).engine).toBe("hyperv-unavailable");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { requiresVm: true }, hypervReady: true }).engine).toBe("hyperv");
  });

  it("offers AppContainer only as an explicit opt-in, never as fallback", () => {
    const d = selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "appcontainer" }, hypervReady: true });
    expect(d.engine).toBe("appcontainer");
    expect(d.reason).toContain("NOT a virtual machine");
    // Explicit VM preference beats AppContainer history; without readiness it still fails closed.
    expect(selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "appcontainer", preferVm: true }, hypervReady: false }).engine).toBe("hyperv-unavailable");
  });
});
