import { installContainer, importFromUrl, runContainer, resetContainer, killContainer } from "./containerService";

describe("containerService", () => {
  const originalWindow = global.window;

  afterEach(() => {
    global.window = originalWindow;
  });

  it("refuses to fake app operations when Electron IPC is not available", async () => {
    global.window = {};
    await expect(installContainer("C:\\fake.exe")).rejects.toThrow("available only in the RunContainer desktop app");
    await expect(importFromUrl("https://example.test/app.exe")).rejects.toThrow("available only in the RunContainer desktop app");
    await expect(runContainer({ id: "1" })).rejects.toThrow("available only in the RunContainer desktop app");
    await expect(resetContainer({ id: "1" })).rejects.toThrow("available only in the RunContainer desktop app");
    await expect(killContainer({ id: "1" })).rejects.toThrow("available only in the RunContainer desktop app");
  });
});
