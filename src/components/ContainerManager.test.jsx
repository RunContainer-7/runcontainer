import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import ContainerManager from "./ContainerManager";
import { onContainerStatus, getAppVersion } from "../services/containerService";

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
  checkForUpdate: jest.fn(async () => null),
  provisionGuestCredential: jest.fn(),
  getAppVersion: jest.fn(async () => "0.5.0"),
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

  it("shows settings controls in Settings", () => {
    const container = render();
    openTab(container, "Settings");
    expect(container.textContent).toContain("VM isolation");
    expect(container.textContent).toContain("Windows inside RunContainer");
    expect(container.textContent).toContain("App storage");
    expect(container.textContent).not.toContain("Auto-isolate APPDATA");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });

  it("requires the VM path and marks AppContainer as not a VM", () => {
    const container = render();
    openTab(container, "Settings");
    expect(container.textContent).toContain("VM isolation");
    expect(container.textContent).toContain("Hyper-V");
    expect(container.textContent).toContain("NOT a VM");
    expect(container.textContent).toContain("no Sandboxie");
    expect(container.textContent).not.toContain("Sandboxie-Plus box");
    expect(container.textContent).not.toContain("Run unguarded instead");
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
    expect(container.textContent).toContain("RunContainer v0.5.0");
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

  it("restores all six tabs including Tweaks and Profiles", () => {
    const container = render();
    for (const tab of ["Sources", "Apps", "Tweaks", "Settings", "Profiles", "Info"]) {
      expect(container.textContent).toContain(tab);
    }
    openTab(container, "Tweaks");
    expect(container.textContent).toContain("Launch arguments");
    expect(container.textContent).toContain("Save tweaks");
    openTab(container, "Profiles");
    expect(container.textContent).toContain("locked");
    expect(container.textContent).toContain("Isolation presets");
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

  it("shows the update banner when a newer Stable release exists, and links Discord", async () => {
    const { checkForUpdate } = require("../services/containerService");
    checkForUpdate.mockResolvedValueOnce({ available: true, current: "0.5.0", latest: "0.5.1", url: "https://github.com/RunContainer-7/runcontainer/releases/latest" });
    const container = render();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("RunContainer 0.5.1 is available");
    openTab(container, "Info");
    const link = Array.from(container.querySelectorAll("a")).find((a) => a.getAttribute("href") === "https://discord.gg/UKTGRMMmC4");
    expect(link).toBeTruthy();
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
