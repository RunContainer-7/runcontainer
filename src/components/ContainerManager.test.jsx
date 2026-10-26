import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import ContainerManager from "./ContainerManager";
import { onContainerStatus, getAppVersion, checkAppUpdates, downloadUpdate, listContainers, repairAppEnvironment, onAiDiagnosis, setAiMonitoring, getAiStatus } from "../services/containerService";

jest.mock("../services/containerService", () => ({
  installContainer: jest.fn(),
  importFromUrl: jest.fn(),
  runContainer: jest.fn(),
  killContainer: jest.fn(),
  resetContainer: jest.fn(),
  duplicateContainer: jest.fn(),
  exportContainer: jest.fn(),
  getAppLogs: jest.fn(),
  cancelDeleteContainer: jest.fn(),
  setIsolationEngine: jest.fn(),
  setWindowHosting: jest.fn(),
  setAppConfig: jest.fn(),
  setAppProfile: jest.fn(),
  resetEnvironment: jest.fn(),
  openGuestDisplay: jest.fn(),
  getHyperVStatus: jest.fn(async () => null),
  provisionGuestCredential: jest.fn(),
  getAppVersion: jest.fn(async () => "0.6.0"),
  checkAppUpdates: jest.fn(async () => ({ status: "up-to-date" })),
  openUpdateLink: jest.fn(async () => ({ opened: true })),
  snoozeUpdate: jest.fn(async () => ({ snoozed: true })),
  downloadUpdate: jest.fn(async () => ({ downloaded: true })),
  cancelUpdateDownload: jest.fn(),
  getUpdateState: jest.fn(async () => ({ check: null, downloaded: false })),
  installDownloadedUpdate: jest.fn(async () => ({ started: true })),
  onUpdateDownloadProgress: jest.fn(() => () => {}),
  getQemuStatus: jest.fn(async () => null),
  getPerformance: jest.fn(async () => null),
  detectQemu: jest.fn(),
  browseQemuBase: jest.fn(),
  setQemuBase: jest.fn(),
  createQemuProvisionDisk: jest.fn(),
  bootQemuProvision: jest.fn(),
  setGuestExePath: jest.fn(),
  listContainers: jest.fn(async () => []),
  onContainerStatus: jest.fn(() => () => {}),
  getAiStatus: jest.fn(async () => ({
    available: true,
    enabled: true,
    monitoring: true,
    knowledgeVersion: "2026-10-22.1",
    limits: ["Small local model, not a language model."],
    model: {
      name: "RC-Brain 1",
      version: "1.0.0",
      parameters: 4229,
      features: 44,
      hiddenLayers: { diagnosis: [32, 16], action: [24, 12] },
      createdAt: "2026-10-22T00:00:00.000Z",
      evaluation: { diagnosisAccuracy: 0.989, actionAccuracy: 0.989, falsePositiveRate: 0, unsafeActions: 0, samples: 348 },
    },
  })),
  getAiHistory: jest.fn(async () => []),
  getAiExperiences: jest.fn(async () => []),
  promoteAiExperiences: jest.fn(async () => ({ promoted: 0 })),
  rollbackAiModel: jest.fn(async () => ({ rolledBack: false, reason: "no previous model" })),
  setAiMonitoring: jest.fn(async () => ({ enabled: false, monitoring: false, available: true })),
  repairAppEnvironment: jest.fn(async () => ({ status: "repaired", clearedProfile: [] })),
  onAiDiagnosis: jest.fn(() => () => {}),
  onAiRepairResult: jest.fn(() => () => {}),
  onAiRecovered: jest.fn(() => () => {}),
  onAiUnavailable: jest.fn(() => () => {}),
  onAiStatus: jest.fn(() => () => {}),
  onAiHistory: jest.fn(() => () => {}),
  onAiVerified: jest.fn(() => () => {}),
  onSetupProgress: jest.fn(() => () => {}),
  onSetupComplete: jest.fn(() => () => {}),
  setUpInBackground: jest.fn(),
}));

describe("ContainerManager", () => {
  const render = () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      ReactDOM.render(<ContainerManager />, container);
    });
    return container;
  };

  const openTab = (container, label) => {
    const button = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent.includes(label));
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  afterEach(() => {
    jest.clearAllMocks();
    listContainers.mockResolvedValue([]);
    document.body.innerHTML = "";
  });

  it("renders the main tabs and header", () => {
    const container = render();
    expect(container.textContent).toContain("Apps");
    expect(container.textContent).toContain("RunContainer");
    expect(onContainerStatus).toHaveBeenCalled();
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows source-import controls in Sources", () => {
    const container = render();
    openTab(container, "Sources");
    expect(container.textContent).toContain("Import from URL");
    expect(container.querySelector('input[placeholder="Source URL"]')).not.toBeNull();
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows where app files live, with nothing to configure in Settings", () => {
    const container = render();
    openTab(container, "Settings");
    expect(container.textContent).toContain("Each app runs in its own space");
    expect(container.textContent).toContain("Where app files live");
    expect(container.textContent).toContain("Logs");
    expect(container.textContent).not.toContain("Auto-isolate APPDATA");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("keeps ISO and provisioning clutter out of Settings", () => {
    const container = render();
    openTab(container, "Settings");
    // A container launcher should not make users provision a VM by hand.
    expect(container.textContent).not.toContain("Windows ISO");
    expect(container.textContent).not.toContain("staging disk");
    expect(container.textContent).not.toContain("Boot provisioning VM");
    expect(container.textContent).not.toContain("RUNCONTAINER_HYPERV_BASE_IMAGE");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("keeps backend and VM jargon out of Settings", () => {
    const container = render();
    openTab(container, "Settings");
    for (const jargon of ["Backend:", "QEMU", "Hyper-V", "AppContainer", "virtual machine", "NOT a VM", "Sandboxie", "Run unguarded instead"]) {
      expect(container.textContent).not.toContain(jargon);
    }
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows the version reported by the main process in Info", async () => {
    getAppVersion.mockResolvedValue("1.2.3");
    const container = render();
    openTab(container, "Info");
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("RunContainer v1.2.3");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("falls back to the packaged version when the version bridge is unavailable", async () => {
    // getAppVersion resolves to undefined here, which is what happens outside Electron.
    const container = render();
    openTab(container, "Info");
    await act(async () => { await Promise.resolve(); });
    // The fallback must track package.json; a stale constant here shows an
    // older version during the first moment of startup.
    expect(container.textContent).toContain(`RunContainer v${require("../../package.json").version}`);
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows the Completely free section in Info", () => {
    const container = render();
    openTab(container, "Info");
    expect(container.textContent).toContain("Completely free");
    expect(container.textContent).toContain("Free forever");
    expect(container.textContent).toContain("Open source");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("links the YouTube channel under Support & documentation in Info", () => {
    const container = render();
    openTab(container, "Info");
    expect(container.textContent).toContain("Video guides");
    const link = Array.from(container.querySelectorAll("a"))
      .find((entry) => entry.textContent === "Watch on YouTube");
    expect(link).not.toBeUndefined();
    expect(link.getAttribute("href")).toBe("https://www.youtube.com/@RunContainer");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("restores every app tab, including Tweaks, Profiles and Updates", () => {
    const container = render();
    for (const tab of ["Sources", "Apps", "Tweaks", "Settings", "Profiles", "Info", "Updates"]) {
      expect(container.textContent).toContain(tab);
    }
    // RC-Brain lives inside Settings now, so the bottom bar has no AI entry.
    expect(container.querySelector(".bottom-nav").textContent).not.toContain("AI");
    // Policies live on the documentation site, not inside the launcher.
    expect(container.textContent).not.toContain("Policies");
    openTab(container, "Tweaks");
    expect(container.textContent).toContain("Launch arguments");
    expect(container.textContent).toContain("Save tweaks");
    openTab(container, "Profiles");
    expect(container.textContent).toContain("locked");
    expect(container.textContent).toContain("Choose how much access");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows the Updates feed with the installed version and changelog", async () => {
    getAppVersion.mockResolvedValue("0.6.0");
    const container = render();
    openTab(container, "Updates");
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("RunContainer v0.6.0");
    expect(container.textContent).toContain("Installed");
    expect(container.textContent).toContain("VM-first Hyper-V isolation");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("offers a Refresh action in the header instead of tab redirects", () => {
    const container = render();
    const headerButtons = Array.from(container.querySelectorAll(".header-actions button"));
    expect(headerButtons.some((entry) => entry.getAttribute("aria-label") === "Refresh app list")).toBe(true);
    expect(headerButtons.some((entry) => entry.textContent.includes("🔗"))).toBe(false);
    expect(headerButtons.some((entry) => entry.textContent.includes("📦"))).toBe(false);
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("does not ask users to choose or override a backend", () => {
    const container = render();
    openTab(container, "Settings");
    expect(container.querySelector("details.advanced-settings")).toBeNull();
    for (const control of ["Use prepared image", "Check readiness", "Override backend", "base image"]) {
      expect(container.textContent).not.toContain(control);
    }
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("does not render the old fake container desktop", () => {
    const container = render();
    expect(container.textContent).not.toContain("RunContainer OS");
    expect(container.textContent).not.toContain("Sandbox Console");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows an update banner with a download action when a release is newer", async () => {
    checkAppUpdates.mockResolvedValue({
      status: "update-available",
      currentVersion: "0.5.1",
      latestVersion: "0.5.2",
      installerUrl: "https://github.com/acme/RunContainer/releases/download/v0.5.2/RunContainer-Setup-0.5.2.exe",
      releaseUrl: "https://github.com/acme/RunContainer/releases/tag/v0.5.2",
    });
    const container = render();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("v0.5.2 is available");
    expect(container.textContent).toContain("Update…");
    expect(container.textContent).toContain("Remind tomorrow");
    openTab(container, "Updates");
    expect(container.textContent).toContain("Check for updates");
    expect(container.textContent).toContain("Download installer");
    expect(container.textContent).toContain("View release");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("stays quiet about updates when the check is unavailable", async () => {
    checkAppUpdates.mockResolvedValue({ status: "unavailable" });
    const container = render();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).not.toContain("is available (you have");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("describes one space per app instead of backend choices", () => {
    const container = render();
    openTab(container, "Settings");
    expect(container.textContent).toContain("own space");
    expect(container.textContent).toContain("Check again");
    for (const jargon of ["picks the strongest backend", "Recheck backend", "not a hardware VM"]) {
      expect(container.textContent).not.toContain(jargon);
    }
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("says when a locked profile cannot be enforced on this PC", async () => {
    listContainers.mockResolvedValue([
      { id: "offline-app", name: "Offline app", source: "C:\\apps\\offline\\app.exe", profile: "locked", networkEnabled: false },
    ]);
    const container = render();
    await act(async () => { await Promise.resolve(); });
    openTab(container, "Profiles");
    expect(container.textContent).toContain("no network requested (not enforced on this PC)");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("reports what an app runs on, and offers no JIT strategy for native code", async () => {
    listContainers.mockResolvedValue([
      {
        id: "native-app",
        name: "Native demo",
        source: "C:\\apps\\native\\app.exe",
        status: "Installed",
        runtime: {
          kind: "native",
          label: "Native code",
          machine: "x64",
          subsystem: "Windows GUI",
          jit: "Already compiled machine code. There is nothing for a JIT to translate.",
        },
      },
    ]);
    const container = render();
    await act(async () => { await Promise.resolve(); });
    openTab(container, "Tweaks");
    const appSelect = container.querySelector("#tweak-app");
    act(() => {
      appSelect.value = "native-app";
      appSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Native code · x64 · Windows GUI");
    expect(container.textContent).toContain("Already compiled machine code");
    // A native exe has no IL, so the strategy must not be offered as if it did.
    const strategy = container.querySelector('select[aria-label="JIT strategy"]');
    expect(strategy).not.toBeNull();
    expect(strategy.disabled).toBe(true);
    expect(container.textContent).toContain("already JIT-compiles JavaScript");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("keeps backend and guest knobs out of the Manage panel", async () => {
    listContainers.mockResolvedValue([
      { id: "app-1", name: "Test app", source: "C:\\apps\\one\\app.exe", status: "Stopped" },
    ]);
    const container = render();
    await act(async () => { await Promise.resolve(); });
    const manage = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Manage");
    expect(manage).not.toBeUndefined();
    act(() => {
      manage.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("This app runs in its own managed environment");
    for (const control of ["Override backend", "Guest exe path", "VM backend", "Containment", "Hyper-V VM", "AppContainer"]) {
      expect(container.textContent).not.toContain(control);
    }
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows update check diagnostics in the Updates tab", async () => {
    checkAppUpdates.mockResolvedValue({ status: "unavailable", reason: "No published releases found." });
    const container = render();
    openTab(container, "Updates");
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("Update check diagnostics");
    expect(container.textContent).toContain("No published releases found.");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows RC-Brain's diagnosis, evidence and repair action in a banner", async () => {
    let emitDiagnosis;
    onAiDiagnosis.mockImplementation((callback) => {
      emitDiagnosis = callback;
      return () => {};
    });
    repairAppEnvironment.mockResolvedValue({ status: "repaired", clearedProfile: [] });
    const container = render();
    act(() => {
      emitDiagnosis({
        id: "app-1",
        name: "Editor",
        outcome: "execute",
        diagnosis: { id: "missing_runtime", summary: "A Microsoft runtime DLL required by the app is missing from this PC.", confidence: 0.99, confidenceText: "99%" },
        action: { id: "restart_same_profile", label: "Restart the app", requiresApproval: false },
        explanation: "A Microsoft runtime DLL required by the app is missing from this PC. Stop the confirmed processes and start the app again.",
        evidence: ["no visible window after 12.0s", "a Microsoft runtime DLL is reported missing"],
        canRepair: true,
      });
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(container.textContent).toContain("RC-Brain");
    expect(container.textContent).toContain("99% confidence");
    expect(container.textContent).toContain("a Microsoft runtime DLL is reported missing");

    const repair = Array.from(alert.querySelectorAll("button")).find((entry) => entry.textContent.includes("Automated Environment Repair"));
    expect(repair).not.toBeUndefined();
    act(() => {
      repair.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(repairAppEnvironment).toHaveBeenCalledWith("app-1", expect.objectContaining({ diagnosis: expect.objectContaining({ id: "missing_runtime" }) }), false);
    expect(container.textContent).toContain("Repaired. The app is running again.");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("requires approval before a repair that touches app data", async () => {
    let emitDiagnosis;
    onAiDiagnosis.mockImplementation((callback) => {
      emitDiagnosis = callback;
      return () => {};
    });
    repairAppEnvironment.mockResolvedValue({ status: "repaired", clearedProfile: ["profile"] });
    const container = render();
    act(() => {
      emitDiagnosis({
        id: "app-1",
        name: "Editor",
        diagnosis: { id: "corrupt_profile", summary: "The app fails consistently while its own profile is in use.", confidenceText: "96%" },
        action: { id: "restart_clean_profile", label: "Restart with a clean profile", requiresApproval: true },
        explanation: "The profile looks corrupt.",
        evidence: ["the log reports corrupt profile or configuration data"],
        canRepair: true,
      });
    });
    expect(container.textContent).toContain("Approve & run repair");
    const approve = Array.from(container.querySelectorAll("[role=\"alert\"] button")).find((entry) => entry.textContent.includes("Approve"));
    act(() => {
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(repairAppEnvironment).toHaveBeenCalledWith("app-1", expect.objectContaining({ action: expect.objectContaining({ id: "restart_clean_profile" }) }), true);
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("disables the repair button once the per-app budget is spent", () => {
    let emitDiagnosis;
    onAiDiagnosis.mockImplementation((callback) => {
      emitDiagnosis = callback;
      return () => {};
    });
    const container = render();
    act(() => {
      emitDiagnosis({
        id: "app-1",
        name: "Editor",
        diagnosis: { id: "resource_hang", summary: "The process holds the CPU while file activity has stopped.", confidenceText: "94%" },
        action: { id: "restart_same_profile", label: "Restart the app", requiresApproval: false },
        explanation: "The app appears hung.",
        evidence: ["CPU at 99% with file activity stopped"],
        canRepair: false,
      });
    });
    const repair = Array.from(container.querySelectorAll("[role=\"alert\"] button")).find((entry) => entry.textContent.includes("Automated Environment Repair"));
    expect(repair.disabled).toBe(true);
    expect(container.textContent).toContain("already run twice");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("shows the model, evaluation and monitoring control in Settings", async () => {
    getAiStatus.mockResolvedValue({
      available: true,
      enabled: true,
      monitoring: true,
      monitor: { running: true, intervalMs: 5000, startedAt: Date.now(), lastTickAt: Date.now(), ticks: 42, watchedApps: 1 },
      permissions: [
        { id: "restart_same_profile", label: "Restart the app", risk: "low", autonomous: true, requiresApproval: false },
        { id: "restart_clean_profile", label: "Restart with a clean profile", risk: "medium", autonomous: false, requiresApproval: true },
      ],
      knowledgeVersion: "2026-10-22.1",
      limits: ["Small local model, not a language model."],
      model: {
        name: "RC-Brain 2",
        version: "2.0.0",
        parameters: 8334,
        features: 66,
        hiddenLayers: { diagnosis: [64, 32], action: [40, 20] },
        createdAt: "2026-10-22T00:00:00.000Z",
        evaluation: {
          familiar: { diagnosisAccuracy: 0.99, actionAccuracy: 0.98, falsePositiveRate: 0.01, unsafeActions: 0 },
          unseen: { diagnosisAccuracy: 0.78, actionAccuracy: 0.75 },
          final: { diagnosisAccuracy: 0.91, actionAccuracy: 0.9, unsafeActions: 0 },
        },
        capabilities: { diagnosisLabels: 19, actionLabels: 12 },
      },
      registry: { current: "rc-brain-4.json", previous: "rc-brain-3.json" },
      experiences: { verified: 0, failed: 0, inconclusive: 0, promoted: 0, pendingPromotion: 0 },
      candidate: { examples: 0, minExamples: 20, canTrain: false },
    });
    setAiMonitoring.mockResolvedValue({ enabled: false, monitoring: false, available: true });
    const container = render();
    openTab(container, "Settings");
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("RC-Brain");
    expect(container.textContent).toContain("8,334 parameters");
    expect(container.textContent).toContain("Familiar cases:");
    expect(container.textContent).toContain("Held-out evaluation");
    expect(container.textContent).toContain("42 checks done");
    expect(container.textContent).toContain("May run automatically: Restart the app.");
    expect(container.textContent).toContain("Needs your approval: Restart with a clean profile.");
    const pause = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent.includes("Pause monitoring"));
    expect(pause).not.toBeUndefined();
    act(() => {
      pause.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(setAiMonitoring).toHaveBeenCalledWith(false);
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("opens the update wizard from the banner", async () => {
    checkAppUpdates.mockResolvedValue({
      status: "update-available",
      currentVersion: "0.6.0",
      latestVersion: "0.6.1",
      installerUrl: "https://github.com/acme/RunContainer/releases/download/v0.6.1/RunContainer-Setup-0.6.1.exe",
      releaseUrl: "https://github.com/acme/RunContainer/releases/tag/v0.6.1",
      releaseNotes: "Faster boots.",
    });
    const container = render();
    await act(async () => { await Promise.resolve(); });
    const updateButton = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Update…");
    expect(updateButton).not.toBeUndefined();
    act(() => {
      updateButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("Update to v0.6.1");
    expect(container.textContent).toContain("Faster boots.");
    downloadUpdate.mockResolvedValue({ downloaded: true });
    const downloadButton = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Download installer");
    act(() => {
      downloadButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("Install & restart");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

});
