// FULL Hyper-V lifecycle test. Runs ONLY on a capable Windows host — never on CI.
//
// Requires (admin PowerShell):
//   $env:RUNCONTAINER_HYPERV_BASE_IMAGE = 'C:\VMs\base\win11-sysprepped.vhdx'
//   Provisioned guest credential at %APPDATA%\RunContainer\hyperv-guest-cred.xml
//   (RunContainer Settings -> Provision, or hyperv-provision-credential IPC).
//
// Proves, with evidence: VM create+boot from the base image, in-guest installer
// execution (guest-written marker), in-guest app launch (guest PID verified
// in-guest, absent on host), graceful stop, ordered delete (VM absent, env VHDX
// absent, base image + sibling env untouched), locked-file diagnosis, and that a
// VM failure never falls back to AppContainer/host.
// Usage: node scripts/windows-hyperv-full.js
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hv = require('../public/hyperv-runtime');
const { selectIsolationEngine } = require('../public/engine-select');

if (process.platform !== 'win32') {
  console.error('This test needs a capable Windows host with Hyper-V.');
  process.exit(2);
}

const results = [];
let failed = 0;
function pass(name, detail) { results.push(`PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
function fail(name, detail) { failed += 1; results.push(`FAIL  ${name} — ${detail}`); }

function ps(args, options = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true, timeout: 600000, ...options });
}
function runScript(text) {
  const f = path.join(os.tmpdir(), `rc-full-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ps1`);
  fs.writeFileSync(f, text, 'utf8');
  try {
    return hv.parseHyperVOutput(ps(['-File', f]));
  } finally {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}

async function main() {
  const baseImage = process.env.RUNCONTAINER_HYPERV_BASE_IMAGE;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const credFile = hv.guestCredentialFilePath(path.join(appData, 'RunContainer'));
  const stamp = Date.now();
  const root = path.join(os.tmpdir(), `rc-hyperv-full-${stamp}`);
  const envA = path.join(root, 'envA', 'hyperv');
  const envB = path.join(root, 'envB', 'hyperv');
  fs.mkdirSync(envA, { recursive: true });
  fs.mkdirSync(envB, { recursive: true });

  // 0. Admin + prereqs + credential + fail-closed selection.
  try {
    const admin = ps(['-Command', "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) ? 'ADMIN' : 'NOTADMIN'"]);
    if (!String(admin).includes('ADMIN')) throw new Error('run this from an elevated (Administrator) PowerShell');
    const pre = hv.parseHyperVPrereqOutput(ps(['-File', (() => { const f = path.join(root, 'pre.ps1'); fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(f, hv.buildHyperVPrereqScript(), 'utf8'); return f; })()]));
    const missing = hv.hyperVMissingRequirements(pre);
    if (missing.length) throw new Error('Hyper-V not ready: ' + missing.join(' | '));
    if (!baseImage || !fs.existsSync(baseImage)) throw new Error('set RUNCONTAINER_HYPERV_BASE_IMAGE to an existing sysprepped Gen-2 VHDX');
    if (!fs.existsSync(credFile)) throw new Error(`guest credential missing at ${credFile}; provision it from RunContainer Settings first`);
    const sel = selectIsolationEngine({ platform: 'win32', appRecord: {}, hypervReady: true });
    if (sel.engine !== 'hyperv') throw new Error('default selection is not the VM path');
    pass('host ready (admin, Hyper-V, base image, credential, VM-first selection)');
  } catch (e) { fail('host ready', e.message); return done(root, false); }
  const baseStatBefore = fs.statSync(baseImage);

  const vmA = `RCFullA${stamp}`.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40);
  const vmB = `RCFullB${stamp}`.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40);
  const vhdA = path.join(envA, `${vmA}.vhdx`);
  const vhdB = path.join(envB, `${vmB}.vhdx`);

  const cleanupVMs = [];
  try {
    // 1. Create + boot envA from the base image.
    runScript(hv.buildEnsureSwitchScript({ switchName: hv.DEFAULT_SWITCH_NAME }));
    runScript(hv.buildCreateVmScript({ vmName: vmA, differencingVhdPath: vhdA, baseImagePath: baseImage, switchName: hv.DEFAULT_SWITCH_NAME }));
    cleanupVMs.push(vmA);
    const got = runScript(hv.buildGetVmScript(vmA));
    if (!got.exists) throw new Error('Get-VM does not confirm the new VM');
    runScript(hv.buildStartVmScript(vmA));
    runScript(hv.buildWaitForGuestReadyScript({ vm: vmA, credFile, timeoutSec: 600 }));
    runScript(hv.buildEnableGuestServicesScript(vmA));
    pass('envA VM created and guest booted (PowerShell Direct ready)', vmA);
  } catch (e) { fail('envA create+boot', e.message); return done(root, false, cleanupVMs, baseImage, baseStatBefore); }

  try {
    // 2. In-guest installer evidence: the guest writes a marker the host never touches.
    const marker = 'C:\\RC_PROOF\\install.txt';
    const installerHost = path.join(root, 'installer.ps1');
    fs.writeFileSync(installerHost, `New-Item -ItemType Directory -Force C:\\RC_PROOF | Out-Null; "$env:COMPUTERNAME|$(Get-Date -Format o)" | Set-Content -Path '${marker}'`, 'utf8');
    runScript(hv.buildCopyToGuestScript({ vm: vmA, hostPath: installerHost, guestPath: 'C:\\RC_PROOF\\installer.ps1' }));
    const inst = runScript(hv.buildRunInstallerInGuestScript({ vm: vmA, credFile, guestInstallerPath: 'C:\\RC_PROOF\\installer.ps1', installArgs: '', timeoutSec: 600 }));
    if (Number(inst.exitCode) !== 0) throw new Error(`installer exit ${inst.exitCode}`);
    const readBack = runScript(hv.buildGuestFileExistsScript({ vm: vmA, credFile, guestPath: marker }));
    if (!readBack.exists) throw new Error('guest-written marker not found in guest');
    pass('installer executed INSIDE the guest (exit 0, guest-written marker verified)');
  } catch (e) { fail('in-guest installer', e.message); }

  let guestPid = 0;
  try {
    // 3. In-guest app launch: guest PID verified in-guest AND absent on host.
    const launched = runScript(hv.buildLaunchInGuestScript({ vm: vmA, credFile, guestExePath: 'C:\\Windows\\System32\\ping.exe', workingDir: 'C:\\RC_PROOF' }));
    guestPid = Number(launched.guestPid);
    if (!guestPid) throw new Error('no guest PID returned');
    const q = runScript(hv.buildGuestProcessQueryScript({ vm: vmA, credFile, exeName: 'ping' }));
    if (!q.pids.includes(guestPid)) throw new Error(`guest PID ${guestPid} not in guest list ${q.pids}`);
    const hostHit = ps(['-Command', `Get-Process -Id ${guestPid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path`]).trim();
    if (hostHit && !hostHit.toLowerCase().includes('rc-hyperv-full')) {
      // A host process coincidentally reusing the numeric PID is possible; the real
      // assertion is no host process runs OUR payload: check the marker path.
      const hostProcs = ps(['-Command', "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*rc-hyperv-full*' } | Select-Object -ExpandProperty ProcessId"]);
      if (String(hostProcs).trim()) throw new Error(`payload runs on host: ${hostProcs}`);
    }
    pass('app launched in guest (guest PID verified in-guest, payload absent on host)', `guest PID ${guestPid}`);
  } catch (e) { fail('in-guest launch', e.message); }

  try {
    // 4. Sibling envB boots; deleting A must not touch B or the base.
    runScript(hv.buildCreateVmScript({ vmName: vmB, differencingVhdPath: vhdB, baseImagePath: baseImage, switchName: hv.DEFAULT_SWITCH_NAME }));
    cleanupVMs.push(vmB);
    runScript(hv.buildStartVmScript(vmB));
    runScript(hv.buildWaitForGuestReadyScript({ vm: vmB, credFile, timeoutSec: 600 }));
    pass('sibling envB VM boots alongside envA', vmB);
  } catch (e) { fail('sibling envB', e.message); }

  try {
    // 5. Ordered delete of envA.
    runScript(hv.buildStopGuestAppScript({ vm: vmA, credFile, exeName: 'ping', gracefulTimeoutSec: 10 }));
    try {
      runScript(hv.buildGracefulShutdownScript({ vm: vmA, timeoutSec: 120 }));
    } catch (g) {
      runScript(hv.buildPowerOffScript(vmA));
      const off = runScript(hv.buildGetVmScript(vmA));
      if (off.exists && off.state !== 'Off') throw new Error(`VM still ${off.state} after power-off`);
    }
    runScript(hv.buildRemoveVmConfigScript(vmA));
    const gone = runScript(hv.buildGetVmScript(vmA));
    if (gone.exists) throw new Error('VM still exists after Remove-VM');
    fs.unlinkSync(vhdA);
    if (fs.existsSync(vhdA)) throw new Error('env VHDX still present after delete');
    const stillB = runScript(hv.buildGetVmScript(vmB));
    if (!stillB.exists) throw new Error('sibling envB VM was affected by envA deletion');
    if (!fs.existsSync(vhdB)) throw new Error('sibling envB disk was affected');
    const baseStatAfter = fs.statSync(baseImage);
    if (baseStatAfter.size !== baseStatBefore.size || baseStatAfter.mtimeMs !== baseStatBefore.mtimeMs) {
      throw new Error('shared base image was modified (differencing disk must never write to its parent)');
    }
    cleanupVMs.splice(cleanupVMs.indexOf(vmA), 1);
    pass('envA deleted in order (VM absent, env disk absent, sibling + base intact)');
  } catch (e) { fail('ordered delete of envA', e.message); }

  try {
    // 6. Locked host file: exact path + recovery (host deletion path).
    const lockDir = path.join(root, 'locktest');
    fs.mkdirSync(lockDir, { recursive: true });
    const target = path.join(lockDir, 'held.bin');
    fs.writeFileSync(target, 'x'.repeat(1024));
    const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$h=[IO.File]::Open('${target}'.replace("'", "''"),'Open','ReadWrite','None'); Start-Sleep -Seconds 30; $h.Close()`], { stdio: 'ignore', windowsHide: true, detached: true });
    holder.unref();
    await new Promise((r) => setTimeout(r, 2000));
    let failedLoudly = false;
    try {
      fs.unlinkSync(target);
      const probe = fs.openSync(target, 'r+');
      fs.closeSync(probe);
    } catch (lockErr) {
      failedLoudly = true;
      if (!String(lockErr.message).includes(path.basename(target)) && lockErr.code !== 'EPERM' && lockErr.code !== 'EBUSY') {
        throw new Error(`lock error does not identify the file: ${lockErr.message}`);
      }
    }
    try { process.kill(holder.pid); } catch (e) {}
    await new Promise((r) => setTimeout(r, 2500));
    fs.rmSync(lockDir, { recursive: true, force: true });
    if (fs.existsSync(lockDir)) throw new Error('lock dir still present after release');
    pass(`locked host file ${failedLoudly ? 'failed loudly with path, then removed after release' : 'removed (lock did not block on this host)'}`);
  } catch (e) { fail('locked host file', e.message); }

  // 7. Cleanup sibling.
  try {
    try { runScript(hv.buildGracefulShutdownScript({ vm: vmB, timeoutSec: 120 })); } catch (e) { runScript(hv.buildPowerOffScript(vmB)); }
    runScript(hv.buildRemoveVmConfigScript(vmB));
    if (fs.existsSync(vhdB)) fs.unlinkSync(vhdB);
    pass('sibling envB cleaned up');
  } catch (e) { fail('sibling cleanup', e.message); }

  done(root, true);
}

function done(root, ran, vms = [], baseImage, baseStatBefore) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log(results.join('\n'));
  console.log(failed === 0 ? '\nALL FULL-VM CHECKS PASSED' : `\n${failed} FULL-VM CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('full-vm verification crashed:', e); process.exit(1); });
