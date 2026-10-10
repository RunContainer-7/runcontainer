import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import ContainerManager from "./ContainerManager";

describe("ContainerManager", () => {
  it("renders the Apps tab and install action", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    act(() => {
      ReactDOM.render(<ContainerManager />, container);
    });

    expect(container.textContent).toContain("Apps");
    expect(container.textContent).toContain("Install EXE");

    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
    container.remove();
  });

  it("shows source-import controls when the Sources tab is opened", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    act(() => {
      ReactDOM.render(<ContainerManager />, container);
    });

    const sourceButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent.includes("Sources"));

    act(() => {
      sourceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Import from URL");
    expect(container.querySelector('input[placeholder="Source URL"]')).not.toBeNull();

    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
    container.remove();
  });

  it("renders the settings toggles in the Settings tab", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    act(() => {
      ReactDOM.render(<ContainerManager />, container);
    });

    const settingsButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent.includes("Settings"));

    act(() => {
      settingsButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Auto-isolate APPDATA");
    expect(container.textContent).toContain("Persistent logs");

    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
    container.remove();
  });
});
