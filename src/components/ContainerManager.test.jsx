import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import ContainerManager from "./ContainerManager";
import { onContainerStatus } from "../services/containerService";

jest.mock("../services/containerService", () => ({
  installContainer: jest.fn(),
  importFromUrl: jest.fn(),
  runContainer: jest.fn(),
  killContainer: jest.fn(),
  resetContainer: jest.fn(),
  duplicateContainer: jest.fn(),
  exportContainer: jest.fn(),
  getAppLogs: jest.fn(),
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
    expect(container.textContent).toContain("Isolation engine");
    expect(container.textContent).toContain("App storage");
    expect(container.textContent).not.toContain("Auto-isolate APPDATA");
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

  it("does not render the old fake container desktop", () => {
    const container = render();
    expect(container.textContent).not.toContain("RunContainer OS");
    expect(container.textContent).not.toContain("Sandbox Console");
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
  });
});
