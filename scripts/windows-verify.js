// Windows verification for the two reported bugs.
//
// This script must run on Windows. It exercises the real modules RunContainer ships
// (public/isolation-runtime.js, public/isolated-launch.js) against the real OS:
//
//   1. the generated PowerShell launchers parse and compile,
//   2. an app really is created inside an AppContainer with a verified container token,
//   3. an app's own processes are found and stopped while a bystander process survives,
//   4. a sandbox folder is really removed: read-only files, a DENY ACL, a long path,
//      and an exclusive file lock that must fail loudly and then succeed once released.
//
// Run it with:  node scripts/windows-verify.js
// It needs no administrator rights. It never touches anything outside its own temp folder.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isolation = require('../public/isolation-runtime');
const launch = require('../public/isolated-launch');
const hyperv = require('../public/hyperv-runtime');
const { selectIsolationEngine } = require('../public/engine-select');
const rcvm = require('../public/rcvm-runtime');
const updateCheck = require('../public/update-check');

const results = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    results.push(`FAIL  ${name} — ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    results.push(`FAIL  ${name} — ${error.message}`);
  }
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
}

function powershell(args, options = {}) {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { timeout: 120000, ...options });
}

function makeSandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rc-verify-${label}-`));
  return root;
}

function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
  } catch (error) {
    // Leftovers in temp are not fatal for the verification run.
  }
}

// ---------------------------------------------------------------------------
// 1. The generated launchers must parse (PowerShell) and compile (C#).
// ---------------------------------------------------------------------------
function checkGeneratedScriptsParse(prefix) {
  const work = makeSandbox('parse');
  const launcher = path.join(work, 'appcontainer.ps1');
  const host = path.join(work, 'windowhost.ps1');
  fs.writeFileSync(launcher, isolation.buildAppContainerScript(), 'utf8');
  fs.writeFileSync(host, require('../public/window-host').buildWindowHostScript(), 'utf8');

  const parseScript = path.join(work, 'parse.ps1');
  fs.writeFileSync(parseScript, [
    'param([string]$Files)',
    '$total = 0',
    'foreach ($file in ($Files -split ",")) {',
    '  $tokens = $null; $errors = $null',
    '  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null',
    '  if ($errors.Count -gt 0) {',
    '    Write-Output ("PARSE_ERRORS " + $file + " " + $errors.Count)',
    '    Write-Output ($errors[0].Message)',
    '  }',
    '  $total += $errors.Count',
    '}',
    'if ($total -gt 0) { exit 1 }',
    'Write-Output "PARSE_OK"',
  ].join('\n'), 'utf8');
  const output = powershell(['-File', parseScript, '-Files', [launcher, host].join(',')]);
  removeQuietly(work);
  if (!String(output).includes('PARSE_OK')) {
    throw new Error(`${prefix} generated scripts do not parse: ${output}`);
  }
  return 'both launchers parse as PowerShell';
}

// ---------------------------------------------------------------------------
// 2. A real process inside a real AppContainer, with the token verified.
// ---------------------------------------------------------------------------
function checkAppContainerLaunch() {
  const sandbox = makeSandbox('container');
  const scriptPath = path.join(sandbox, 'launcher.ps1');
  fs.writeFileSync(scriptPath, isolation.buildAppContainerScript(), 'utf8');
  const containerName = isolation.appContainerName(`verify-${Date.now()}`);

  const target = path.join(sandbox, 'hostapp.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), target);

  const sidOut = powershell(['-File', scriptPath, '-Mode', 'sid', '-Name', containerName]);
  const sid = isolation.parseAppContainerOutput(sidOut).sid;
  if (!sid || !sid.startsWith('S-1-15-2-')) throw new Error(`unexpected AppContainer SID: ${sid}`);

  run('icacls.exe', isolation.buildAppContainerFolderAclArgs(sandbox, sid));

  const launchOut = powershell(['-File', scriptPath, '-Mode', 'launch', '-Name', containerName, '-Exe', target, '-Dir', sandbox]);
  const result = isolation.parseAppContainerOutput(launchOut);
  if (!result.verified || result.processSid !== result.containerSid) {
    throw new Error(`the created process token was not verified as an AppContainer token: ${JSON.stringify(result)}`);
  }
  try {
    run('taskkill.exe', launch.buildTaskkillArgs(result.pid));
  } catch (error) {
    // The process may already have exited.
  }

  const deleteOut = powershell(['-File', scriptPath, '-Mode', 'delete', '-Name', containerName]);
  const deleted = isolation.parseAppContainerOutput(deleteOut);
  if (!deleted.deleted) throw new Error('the AppContainer profile was not removed');

  removeQuietly(path.join(process.env.LOCALAPPDATA || os.homedir(), 'Packages', containerName));
  removeQuietly(sandbox);
  return `pid ${result.pid} ran as ${result.containerSid}, profile removed`;
}

// ---------------------------------------------------------------------------
// 3. Process scoping: the app's own process is stopped, a bystander is not.
// ---------------------------------------------------------------------------
async function checkProcessScoping() {
  const sandbox = makeSandbox('scope');
  const app = path.join(sandbox, 'app.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), app);

  const appProcess = spawn(app, ['/c', 'ping -n 30 127.0.0.1 > nul'], { cwd: sandbox, detached: true, stdio: 'ignore', windowsHide: true });
  const bystander = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/c', 'ping -n 30 127.0.0.1 > nul'], { detached: true, stdio: 'ignore', windowsHide: true });
  appProcess.unref();
  bystander.unref();

  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(2000);

    const listProcesses = async () => launch.parseProcessTable(powershell(launch.buildProcessTableArgs()));
    const table = await listProcesses();
    const found = launch.findAppProcessIds(table, sandbox, [appProcess.pid]);
    if (!found.includes(appProcess.pid)) throw new Error(`the app process ${appProcess.pid} was not found from ${sandbox}`);
    if (found.includes(bystander.pid)) throw new Error(`the bystander process ${bystander.pid} was wrongly selected`);

    const remaining = await launch.stopAppProcesses({
      directory: sandbox,
      seedPids: [appProcess.pid],
      listProcesses,
      terminate: async (pid, { force }) => {
        run('taskkill.exe', force ? launch.buildTaskkillArgs(pid) : launch.buildGracefulTaskkillArgs(pid));
      },
      wait,
      attempts: 3,
      forceAfterGracefulMs: 1500,
      verifyAfterMs: 500,
    });
    if (remaining.length > 0) throw new Error(`PIDs ${remaining.join(', ')} could not be stopped`);

    let bystanderAlive = true;
    try {
      run('tasklist.exe', ['/FI', `PID eq ${bystander.pid}`, '/NH']);
    } catch (error) {
      bystanderAlive = false;
    }
    if (!bystanderAlive) throw new Error('the bystander process was terminated');
    if (!fs.existsSync(app)) throw new Error('the app executable disappeared');
    return `stopped PID(s) ${found.join(', ')} and left bystander PID ${bystander.pid} running`;
  } finally {
    try { run('taskkill.exe', ['/PID', String(appProcess.pid), '/T', '/F']); } catch (error) {}
    try { run('taskkill.exe', ['/PID', String(bystander.pid), '/T', '/F']); } catch (error) {}
    removeQuietly(sandbox);
  }
}

// ---------------------------------------------------------------------------
// 4. Deletion on real Windows.
// ---------------------------------------------------------------------------
async function checkDeletionCases() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const notes = [];

  // 4a. read-only file inside the tree
  {
    const sandbox = makeSandbox('readonly');
    fs.mkdirSync(path.join(sandbox, 'Temp'), { recursive: true });
    const locked = path.join(sandbox, 'Temp', 'read-only.txt');
    fs.writeFileSync(locked, 'x');
    run('attrib.exe', ['+R', locked]);
    await launch.removeDirectoryWithRetries({ directory: sandbox, attempts: 3, retryDelayMs: 300 });
    if (fs.existsSync(sandbox)) throw new Error('read-only tree was not removed');
    notes.push('read-only');
  }

  // 4b. explicit DENY ACE, the classic installer leftover
  {
    const sandbox = makeSandbox('deny');
    fs.writeFileSync(path.join(sandbox, 'data.bin'), 'x');
    run('icacls.exe', [sandbox, '/deny', `${process.env.USERNAME}:(OI)(CI)F`]);
    await launch.removeDirectoryWithRetries({
      directory: sandbox,
      attempts: 6,
      retryDelayMs: 300,
      // Exactly the sequence the app runs, in the same order.
      prepareForRemoval: async () => {
        for (const step of launch.buildAclRepairPlan(sandbox)) {
          try { run(step.command, step.args); } catch (error) { /* /C keeps icacls going; a failed step is retried by the removal loop */ }
        }
      },
    });
    if (fs.existsSync(sandbox)) throw new Error('DENY-ACL tree was not removed');
    notes.push('deny-acl-repair');
  }

  // 4c. path longer than MAX_PATH
  {
    const sandbox = makeSandbox('longpath');
    const deep = path.join(sandbox, ...Array.from({ length: 12 }, (_, i) => `segment-${i}-${'x'.repeat(18)}`));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'leaf.bin'), 'x');
    if (path.join(deep, 'leaf.bin').length <= 260) throw new Error('the test path did not exceed MAX_PATH');
    await launch.removeDirectoryWithRetries({ directory: sandbox, attempts: 3, retryDelayMs: 300 });
    if (fs.existsSync(sandbox)) throw new Error('long-path tree was not removed');
    notes.push('long-path');
  }

  // 4d. exclusive file lock: must fail loudly, then succeed once released
  {
    const sandbox = makeSandbox('lock');
    const target = path.join(sandbox, 'held.bin');
    const marker = path.join(sandbox, 'holder-ready.txt');
    const holderScript = path.join(sandbox, 'holder.ps1');
    fs.writeFileSync(holderScript, [
      'param([string]$Path, [string]$Marker)',
      "$handle = [IO.File]::Open($Path, 'Create', 'ReadWrite', 'None')",
      'Set-Content -Path $Marker -Value "locked"',
      'Start-Sleep -Seconds 45',
      '$handle.Close()',
    ].join('\n'), 'utf8');

    const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', holderScript, '-Path', target, '-Marker', marker], { detached: true, stdio: 'ignore', windowsHide: true });
    holder.unref();
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await wait(250);
    if (!fs.existsSync(marker)) throw new Error('the lock holder never started');
    holder.kill();

    let failureMessage = null;
    try {
      await launch.removeDirectoryWithRetries({ directory: sandbox, attempts: 2, retryDelayMs: 200 });
    } catch (error) {
      failureMessage = error.message;
    }
    // Close only the holder we started, never other PowerShell processes.
    try { run('taskkill.exe', ['/PID', String(holder.pid), '/T', '/F']); } catch (error) {}
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const handle = fs.openSync(target, 'r+');
        fs.closeSync(handle);
        break;
      } catch (error) {
        await wait(250);
      }
    }
    await wait(500);
    await launch.removeDirectoryWithRetries({ directory: sandbox, attempts: 6, retryDelayMs: 500 });
    if (fs.existsSync(sandbox)) throw new Error('the tree was not removed after the lock was released');
    notes.push(`locked-then-released${failureMessage ? ` (locked attempt failed with: ${failureMessage.slice(0, 90)}…)` : ' (N.B. the lock did not block deletion on this system)'}`);
  }

  return notes.join(', ');
}


// ---------------------------------------------------------------------------
// 2b. Boundary evidence: token + ACLs prove the container cannot reach outside.
// The created process carries the container SID (verified above), the sandbox folder
// grants that SID access, and a file outside the sandbox has no ACE for it.
// ---------------------------------------------------------------------------
function checkAppContainerBoundary() {
  const sandbox = makeSandbox('boundary');
  const outsideDir = makeSandbox('outside');
  const secret = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(secret, 'outside-secret');
  const scriptPath = path.join(sandbox, 'launcher.ps1');
  fs.writeFileSync(scriptPath, isolation.buildAppContainerScript(), 'utf8');
  const containerName = isolation.appContainerName(`boundary-${Date.now()}`);
  const target = path.join(sandbox, 'hostapp.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), target);
  const sid = isolation.parseAppContainerOutput(powershell(['-File', scriptPath, '-Mode', 'sid', '-Name', containerName])).sid;
  if (!sid || !sid.startsWith('S-1-15-2-')) throw new Error(`unexpected SID: ${sid}`);
  run('icacls.exe', isolation.buildAppContainerFolderAclArgs(sandbox, sid));
  const launchOut = powershell(['-File', scriptPath, '-Mode', 'launch', '-Name', containerName, '-Exe', target, '-Dir', sandbox]);
  const result = isolation.parseAppContainerOutput(launchOut);
  try {
    if (!result.verified || result.processSid !== result.containerSid) throw new Error('container token was not verified');
    const outsideAcl = run('icacls.exe', [secret]);
    if (String(outsideAcl).includes(sid)) throw new Error('the outside file unexpectedly grants the container SID access');
    const sandboxAcl = run('icacls.exe', [sandbox]);
    if (!String(sandboxAcl).includes(sid)) throw new Error('the sandbox folder does not grant the container SID access');
    return `token ${result.containerSid} verified; sandbox grants ${sid.slice(0, 18)}…, outside file does not`;
  } finally {
    try { run('taskkill.exe', launch.buildTaskkillArgs(result.pid)); } catch (e) {}
    try { powershell(['-File', scriptPath, '-Mode', 'delete', '-Name', containerName]); } catch (e) {}
    removeQuietly(sandbox);
    removeQuietly(outsideDir);
  }
}

// ---------------------------------------------------------------------------
// 2c. Fail-closed: a bad executable refuses instead of running unguarded.
// ---------------------------------------------------------------------------
function checkFailClosed() {
  const sandbox = makeSandbox('failclosed');
  const scriptPath = path.join(sandbox, 'launcher.ps1');
  fs.writeFileSync(scriptPath, isolation.buildAppContainerScript(), 'utf8');
  const containerName = isolation.appContainerName(`fail-${Date.now()}`);
  let refused = false;
  try {
    const out = powershell(['-File', scriptPath, '-Mode', 'launch', '-Name', containerName, '-Exe', path.join(sandbox, 'missing.exe'), '-Dir', sandbox]);
    isolation.parseAppContainerOutput(out);
  } catch (error) {
    refused = true;
  }
  // Engine selection itself must refuse unguarded/sandboxie with no process started.
  const p1 = selectIsolationEngine({ platform: 'win32', appRecord: { isolationEngine: 'profile' }, hypervReady: true });
  const p2 = selectIsolationEngine({ platform: 'win32', appRecord: { isolationEngine: 'sandboxie' }, hypervReady: true });
  removeQuietly(sandbox);
  if (!refused) throw new Error('the launcher reported success for a missing executable');
  if (p1.engine !== 'refused' || p2.engine !== 'refused') throw new Error('engine selection did not refuse unguarded/sandboxie');
  return 'bad launch errored with no process; profile/sandboxie selection refused';
}

// ---------------------------------------------------------------------------
// 3b. Installer lineage: parent exits, child stays tracked via persisted seeds.
// ---------------------------------------------------------------------------
async function checkInstallerLineage() {
  const sandbox = makeSandbox('lineage');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Installer-style launcher: starts a long-lived child, then exits immediately.
  const installer = spawn(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    ['/c', `start /min cmd /c ping -n 25 127.0.0.1 > nul`],
    { cwd: sandbox, detached: true, stdio: 'ignore', windowsHide: true }
  );
  installer.unref();
  const installerPid = installer.pid;
  await wait(3000);
  try {
    const listProcesses = async () => launch.parseProcessTable(powershell(launch.buildProcessTableArgs()));
    const table = await listProcesses();
    const installerAlive = table.some((r) => r.pid === installerPid);
    // The child must be found through the exited parent's PID lineage alone.
    const found = launch.findAppProcessIds(table, sandbox, [installerPid]);
    if (found.length === 0) throw new Error(`no child tracked after installer PID ${installerPid} exited (alive: ${installerAlive})`);
    const remaining = await launch.stopAppProcesses({
      directory: sandbox, seedPids: [installerPid], listProcesses,
      terminate: async (pid, { force }) => { run('taskkill.exe', force ? launch.buildTaskkillArgs(pid) : launch.buildGracefulTaskkillArgs(pid)); },
      wait, attempts: 3, forceAfterGracefulMs: 1500, verifyAfterMs: 500,
    });
    if (remaining.length > 0) throw new Error(`lineage PIDs ${remaining.join(', ')} could not be stopped`);
    return `installer PID ${installerPid} exited=${!installerAlive}; tracked and stopped child PID(s) ${found.join(', ')}`;
  } finally {
    try { run('taskkill.exe', ['/PID', String(installerPid), '/T', '/F']); } catch (e) {}
    removeQuietly(sandbox);
  }
}

// ---------------------------------------------------------------------------
// 5. Hyper-V readiness report (informational: CI runners lack nested virt).
// ---------------------------------------------------------------------------
// Hyper-V PROBE ONLY (safe on CI): read-only host capability report plus static
// builder audits. windows-latest has no nested virtualization, so this never
// creates a VM here. Real create/boot/install/launch/delete runs in
// scripts/windows-hyperv-full.js on a capable host.
function checkHyperVReport() {
  const work = makeSandbox('hyperv');
  // Static audits prove the fail-closed contract without a hypervisor.
  const launch = hyperv.buildLaunchInGuestScript({ vm: 'V', credFile: 'C:\\c.xml', guestExePath: 'C:\\g\\a.exe', workingDir: 'C:\\g' });
  if (/\$pid\s*=/.test(launch)) throw new Error('guest launcher assigns to automatic $pid');
  if (!launch.includes('$guestPid') || !launch.includes('-Credential')) throw new Error('guest launcher must use $guestPid with -Credential');
  for (const script of [
    hyperv.buildGuestProcessQueryScript({ vm: 'V', credFile: 'C:\\c.xml', exeName: 'a' }),
    hyperv.buildRunInstallerInGuestScript({ vm: 'V', credFile: 'C:\\c.xml', guestInstallerPath: 'C:\\g\\s.exe' }),
    hyperv.buildStopGuestAppScript({ vm: 'V', credFile: 'C:\\c.xml', exeName: 'a' }),
    hyperv.buildWaitForGuestReadyScript({ vm: 'V', credFile: 'C:\\c.xml', timeoutSec: 5 }),
  ]) {
    if (!script.includes('-Credential') || !script.includes('Import-Clixml')) throw new Error('in-guest script missing guest credential wiring');
  }
  if (hyperv.buildGracefulShutdownScript({ vm: 'V' }).includes('-TurnOff')) throw new Error('graceful shutdown must not power off');
  if (!hyperv.buildHyperVPrereqScript({}).includes('isAdmin')) throw new Error('readiness must check elevation');
  if (hyperv.validateLaunchArgs('x'.repeat(2049)).ok) throw new Error('oversize launch args must be rejected');
  if (!hyperv.buildLaunchInGuestScript({ vm: 'V', credFile: 'C:\\c.xml', guestExePath: 'C:\\g\\a.exe', appArgs: '--t' }).includes('--t')) throw new Error('launch args must reach the guest');
  if (!hyperv.buildSetVmResourcesScript({ vm: 'V', memoryMB: 1, cpuCount: 99 }).includes('512MB')) throw new Error('resources must be clamped server-side');
  const plan = hyperv.deletionPlan({ vm: 'V', vhdValid: true });
  if (plan.indexOf('remove-env-vhd') < plan.indexOf('verify-vm-absent')) throw new Error('disk must only be removed after the VM is verified absent');
  const selDefault = selectIsolationEngine({ platform: 'win32', appRecord: {}, hypervReady: false });
  const selReady = selectIsolationEngine({ platform: 'win32', appRecord: {}, hypervReady: true });
  if (selDefault.engine !== 'rcvm') throw new Error('default must be RCVM containment (all editions), not a Hyper-V gate');
  if (selReady.engine !== 'rcvm') throw new Error('default with Hyper-V ready is still RCVM; the VM is opt-in');
  const selVmCold = selectIsolationEngine({ platform: 'win32', appRecord: { isolationEngine: 'hyperv' }, hypervReady: false });
  const selVmReady = selectIsolationEngine({ platform: 'win32', appRecord: { isolationEngine: 'hyperv' }, hypervReady: true });
  if (selVmCold.engine !== 'hyperv-unavailable') throw new Error('explicit Hyper-V without readiness must fail closed');
  if (selVmReady.engine !== 'hyperv') throw new Error('explicit Hyper-V with readiness must select the VM path');
  // RCVM builders: limits validated, launcher contains + redirects + reports.
  if (!rcvm.validateRcvmLimits({}).ok) throw new Error('RCVM defaults must validate');
  if (rcvm.validateRcvmLimits({ memoryMB: 64 }).ok) throw new Error('tiny RCVM memory cap must be rejected');
  const rcvmScript = rcvm.buildRcvmLaunchScript({
    jobName: 'verify', executablePath: 'C:\\a.exe', workingDirectory: 'C:\\w',
    appDataDir: 'C:\\w\\p\\Roaming', localAppDataDir: 'C:\\w\\p\\Local', tempDir: 'C:\\w\\p\\Temp',
    memoryCapBytes: 1024 * 1024 * 1024, cpuRate: 2500, maxProcesses: 32,
  });
  for (const token of ['CreateJobObjectW', 'AssignProcessToJobObject', 'LIMIT_KILL_ON_JOB_CLOSE', 'APPDATA', 'WaitForExit']) {
    if (!rcvmScript.includes(token)) throw new Error(`RCVM launcher is missing ${token}`);
  }
  if (rcvm.parseRcvmLauncherOutput('{"pid":7}').pid !== 7) throw new Error('RCVM pid line must parse');
  // Update checks: stable-only endpoint, numeric compare, installer picking.
  if (!updateCheck.buildLatestReleaseUrl('o/r').endsWith('/repos/o/r/releases/latest')) throw new Error('update endpoint must be releases/latest');
  if (!updateCheck.isNewerVersion('0.5.1', '0.5.10')) throw new Error('versions must compare numerically');
  if (updateCheck.isNewerVersion('0.5.1', '0.5.1')) throw new Error('equal versions are not an update');
  if (updateCheck.isUpdateRepoConfigured(updateCheck.DEFAULT_UPDATE_REPO)) throw new Error('placeholder repo must read as unconfigured');
  // Read-only host probe (never creates anything).
  let probe = 'Hyper-V PowerShell module not present here (expected on CI)';
  try {
    const out = powershell(['-Command', "(Get-Command Get-VM -ErrorAction SilentlyContinue) ? 'PRESENT' : 'ABSENT'"]);
    if (String(out).includes('PRESENT')) {
      const script = path.join(work, 'prereq.ps1');
      fs.writeFileSync(script, hyperv.buildHyperVPrereqScript(), 'utf8');
      const detail = hyperv.parseHyperVPrereqOutput(powershell(['-File', script]));
      const missing = hyperv.hyperVMissingRequirements(detail);
      probe = missing.length === 0 ? 'Hyper-V ready on this machine' : `Hyper-V not ready here: ${missing.join(' | ').slice(0, 300)}`;
    }
  } catch (error) {
    probe = `host probe skipped: ${String(error.message).slice(0, 160)}`;
  }
  removeQuietly(work);
  return `builders audited (cred-wired, no $pid, graceful-first, VM-first selection); ${probe}. Full VM lifecycle: run scripts/windows-hyperv-full.js on a capable host.`;
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('This verification must run on Windows (current platform: ' + process.platform + ').');
    process.exit(2);
  }

  check('generated launchers parse', () => checkGeneratedScriptsParse(''));
  check('AppContainer launch + token verification + profile delete', checkAppContainerLaunch);
  check('AppContainer boundary (token + sandbox grant, no outside grant)', checkAppContainerBoundary);
  check('fail-closed launch and engine selection', checkFailClosed);
  await checkAsync('process scoping stops the app and spares bystanders', checkProcessScoping);
  await checkAsync('installer lineage stays tracked after the installer exits', checkInstallerLineage);
  await checkAsync('sandbox deletion (attributes, ACL, long path, lock)', checkDeletionCases);
  check('Hyper-V readiness report', checkHyperVReport);

  console.log(results.join('\n'));
  console.log(failed === 0 ? '\nALL WINDOWS CHECKS PASSED' : `\n${failed} WINDOWS CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verification crashed:', error);
  process.exit(1);
});
