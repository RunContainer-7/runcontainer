const { selectIsolationEngine, requestedIsolationEngine } = require("../../public/engine-select");

describe("best-available engine selection", () => {
  it("never selects an unguarded profile launch, even when requested", () => {
    const d = selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "profile" }, hypervReady: true, qemuReady: true });
    expect(d.engine).toBe("refused");
    expect(d.reason).toContain("Nothing was launched");
  });

  it("never selects sandboxie, even for legacy records", () => {
    expect(selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "sandboxie" }, qemuReady: true }).engine).toBe("refused");
    expect(selectIsolationEngine({ platform: "win32", appRecord: { launchMode: "sandboxie" }, qemuReady: true }).engine).toBe("refused");
  });

  it("refuses isolation off windows instead of launching", () => {
    expect(selectIsolationEngine({ platform: "linux", appRecord: {} }).engine).toBe("unavailable");
  });

  it("defaults to the genuine QEMU VM when provisioned", () => {
    for (const appRecord of [{}, { isolationEngine: "auto" }]) {
      const d = selectIsolationEngine({ platform: "win32", appRecord, qemuReady: true });
      expect(d.engine).toBe("qemu");
    }
  });

  it("defaults to honest RCVM containment when no VM is provisioned, so Run works", () => {
    for (const appRecord of [{}, { isolationEngine: "auto" }]) {
      const d = selectIsolationEngine({ platform: "win32", appRecord, qemuReady: false });
      expect(d.engine).toBe("rcvm");
      expect(d.reason).toContain("NOT a virtual machine");
    }
  });

  it("fails closed when the genuine VM is explicitly requested but missing", () => {
    const d = selectIsolationEngine({
      platform: "win32", appRecord: { isolationEngine: "qemu" }, qemuReady: false,
      qemuMissing: ["QEMU is not installed."],
    });
    expect(d.engine).toBe("qemu-unavailable");
    expect(d.reason).toContain("QEMU is not installed.");
    expect(d.reason).toContain("did not fall back");
    expect(d.reason).toContain("Use automatic");
  });

  it("keeps 'auto' automatic instead of pinning it to a VM", () => {
    expect(requestedIsolationEngine("auto")).toBe("auto");
    expect(requestedIsolationEngine(undefined)).toBe("auto");
    expect(requestedIsolationEngine("qemu")).toBe("qemu");
    expect(requestedIsolationEngine("rcvm")).toBe("rcvm");
  });

  it("keeps explicit RCVM containment as a non-VM choice", () => {
    const d = selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "rcvm" }, qemuReady: true });
    expect(d.engine).toBe("rcvm");
    expect(d.reason).toContain("NOT a virtual machine");
  });

  it("sends explicit Hyper-V choices to the full VM, failing closed when not ready", () => {
    expect(selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "hyperv" }, hypervReady: true, qemuReady: true }).engine).toBe("hyperv");
    const cold = selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "hyperv" }, hypervReady: false, qemuReady: true });
    expect(cold.engine).toBe("hyperv-unavailable");
  });

  it("offers AppContainer only as an explicit opt-in, never as fallback", () => {
    const d = selectIsolationEngine({ platform: "win32", appRecord: { isolationEngine: "appcontainer" }, qemuReady: true });
    expect(d.engine).toBe("appcontainer");
    expect(d.reason).toContain("NOT a virtual machine");
  });
});
