import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import CompanionQr from "./CompanionQr";

function render(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    ReactDOM.render(<CompanionQr {...props} />, container);
  });
  return container;
}

describe("CompanionQr", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("draws a scannable code for the address, with a white quiet zone", () => {
    const container = render({ value: "http://192.168.1.20:7878/" });
    const svg = container.querySelector("svg.companion-qr");
    expect(svg).not.toBeNull();
    // A version-2 code is 25 modules; the quiet zone adds four on each side.
    expect(svg.getAttribute("viewBox")).toBe("0 0 33 33");
    expect(svg.querySelectorAll("rect").length).toBeGreaterThan(20);
    expect(svg.querySelector("rect").getAttribute("fill")).toBe("#ffffff");
    expect(svg.getAttribute("aria-label")).toContain("192.168.1.20");
  });

  it("renders nothing when there is no address yet", () => {
    const container = render({ value: "" });
    expect(container.querySelector("svg")).toBeNull();
  });

  it("grows the code rather than failing on a longer address", () => {
    const container = render({ value: "http://100.101.102.103:7878/" });
    const svg = container.querySelector("svg.companion-qr");
    expect(svg).not.toBeNull();
    expect(Number(svg.getAttribute("viewBox").split(" ")[2])).toBeGreaterThan(0);
  });
});
