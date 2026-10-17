// Hyper-V virtual-machine isolation backend.
//
// Genuine VM isolation: each environment gets its own guest VM with a
// differencing VHDX backed by a shared base image. The installer and the app
// execute inside the guest OS via PowerShell Direct; the host only manages
// the VM. This module only builds and parses text so it can be unit tested
// off Windows.
//
// Corrected against Microsoft docs:
// - New-VM -SwitchName requires an EXISTING switch (see buildEnsureSwitchScript).
// - Copy-VMFile needs the 'Guest Service Interface' integration service.
// - Invoke-Command -VMName (PowerShell Direct) needs guest -Credential,
//   loaded from a DPAPI-encrypted file created at provisioning time.
// - Never assign to $pid (automatic read-only); guest PID uses $guestPid.
// - Stop-VM alone = graceful shutdown; -TurnOff = power cut (escalation only).
// - Remove-VM deletes config only, never disks; VHDX removal is separate and
//   verified, and the shared base image is never a deletion target.
const path = require('path');

const RESULT_PREFIX = 'RCHYPERV ';
const DEFAULT_SWITCH_NAME = 'RunContainer-NAT';
const DEFAULT_SWITCH_TYPE = 'Internal';
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_CPU_COUNT = 2;
const GUEST_FILE_COPY_SERVICE = 'Guest Service Interface';

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

// Differencing disk for this environment. The ONLY disk Delete may remove.
function envVhdPathForApp(envDir, appId) {
  return path.win32.join(path.win32.resolve(envDir), `${vmName(appId)}.vhdx`);
}

// True only when candidate is exactly this environment's differencing disk.
// Everything else (base image, other envs, bare drive roots) is refused.
function isEnvVhdPath(candidate, envDir, appId) {
  if (!candidate || !envDir || !appId) return false;
  try {
    const resolved = path.win32.resolve(candidate);
    const expected = path.win32.resolve(envVhdPathForApp(envDir, appId));
    if (resolved.toLowerCase() !== expected.toLowerCase()) return false;
    if (!resolved.toLowerCase().endsWith('.vhdx')) return false;
    return path.win32.basename(resolved).toLowerCase() === `${vmName(appId).toLowerCase()}.vhdx`;
  } catch (error) {
    return false;
  }
}

// Refuse to delete the shared base image or anything outside the environment.
function validateDeletionTarget({ candidate, envDir, baseImagePath }) {
  if (!candidate) return { ok: false, reason: 'No path was provided for deletion.' };
  try {
    const resolved = path.win32.resolve(candidate).toLowerCase();
    if (baseImagePath && resolved === path.win32.resolve(baseImagePath).toLowerCase()) {
      return { ok: false, reason: 'Refusing to delete the shared base image. Only per-environment differencing disks may be removed.' };
    }
    if (envDir) {
      const scope = `${path.win32.resolve(envDir).toLowerCase()}${path.win32.sep}`;
      if (resolved !== scope.slice(0, -1) && !resolved.startsWith(scope)) {
        return { ok: false, reason: 'Refusing to delete a path outside the target environment.' };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Could not validate the deletion target: ${error.message}` };
  }
}

function guestCredentialFilePath(hostDataDir) {
  return path.win32.join(path.win32.resolve(hostDataDir), 'hyperv-guest-cred.xml');
}

// Interactive, run once on the host during base-image provisioning. Stores the
// guest local-admin credential DPAPI-encrypted (same user, same host only).
function buildProvisionCredentialScript(credFile) {
  const esc = String(credFile).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$cred = Get-Credential -Message 'Guest Windows local administrator for RunContainer VMs'`,
    `Export-Clixml -InputObject $cred -Path '${esc}'`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ provisioned = $true } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function isHyperVSupported(platform = process.platform) {
  return platform === 'win32';
}

// Validates host readiness AND operator capacity: Hyper-V feature, vmms,
// hypervisor, edition, elevated admin (VM create/start needs it), and free disk
// on the drive that holds the environments (base copy + differencing growth).
function buildHyperVPrereqScript({ dataDir = '', requiredFreeGB = 40 } = {}) {
  const eDir = String(dataDir).replace(/'/g, "''");
  const needGB = Math.max(1, Number(requiredFreeGB) || 40);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$feat = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue).State",
    "$svc = (Get-Service vmms -ErrorAction SilentlyContinue).Status",
    "$cs = Get-ComputerInfo -Property HyperHypervisorPresent, HyperVRequirementVirtualizationFirmwareEnabled, WindowsProductName -ErrorAction SilentlyContinue",
    "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ...(eDir
      ? [
          `$drv = (Split-Path -Qualifier '${eDir}')`,
          `$freeGB = 0; try { $freeGB = [math]::Round((Get-PSDrive ($drv.TrimEnd(':')) -ErrorAction Stop).Free / 1GB, 1) } catch {}`,
        ]
      : [`$freeGB = 0`]),
    `$out = @{ feature = $feat; service = "$svc"; hypervisorPresent = [bool]$cs.HyperHypervisorPresent; firmwareOk = [bool]$cs.HyperVRequirementVirtualizationFirmwareEnabled; product = "$($cs.WindowsProductName)"; isAdmin = [bool]$admin; freeGB = $freeGB; requiredFreeGB = ${needGB} }`,
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
  if (prereq.isAdmin === false) missing.push('RunContainer is not elevated: creating, starting, and deleting VMs requires Administrator. Restart RunContainer as administrator.');
  if (typeof prereq.freeGB === 'number' && typeof prereq.requiredFreeGB === 'number' && prereq.freeGB > 0 && prereq.freeGB < prereq.requiredFreeGB) {
    missing.push(`Only ${prereq.freeGB} GB free where environments live; at least ${prereq.requiredFreeGB} GB is required for the base copy and differencing-disk growth. Free disk space first.`);
  }
  return missing;
}

function describeHyperVMissing(missing) {
  return `VM isolation requires Hyper-V, which is not ready: ${missing.join(' ')} Nothing was launched. Your data was not touched.`;
}

// Idempotent: reuses the existing switch after validating its type.
function buildEnsureSwitchScript({ switchName = DEFAULT_SWITCH_NAME, switchType = DEFAULT_SWITCH_TYPE } = {}) {
  const eName = String(switchName).replace(/'/g, "''");
  const eType = String(switchType).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${eName}', [string]$Type = '${eType}')`,
    "$sw = Get-VMSwitch -Name $Name -ErrorAction SilentlyContinue",
    "if (-not $sw) { $sw = New-VMSwitch -Name $Name -SwitchType $Type }",
    "elseif ($sw.SwitchType -ne $Type) { throw \"Switch '$Name' exists with type '$($sw.SwitchType)', expected '$Type'.\" }",
    `Write-Output ('${RESULT_PREFIX}' + (@{ switch = $sw.Name; type = "$($sw.SwitchType)" } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Source of truth for whether the VM exists (filesystem checks are not).
function buildGetVmScript(vm) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${esc}')`,
    "$vm = Get-VM -Name $Name -ErrorAction SilentlyContinue",
    "if (-not $vm) {",
    `  Write-Output ('${RESULT_PREFIX}' + (@{ exists = $false } | ConvertTo-Json -Compress))`,
    "} else {",
    `  Write-Output ('${RESULT_PREFIX}' + (@{ exists = $true; state = "$($vm.State)"; status = "$($vm.Status)" } | ConvertTo-Json -Compress))`,
    "}",
  ].join('\n');
}

function buildEnableGuestServicesScript(vm) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${esc}')`,
    `$vm = Get-VM -Name $Name -ErrorAction Stop`,
    `Enable-VMIntegrationService -VM $vm -Name '${GUEST_FILE_COPY_SERVICE}' -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ fileCopyEnabled = $true } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildCreateVmScript({ vmName: name, differencingVhdPath, baseImagePath, switchName, memoryMB = DEFAULT_MEMORY_MB, cpuCount = DEFAULT_CPU_COUNT }) {
  const esc = (s) => String(s).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `New-VHD -ParentPath '${esc(baseImagePath)}' -Path '${esc(differencingVhdPath)}' -Differencing | Out-Null`,
    `New-VM -Name '${esc(name)}' -MemoryStartupBytes (${memoryMB}MB) -VHDPath '${esc(differencingVhdPath)}' -SwitchName '${esc(switchName)}' -Generation 2 | Out-Null`,
    `Set-VM -Name '${esc(name)}' -ProcessorCount ${cpuCount} -AutomaticCheckpointsEnabled $false | Out-Null`,
    `Enable-VMIntegrationService -VM (Get-VM -Name '${esc(name)}' -ErrorAction Stop) -Name '${GUEST_FILE_COPY_SERVICE}' -ErrorAction SilentlyContinue`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ created = $true; vm = '${esc(name)}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Re-attaches an orphaned environment disk (VHDX exists, VM config missing)
// without destroying the data on it.
function buildCreateVmFromExistingVhdScript({ vmName: name, existingVhdPath, switchName, memoryMB = DEFAULT_MEMORY_MB, cpuCount = DEFAULT_CPU_COUNT }) {
  const esc = (s) => String(s).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `New-VM -Name '${esc(name)}' -MemoryStartupBytes (${memoryMB}MB) -VHDPath '${esc(existingVhdPath)}' -SwitchName '${esc(switchName)}' -Generation 2 | Out-Null`,
    `Set-VM -Name '${esc(name)}' -ProcessorCount ${cpuCount} -AutomaticCheckpointsEnabled $false | Out-Null`,
    `Enable-VMIntegrationService -VM (Get-VM -Name '${esc(name)}' -ErrorAction Stop) -Name '${GUEST_FILE_COPY_SERVICE}' -ErrorAction SilentlyContinue`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ created = $true; reusedDisk = $true; vm = '${esc(name)}' } | ConvertTo-Json -Compress))`,
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

// Probes REAL guest readiness: an actual PowerShell Direct command with the
// guest credential, retried until timeout. Get-VM State 'Running' alone does
// not prove the guest OS is operational.
function buildWaitForGuestReadyScript({ vm, credFile, timeoutSec = 300, pollSec = 5 }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eCred = String(credFile).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${eVm}', [string]$CredFile = '${eCred}', [int]$TimeoutSec = ${Number(timeoutSec)}, [int]$PollSec = ${Number(pollSec)})`,
    "$cred = Import-Clixml -Path $CredFile -ErrorAction Stop",
    "$deadline = [datetime]::UtcNow.AddSeconds($TimeoutSec)",
    "$ready = $false",
    "while ([datetime]::UtcNow -lt $deadline) {",
    "  try {",
    "    Invoke-Command -VMName $Name -Credential $cred -ScriptBlock { $env:COMPUTERNAME } -ErrorAction Stop | Out-Null",
    "    $ready = $true",
    "    break",
    "  } catch { Start-Sleep -Seconds $PollSec }",
    "}",
    "if (-not $ready) { throw \"PowerShell Direct did not become ready within $TimeoutSec seconds. The guest may still be booting, its network/integration services may be off, or the stored guest credential may be wrong.\" }",
    `Write-Output ('${RESULT_PREFIX}' + (@{ ready = $true } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildCopyToGuestScript({ vm, hostPath, guestPath }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eHost = String(hostPath).replace(/'/g, "''");
  const eGuest = String(guestPath).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Copy-VMFile -Name '${eVm}' -SourcePath '${eHost}' -DestinationPath '${eGuest}' -CreateFullPath -FileSource Host -Force -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ copied = $true } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Runs the installer INSIDE the guest, waits for its real exit code.
function buildRunInstallerInGuestScript({ vm, credFile, guestInstallerPath, installArgs = '', timeoutSec = 1800 }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eGuest = String(guestInstallerPath).replace(/'/g, "''");
  const eArgs = String(installArgs).replace(/'/g, "''");
  const eCred = String(credFile).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${eVm}', [string]$CredFile = '${eCred}')`,
    "$cred = Import-Clixml -Path $CredFile -ErrorAction Stop",
    `$sb = { param($p, $a) $proc = Start-Process -FilePath $p -ArgumentList $a -Wait -PassThru; $proc.ExitCode }`,
    `$code = Invoke-Command -VMName $Name -Credential $cred -ScriptBlock $sb -ArgumentList '${eGuest}', '${eArgs}' -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ installed = $true; exitCode = $code } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Legacy combined copy+run (kept for compatibility; new code uses the split steps).
function buildInstallInGuestScript({ vm, credFile = '', hostInstallerPath, guestInstallerPath, installArgs = '' }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eHost = String(hostInstallerPath).replace(/'/g, "''");
  const eGuest = String(guestInstallerPath).replace(/'/g, "''");
  const eArgs = String(installArgs).replace(/'/g, "''");
  const eCred = String(credFile).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Copy-VMFile -Name '${eVm}' -SourcePath '${eHost}' -DestinationPath '${eGuest}' -CreateFullPath -FileSource Host -Force -ErrorAction Stop`,
    ...(eCred
      ? [
          `$cred = Import-Clixml -Path '${eCred}' -ErrorAction Stop`,
          `$sb = { param($p, $a) Start-Process -FilePath $p -ArgumentList $a -Wait -PassThru | Select-Object -ExpandProperty ExitCode }`,
          `$code = Invoke-Command -VMName '${eVm}' -Credential $cred -ScriptBlock $sb -ArgumentList '${eGuest}', '${eArgs}' -ErrorAction Stop`,
        ]
      : [
          `$sb = { param($p, $a) Start-Process -FilePath $p -ArgumentList $a -Wait -PassThru | Select-Object -ExpandProperty ExitCode }`,
          `$code = Invoke-Command -VMName '${eVm}' -ScriptBlock $sb -ArgumentList '${eGuest}', '${eArgs}' -ErrorAction Stop`,
        ]),
    `Write-Output ('${RESULT_PREFIX}' + (@{ installed = $true; exitCode = $code; vm = '${eVm}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Launches the app INSIDE the guest. $guestPid is used because $pid is a
// read-only automatic PowerShell variable and assignment to it fails.
// appArgs is a single validated argument string (may be empty).
function buildLaunchInGuestScript({ vm, credFile = '', guestExePath, workingDir = '', appArgs = '' }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eExe = String(guestExePath).replace(/'/g, "''");
  const eDir = String(workingDir).replace(/'/g, "''");
  const eArgs = String(appArgs || '').replace(/'/g, "''");
  const eCred = String(credFile).replace(/'/g, "''");
  const credDecl = eCred ? `$cred = Import-Clixml -Path '${eCred}' -ErrorAction Stop; ` : '';
  const credArg = eCred ? '-Credential $cred ' : '';
  return [
    "$ErrorActionPreference = 'Stop'",
    ...(workingDir
      ? [`$sb = { param($e, $d, $a) $p = Start-Process -FilePath $e -WorkingDirectory $d -ArgumentList $a -PassThru; $p.Id }`]
      : [`$sb = { param($e, $d, $a) $p = Start-Process -FilePath $e -ArgumentList $a -PassThru; $p.Id }`]),
    `${credDecl}$guestPid = Invoke-Command -VMName '${eVm}' ${credArg}-ScriptBlock $sb -ArgumentList '${eExe}', '${eDir}', '${eArgs}' -ErrorAction Stop`,
    `if (-not $guestPid -or [int]$guestPid -le 0) { throw 'The guest did not confirm a process id.' }`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ guestPid = [int]$guestPid; vm = '${eVm}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildGuestProcessQueryScript({ vm, credFile = '', exeName }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eExe = String(exeName).replace(/'/g, "''");
  const eCred = String(credFile).replace(/'/g, "''");
  const credDecl = eCred ? `$cred = Import-Clixml -Path '${eCred}' -ErrorAction Stop; ` : '';
  const credArg = eCred ? '-Credential $cred ' : '';
  return [
    "$ErrorActionPreference = 'Stop'",
    `$sb = { param($n) Get-Process -Name $n -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id }`,
    `${credDecl}$found = Invoke-Command -VMName '${eVm}' ${credArg}-ScriptBlock $sb -ArgumentList '${eExe}' -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ pids = @($found) } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Asks the guest app to close, waits, then force-stops leftovers in the guest.
function buildStopGuestAppScript({ vm, credFile, exeName, gracefulTimeoutSec = 15 }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eExe = String(exeName).replace(/'/g, "''");
  const eCred = String(credFile).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${eVm}', [string]$CredFile = '${eCred}')`,
    "$cred = Import-Clixml -Path $CredFile -ErrorAction Stop",
    `$sb = { param($n, $t)`,
    `  $procs = Get-Process -Name $n -ErrorAction SilentlyContinue`,
    "  foreach ($p in $procs) { try { $p.CloseMainWindow() | Out-Null } catch {} }",
    `  $deadline = [datetime]::UtcNow.AddSeconds($t)`,
    "  while ([datetime]::UtcNow -lt $deadline) {",
    `    if (-not (Get-Process -Name $n -ErrorAction SilentlyContinue)) { break }`,
    "    Start-Sleep -Seconds 1",
    "  }",
    `  $left = Get-Process -Name $n -ErrorAction SilentlyContinue`,
    "  foreach ($p in $left) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} }",
    `  @(Get-Process -Name $n -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)`,
    "}",
    `$still = Invoke-Command -VMName $Name -Credential $cred -ScriptBlock $sb -ArgumentList '${eExe}', ${Number(gracefulTimeoutSec)} -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ remaining = @($still) } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildGuestFileExistsScript({ vm, credFile, guestPath }) {
  const eVm = String(vm).replace(/'/g, "''");
  const ePath = String(guestPath).replace(/'/g, "''");
  const eCred = String(credFile).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$exists = Invoke-Command -VMName '${eVm}' -Credential (Import-Clixml -Path '${eCred}' -ErrorAction Stop) -ScriptBlock { param($p) Test-Path -LiteralPath $p } -ArgumentList '${ePath}' -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ exists = [bool]$exists } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Graceful guest shutdown with a documented timeout; throws on timeout so the
// caller can decide whether to escalate to power-off (never silently).
function buildGracefulShutdownScript({ vm, timeoutSec = 120, pollSec = 3 }) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${esc}', [int]$TimeoutSec = ${Number(timeoutSec)}, [int]$PollSec = ${Number(pollSec)})`,
    "Stop-VM -Name $Name -ErrorAction Stop",
    "$deadline = [datetime]::UtcNow.AddSeconds($TimeoutSec)",
    "$state = (Get-VM -Name $Name -ErrorAction Stop).State",
    "while ($state -ne 'Off' -and [datetime]::UtcNow -lt $deadline) {",
    "  Start-Sleep -Seconds $PollSec",
    "  $state = (Get-VM -Name $Name -ErrorAction Stop).State",
    "}",
    "if ($state -ne 'Off') { throw \"VM '$Name' did not reach Off within $TimeoutSec seconds (state: $state).\" }",
    `Write-Output ('${RESULT_PREFIX}' + (@{ stopped = $true; graceful = $true } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Hard power-off: escalation path only, used after graceful shutdown times out
// and only when the user confirms data loss is acceptable (Delete implies it).
function buildPowerOffScript(vm) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Stop-VM -Name '${esc}' -TurnOff -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ stopped = $true; graceful = $false } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildStopVmScript(vm) {
  return buildPowerOffScript(vm);
}

// Removes VM CONFIGURATION only (disks are separate). Verifies absence.
function buildRemoveVmConfigScript(vm) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Remove-VM -Name '${esc}' -Force -ErrorAction Stop`,
    `$gone = Get-VM -Name '${esc}' -ErrorAction SilentlyContinue`,
    `if ($gone) { throw "VM '${esc}' still exists after Remove-VM." }`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ removed = $true; vm = '${esc}' } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildRemoveVmScript({ vm, vhdPath }) {
  const e1 = String(vm).replace(/'/g, "''");
  const e2 = String(vhdPath).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Stop-VM -Name '${e1}' -TurnOff -ErrorAction SilentlyContinue`,
    `Remove-VM -Name '${e1}' -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath '${e2}' -Force -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ removed = $true; vm = '${e1}' } | ConvertTo-Json -Compress))`,
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

// Ordered deletion lifecycle for one environment. Pure and testable: each step
// names the Hyper-V/host operation; the executor (main.js) runs them in order,
// stops at the first failure, and never reports success until every step passes.
function deletionPlan({ vm, vhdValid }) {
  const steps = [
    'guard-launches',
    'stop-guest-app',
    'graceful-shutdown',
    'verify-off',
    'remove-vm-config',
    'verify-vm-absent',
  ];
  if (vhdValid) steps.push('remove-env-vhd', 'verify-vhd-absent');
  steps.push('remove-host-files', 'verify-host-absent', 'remove-record');
  return steps;
}

// Applies CPU/memory to a VM that is Off/Saved (Hyper-V rejects these while running).
function buildSetVmResourcesScript({ vm, memoryMB, cpuCount }) {
  const eVm = String(vm).replace(/'/g, "''");
  const mem = Math.max(512, Math.min(32768, Number(memoryMB) || DEFAULT_MEMORY_MB));
  const cpu = Math.max(1, Math.min(16, Number(cpuCount) || DEFAULT_CPU_COUNT));
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${eVm}')`,
    `$state = (Get-VM -Name $Name -ErrorAction Stop).State`,
    `if ($state -ne 'Off' -and $state -ne 'Saved') { throw "VM '$Name' must be Off to change CPU/memory (state: $state). Stop it first." }`,
    `Set-VM -Name $Name -MemoryStartupBytes (${mem}MB) -ProcessorCount ${cpu} -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ resources = $true; memoryMB = ${mem}; cpuCount = ${cpu} } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Removes all virtual NICs: the guest goes offline (least privilege default for
// locked profiles). Re-attaching needs buildAttachNetworkScript while Off.
function buildDetachNetworkScript(vm) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Get-VMNetworkAdapter -VMName '${esc}' -ErrorAction Stop | Remove-VMNetworkAdapter -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ offline = $true } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildAttachNetworkScript({ vm, switchName = DEFAULT_SWITCH_NAME }) {
  const eVm = String(vm).replace(/'/g, "''");
  const eSw = String(switchName).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `param([string]$Name = '${eVm}')`,
    `$state = (Get-VM -Name $Name -ErrorAction Stop).State`,
    `if ($state -ne 'Off') { throw "VM '$Name' must be Off to attach networking (state: $state)." }`,
    `Add-VMNetworkAdapter -VMName $Name -SwitchName '${eSw}' -ErrorAction Stop`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ online = $true } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function buildNetworkStateScript(vm) {
  const esc = String(vm).replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$nics = @(Get-VMNetworkAdapter -VMName '${esc}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SwitchName)`,
    `Write-Output ('${RESULT_PREFIX}' + (@{ adapters = @($nics) } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

// Passing more than 0 args? No: single validated argument string.
function validateLaunchArgs(value) {
  if (value === undefined || value === null || value === '') return { ok: true, args: '' };
  if (typeof value !== 'string') return { ok: false, reason: 'Launch arguments must be text.' };
  if (value.length > 2048) return { ok: false, reason: 'Launch arguments are too long (max 2048 characters).' };
  return { ok: true, args: value };
}

function guestExePathForApp(vmDriveRoot, appId, exeBaseName) {
  return path.win32.join(vmDriveRoot, vmName(appId), exeBaseName);
}

module.exports = {
  RESULT_PREFIX,
  DEFAULT_SWITCH_NAME,
  DEFAULT_SWITCH_TYPE,
  DEFAULT_MEMORY_MB,
  DEFAULT_CPU_COUNT,
  GUEST_FILE_COPY_SERVICE,
  vmName,
  vmFileNames,
  envVhdPathForApp,
  isEnvVhdPath,
  validateDeletionTarget,
  guestCredentialFilePath,
  buildProvisionCredentialScript,
  isHyperVSupported,
  buildHyperVPrereqScript,
  parseHyperVPrereqOutput,
  hyperVMissingRequirements,
  describeHyperVMissing,
  buildEnsureSwitchScript,
  buildGetVmScript,
  buildEnableGuestServicesScript,
  buildCreateVmScript,
  buildCreateVmFromExistingVhdScript,
  buildStartVmScript,
  buildWaitForGuestReadyScript,
  buildCopyToGuestScript,
  buildRunInstallerInGuestScript,
  buildInstallInGuestScript,
  buildLaunchInGuestScript,
  buildGuestProcessQueryScript,
  buildStopGuestAppScript,
  buildGuestFileExistsScript,
  buildGracefulShutdownScript,
  buildPowerOffScript,
  buildStopVmScript,
  buildRemoveVmConfigScript,
  buildSetVmResourcesScript,
  buildDetachNetworkScript,
  buildAttachNetworkScript,
  buildNetworkStateScript,
  validateLaunchArgs,
  buildRemoveVmScript,
  parseHyperVOutput,
  deletionPlan,
  guestExePathForApp,
};
