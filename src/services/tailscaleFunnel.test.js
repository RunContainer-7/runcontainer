const { createTailscaleFunnel } = require("./tailscaleFunnel");

const RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "study-pc.tail1a2b.ts.net." },
});

function runner(handlers) {
  const calls = [];
  const run = async (binary, args) => {
    calls.push([binary, ...args].join(" "));
    const key = args.join(" ");
    const handler = handlers[key];
    if (handler) return typeof handler === "function" ? handler() : handler;
    return { code: 1, missing: false, stdout: "", stderr: "unexpected command" };
  };
  run.calls = calls;
  return run;
}

describe("Tailscale Funnel", () => {
  it("reports Tailscale as missing when no binary answers", async () => {
    const funnel = createTailscaleFunnel({
      runCommand: async () => ({ code: 1, missing: true, stdout: "", stderr: "" }),
    });
    const status = await funnel.status();
    expect(status.installed).toBe(false);
    expect(status.error).toMatch(/not installed/i);
  });

  it("refuses to open a web address while Tailscale is logged out", async () => {
    const runCommand = runner({
      "status --json": {
        code: 0,
        missing: false,
        stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } }),
        stderr: "",
      },
    });
    const funnel = createTailscaleFunnel({ runCommand });
    const status = await funnel.status();
    expect(status.installed).toBe(true);
    expect(status.signedIn).toBe(false);
    expect(status.error).toMatch(/not signed in/i);

    const result = await funnel.enable(7878);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sign in/i);
    expect(runCommand.calls.some((call) => call.includes("funnel --bg"))).toBe(false);
  });

  it("opens a funnel and returns the https address without the trailing dot", async () => {
    const runCommand = runner({
      "status --json": { code: 0, missing: false, stdout: RUNNING, stderr: "" },
      "funnel --bg --yes 7878": { code: 0, missing: false, stdout: "", stderr: "" },
    });
    const funnel = createTailscaleFunnel({ runCommand });
    const result = await funnel.enable(7878);
    expect(result).toEqual({ ok: true, url: "https://study-pc.tail1a2b.ts.net/" });
    expect(runCommand.calls).toContain("tailscale funnel --bg --yes 7878");
  });

  it("keeps the activation link when the tailnet has Funnel turned off", async () => {
    const runCommand = runner({
      "status --json": { code: 0, missing: false, stdout: RUNNING, stderr: "" },
      "funnel --bg --yes 7878": {
        code: 1,
        missing: false,
        stdout: "",
        stderr: "Funnel is not enabled on your tailnet.\nhttps://login.tailscale.com/f/funnel?node=abc",
      },
    });
    const funnel = createTailscaleFunnel({ runCommand });
    const result = await funnel.enable(7878);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("https://login.tailscale.com/f/funnel?node=abc");
  });

  it("treats an already-empty funnel config as off", async () => {
    const runCommand = runner({
      "funnel --https=443 off": {
        code: 1,
        missing: false,
        stdout: "",
        stderr: "No serve config",
      },
    });
    const funnel = createTailscaleFunnel({ runCommand });
    expect(await funnel.disable()).toEqual({ ok: true });
  });

  it("reports the first real binary and remembers the last status briefly", async () => {
    const runCommand = runner({
      "status --json": { code: 0, missing: false, stdout: RUNNING, stderr: "" },
    });
    const funnel = createTailscaleFunnel({
      binaries: ["C:\\Program Files\\Tailscale\\tailscale.exe"],
      runCommand,
    });
    await funnel.status();
    await funnel.status();
    expect(runCommand.calls).toEqual(["C:\\Program Files\\Tailscale\\tailscale.exe status --json"]);
  });
});
