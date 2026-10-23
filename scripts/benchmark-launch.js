// Launch-path benchmark for RCVM containment.
//
// Every number is measured here, on this machine, with the same launcher the
// app ships. Nothing is estimated. Run it before and after changing the launch
// path and compare medians; a single run is not evidence.
//
//   node scripts/benchmark-launch.js [--runs 7]
//
// What it measures:
//   build      — generating the PowerShell launcher text (pure JS, no I/O)
//   pid        — spawn to the launcher reporting the started PID
//   verify     — spawn to post-launch containment verification
//   exit       — spawn to the app's own exit (a trivial command that exits)
//   proctable  — one Windows process-table query, which launch and the monitor use
//
// It needs Windows (Job Objects and PowerShell). On other platforms it exits
// with a clear message instead of printing invented timings.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rcvm = require('../public/rcvm-runtime');
const { buildProcessTableArgs } = require('../public/isolated-launch');

const runsArg = process.argv.indexOf('--runs');
const RUNS = Math.max(1, Math.min(30, Number(runsArg > -1 ? process.argv[runsArg + 1] : 7) || 7));
// --no-cache reproduces the pre-0.7.0 launcher, which compiled the C# assembly
// on every launch.
const USE_CACHE = !process.argv.includes('--no-cache');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(values) {
  const rounded = values.map((value) => Math.round(value));
  return {
    median: Math.round(median(values)),
    min: Math.min(...rounded),
    max: Math.max(...rounded),
    runs: rounded,
  };
}

function runLauncherOnce() {
  return new Promise((resolve) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rcvm-bench-'));
    for (const dir of ['Roaming', 'Local', 'Temp']) fs.mkdirSync(path.join(sandbox, dir), { recursive: true });
    const limits = rcvm.validateRcvmLimits({ processorCount: os.cpus().length });
    const buildStart = process.hrtime.bigint();
    const script = rcvm.buildRcvmLaunchScript({
      jobName: rcvm.rcvmJobName(`bench-${process.pid}-${Date.now()}`),
      executablePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      workingDirectory: sandbox,
      appDataDir: path.join(sandbox, 'Roaming'),
      localAppDataDir: path.join(sandbox, 'Local'),
      tempDir: path.join(sandbox, 'Temp'),
      userProfileDir: sandbox,
      launchArgs: '/c exit 0',
      memoryCapBytes: limits.limits.memoryCapBytes,
      cpuRate: limits.limits.cpuRate,
      maxProcesses: limits.limits.maxProcesses,
      // Same cache the app uses. The first run pays for compilation; later runs
      // load the assembly, which is what a user sees after the first launch.
      ...(USE_CACHE
        ? {
          launcherCacheDir: path.join(os.tmpdir(), 'rcvm-bench-cache'),
          launcherCacheKey: rcvm.rcvmLauncherCacheKey(),
        }
        : {}),
    });
    const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
    const scriptPath = path.join(sandbox, 'launch.ps1');
    fs.writeFileSync(scriptPath, script, 'utf8');

    const started = process.hrtime.bigint();
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true });
    let output = '';
    let pidMs = null;
    let verifyMs = null;
    const done = () => {
      const exitMs = Number(process.hrtime.bigint() - started) / 1e6;
      fs.rmSync(sandbox, { recursive: true, force: true });
      resolve({ buildMs, pidMs, verifyMs, exitMs, output });
    };
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const parsed = rcvm.parseRcvmLauncherOutput(output);
      if (pidMs === null && parsed.pid) pidMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (verifyMs === null && parsed.verified) verifyMs = Number(process.hrtime.bigint() - started) / 1e6;
    });
    child.once('exit', done);
    child.once('error', done);
  });
}

function measureProcessTable() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    execFile('powershell.exe', buildProcessTableArgs(), { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, () => {
      resolve(Number(process.hrtime.bigint() - start) / 1e6);
    });
  });
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('This benchmark measures Windows Job Object launches; run it on Windows.');
    process.exit(1);
  }
  const builds = [];
  const pids = [];
  const verifies = [];
  const exits = [];
  const tables = [];
  for (let i = 0; i < RUNS; i += 1) {
    const run = await runLauncherOnce();
    builds.push(run.buildMs);
    if (run.pidMs !== null) pids.push(run.pidMs);
    if (run.verifyMs !== null) verifies.push(run.verifyMs);
    exits.push(run.exitMs);
    // Progress goes to stderr so stdout stays machine-readable JSON.
    process.stderr.write(`run ${i + 1}/${RUNS}: pid ${Math.round(run.pidMs || -1)} ms, verify ${Math.round(run.verifyMs || -1)} ms, exit ${Math.round(run.exitMs)} ms\n`);
  }
  for (let i = 0; i < RUNS; i += 1) tables.push(await measureProcessTable());

  const report = {
    measuredAt: new Date().toISOString(),
    machine: {
      platform: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length,
      cpu: os.cpus()[0]?.model,
      memoryGB: Math.round(os.totalmem() / 1024 ** 3),
      powershell: process.env.PSModulePath ? 'Windows PowerShell 5.1' : 'unknown',
    },
    runs: RUNS,
    launcherCache: USE_CACHE,
    buildScriptMs: summarize(builds),
    spawnToPidMs: summarize(pids),
    spawnToVerifyMs: summarize(verifies),
    spawnToExitMs: summarize(exits),
    processTableQueryMs: summarize(tables),
  };
  console.log(JSON.stringify(report, null, 2));
})();
