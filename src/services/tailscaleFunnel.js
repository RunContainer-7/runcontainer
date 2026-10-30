// A real web address for the companion, without hosting a relay.
//
// Tailscale Funnel terminates HTTPS on a *.ts.net name and proxies to a port on this
// PC, so the phone opens an ordinary https:// URL: installable, no port, and reachable
// away from home. Tailscale has to be installed and signed in; when it is not, the
// caller gets a plain explanation rather than a failed command.
//
// The commands are the documented ones:
//   tailscale status --json
//   tailscale funnel --bg --yes <port>
//   tailscale funnel --https=443 off

const { execFile } = require("child_process");

const WINDOWS_BINARIES = [
  "tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
];
const STATUS_TTL_MS = 15000;

function runOnce(binary, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(binary, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        missing: Boolean(error && error.code === "ENOENT"),
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        message: error ? String(error.message || "") : "",
      });
    });
  });
}

function createTailscaleFunnel({ runCommand = runOnce, binaries = WINDOWS_BINARIES, timeoutMs = 25000 } = {}) {
  let cachedStatus = null;
  let cachedAt = 0;

  async function invoke(args) {
    let last = null;
    for (const binary of binaries) {
      const result = await runCommand(binary, args, timeoutMs);
      if (!result.missing) return { ...result, binary };
      last = result;
    }
    return last || { code: 1, missing: true, stdout: "", stderr: "", message: "" };
  }

  async function status({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && cachedStatus && now - cachedAt < STATUS_TTL_MS) return cachedStatus;

    const result = await invoke(["status", "--json"]);
    if (result.missing) {
      cachedStatus = { installed: false, signedIn: false, dnsName: "", error: "Tailscale is not installed on this PC." };
      cachedAt = now;
      return cachedStatus;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      parsed = {};
    }
    const dnsName = String(parsed?.Self?.DNSName || "").replace(/\.$/, "");
    const backendState = String(parsed?.BackendState || "");
    const signedIn = Boolean(dnsName) && backendState === "Running";
    const error = signedIn
      ? ""
      : backendState === "NeedsLogin" || backendState === "Stopped" || !backendState
        ? "Tailscale is installed but not signed in. Open Tailscale and sign in, then try again."
        : `Tailscale is ${backendState || "not ready"}. Open it and finish signing in.`;

    cachedStatus = { installed: true, signedIn, dnsName, backendState, error };
    cachedAt = now;
    return cachedStatus;
  }

  async function enable(port) {
    if (!Number.isInteger(Number(port)) || Number(port) <= 0) {
      return { ok: false, error: "The companion is not listening yet." };
    }
    const current = await status({ fresh: true });
    if (!current.installed) return { ok: false, error: current.error };
    if (!current.signedIn) return { ok: false, error: current.error };

    const result = await invoke(["funnel", "--bg", "--yes", String(port)]);
    if (result.code !== 0) {
      // Tailscale prints the page that enables Funnel on the tailnet. Keep the URL in
      // the message so the screen can show it rather than a bare exit code.
      const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
      const link = detail.match(/https:\/\/[^\s]+/);
      return {
        ok: false,
        error: link
          ? `Tailscale needs Funnel enabled for this tailnet. Open ${link[0]} once, then try again.`
          : (detail.split("\n").filter(Boolean).pop() || "Tailscale refused to open a web address."),
      };
    }

    cachedAt = 0;
    return { ok: true, url: `https://${current.dnsName}/` };
  }

  async function disable() {
    const result = await invoke(["funnel", "--https=443", "off"]);
    if (result.missing) return { ok: true };
    // "No serve config" means it was already off, which is the state we wanted.
    if (result.code !== 0) {
      const detail = `${result.stderr || ""}${result.stdout || ""}`;
      if (!/no serve config/i.test(detail)) return { ok: false, error: detail.trim() || "Tailscale did not close the web address." };
    }
    cachedAt = 0;
    return { ok: true };
  }

  return { status, enable, disable };
}

module.exports = { createTailscaleFunnel, runOnce, WINDOWS_BINARIES };
