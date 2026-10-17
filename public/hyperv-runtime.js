// Hyper-V virtual-machine isolation backend.
// Architecture: AppContainer is a real token boundary but cannot run arbitrary
// installers. Full VM isolation is required for arbitrary desktop software.
// This module only builds and parses text so it can be unit tested off Windows.
const path = require('path');
const crypto = require('crypto');

const RESULT_PREFIX = 'RCHYPERV ';
const DEFAULT_SWITCH_NAME = 'RunContainer-NAT';
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_CPU_COUNT = 2;

function sanitizeVmNamePart(value) {
  return String(value || 'app').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'app';
}

function vmName(appId) {
  return `RunContainer-${sanitizeVmNamePart(appId)}`;
}

function vmFileNames(appId, baseDir) {
  const name = vmName(appId);
  return {
    vmName: name,
    differencingVhdPath: path.win32.join(baseDir, `${name}.vhdx`),
    switchName: DEFAULT_SWITCH_NAME,
  };
}

function isHyperVSupported(platform = process.platform) {
  return platform === 'win32';
}

// Reports host readiness. Runs on Windows via powershell; parsing is pure.
function buildHyperVPrereqScript() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$feat = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue).State",
    "$svc = (Get-Service vmms -ErrorAction SilentlyContinue).Status",
    "$cs = Get-ComputerInfo -Property HyperHypervisorPresent, HyperVRequirementVirtualizationFirmwareEnabled, WindowsProductName, OsHardwareAbstractionLayer -ErrorAction SilentlyContinue",
    "$out = @{ feature = $feat; service = \"$svc\"; hypervisorPresent = [bool]$cs.HyperHypervisorPresent; firmwareOk = [bool]$cs.HyperVRequirementVirtualizationFirmwareEnabled; product = \"$($cs.WindowsProductName)\" }",
    `Write-Output ('${RESULT_PREFIX}' + ($out | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function parseHyperVPrereqOutput(stdout) {
  const text = String(stdout || '');
  const line = text.split(/\r?\n/).reverse().find((e) => e.startsWith(RESULT_PREFIX));
  if (!line) throw new Error('The Hyper-V check did not return a result.');
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch (e) {
    throw new Error('The Hyper-V check returned an unreadable result.');
  }
}

function hyperVMissingRequirements(prereq) {
  const missing = [];
  if (!prereq) return ['Hyper-V readiness could not be determined.'];
  if (String(prereq.feature) !== 'Enabled') missing.push('Enable Hyper-V: DISM /Online /Enable-Feature /All /FeatureName:Microsoft-Hyper-V (Windows 10/11 Pro, Enterprise, or Education; Home edition has no Hyper-V).');
  if (!prereq.hypervisorPresent) missing.push('Enable virtualization in firmware (Intel VT-x / AMD-V) and ensure the Hyper-V hypervisor is running.');
  if (String(prereq.service) !== 'Running' && String(prereq.service) !== 'Running ') missing.push('Start the Hyper-V Virtual Machine Management service (vmms).');
  const product = String(prereq.product || '');
  if (/home/i.test(product)) missing.push(`This Windows edition (${product}) does not include Hyper-V; upgrade to Pro/Enterprise/Education for VM isolation.`);
  return missing;
}

function describeHyperVMissing(missing) {
  return `VM isolation requires Hyper-V, which is not ready: ${missing.join(' ')} Nothing was launched. Your data was not touched.`;
}

// PowerShell scripts for VM lifecycle. Host executes these; builders are pure.
function buildCreateVmScript({ vmName: name, differencingVhdPath, baseImagePath, switchName, memoryMB = DEFAULT_MEMORY_MB, cpuCount = DEFAULT_CPU_COUNT }) {
  const esc = (s) => String(s).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `New-VHD -ParentPath '${esc(baseImagePath)}' -Path '${esc(differencingVhdPath)}' -Differencing | Out-Null`,
    `New-VM -Name '${esc(name)}' -MemoryStartupBytes (${memoryMB}MB) -VHDPath '${esc(differencingVhdPath)}' -SwitchName '${esc(switchName)}' -Generation 2 | Out-Null`,
    `Set-VM -Name '${esc(name)}' -ProcessorCount ${cpuCount} -AutomaticCheckpointsEnabled $false | Out-Null`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ created = $true; vm = '${esc(name)}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildStartVmScript(vm) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Start-VM -Name '${esc}'`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ started = $true; vm = '${esc}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildStopVmScript(vm) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Stop-VM -Name '${esc}' -TurnOff -Force -ErrorAction SilentlyContinue`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ stopped = $true; vm = '${esc}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildRemoveVmScript({ vm, vhdPath }) {
  const e1 = String(vm).replace(/'/g, "''");
  const e2 = String(vhdPath).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Stop-VM -Name '${e1}' -TurnOff -Force -ErrorAction SilentlyContinue`,
    `Remove-VM -Name '${e1}' -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath '${e2}' -Force -ErrorAction SilentlyContinue`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ removed = $true; vm = '${e1}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Copy installer into guest and execute it there via PowerShell Direct.
// Requires guest Windows 10+ with PowerShell Direct, host admin, VM running.
function buildInstallInGuestScript({ vm, hostInstallerPath, guestInstallerPath, installArgs = '' }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eHost = String(hostInstallerPath).replace(/'/g, "''");
  const eGuest = String(guestInstallerPath).replace(/'/g, "''");
  const eArgs = String(installArgs).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Copy-VMFile -Name '${eVm}' -SourcePath '${eHost}' -DestinationPath '${eGuest}' -CreateFullPath -FileSource Host -Force`,
    `$sb = { param($p, $a) Start-Process -FilePath $p -ArgumentList $a -Wait -PassThru | Select-Object -ExpandProperty ExitCode }`,
    `$code = Invoke-Command -VMName '${eVm}' -ScriptBlock $sb -ArgumentList '${eGuest}', '${eArgs}'`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ installed = $true; exitCode = $code; vm = '${eVm}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildLaunchInGuestScript({ vm, guestExePath, workingDir = '' }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eExe = String(guestExePath).replace(/'/g, "''");
  const eDir = String(workingDir).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$sb = { param($e, $d) $p = Start-Process -FilePath $e ${workingDir ? "-WorkingDirectory $d" : ''} -PassThru; $p.Id }`,
    `$pid = Invoke-Command -VMName '${eVm}' -ScriptBlock $sb -ArgumentList '${eExe}', '${eDir}'`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ guestPid = $pid; vm = '${eVm}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildGuestProcessQueryScript({ vm, exeName }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eExe = String(exeName).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$sb = { param($n) Get-Process -Name $n -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id }`,
    `$pids = Invoke-Command -VMName '${eVm}' -ScriptBlock $sb -ArgumentList '${eExe}'`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ pids = @($pids) } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function parseHyperVOutput(stdout) {
  const text = String(stdout || '');
  const line = text.split(/\r?\n/).reverse().find((e) => e.startsWith(RESULT_PREFIX));
  if (!line) throw new Error('The Hyper-V operation did not return a result.');
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch (e) {
    throw new Error('The Hyper-V operation returned an unreadable result.');
  }
}

function guestExePathForApp(vmDriveRoot, appId, exeBaseName) {
  return path.win32.join(vmDriveRoot, vmName(appId), exeBaseName);
}

module.exports = {
  RESULT_PREFIX,
  DEFAULT_SWITCH_NAME,
  DEFAULT_MEMORY_MB,
  DEFAULT_CPU_COUNT,
  vmName,
  vmFileNames,
  isHyperVSupported,
  buildHyperVPrereqScript,
  parseHyperVPrereqOutput,
  hyperVMissingRequirements,
  describeHyperVMissing,
  buildCreateVmScript,
  buildStartVmScript,
  buildStopVmScript,
  buildRemoveVmScript,
  buildInstallInGuestScript,
  buildLaunchInGuestScript,
  buildGuestProcessQueryScript,
  parseHyperVOutput,
  guestExePathForApp,
};
