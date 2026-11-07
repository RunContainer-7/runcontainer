// Proves Tweaks and RC-Brain on real Windows, through the app's own interface.
//
// Two promises have never been checked end to end:
//
//   1. Tweaks: pressing Save tweaks writes launch arguments, a memory limit, a CPU
//      limit and a JIT strategy, and the NEXT launch really receives all four. This
//      installs a real GUI program, saves tweaks with the product's own IPC, runs it,
//      then asks Windows what the process is actually limited to (the Job Object, not
//      the record on disk) and asks the app what environment it actually received.
//
//   2. RC-Brain: the packaged model loads in the real app, reports which model it is,
//      and records what it observed. A model that only exists in tests is not working.
//
// It uses its own user-data directory, so a real app list is never touched.
//
//   node scripts/windows-tweaks-verify.js
//
// Exit code 0 means every check held. Anything else explains which promise failed.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const repoRoot = path.join(__dirname, '..');
const probeTitle = 'RCTweaksProbe';
const notes = [];

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

// A real managed .NET window that also writes down what it was started with. .NET is
// the only runtime where a JIT strategy is a real setting, so this probe can prove it.
function buildProbe(directory) {
  const source = path.join(directory, 'probe.cs');
  const output = path.join(directory, `${probeTitle}.exe`);
  fs.writeFileSync(source, [
    'using System;',
    'using System.IO;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'using System.Windows.Forms;',
    'public static class RCTweaksProbe {',
    '  [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);',
    '  [StructLayout(LayoutKind.Sequential)] struct BASIC {',
    '    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;',
    '    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;',
    '    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;',
    '  }',
    '  [StructLayout(LayoutKind.Sequential)] struct IO {',
    '    public ulong a, b, c, d, e, f;',
    '  }',
    '  [StructLayout(LayoutKind.Sequential)] struct EXT {',
    '    public BASIC Basic; public IO Io;',
    '    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcess; public UIntPtr PeakJob;',
    '  }',
    '  [StructLayout(LayoutKind.Sequential)] struct CPURATE { public uint ControlFlags; public uint CpuRate; }',
    '  // A process can always query the job it belongs to. IntPtr.Zero means "mine", which',
    '  // needs no name and no handle - so this is the OS answering, not RunContainer.',
    '  static string OwnJobLimits() {',
    '    EXT ext = new EXT();',
    '    int size = Marshal.SizeOf(ext);',
    '    IntPtr buffer = Marshal.AllocHGlobal(size);',
    '    try {',
    '      if (!QueryInformationJobObject(IntPtr.Zero, 9, buffer, (uint)size, IntPtr.Zero)) return "JOBMEM=none\\nJOBCPU=none";',
    '      ext = (EXT)Marshal.PtrToStructure(buffer, typeof(EXT));',
    '    } finally { Marshal.FreeHGlobal(buffer); }',
    '    CPURATE cpu = new CPURATE();',
    '    int cpuSize = Marshal.SizeOf(cpu);',
    '    IntPtr cpuBuffer = Marshal.AllocHGlobal(cpuSize);',
    '    bool cpuOk;',
    '    try { cpuOk = QueryInformationJobObject(IntPtr.Zero, 15, cpuBuffer, (uint)cpuSize, IntPtr.Zero); if (cpuOk) cpu = (CPURATE)Marshal.PtrToStructure(cpuBuffer, typeof(CPURATE)); }',
    '    finally { Marshal.FreeHGlobal(cpuBuffer); }',
    '    return "JOBMEM=" + ext.JobMemoryLimit.ToUInt64() + "\\nJOBCPU=" + (cpuOk ? cpu.CpuRate.ToString() : "none") + "\\nPROCLIMIT=" + ext.Basic.ActiveProcessLimit;',
    '  }',
    '  [STAThread]',
    '  public static void Main() {',
    '    StringBuilder record = new StringBuilder();',
    '    record.AppendLine("ARGS=" + Environment.CommandLine);',
    '    record.AppendLine("TIERED=" + (Environment.GetEnvironmentVariable("DOTNET_TieredCompilation") ?? "<unset>"));',
    '    record.AppendLine("LOOPS=" + (Environment.GetEnvironmentVariable("DOTNET_TC_QuickJitForLoops") ?? "<unset>"));',
    '    record.AppendLine(OwnJobLimits());',
    '    File.WriteAllText("probe-args.txt", record.ToString());',
    '    Application.EnableVisualStyles();',
    '    Form form = new Form();',
    `    form.Text = "${probeTitle}";`,
    '    form.Width = 420;',
    '    form.Height = 300;',
    '    form.Shown += (sender, args) => {',
    '      Timer timer = new Timer(); timer.Interval = 30000;',
    '      timer.Tick += (s, e) => { timer.Stop(); form.Close(); };',
    '      timer.Start();',
    '    };',
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
    throw new Error(`the tweaks probe could not be compiled: ${String(result).slice(0, 400)}`);
  }
  return output;
}

function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch (error) { return; }
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
        close() { try { socket.close(); } catch (error) { /* already closed */ } },
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
      lastError = targets.map((target) => target.url).join(', ').slice(0, 200);
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

function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
  } catch (error) {
    // Leftovers in temp are not fatal.
  }
}

async function main() {
  if (process.platform !== 'win32') {
    log('This check needs Windows.');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(repoRoot, 'build', 'index.html'))) {
    log('No production build found. Run `npm run build` first: the check drives the real app.');
    process.exit(1);
  }

  const rcvm = require('../public/rcvm-runtime');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tweaks-verify-'));
  const userDataDir = path.join(work, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  const port = await freePort();
  let appProcess = null;
  let installed = null;
  let client = null;
  let passed = false;

  // The tweaks that must reach the launch. Deliberately not the defaults, so a launch
  // that ignores saved settings cannot pass by coincidence.
  const tweaks = { launchArgs: '--rc-tweak=42 --second-flag', vmMemoryMB: 1024, vmCpuCount: 1, runtimeJit: 'fast-start' };
  const expectedCpuRate = rcvm.cpuRateForCount(1, os.cpus().length);

  try {
    const probe = buildProbe(work);
    const electronPath = require('electron');
    appProcess = spawn(electronPath, [
      '.',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
    ], { cwd: repoRoot, stdio: 'ignore', windowsHide: false });

    client = await cdpClient(await waitForRenderer(port, 60000));
    notes.push('app started and its renderer connected');

    const call = async (expression) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          if (!client) client = await cdpClient(await waitForRenderer(port, 30000));
          return await evaluate(client, expression);
        } catch (error) {
          if (attempt === 3) throw error;
          client.close();
          client = null;
          await wait(1200);
        }
      }
      return null;
    };

    installed = await call(`require('electron').ipcRenderer.invoke('install-exe', ${JSON.stringify(probe)})`);
    if (!installed?.id) throw new Error(`install-exe did not return an app record: ${JSON.stringify(installed).slice(0, 300)}`);
    notes.push(`installed as "${installed.name}" (${installed.id})`);

    // The app must agree it is a managed .NET program, or the JIT tweak is rightly refused.
    if (installed.runtime?.kind !== 'dotnet') {
      throw new Error(`the probe was not detected as a managed .NET app (runtime: ${JSON.stringify(installed.runtime)})`);
    }

    // Save the tweaks exactly as the Tweaks panel does.
    const saved = await call(`require('electron').ipcRenderer.invoke('set-app-config', ${JSON.stringify({ id: installed.id, ...tweaks })})`);
    if (saved?.status === 'Failed') throw new Error(`saving tweaks was refused: ${saved.error}`);
    for (const key of Object.keys(tweaks)) {
      const expected = key === 'launchArgs' ? tweaks[key] : tweaks[key];
      if (String(saved?.[key]) !== String(expected)) {
        throw new Error(`the saved tweak ${key} came back as ${JSON.stringify(saved?.[key])} instead of ${JSON.stringify(expected)}`);
      }
    }
    notes.push(`tweaks saved: ${tweaks.launchArgs}, ${tweaks.vmMemoryMB} MB, ${tweaks.vmCpuCount} CPU, ${tweaks.runtimeJit}`);

    const run = await call(`require('electron').ipcRenderer.invoke('run-exe', ${JSON.stringify({ id: installed.id })})`);
    if (run?.status !== 'Running') throw new Error(`the app did not start with the saved tweaks: ${JSON.stringify(run).slice(0, 400)}`);
    notes.push(`launched (${run.activeEngine}, pid ${run.pid})`);

    // What the app received, written by the app itself into its own folder.
    const argsFile = path.join(installed.sandboxRoot, 'probe-args.txt');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !fs.existsSync(argsFile)) await wait(500);
    if (!fs.existsSync(argsFile)) throw new Error('the app never ran far enough to record its own arguments');
    const recorded = fs.readFileSync(argsFile, 'utf8');
    if (!recorded.includes('--rc-tweak=42') || !recorded.includes('--second-flag')) {
      throw new Error(`the saved launch arguments did not reach the app: ${recorded.split(/\r?\n/)[0]}`);
    }
    notes.push('saved launch arguments reached the running app');

    if (!/TIERED=0/.test(recorded) || !/LOOPS=0/.test(recorded)) {
      throw new Error(`the Fast start JIT strategy did not reach the app: ${recorded.replace(/\r?\n/g, ' | ')}`);
    }
    notes.push('the .NET JIT strategy reached the process environment');

    // What Windows is enforcing, as reported by the contained process asking about its
    // OWN job object. No handle, no name and no launcher involvement: if the limits had
    // not been applied, this process could not report them.
    const jobMemory = Number((/JOBMEM=(\d+)/.exec(recorded) || [])[1]);
    const jobCpu = Number((/JOBCPU=(\d+)/.exec(recorded) || [])[1]);
    if (jobMemory !== tweaks.vmMemoryMB * 1024 * 1024) {
      throw new Error(`the process is in a job limited to ${jobMemory} bytes, not the saved ${tweaks.vmMemoryMB} MB (${tweaks.vmMemoryMB * 1024 * 1024}): ${recorded.replace(/\r?\n/g, ' | ')}`);
    }
    if (jobCpu !== expectedCpuRate) {
      throw new Error(`the job's CPU rate is ${jobCpu}, not the ${expectedCpuRate} saved for one CPU: ${recorded.replace(/\r?\n/g, ' | ')}`);
    }
    notes.push(`the running app reports its own job capped at ${jobMemory / (1024 * 1024)} MB and CPU rate ${jobCpu}`);

    // RC-Brain: the packaged model must load in the real app and name itself.
    const ai = await call(`require('electron').ipcRenderer.invoke('ai-status')`);
    if (!ai?.available) throw new Error(`RC-Brain did not load in the app: ${JSON.stringify(ai).slice(0, 400)}`);
    // ai-status reports the loaded model as an object, so read its identifier rather
    // than stringifying it into "[object Object]".
    const modelId = ai.model?.id || ai.model?.name || ai.modelId || ai.name || '';
    if (!/rc-brain-5/i.test(String(modelId))) {
      throw new Error(`the app loaded ${String(modelId) || 'no model'} instead of RC-Brain 5`);
    }
    notes.push(`RC-Brain loaded: ${modelId} version ${ai.model?.version || 'unknown'}`);

    // It must actually be watching the running app, not merely loaded.
    const historyDeadline = Date.now() + 40000;
    let history = [];
    while (Date.now() < historyDeadline) {
      history = await call(`require('electron').ipcRenderer.invoke('ai-history')`);
      if (Array.isArray(history) && history.length > 0) break;
      await wait(2000);
    }
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error('RC-Brain loaded but recorded no observation of the running app, so it is not monitoring');
    }
    const latest = history[0];
    notes.push(`RC-Brain observed the app: ${latest?.diagnosis?.id || latest?.diagnosis || 'unknown'} -> ${latest?.action?.id || latest?.action || 'none'}`);

    await call(`require('electron').ipcRenderer.invoke('kill-exe', ${JSON.stringify({ id: installed.id })})`).catch(() => {});
    installed = null;
    passed = true;
  } catch (error) {
    log(`FAIL  ${error.message}`);
  } finally {
    if (installed?.id) {
      try { await evaluate(client, `require('electron').ipcRenderer.invoke('kill-exe', ${JSON.stringify({ id: installed.id })})`); } catch (error) { /* quitting */ }
    }
    if (appProcess?.pid) {
      try { execFileSync('taskkill.exe', ['/PID', String(appProcess.pid), '/T', '/F'], { windowsHide: true }); } catch (error) { /* already gone */ }
    }
    try { client?.close(); } catch (error) { /* already closed */ }
    removeQuietly(work);
  }

  for (const note of notes) log(`  · ${note}`);
  if (!passed) process.exit(1);
  log('PASS  saved tweaks reach the launch and Windows enforces them, and RC-Brain 5 is loaded and watching');
}

main().catch((error) => {
  log(`FAIL  ${error.message}`);
  process.exit(1);
});
