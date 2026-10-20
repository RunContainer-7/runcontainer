const { selectIsolationEngine } = require("../../public/engine-select");

describe("QEMU-first engine selection", () => {
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
    for (const appRecord of [{}, { isolationEngine: "auto" }, { isolationEngine: "qemu" }]) {
      const d = selectIsolationEngine({ platform: "win32", appRecord, qemuReady: true });
      expect(d.engine).toBe("qemu");
    }
  });

  it("fails closed with setup guidance when QEMU is not provisioned", () => {
    const d = selectIsolationEngine({
      platform: "win32", appRecord: {}, qemuReady: false,
      qemuMissing: ["QEMU is not installed."],
    });
    expect(d.engine).toBe("qemu-unavailable");
    expect(d.reason).toContain("QEMU is not installed.");
    expect(d.reason).toContain("did not fall back");
  });

  it("keeps legacy RCVM containment as an explicit non-VM opt-in", () => {
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
