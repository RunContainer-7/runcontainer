const { selectIsolationEngine } = require("../../public/engine-select");

describe("fail-closed engine selection", () => {
  it("never selects an unguarded profile launch, even when requested", () => {
    const d = selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "profile" }, hypervReady: true });
    expect(d.engine).toBe("refused");
    expect(d.reason).toContain("not a security boundary");
  });

  it("never selects sandboxie, even for legacy records", () => {
    expect(selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "sandboxie" }, hypervReady: true }).engine).toBe("refused");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { launchMode: "sandboxie" }, hypervReady: true }).engine).toBe("refused");
  });

  it("refuses isolation off windows instead of launching", () => {
    expect(selectIsolationEngine({ platform: "linux", appRecord: {}, hypervReady: false }).engine).toBe("unavailable");
  });

  it("sends vm-needing apps to hyper-v, failing closed when hyper-v is not ready", () => {
    const noHv = selectIsolationEngine({ platform: "win32", appRecord: { requiresVm: true }, hypervReady: false });
    expect(noHv.engine).toBe("hyperv-unavailable");
    expect(noHv.reason).toContain("Hyper-V is not ready");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { requiresVm: true }, hypervReady: true }).engine).toBe("hyperv");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { preferVm: true }, hypervReady: false }).engine).toBe("hyperv-unavailable");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { preferVm: true }, hypervReady: true }).engine).toBe("hyperv");
  });

  it("defaults to appcontainer for compatible apps", () => {
    expect(selectIsolationEngine({ platform: "win32", appRecord: {}, hypervReady: false }).engine).toBe("appcontainer");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "auto" }, hypervReady: false }).engine).toBe("appcontainer");
  });
});
