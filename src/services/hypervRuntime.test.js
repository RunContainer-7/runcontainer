const {
  vmName,
  vmFileNames,
  envVhdPathForApp,
  isEnvVhdPath,
  validateDeletionTarget,
  guestCredentialFilePath,
  buildProvisionCredentialScript,
  buildEnsureSwitchScript,
  buildGetVmScript,
  buildEnableGuestServicesScript,
  buildCreateVmFromExistingVhdScript,
  buildWaitForGuestReadyScript,
  buildCopyToGuestScript,
  buildRunInstallerInGuestScript,
  buildStopGuestAppScript,
  buildGuestFileExistsScript,
  buildGracefulShutdownScript,
  buildPowerOffScript,
  buildRemoveVmConfigScript,
  deletionPlan,
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


describe("vm disk guards", () => {
  const appId = "abc-123";
  const envDir = "C:\\RunContainer\\sandboxes\\app-x\\hyperv";
  it("accepts only this environment's differencing disk", () => {
    const vhd = envVhdPathForApp(envDir, appId);
    expect(vhd.toLowerCase().endsWith("runcontainer-abc-123.vhdx")).toBe(true);
    expect(isEnvVhdPath(vhd, envDir, appId)).toBe(true);
    expect(isEnvVhdPath("C:\\base.vhdx", envDir, appId)).toBe(false);
    expect(isEnvVhdPath(envVhdPathForApp("C:\\other", appId), envDir, appId)).toBe(false);
  });
  it("never targets the shared base image", () => {
    expect(validateDeletionTarget({ candidate: "C:\\base.vhdx", envDir, baseImagePath: "C:\\base.vhdx" }).ok).toBe(false);
    expect(validateDeletionTarget({ candidate: "C:\\elsewhere\\x.vhdx", envDir, baseImagePath: "C:\\base.vhdx" }).ok).toBe(false);
    expect(validateDeletionTarget({ candidate: envVhdPathForApp(envDir, appId), envDir, baseImagePath: "C:\\base.vhdx" }).ok).toBe(true);
  });
  it("orders deletion VM-first and verifies every step", () => {
    const plan = deletionPlan({ vm: "RunContainer-a", vhdValid: true });
    expect(plan).toEqual(["guard-launches", "stop-guest-app", "graceful-shutdown", "verify-off", "remove-vm-config", "verify-vm-absent", "remove-env-vhd", "verify-vhd-absent", "remove-host-files", "verify-host-absent", "remove-record"]);
    expect(deletionPlan({ vm: "RunContainer-a", vhdValid: false })).not.toContain("remove-env-vhd");
  });
});

describe("corrected hyper-v builders", () => {
  it("never assigns to the automatic $pid variable", () => {
    const launch = buildLaunchInGuestScript({ vm: "RunContainer-a", credFile: "C:\\c.xml", guestExePath: "C:\\g\\a.exe", workingDir: "C:\\g" });
    expect(launch).toContain("$guestPid");
    expect(launch).not.toMatch(/\$pid\s*=/);
  });
  it("passes guest credentials to every in-guest command", () => {
    for (const script of [
      buildLaunchInGuestScript({ vm: "V", credFile: "C:\\c.xml", guestExePath: "C:\\g\\a.exe" }),
      buildGuestProcessQueryScript({ vm: "V", credFile: "C:\\c.xml", exeName: "a" }),
      buildRunInstallerInGuestScript({ vm: "V", credFile: "C:\\c.xml", guestInstallerPath: "C:\\g\\s.exe" }),
      buildStopGuestAppScript({ vm: "V", credFile: "C:\\c.xml", exeName: "a" }),
      buildWaitForGuestReadyScript({ vm: "V", credFile: "C:\\c.xml" }),
    ]) {
      expect(script).toContain("-Credential");
      expect(script).toContain("Import-Clixml");
    }
  });
  it("ensures the switch, reconciles VM existence, and enables file copy", () => {
    expect(buildEnsureSwitchScript({})).toContain("Get-VMSwitch");
    expect(buildEnsureSwitchScript({})).toContain("New-VMSwitch");
    expect(buildGetVmScript("V")).toContain("Get-VM");
    expect(buildEnableGuestServicesScript("V")).toContain("Guest Service Interface");
    expect(buildCreateVmFromExistingVhdScript({ vmName: "V", existingVhdPath: "C:\\e.vhdx", switchName: "S" })).not.toContain("New-VHD");
  });
  it("shuts down gracefully with timeout and escalates explicitly", () => {
    const graceful = buildGracefulShutdownScript({ vm: "V", timeoutSec: 120 });
    expect(graceful).toContain("Stop-VM -Name");
    expect(graceful).not.toContain("-TurnOff");
    expect(graceful).toContain("did not reach Off");
    expect(buildPowerOffScript("V")).toContain("-TurnOff");
    expect(buildRemoveVmConfigScript("V")).toContain("still exists after Remove-VM");
  });
  it("provisions credentials encrypted, never in plain text", () => {
    const prov = buildProvisionCredentialScript("C:\\u\\cred.xml");
    expect(prov).toContain("Get-Credential");
    expect(prov).toContain("Export-Clixml");
    expect(guestCredentialFilePath("C:\\u").toLowerCase()).toContain("hyperv-guest-cred.xml");
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
