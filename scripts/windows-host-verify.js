// Proves RunContainer's central promise on real Windows, end to end:
//
//   press Run on a graphical app, and that app's window is drawn INSIDE a
//   RunContainer window — it is a child window of it, not a window sitting on the
//   desktop beside it.
//
// Every other check in this repository tests the pieces (the launcher, the window
// host script, the process scoping). None of them ever launched the real app and
// looked at the windows that resulted, which is how "it did not render inside" could
// be reported repeatedly without a failing test to point at. This script closes that
// gap: it starts the real Electron app, installs a real GUI program through the
// product's own IPC, runs it, and then asks Windows where the window actually is.
//
//   node scripts/windows-host-verify.js
//
// It uses its own user-data directory, so the app list, the settings and the sandboxes
// of the person running it are untouched. No administrator rights are needed.
//
// Exit code 0 means the app's window was found inside a RunContainer window with a
// sensible size, and that no copy of it was left on the desktop. Anything else is a
// failure and is reported with the app's own log lines as evidence.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const repoRoot = path.join(__dirname, '..');
const probeTitle = 'RCHostProbe';
const notes = [];

// The host window is titled `${PRODUCT_NAME} — <app>` by main.js, and the product name
// depends on the channel: a Nightly build calls itself "RunContainer Nightly". Deriving
// that name from this build's own version keeps the check honest on both channels;
// hard-coding the Stable title made every Nightly run fail although hosting worked.
const productName = /-nightly\.\d+$/.test(require('../package.json').version)
  ? 'RunContainer Nightly'
  : 'RunContainer';
const hostTitlePrefix = `${productName} — `;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function powershell(args, options = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    ...options,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
  } catch (error) {
    // Leftovers in temp are not fatal.
  }
}

// A real, small, graphical Windows program: an ordinary window with a known title.
// What is under test is RunContainer's hosting, not the probe.
function buildProbe(directory) {
  const source = path.join(directory, 'probe.cs');
  const output = path.join(directory, `${probeTitle}.exe`);
  fs.writeFileSync(source, [
    'using System;',
    'using System.Windows.Forms;',
    'public static class RCProbe {',
    '  [STAThread]',
    '  public static void Main() {',
    '    Application.EnableVisualStyles();',
    '    Form form = new Form();',
    `    form.Text = "${probeTitle}";`,
    '    form.Width = 420;',
    '    form.Height = 300;',
    '    form.StartPosition = FormStartPosition.CenterScreen;',
    '    Timer timer = new Timer(); timer.Interval = 2500;',
    '    timer.Tick += (sender, args) => {',
    '      timer.Stop();',
    '      Form dialog = new Form(); dialog.Text = "RCHostProbeDialog";',
    '      dialog.Width = 320; dialog.Height = 200;',
    '      dialog.Show(form);',
    '      Form next = new Form(); next.Text = "RCHostProbeMain";',
    '      next.Width = 420; next.Height = 300; next.Show();',
    '      Timer resetDialog = new Timer(); resetDialog.Interval = 5000;',
    '      resetDialog.Tick += (s, e) => { resetDialog.Stop(); dialog.Owner = null; };',
    '      resetDialog.Start();',
    '      Timer closeSplash = new Timer(); closeSplash.Interval = 10000;',
    '      closeSplash.Tick += (s, e) => { closeSplash.Stop(); form.Close(); };',
    '      closeSplash.Start();',
    '    };',
    '    form.Shown += (sender, args) => timer.Start();',
    '    form.Show();',
    '    Application.Run(new ApplicationContext());',
    '  }',
    '}',
  ].join('\n'), 'utf8');
  const script = path.join(directory, 'build-probe.ps1');
  fs.writeFileSync(script, [
    'param([string]$Source, [string]$Out)',
    'Add-Type -Path $Source -ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputAssembly $Out -OutputType WindowsApplication',
    'if (-not (Test-Path $Out)) { exit 1 }',
    'Write-Output "PROBE_BUILT"',
  ].join('\n'), 'utf8');
  const result = powershell(['-File', script, '-Source', source, '-Out', output]);
  if (!String(result).includes('PROBE_BUILT') || !fs.existsSync(output)) {
    throw new Error(`the GUI probe could not be compiled: ${String(result).slice(0, 400)}`);
  }
  return output;
}

// A controlled installer exercises the actual unattended launch path without touching
// system locations. It identifies as Inno, records the arguments and installs the probe
// into the environment's working directory.
function buildSetupProbe(directory, probe) {
  const source = path.join(directory, 'setup-probe.cs');
  const output = path.join(directory, 'RCSetupProbe.exe');
  const escaped = probe.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  fs.writeFileSync(source, [
    'using System;',
    'using System.IO;',
    'using System.Threading;',
    'public static class RCSetupProbe {',
    '  public static void Main(string[] args) {',
    '    string marker = "Inno Setup";',
    '    File.WriteAllText("setup-args.txt", marker + " " + string.Join(" ", args));',
    '    Thread.Sleep(18000);',
    `    File.Copy("${escaped}", "InstalledProbe.exe", true);`,
    '    File.SetLastWriteTimeUtc("InstalledProbe.exe", DateTime.UtcNow);',
    '  }',
    '}',
  ].join('\n'), 'utf8');
  const script = path.join(directory, 'build-setup-probe.ps1');
  fs.writeFileSync(script, 'param([string]$Source, [string]$Out)\nAdd-Type -Path $Source -OutputAssembly $Out -OutputType WindowsApplication\n', 'utf8');
  powershell(['-File', script, '-Source', source, '-Out', output]);
  if (!fs.existsSync(output)) throw new Error('setup probe could not be compiled');
  // The detector reads byte signatures; .NET string literals are UTF-16.
  fs.appendFileSync(output, Buffer.from('Inno Setup', 'ascii'));
  return output;
}

// Every top-level window on this desktop, plus every descendant of the RunContainer
// windows. A hosted app window is a CHILD window, so it only appears in the second
// half: that is what makes this an answer to "is it rendered inside RunContainer?" and
// not merely "does some window exist?".
function windowDumpScript(directory) {
  const script = path.join(directory, 'windows.ps1');
  fs.writeFileSync(script, [
    'param([string]$Out)',
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class RCWin {',
    '  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '  private static string Describe(IntPtr hWnd) {',
    '    StringBuilder title = new StringBuilder(512); GetWindowTextW(hWnd, title, 512);',
    '    StringBuilder cls = new StringBuilder(256); GetClassNameW(hWnd, cls, 256);',
    '    uint pid; GetWindowThreadProcessId(hWnd, out pid);',
    '    RECT rect; GetWindowRect(hWnd, out rect);',
    '    return string.Join("|", new string[] {',
    '      hWnd.ToInt64().ToString(), GetParent(hWnd).ToInt64().ToString(), pid.ToString(),',
    '      IsWindowVisible(hWnd) ? "1" : "0", (rect.Right - rect.Left).ToString(), (rect.Bottom - rect.Top).ToString(),',
    '      cls.ToString(), title.ToString().Replace("|", "/"),',
    '    });',
    '  }',
    '  public static string Dump() {',
    '    List<string> lines = new List<string>();',
    '    List<IntPtr> hosts = new List<IntPtr>();',
    '    EnumWindows((hWnd, lParam) => {',
    '      lines.Add("TOP|" + Describe(hWnd));',
    '      StringBuilder title = new StringBuilder(512); GetWindowTextW(hWnd, title, 512);',
    '      if (title.ToString().StartsWith("RunContainer")) hosts.Add(hWnd);',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    foreach (IntPtr host in hosts) {',
    '      EnumChildWindows(host, (hWnd, lParam) => { lines.Add("CHILD|" + Describe(hWnd)); return true; }, IntPtr.Zero);',
    '    }',
    '    return string.Join("\\n", lines.ToArray());',
    '  }',
    '}',
    '\'@',
    '[RCWin]::Dump() | Set-Content -Path $Out -Encoding UTF8',
  ].join('\n'), 'utf8');
  return script;
}

function dumpWindows(script, directory) {
  const out = path.join(directory, `windows-${Date.now()}.txt`);
  powershell(['-File', script, '-Out', out]);
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  fs.unlinkSync(out);
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const [kind, rest] = [line.slice(0, line.indexOf('|')), line.slice(line.indexOf('|') + 1)];
    const [handle, parent, pid, visible, width, height, cls, ...titleParts] = rest.split('|');
    return {
      kind,
      handle: Number(handle),
      parent: Number(parent),
      pid: Number(pid),
      visible: visible === '1',
      width: Number(width),
      height: Number(height),
      cls,
      title: titleParts.join('|'),
    };
  });
}

function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    socket.on('error', reject);
    socket.on('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = (nextId += 1);
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try { socket.close(); } catch (error) { /* already closed */ }
        },
      });
    });
  });
}

async function waitForRenderer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no debugging endpoint';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && /index\.html/.test(target.url));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      lastError = `targets: ${targets.map((target) => target.url).join(', ').slice(0, 200)}`;
    } catch (error) {
      lastError = error.message;
    }
    await wait(500);
  }
  throw new Error(`the app never exposed a renderer to drive (${lastError})`);
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const described = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`the renderer threw: ${String(described).slice(0, 400)}`);
  }
  return result.result.value;
}

function appLogLines(userDataDir, limit = 25) {
  const logPath = path.join(userDataDir, 'runcontainer-error.log');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
}

function isPidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The second promise in the same area: a virtual machine is not left behind.
//
// A VM's QEMU process is detached, so it outlives the app that started it — and the record
// on disk then said "Stopped" while that process still held the disk and the console port,
// which is how two machines could end up booting one disk. This starts a stand-in for that
// leftover process, writes the record that points at it, launches the app, and requires that
// the app stops it and clears the record.
async function checkVmLeftover(work) {
  const userDataDir = path.join(work, 'vm-userdata');
  const vmsDir = path.join(userDataDir, 'vms');
  fs.mkdirSync(vmsDir, { recursive: true });
  const standIn = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    ['/c', 'ping -n 300 127.0.0.1 > nul'], { windowsHide: true, stdio: 'ignore' });
  const recordPath = path.join(userDataDir, 'runcontainer-vms.json');
  fs.writeFileSync(recordPath, JSON.stringify({
    vms: [{
      id: 'vm-leftover-verify',
      name: 'Leftover machine',
      memoryMB: 4096,
      cpuCount: 2,
      diskGB: 40,
      isoPath: null,
      diskPath: path.join(vmsDir, 'vm-leftover-verify.qcow2'),
      bootFromMedia: false,
      createdAt: new Date().toISOString(),
      qemuPid: standIn.pid,
    }],
  }, null, 2), 'utf8');

  const electronPath = require('electron');
  const vmApp = spawn(electronPath, ['.', `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0'],
    { cwd: repoRoot, stdio: 'ignore', windowsHide: false });
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && isPidAlive(standIn.pid)) await wait(1000);
    if (isPidAlive(standIn.pid)) {
      throw new Error('a virtual machine that outlived the previous session was left running: its process still holds the disk');
    }
    const stored = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (stored.vms[0].qemuPid) {
      throw new Error('the stored record still claims a running QEMU process for a machine that is stopped');
    }
    return 'a leftover virtual machine was stopped at startup and its record cleared';
  } finally {
    try { execFileSync('taskkill.exe', ['/PID', String(vmApp.pid), '/T', '/F'], { windowsHide: true }); } catch (error) { /* already gone */ }
    try { execFileSync('taskkill.exe', ['/PID', String(standIn.pid), '/T', '/F'], { windowsHide: true }); } catch (error) { /* already gone */ }
  }
}

async function main() {
  if (process.platform !== 'win32') {
    log('This check needs Windows: it inspects real window ownership.');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(repoRoot, 'build', 'index.html'))) {
    log('No production build found. Run `npm run build` first: the check drives the real app.');
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-host-verify-'));
  const userDataDir = path.join(work, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  const port = await freePort();
  let appProcess = null;
  let installed = null;
  let client = null;
  let passed = false;
  let failure = null;
  let appStderr = '';

  try {
    const dumpScript = windowDumpScript(work);

    // A machine with no desktop has no windows to inspect, and reporting that as the app
    // failing to render would be a lie. The check needs an interactive session; a build
    // agent without one is told so plainly instead.
    const preflight = dumpWindows(dumpScript, work).filter((entry) => entry.kind === 'TOP');
    if (preflight.length === 0) {
      log('SKIP  no interactive desktop on this machine, so there are no windows to inspect.');
      removeQuietly(work);
      process.exit(0);
    }

    const probe = buildProbe(work);
    notes.push(`probe built: ${path.basename(probe)}`);

    // The real application, with its own data directory so nothing of the person
    // running this is created, changed or deleted.
    const electronPath = require('electron');
    appProcess = spawn(electronPath, [
      '.',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    appProcess.stdout.on('data', (chunk) => { appStderr += chunk.toString(); });
    appProcess.stderr.on('data', (chunk) => { appStderr += chunk.toString(); });

    // The renderer reloads shortly after start in some builds (the window is created
    // before its page settles), which destroys the first debugging context. Reconnect
    // instead of failing: what is under test is the window hosting, not the timing.
    const evaluateWithRetry = async (expression) => {
      let lastError = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          if (!client) {
            client = await cdpClient(await waitForRenderer(port, 30000));
          }
          return await evaluate(client, expression);
        } catch (error) {
          lastError = error;
          client.close();
          client = null;
          await wait(1500);
        }
      }
      throw lastError || new Error('the app renderer never answered');
    };

    await waitForRenderer(port, 60000);
    client = await cdpClient(await waitForRenderer(port, 60000));
    notes.push('app started and its renderer connected');

    // Install the probe exactly the way the interface does, then Run it.
    installed = await evaluateWithRetry(`require('electron').ipcRenderer.invoke('install-exe', ${JSON.stringify(probe)})`);
    if (!installed || !installed.id) throw new Error(`install-exe did not return an app record: ${JSON.stringify(installed).slice(0, 300)}`);
    notes.push(`installed as "${installed.name}" (${installed.id})`);

    const run = await evaluateWithRetry(`require('electron').ipcRenderer.invoke('run-exe', ${JSON.stringify(installed)})`);
    notes.push(`run-exe answered: ${JSON.stringify(run).slice(0, 220)}`);

    // Give the host window, the launcher and the watcher their time, then ask Windows
    // where the probe's window actually is.
    const deadline = Date.now() + 40000;
    let dump = [];
    let hosted = null;
    let standalone = null;
    let hostWindow = null;
    while (Date.now() < deadline) {
      dump = dumpWindows(dumpScript, work);
      hostWindow = dump.find((entry) => entry.kind === 'TOP' && entry.title.startsWith(hostTitlePrefix)) || null;
      standalone = dump.find((entry) => entry.kind === 'TOP' && entry.title === probeTitle) || null;
      hosted = dump.find((entry) => entry.kind === 'CHILD' && entry.title === probeTitle) || null;
      if (hosted && hostWindow) break;
      await wait(1500);
    }

    if (!hostWindow) {
      throw new Error('no RunContainer window for the app exists at all: pressing Run produced nowhere to render it');
    }
    if (!hosted) {
      throw new Error(standalone
        ? `the app opened on the desktop instead of inside RunContainer (its window ${standalone.handle} is a top-level window, ${standalone.width}x${standalone.height})`
        : 'the app\'s window was never found, either inside a RunContainer window or on the desktop');
    }
    if (standalone) {
      throw new Error(`the app is hosted AND left a copy on the desktop (top-level window ${standalone.handle}, title "${standalone.title}")`);
    }
    if (!hosted.visible) {
      throw new Error(`the app's window is inside RunContainer but not visible (${hosted.width}x${hosted.height})`);
    }
    if (hosted.width < 120 || hosted.height < 80) {
      throw new Error(`the hosted window is too small to be a rendered app: ${hosted.width}x${hosted.height}`);
    }
    if (Number(hosted.parent) !== Number(hostWindow.handle)) {
      throw new Error(`the app's window is nested under ${hosted.parent} rather than the RunContainer window ${hostWindow.handle}`);
    }

    notes.push(`hosted inside "${hostWindow.title}" (window ${hostWindow.handle}), ${hosted.width}x${hosted.height}, visible`);

    // Installer wizards commonly create owned dialogs; Windows GetParent reports their
    // owner even though they are top-level. Check that one is actually adopted too.
    const dialogDeadline = Date.now() + 20000;
    let dialog = null;
    let desktopDialog = null;
    while (Date.now() < dialogDeadline) {
      const windows = dumpWindows(dumpScript, work);
      dialog = windows.find((entry) => entry.kind === 'CHILD' && entry.title === 'RCHostProbeDialog' && entry.parent === hostWindow.handle && entry.visible);
      desktopDialog = windows.find((entry) => entry.kind === 'TOP' && entry.title === 'RCHostProbeDialog');
      if (dialog && !desktopDialog) break;
      await wait(1000);
    }
    if (!dialog || desktopDialog) throw new Error('the owned installer-style dialog did not render inside the RunContainer window');
    notes.push('owned installer-style dialog hosted inside the same window');
    const promotionDeadline = Date.now() + 25000;
    let promoted = null;
    while (Date.now() < promotionDeadline) {
      const windows = dumpWindows(dumpScript, work);
      const splash = windows.find((entry) => entry.kind === 'CHILD' && entry.title === probeTitle);
      promoted = windows.find((entry) => entry.kind === 'CHILD' && entry.title === 'RCHostProbeMain' && entry.parent === hostWindow.handle && entry.visible && entry.width > 700 && entry.height > 300);
      if (!splash && promoted) break;
      await wait(1000);
    }
    if (!promoted) {
      const relevant = dumpWindows(dumpScript, work).filter((entry) => /RCHostProbe/.test(entry.title) || entry.title.startsWith(hostTitlePrefix));
      throw new Error(`the window remaining after the splash closed did not fill the host: ${JSON.stringify(relevant)}`);
    }
    const afterReset = dumpWindows(dumpScript, work);
    const dialogAgain = afterReset.find((entry) => entry.kind === 'CHILD' && entry.title === 'RCHostProbeDialog' && entry.parent === hostWindow.handle && entry.visible);
    const dialogOnDesktop = afterReset.find((entry) => entry.kind === 'TOP' && entry.title === 'RCHostProbeDialog');
    if (!dialogAgain || dialogOnDesktop) throw new Error('the dialog was not re-hosted after its framework reset its parent');
    notes.push('remaining window filled the host and the reset dialog was re-hosted');
    await evaluateWithRetry(`require('electron').ipcRenderer.invoke('kill-exe', ${JSON.stringify({ id: installed.id })})`);
    installed = null;

    const setup = buildSetupProbe(work, probe);
    installed = await evaluateWithRetry(`require('electron').ipcRenderer.invoke('install-exe', ${JSON.stringify(setup)})`);
    if (!installed?.id) throw new Error('setup probe could not be added');
    const setupResult = await evaluateWithRetry(`require('electron').ipcRenderer.invoke('setup-in-background', ${JSON.stringify({ id: installed.id })})`);
    if (setupResult?.status !== 'Running') throw new Error(`background setup did not start the installed app: ${JSON.stringify(setupResult)}`);
    const argsFile = path.join(installed.sandboxRoot, 'setup-args.txt');
    const args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '';
    if (!args.includes('/VERYSILENT') || !args.includes('/NORESTART')) throw new Error(`installer did not receive unattended arguments: ${args}`);
    const setupDeadline = Date.now() + 30000;
    let installedWindow = null;
    while (Date.now() < setupDeadline) {
      const windows = dumpWindows(dumpScript, work);
      const host = windows.find((entry) => entry.kind === 'TOP' && entry.title.startsWith(`${hostTitlePrefix}RCSetupProbe`));
      installedWindow = host && windows.find((entry) => entry.kind === 'CHILD' && entry.title === probeTitle && entry.parent === host.handle && entry.visible);
      if (installedWindow) break;
      await wait(1000);
    }
    if (!installedWindow) throw new Error('the app installed by background setup did not render inside RunContainer');
    notes.push('background setup received silent arguments and its installed app was hosted');
    notes.push(await checkVmLeftover(work));
    passed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (client) {
      try {
        if (installed?.id) await evaluate(client, `require('electron').ipcRenderer.invoke('kill-exe', ${JSON.stringify({ id: installed.id })})`).catch(() => {});
      } catch (error) {
        // Best effort: the app is being closed anyway.
      }
      client.close();
    }
    if (appProcess && appProcess.pid) {
      try { execFileSync('taskkill.exe', ['/PID', String(appProcess.pid), '/T', '/F'], { windowsHide: true }); } catch (error) { /* already gone */ }
    }
    if (!passed && appProcess) {
      // What the desktop actually looked like, so a failure can be read rather than
      // guessed at: every window the app process owns, and every window that mentions
      // the probe by name at all.
      try {
        const seen = dumpWindows(windowDumpScript(work), work);
        const interesting = seen.filter((entry) => /RunContainer|RCHost/i.test(entry.title));
        log(`\nWindows seen (${seen.length} enumerated, app pid ${appProcess.pid}, ${interesting.length} relevant):`);
        for (const entry of interesting.slice(0, 40)) {
          log(`  ${entry.kind} hwnd=${entry.handle} parent=${entry.parent} pid=${entry.pid} visible=${entry.visible ? 'yes' : 'no'} ${entry.width}x${entry.height} class=${entry.cls} title="${entry.title}"`);
        }
        const named = seen.filter((entry) => entry.kind === 'TOP' && entry.title.trim().length > 0);
        log(`\nEvery top-level window with a title (${named.length}), app pid ${appProcess.pid}:`);
        for (const entry of named.slice(0, 60)) {
          const mine = entry.pid === appProcess.pid ? ' <== app process' : '';
          log(`  pid=${entry.pid} visible=${entry.visible ? 'yes' : 'no'} ${entry.width}x${entry.height} class=${entry.cls} title="${entry.title}"${mine}`);
        }
      } catch (error) {
        log(`  (window dump for diagnosis failed: ${error.message})`);
      }
      const lines = appLogLines(userDataDir);
      if (lines.length) {
        log('\nThe app\'s own log, from this run:');
        for (const line of lines) log(`  ${line}`);
      }
      // The per-app log is where hosting decisions are written: whether the window host
      // ever reported that it was watching, whether a window was hosted, or whether the
      // app was left on the desktop and why.
      try {
        const sandboxes = path.join(userDataDir, 'sandboxes');
        for (const entry of fs.existsSync(sandboxes) ? fs.readdirSync(sandboxes) : []) {
          const logsDir = path.join(sandboxes, entry, 'logs');
          if (!fs.existsSync(logsDir)) continue;
          for (const file of fs.readdirSync(logsDir)) {
            log(`\nApp log ${file}:`);
            const text = fs.readFileSync(path.join(logsDir, file), 'utf8');
            for (const line of text.split(/\r?\n/).filter(Boolean).slice(-30)) log(`  ${line}`);
          }
        }
      } catch (error) {
        log(`  (app log could not be read: ${error.message})`);
      }
      if (appStderr.trim()) {
        log('\nProcess output:');
        log(appStderr.trim().split(/\r?\n/).slice(-12).map((line) => `  ${line}`).join('\n'));
      }
    }
    removeQuietly(work);
  }

  for (const note of notes) log(`  · ${note}`);
  if (passed) {
    log('\nPASS  an app really renders inside a RunContainer window');
    process.exit(0);
  }
  log(`\nFAIL  the app did not render inside RunContainer — ${failure ? failure.message : 'unknown failure'}`);
  process.exit(1);
}

main().catch((error) => {
  log(`FAIL  ${error.message}`);
  process.exit(1);
});
