import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import ContainerManager from "./ContainerManager";
import { onContainerStatus, getAppVersion, checkAppUpdates, downloadUpdate, listContainers } from "../services/containerService";

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
  detectQemu: jest.fn(),
  browseQemuBase: jest.fn(),
  setQemuBase: jest.fn(),
  createQemuProvisionDisk: jest.fn(),
  bootQemuProvision: jest.fn(),
  setGuestExePath: jest.fn(),
  listContainers: jest.fn(async () => []),
  onContainerStatus: jest.fn(() => () => {}),
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
    expect(container.textContent).toContain("RunContainer v0.6.4");
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

  it("restores all seven tabs including Tweaks, Profiles, and Updates", () => {
    const container = render();
    for (const tab of ["Sources", "Apps", "Tweaks", "Settings", "Profiles", "Info", "Updates"]) {
      expect(container.textContent).toContain(tab);
    }
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
