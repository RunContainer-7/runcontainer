const {
  vmName,
  vmFileNames,
  buildHyperVPrereqScript,
  parseHyperVPrereqOutput,
  hyperVMissingRequirements,
  describeHyperVMissing,
  buildCreateVmScript,
  buildStartVmScript,
  buildStopVmScript,
  buildRemoveVmScript,
  buildInstallInGuestScript,
  buildLaunchInGuestScript,
  buildGuestProcessQueryScript,
  parseHyperVOutput,
  RESULT_PREFIX,
} = require("../../public/hyperv-runtime");

describe("hyper-v vm identity", () => {
  it("derives a stable per-environment vm name", () => {
    expect(vmName("abc-123")).toBe("RunContainer-abc-123");
    expect(vmName("")).toBe("RunContainer-app");
    expect(vmFileNames("abc", "C:\\\\hv").vmName).toBe("RunContainer-abc");
    expect(vmFileNames("abc", "C:\\\\hv").differencingVhdPath).toContain("RunContainer-abc.vhdx");
  });
});

describe("hyper-v readiness", () => {
  it("parses the readiness result", () => {
    const out = `${RESULT_PREFIX}{"feature":"Enabled","service":"Running","hypervisorPresent":true,"product":"Windows 11 Pro"}`;
    expect(parseHyperVPrereqOutput(out).feature).toBe("Enabled");
    expect(() => parseHyperVPrereqOutput("no result")).toThrow("did not return");
  });

  it("lists every missing requirement with an actionable fix", () => {
    const missing = hyperVMissingRequirements({ feature: "Disabled", service: "Stopped", hypervisorPresent: false, product: "Windows 11 Home" });
    expect(missing.join(" ")).toContain("Enable Hyper-V");
    expect(missing.join(" ")).toContain("virtualization");
    expect(missing.join(" ")).toContain("Home");
    expect(hyperVMissingRequirements({ feature: "Enabled", service: "Running", hypervisorPresent: true, product: "Windows 11 Pro" })).toEqual([]);
    expect(describeHyperVMissing(missing)).toContain("Nothing was launched");
  });

  it("checks readiness through powershell without admin-only commands", () => {
    const script = buildHyperVPrereqScript();
    expect(script).toContain("Get-WindowsOptionalFeature");
    expect(script).toContain("HyperHypervisorPresent");
    expect(script).toContain(RESULT_PREFIX.trim());
  });
});

describe("hyper-v lifecycle scripts", () => {
  it("creates a differencing vm, never a host process", () => {
    const script = buildCreateVmScript({ vmName: "RunContainer-a", differencingVhdPath: "C:\\\\hv\\\\a.vhdx", baseImagePath: "C:\\\\base.vhdx", switchName: "RunContainer-NAT" });
    expect(script).toContain("New-VHD");
    expect(script).toContain("-Differencing");
    expect(script).toContain("New-VM");
    expect(script).not.toContain("Start-Process");
  });

  it("starts, stops, and removes the vm by name only", () => {
    expect(buildStartVmScript("RunContainer-a")).toContain("Start-VM");
    expect(buildStopVmScript("RunContainer-a")).toContain("Stop-VM");
    const rm = buildRemoveVmScript({ vm: "RunContainer-a", vhdPath: "C:\\\\hv\\\\a.vhdx" });
    expect(rm).toContain("Remove-VM");
    expect(rm).toContain("Remove-Item");
  });

  it("installs and launches inside the guest via powerShell direct", () => {
    const inst = buildInstallInGuestScript({ vm: "RunContainer-a", hostInstallerPath: "C:\\\\h\\\\setup.exe", guestInstallerPath: "C:\\\\RunContainer\\\\a\\\\setup.exe", installArgs: "/S" });
    expect(inst).toContain("Copy-VMFile");
    expect(inst).toContain("Invoke-Command -VMName");
    const launch = buildLaunchInGuestScript({ vm: "RunContainer-a", guestExePath: "C:\\\\RunContainer\\\\a\\\\app.exe", workingDir: "C:\\\\RunContainer\\\\a" });
    expect(launch).toContain("Invoke-Command -VMName");
    expect(launch).toContain("Start-Process");
    expect(buildGuestProcessQueryScript({ vm: "RunContainer-a", exeName: "app" })).toContain("Get-Process");
  });

  it("reads hyper-v results and rejects missing lines", () => {
    expect(parseHyperVOutput(`${RESULT_PREFIX}{"started":true}`)).toMatchObject({ started: true });
    expect(() => parseHyperVOutput("nothing")).toThrow("did not return");
  });
});
