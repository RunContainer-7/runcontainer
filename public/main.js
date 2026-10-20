const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
// No Sandboxie backend: RunContainer's only isolation engines are Hyper-V VMs
// (arbitrary software) and AppContainer (compatible apps, explicit opt-in).
// isWithinDirectory comes from isolated-launch (pure path validation).
const {
  vmName,
  vmFileNames,
  buildHyperVPrereqScript,
  parseHyperVPrereqOutput,
  hyperVMissingRequirements,
  describeHyperVMissing,
  buildStartVmScript,
  buildStopVmScript,
  buildRemoveVmScript,
  buildInstallInGuestScript,
  buildLaunchInGuestScript,
  parseHyperVOutput,
} = require('./hyperv-runtime');
const { selectIsolationEngine } = require('./engine-select');
const {
  buildProcessTableArgs,
  parseProcessTable,
  findAppProcessIds,
  buildTaskkillArgs,
  buildGracefulTaskkillArgs,
  buildBlockingProcessArgs,
  parseBlockingProcesses,
  describeCleanupFailure,
  stopAppProcesses,
  mergeStatusUpdates,
  resolveDownloadRedirect,
  resetLaunchState,
  buildIsolatedEnvironment,
  removeDirectoryWithRetries,
  buildClearReadOnlyArgs,
  buildAclRepairPlan,
  CleanupCancelledError,
  isWithinDirectory,
} = require('./isolated-launch');
const {
  buildWindowHostScript,
  buildWindowHostScriptArgs,
  parseWindowHostOutput,
  nativeHandleToInt,
} = require('./window-host');
const {
  appContainerName,
  isAppContainerSupported,
  buildAppContainerFolderAclArgs,
  buildAppContainerAncestorAclArgs,
  listAncestorDirectories,
  buildAppContainerScript,
  buildAppContainerScriptArgs,
  parseAppContainerOutput,
} = require('./isolation-runtime');

let mainWindow;
const appStorePath = path.join(app.getPath('userData'), 'runcontainer-apps.json');
const sandboxMonitors = new Map();
// One live deletion job per app, so a long retry loop can be cancelled from the UI.
const deleteJobs = new Map();
// One in-flight run/install/delete/reset operation per app. Concurrent operations on
// the same environment are refused instead of corrupting it.
const opLocks = new Map();
async function withOpLock(appId, op, fn) {
  if (opLocks.has(appId)) {
    throw new Error(`Another operation (${opLocks.get(appId)}) is already running for this environment. Wait for it to finish and try again.`);
  }
  opLocks.set(appId, op);
  try { return await fn(); }
  finally { opLocks.delete(appId); }
}
const sandboxRootBase = path.join(app.getPath('userData'), 'sandboxes');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.setName('RunContainer');
app.setAppUserModelId('RunContainer');

function ensureStoreFile() {
  if (!fs.existsSync(appStorePath)) {
    fs.writeFileSync(appStorePath, '[]', 'utf8');
  }
}

function loadApps() {
  ensureStoreFile();
  try {
    return JSON.parse(fs.readFileSync(appStorePath, 'utf8'));
  } catch (error) {
    return [];
  }
}

function saveApps(apps) {
  ensureStoreFile();
  fs.writeFileSync(appStorePath, JSON.stringify(apps, null, 2), 'utf8');
}

function getStoredApp(appId) {
  if (!appId) return null;
  const found = loadApps().find((entry) => entry.id === appId) || null;
  return found ? withVmDefaults(found) : null;
}

// Defaults for fields added after earlier releases; normalization keeps old
// records working without trusting stale state as proof of anything.
function withVmDefaults(record) {
  const normalized = { ...record };
  if (typeof normalized.launchArgs !== 'string') normalized.launchArgs = '';
  if (!Number.isSafeInteger(normalized.vmMemoryMB)) normalized.vmMemoryMB = require('./hyperv-runtime').DEFAULT_MEMORY_MB;
  if (!Number.isSafeInteger(normalized.vmCpuCount)) normalized.vmCpuCount = require('./hyperv-runtime').DEFAULT_CPU_COUNT;
  if (typeof normalized.networkEnabled !== 'boolean') normalized.networkEnabled = true;
  if (typeof normalized.profile !== 'string') normalized.profile = 'default';
  if (!Array.isArray(normalized.appContainerCapabilities)) normalized.appContainerCapabilities = ['internetClient'];
  return normalized;
}

function removeAppRecord(appRecord) {
  const apps = loadApps();
  const remainingApps = apps.filter((entry) => {
    if (appRecord?.id) return entry.id !== appRecord.id;
    if (appRecord?.source && entry.source) return entry.source !== appRecord.source;
    if (appRecord?.sandboxRoot && entry.sandboxRoot) return entry.sandboxRoot !== appRecord.sandboxRoot;
    if (appRecord?.name && entry.name) return entry.name !== appRecord.name;
    return true;
  });

  saveApps(remainingApps);
  return remainingApps;
}

function sanitizeName(name) {
  return String(name || 'app')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'app';
}

function appendLog(logPath, entry) {
  ensureDirectory(path.dirname(logPath));
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  fs.appendFileSync(logPath, line, 'utf8');
}

function getSandboxProfile(profileName) {
  const profiles = {
    default: {
      network: true,
      filesystem: false,
      registry: false,
      isolateUserData: true,
      allowClipboard: false,
    },
    relaxed: {
      network: true,
      filesystem: true,
      registry: false,
      isolateUserData: false,
      allowClipboard: true,
    },
    locked: {
      network: false,
      filesystem: false,
      registry: false,
      isolateUserData: true,
      allowClipboard: false,
    },
  };

  return profiles[profileName] || profiles.default;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureSandboxLayout(sandboxRoot) {
  const layout = {
    runtime: path.join(sandboxRoot, 'runtime'),
    appData: path.join(sandboxRoot, 'AppData'),
    temp: path.join(sandboxRoot, 'Temp'),
    logs: path.join(sandboxRoot, 'logs'),
    desktop: path.join(sandboxRoot, 'Desktop'),
    documents: path.join(sandboxRoot, 'Documents'),
    downloads: path.join(sandboxRoot, 'Downloads'),
    pictures: path.join(sandboxRoot, 'Pictures'),
    music: path.join(sandboxRoot, 'Music'),
    videos: path.join(sandboxRoot, 'Videos'),
    programFiles: path.join(sandboxRoot, 'Program Files'),
    programData: path.join(sandboxRoot, 'ProgramData'),
    public: path.join(sandboxRoot, 'Public'),
  };

  Object.values(layout).forEach((folderPath) => ensureDirectory(folderPath));
  return layout;
}


function validateExe(exePath) {
  if (!exePath || typeof exePath !== 'string') {
    return { isValid: false, reason: 'No file path was provided.' };
  }

  if (!fs.existsSync(exePath)) {
    return { isValid: false, reason: 'The selected file does not exist.' };
  }

  if (!exePath.toLowerCase().endsWith('.exe')) {
    return { isValid: false, reason: 'Only .exe files are supported.' };
  }

  const fileDescriptor = fs.openSync(exePath, 'r');
  const header = Buffer.alloc(2);
  try {
    const bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, 0);
    if (bytesRead !== 2 || header.toString('hex') !== '4d5a') {
      return { isValid: false, reason: 'The file is not a valid Windows executable.' };
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }

  return { isValid: true, reason: 'Valid Windows executable.' };
}

function getExeMetadata(exePath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({
        title: path.basename(exePath, path.extname(exePath)),
        version: null,
        company: null,
        originalName: path.basename(exePath),
      });
      return;
    }

    const escapedPath = String(exePath).replace(/'/g, "''");
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Diagnostics",
      "Add-Type -AssemblyName System.Drawing",
      "$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo('$escapedPath')",
      "$obj = [pscustomobject]@{",
      "title = if ($info.FileDescription) { $info.FileDescription } elseif ($info.ProductName) { $info.ProductName } else { $null }",
      "version = if ($info.FileVersion) { $info.FileVersion } else { $null }",
      "company = if ($info.CompanyName) { $info.CompanyName } else { $null }",
      "originalName = if ($info.OriginalFilename) { $info.OriginalFilename } else { [System.IO.Path]::GetFileName('$escapedPath') }",
      "}",
      "$obj | ConvertTo-Json -Compress",
    ].join('; ');

    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout) {
        resolve({
          title: path.basename(exePath, path.extname(exePath)),
          version: null,
          company: null,
          originalName: path.basename(exePath),
        });
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        resolve({
          title: path.basename(exePath, path.extname(exePath)),
          version: null,
          company: null,
          originalName: path.basename(exePath),
        });
      }
    });
  });
}

function extractExeIcon(exePath, outputPath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }

    ensureDirectory(path.dirname(outputPath));
    const escapedPath = String(exePath).replace(/'/g, "''");
    const escapedOutput = String(outputPath).replace(/'/g, "''");
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Drawing",
      "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon('$escapedPath')",
      "if ($icon) { $icon.Save('$escapedOutput'); 'ok' } else { 'missing' }",
    ].join('; ');

    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true }, (error, stdout) => {
      if (error || stdout?.trim() !== 'ok') {
        resolve(null);
        return;
      }

      resolve(outputPath);
    });
  });
}

function downloadUrl(url, outputPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('The download redirected too many times.'));
          return;
        }
        let nextUrl;
        try {
          nextUrl = resolveDownloadRedirect(url, response.headers.location);
        } catch (error) {
          reject(error);
          return;
        }
        downloadUrl(nextUrl, outputPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Download failed with status ${status}.`));
        return;
      }

      const file = fs.createWriteStream(outputPath);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(outputPath)));
      file.on('error', (error) => {
        fs.unlink(outputPath, () => {});
        reject(error);
      });
      response.on('error', (error) => {
        file.destroy();
        fs.unlink(outputPath, () => {});
        reject(error);
      });
    });
    request.on('error', (error) => {
      fs.unlink(outputPath, () => {});
      reject(error);
    });
  });
}

function executeFile(filePath, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(filePath, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const details = String(stderr || stdout || error.message).trim();
        reject(new Error(details || `Command failed: ${path.basename(filePath)}`));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function broadcastContainerStatus(record) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('container:status', record);
  }
}

function failedLaunch(appRecord, reason) {
  return { id: appRecord.id, status: 'Failed', error: reason, reason, embedded: false };
}

function stopMonitor(appId) {
  const monitor = sandboxMonitors.get(appId);
  if (monitor) clearInterval(monitor);
  sandboxMonitors.delete(appId);
}

async function listProcessTable() {
  if (process.platform !== 'win32') throw new Error('Process inspection requires Windows.');
  const { stdout } = await executeFile('powershell.exe', buildProcessTableArgs(), { maxBuffer: 16 * 1024 * 1024 });
  return parseProcessTable(stdout);
}

async function listRunningPids(appRecord) {
  // Guest (Hyper-V) processes are queried inside the VM, not from the host table.
  if (appRecord.launchMode === 'hyperv' || appRecord.activeEngine === 'hyperv') {
    return findAppProcessIds(await listProcessTable(), appRecord.sandboxRoot || path.dirname(appRecord.source), trackedPids(appRecord));
  }
  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source);
  return findAppProcessIds(await listProcessTable(), sandboxRoot, trackedPids(appRecord));
}

// Every PID RunContainer has ever confirmed for this app. The lineage is kept after those
// processes exit: Windows keeps ParentProcessId on surviving descendants, so an installer
// that starts the real app and quits still leaves a traceable chain for Delete.
function trackedPids(appRecord) {
  return [...new Set([
    ...(appRecord?.sandboxPids || []),
    ...(appRecord?.knownPids || []),
    ...(Number.isSafeInteger(appRecord?.pid) && appRecord.pid > 0 ? [appRecord.pid] : []),
  ].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
}

function withTrackedPids(appRecord, pids) {
  return { ...appRecord, knownPids: [...new Set([...trackedPids(appRecord), ...(pids || [])])] };
}

function monitorAppProcesses(appId, logPath) {
  stopMonitor(appId);
  // A PowerShell process query can take longer than the poll interval; skip ticks while one is still running.
  let checking = false;
  const interval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await checkAppProcesses(appId, logPath);
    } finally {
      checking = false;
    }
  }, 1500);
  sandboxMonitors.set(appId, interval);
}

async function checkAppProcesses(appId, logPath) {
  const current = getStoredApp(appId);
  if (!current || current.status !== 'Running') {
    stopMonitor(appId);
    return;
  }
  try {
    const pids = await listRunningPids(current);
    if (pids.length === 0) {
      // knownPids is deliberately preserved: a child started later still names one of
      // these PIDs as its parent, so Delete can still find a process that outlived its launcher.
      const updated = { ...withTrackedPids(current, []), status: 'Stopped', pid: null, sandboxPids: [], lastExitAt: new Date().toISOString() };
      saveApps(loadApps().map((entry) => (entry.id === appId ? updated : entry)));
      appendLog(logPath, 'All processes for this app have exited.');
      stopMonitor(appId);
      broadcastContainerStatus(updated);
      return;
    }
    if (JSON.stringify(pids) !== JSON.stringify(current.sandboxPids || [])) {
      const updated = { ...withTrackedPids(current, pids), pid: pids[0], sandboxPids: pids };
      saveApps(loadApps().map((entry) => (entry.id === appId ? updated : entry)));
      broadcastContainerStatus(updated);
    }
  } catch (error) {
    appendLog(logPath, `Unable to query process state: ${error.message}`);
  }
}

// Stops only this app's processes: anything executing from its folder, the recorded launch
// PIDs, and every descendant of those. Nothing else is ever terminated — a process whose
// identity is not confirmed as part of this app is reported, never killed. The app is first
// asked to close (taskkill /T without /F), then force-closed. Returns surviving PIDs.
async function stopProcessesUnder(directory, seedPids = [], { logPath } = {}) {
  const terminate = async (pid, { force }) => {
    const args = force ? buildTaskkillArgs(pid) : buildGracefulTaskkillArgs(pid);
    await executeFile('taskkill.exe', args);
  };
  const remaining = await stopAppProcesses({
    directory,
    seedPids,
    listProcesses: listProcessTable,
    terminate,
    wait: delay,
    attempts: 4,
    forceAfterGracefulMs: 3000,
    verifyAfterMs: 800,
  });
  if (remaining.length > 0 && logPath) {
    appendLog(logPath, `Could not stop PIDs ${remaining.join(', ')} running from ${directory}.`);
  }
  return remaining;
}

// Read-only: lists processes whose image or loaded modules come from the folder. A mapped
// image blocks deletion even when no ordinary file handle exists. Nothing is force-closed here.
async function listBlockingProcesses(directory) {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await executeFile('powershell.exe', buildBlockingProcessArgs(directory), {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60000,
    });
    return parseBlockingProcesses(stdout);
  } catch (error) {
    return [];
  }
}

function ensureWorkingDirectoryOutside(sandboxRoot) {
  // Windows refuses to remove a directory that is any live process's current directory,
  // and a launched app was started with its own folder as cwd.
  try {
    if (isWithinDirectory(sandboxRoot, process.cwd())) process.chdir(app.getPath('home'));
  } catch (error) {
    // A cwd on another drive is fine; nothing to do.
  }
}

// An installer can leave explicit DENY ACEs or a foreign owner behind, which no amount of
// retrying fixes. Ownership plus an ACL reset is the documented repair and is applied only
// to the app's own managed folder.
async function repairSandboxPermissions(sandboxRoot) {
  if (process.platform !== 'win32') return;
  // Root ACL reset first (a DENY also denies traverse), then ownership, then inherited ACLs.
  for (const step of buildAclRepairPlan(sandboxRoot)) {
    await executeFile(step.command, step.args, { timeout: 120000 }).catch(() => {});
  }
}

async function removeSandboxDirectory(sandboxRoot, { shouldAbort = () => false, logPath } = {}) {
  ensureWorkingDirectoryOutside(sandboxRoot);
  try {
    await removeDirectoryWithRetries({
      directory: sandboxRoot,
      clearReadOnly: async () => {
        if (process.platform === 'win32') await executeFile('attrib.exe', buildClearReadOnlyArgs(sandboxRoot));
      },
      prepareForRemoval: async () => { await repairSandboxPermissions(sandboxRoot); },
      shouldAbort,
      attempts: 12,
      retryDelayMs: 1000,
      onAttempt: ({ phase, error }) => {
        if (phase === 'repair' && logPath) {
          appendLog(logPath, `Removal was denied (${error?.code || error?.message || 'error'}); repairing permissions on ${sandboxRoot}.`);
        }
      },
    });
  } catch (error) {
    if (error instanceof CleanupCancelledError) throw error;
    const blockers = await listBlockingProcesses(sandboxRoot);
    throw new Error(describeCleanupFailure({ directory: sandboxRoot, error, blockers }));
  }
}

// Shared VM readiness: prereqs, base image, guest credential, reconcile VM
// existence via Get-VM, ensure switch, create or re-attach, start, wait for
// PowerShell Direct readiness, enable file-copy service. Returns { hv, files,
// credFile, baseImage }. Throws fail-closed on any problem.
async function ensureHyperVGuestReady(appRecord, sandboxRoot, logPath) {
  const hv = require('./hyperv-runtime');
  const readiness = await checkHyperVReady();
  if (!readiness.ready) throw new Error(describeHyperVMissing(readiness.missing));
  const baseImage = hyperVBaseImagePath();
  if (!baseImage || !fs.existsSync(baseImage)) {
    throw new Error('VM isolation needs a provisioned Windows base image: set RUNCONTAINER_HYPERV_BASE_IMAGE to a sysprepped Windows 10/11 VHDX (Generation 2) and provision the guest credential (see Settings). Nothing was launched on the host.');
  }
  const credFile = guestCredentialFile();
  if (!fs.existsSync(credFile)) {
    throw new Error(`The guest credential is not provisioned (missing ${credFile}). Provision it once from Settings: it runs Get-Credential for the guest local administrator and stores it DPAPI-encrypted. PowerShell Direct requires guest credentials; without them nothing is launched.`);
  }
  const hvDir = path.join(sandboxRoot, 'hyperv');
  ensureDirectory(hvDir);
  const files = hv.vmFileNames(appRecord.id, hvDir);
  const vhdCheck = hv.validateDeletionTarget({ candidate: files.differencingVhdPath, envDir: hvDir, baseImagePath: baseImage });
  if (!vhdCheck.ok) throw new Error(`Unsafe environment disk location: ${vhdCheck.reason}`);
  let vmInfo = await runHyperVScript(hv.buildGetVmScript(files.vmName), logPath);
  const vhdExists = fs.existsSync(files.differencingVhdPath);
  if (!vmInfo.exists && vhdExists) {
    appendLog(logPath, `VM config for ${files.vmName} is missing but its disk exists; re-attaching the disk without touching its data.`);
    await runHyperVScript(hv.buildEnsureSwitchScript({ switchName: files.switchName }), logPath);
    await runHyperVScript(hv.buildCreateVmFromExistingVhdScript({ vmName: files.vmName, existingVhdPath: files.differencingVhdPath, switchName: files.switchName }), logPath);
    vmInfo = await runHyperVScript(hv.buildGetVmScript(files.vmName), logPath);
  }
  if (!vmInfo.exists) {
    appendLog(logPath, `Creating Hyper-V VM ${files.vmName} (differencing disk off the shared base image; base image is never modified).`);
    await runHyperVScript(hv.buildEnsureSwitchScript({ switchName: files.switchName }), logPath);
    await runHyperVScript(hv.buildCreateVmScript({ vmName: files.vmName, differencingVhdPath: files.differencingVhdPath, baseImagePath: baseImage, switchName: files.switchName }), logPath);
    vmInfo = await runHyperVScript(hv.buildGetVmScript(files.vmName), logPath);
    if (!vmInfo.exists) throw new Error(`Hyper-V did not confirm VM ${files.vmName} exists after creation.`);
  }
  // Apply CPU/memory and network attachment while the VM is Off. A running VM
  // keeps its current settings; differences are logged and take effect at Reset.
  if (vmInfo.state !== 'Running') {
    try {
      await runHyperVScript(hv.buildSetVmResourcesScript({ vm: files.vmName, memoryMB: appRecord.vmMemoryMB, cpuCount: appRecord.vmCpuCount }), logPath);
    } catch (resError) {
      appendLog(logPath, `VM resources kept as-is: ${resError.message}`);
    }
    const wantOnline = appRecord.networkEnabled !== false;
    try {
      const nicState = await runHyperVScript(hv.buildNetworkStateScript(files.vmName), logPath).catch(() => ({ adapters: [] }));
      const hasNic = Array.isArray(nicState.adapters) && nicState.adapters.length > 0;
      if (wantOnline && !hasNic) {
        await runHyperVScript(hv.buildAttachNetworkScript({ vm: files.vmName, switchName: files.switchName }), logPath);
        appendLog(logPath, 'Network adapter attached (profile allows networking).');
      } else if (!wantOnline && hasNic) {
        await runHyperVScript(hv.buildDetachNetworkScript(files.vmName), logPath);
        appendLog(logPath, 'Network adapters removed: this environment is offline (locked profile).');
      }
    } catch (netError) {
      appendLog(logPath, `Network state kept as-is: ${netError.message}`);
    }
    vmInfo = await runHyperVScript(hv.buildGetVmScript(files.vmName), logPath);
  }
  if (vmInfo.state !== 'Running') {
    appendLog(logPath, `Starting VM ${files.vmName} (state: ${vmInfo.state || 'unknown'}).`);
    await runHyperVScript(hv.buildStartVmScript(files.vmName), logPath);
  } else {
    appendLog(logPath, `VM ${files.vmName} is already running; reusing it (no reboot).`);
  }
  appendLog(logPath, 'Waiting for the guest OS to accept PowerShell Direct commands (this proves boot, not just VM state).');
  await runHyperVScript(hv.buildWaitForGuestReadyScript({ vm: files.vmName, credFile, timeoutSec: 300 }), logPath);
  try {
    await runHyperVScript(hv.buildEnableGuestServicesScript(files.vmName), logPath);
  } catch (svcError) {
    appendLog(logPath, `Guest file-copy service could not be confirmed: ${svcError.message}`);
  }
  return { hv, files, credFile, baseImage };
}

// Full-VM isolation via Hyper-V. Ordered lifecycle, every step verified:
// prereqs -> base image -> guest credential -> reconcile VM existence (Get-VM is
// the source of truth, not the filesystem) -> ensure switch -> create (or
// re-attach orphaned disk) -> start -> wait for PowerShell Direct readiness ->
// enable file-copy service -> copy into guest -> launch in guest -> verify the
// guest process AND that nothing runs on the host. Any failure refuses: no
// AppContainer fallback, no host process, ever.
async function runWithHyperV(appRecord, sandboxRoot, logPath) {
  const hv = require('./hyperv-runtime');
  if (deleteJobs.has(appRecord.id)) {
    return failedLaunch(appRecord, 'Deletion is in progress for this environment; launches are blocked until it finishes. Nothing was launched.');
  }
  try {
    const { files, credFile } = await ensureHyperVGuestReady(appRecord, sandboxRoot, logPath);

    const guestDir = `C:\RunContainer\${appRecord.id}`;
    const guestExe = appRecord.installedExeGuestPath || `C:\RunContainer\${appRecord.id}\${path.win32.basename(appRecord.source)}`;
    appendLog(logPath, `Copying ${path.basename(appRecord.source)} into the guest at ${guestExe} (host-to-guest file copy; the binary never executes on the host).`);
    await runHyperVScript(hv.buildCopyToGuestScript({ vm: files.vmName, hostPath: appRecord.source, guestPath: guestExe }), logPath);
    const existsInGuest = await runHyperVScript(hv.buildGuestFileExistsScript({ vm: files.vmName, credFile, guestPath: guestExe }), logPath);
    if (!existsInGuest.exists) throw new Error(`The guest did not confirm ${guestExe} after copy. Nothing was started.`);

    const argsCheck = hv.validateLaunchArgs(appRecord.launchArgs);
    if (!argsCheck.ok) throw new Error(`Saved launch arguments are invalid: ${argsCheck.reason} Clear them in Tweaks and try again. Nothing was launched.`);
    appendLog(logPath, `Launching inside the guest (never on the host): ${guestExe}${argsCheck.args ? ` (args: ${argsCheck.args})` : ''}`);
    const launched = await runHyperVScript(hv.buildLaunchInGuestScript({ vm: files.vmName, credFile, guestExePath: guestExe, workingDir: guestDir, appArgs: argsCheck.args }), logPath);
    const guestPid = Number(launched.guestPid);
    if (!Number.isSafeInteger(guestPid) || guestPid <= 0) throw new Error('The guest did not confirm a process id. The app was not reported as running.');

    // Independent guest-state evidence: the exe name is alive in the guest...
    const exeBase = path.win32.basename(guestExe, path.win32.extname(guestExe));
    const query = await runHyperVScript(hv.buildGuestProcessQueryScript({ vm: files.vmName, credFile, exeName: exeBase }), logPath);
    const guestPids = Array.isArray(query.pids) ? query.pids.filter((n) => Number.isSafeInteger(n) && n > 0) : [];
    if (!guestPids.includes(guestPid)) throw new Error(`Guest PID ${guestPid} is not visible in the guest process list (${guestPids.join(', ') || 'empty'}). The launch is not reported as running.`);
    // ...and nothing from this environment runs on the HOST.
    let hostStrays = [];
    try {
      hostStrays = findAppProcessIds(await listProcessTable(), sandboxRoot, []);
    } catch (tableError) {
      appendLog(logPath, `Host process table could not be read after guest launch: ${tableError.message}`);
    }
    if (hostStrays.length > 0) {
      appendLog(logPath, `Unisolated host strays detected (PIDs ${hostStrays.join(', ')}); stopping them and refusing the launch.`);
      await stopProcessesUnder(sandboxRoot, hostStrays, { logPath });
      throw new Error(`Processes from this environment were found on the host (PIDs ${hostStrays.join(', ')}). They were stopped; the guest launch was refused so nothing runs unisolated.`);
    }

    const base = getStoredApp(appRecord.id) || appRecord;
    const updatedApp = {
      ...withTrackedPids(base, []),
      status: 'Running',
      launchMode: 'hyperv',
      activeEngine: 'hyperv',
      isolated: true,
      isolationLevel: 'vm',
      hypervVm: files.vmName,
      hypervVhd: files.differencingVhdPath,
      installedExeGuestPath: guestExe,
      guestPid,
      guestPids,
      knownPids: [],
      pid: null,
      sandboxPids: [],
      lastLaunchedAt: new Date().toISOString(),
      launchCleanupPending: false,
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updatedApp : entry)));
    appendLog(logPath, `Running inside Hyper-V VM ${files.vmName}: guest PID ${guestPid} confirmed in-guest (guest list: ${guestPids.join(', ')}), zero host processes from this environment.`);
    monitorHyperVApp(appRecord.id, logPath);
    broadcastContainerStatus(updatedApp);
    return { id: appRecord.id, status: 'Running', pid: null, guestPid, guestPids, hypervVm: files.vmName, launchMode: 'hyperv', activeEngine: 'hyperv', isolationLevel: 'vm', isolated: true, embedded: false, reason: `Running inside Hyper-V VM ${files.vmName} (guest PID ${guestPid}, verified in-guest, nothing on the host).` };
  } catch (error) {
    appendLog(logPath, `VM launch failed: ${error.message}`);
    return failedLaunch(appRecord, `${error.message}`);
  }
}

function monitorHyperVApp(appId, logPath) {
  stopMonitor(appId);
  let checking = false;
  let failures = 0;
  const interval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const current = getStoredApp(appId);
      if (!current || current.status !== 'Running' || current.activeEngine !== 'hyperv') { stopMonitor(appId); return; }
      const guestExe = current.installedExeGuestPath || current.source;
      const exeBase = path.win32.basename(guestExe, path.win32.extname(guestExe));
      const q = require('./hyperv-runtime').buildGuestProcessQueryScript({ vm: current.hypervVm, credFile: guestCredentialFile(), exeName: exeBase });
      try {
        const res = await runHyperVScript(q, logPath);
        const pids = Array.isArray(res.pids) ? res.pids.filter((n) => Number.isSafeInteger(n) && n > 0) : [];
        failures = 0;
        if (pids.length === 0) {
          const updated = { ...current, status: 'Stopped', guestPid: null, lastExitAt: new Date().toISOString() };
          saveApps(loadApps().map((e) => (e.id === appId ? updated : e)));
          appendLog(logPath, 'Guest process exited; VM kept for data. Delete removes the VM and its disk.');
          stopMonitor(appId);
          broadcastContainerStatus(updated);
        }
      } catch (queryError) {
        failures += 1;
        appendLog(logPath, `Unable to query guest process state (${failures}/3): ${queryError.message}`);
        if (failures >= 3) {
          const current = getStoredApp(appId);
          if (current && current.status === 'Running') {
            const updated = { ...current, status: 'Unknown', statusNote: 'The guest stopped answering queries. The app may still run in the VM; Run reconciles, Stop attempts a clean stop, Reset reboots the guest.' };
            saveApps(loadApps().map((e) => (e.id === appId ? updated : e)));
            broadcastContainerStatus(updated);
          }
          stopMonitor(appId);
        }
      }
    } finally { checking = false; }
  }, 5000);
  sandboxMonitors.set(appId, interval);
}

// Unguarded profile execution was removed: env-redirection without a token/VM boundary
// is not isolation, so launching it would violate the fail-closed requirement.
async function runWithIsolatedProfile(appRecord, sandboxRoot, logPath) {
  appendLog(logPath, 'Refused unguarded launch: profile redirection is not a security boundary.');
  return failedLaunch(appRecord, 'RunContainer refuses to run apps without a security boundary. Profile-only execution was removed. Use AppContainer (compatible apps) or a Hyper-V VM (arbitrary software). Nothing was launched.');
}

function isolationScriptPath() {
  return path.join(app.getPath('userData'), 'runcontainer-appcontainer.ps1');
}

function ensureIsolationScript() {
  const scriptPath = isolationScriptPath();
  const source = buildAppContainerScript();
  let current = null;
  try {
    current = fs.readFileSync(scriptPath, 'utf8');
  } catch (error) {
    current = null;
  }
  if (current !== source) fs.writeFileSync(scriptPath, source, 'utf8');
  return scriptPath;
}

function windowHostScriptPath() {
  return path.join(app.getPath('userData'), 'runcontainer-windowhost.ps1');
}

function ensureWindowHostScript() {
  const scriptPath = windowHostScriptPath();
  const source = buildWindowHostScript();
  let current = null;
  try {
    current = fs.readFileSync(scriptPath, 'utf8');
  } catch (error) {
    current = null;
  }
  if (current !== source) fs.writeFileSync(scriptPath, source, 'utf8');
  return scriptPath;
}

async function runWindowHostScript(args) {
  try {
    return parseWindowHostOutput((await executeFile('powershell.exe', args, { timeout: 90000 })).stdout);
  } catch (error) {
    try {
      return parseWindowHostOutput(String(error.message));
    } catch (unreadable) {
      throw error;
    }
  }
}

// Re-parents the app's window into RunContainer's window. This is presentation only: it adds
// no isolation, and Windows can refuse it (a lower-integrity window usually cannot be hosted
// by a higher-integrity one). A failure is logged and the app keeps running normally.
async function hostAppWindow(appRecord, pid, logPath) {
  if (process.platform !== 'win32' || !pid) return null;
  if (appRecord?.windowHosting === false) return null;
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const parentHandle = nativeHandleToInt(mainWindow.getNativeWindowHandle());
  if (!parentHandle) return null;
  try {
    const result = await runWindowHostScript(buildWindowHostScriptArgs(ensureWindowHostScript(), {
      mode: 'embed',
      processId: pid,
      parentHandle,
      timeoutMs: 12000,
    }));
    if (result.embedded) {
      appendLog(logPath, 'Hosted the app window inside RunContainer (window hosting only; it does not change isolation).');
    } else {
      appendLog(logPath, `The app keeps its own window: ${result.reason || 'Windows refused window hosting'}. Isolation is unaffected.`);
    }
    const updated = loadApps().map((entry) => (entry.id === appRecord.id ? { ...entry, windowHosted: Boolean(result.embedded) } : entry));
    saveApps(updated);
    return result;
  } catch (error) {
    appendLog(logPath, `Window hosting failed: ${error.message} The app still runs in its own window.`);
    return null;
  }
}

// Puts the app's window back on the desktop before the app is stopped or its sandbox deleted,
// so no window is left parented to a window that is about to be destroyed.
async function releaseAppWindow(appRecord, pids, logPath) {
  if (process.platform !== 'win32') return null;
  if (!appRecord?.windowHosted && !appRecord?.pid) return null;
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const parentHandle = nativeHandleToInt(mainWindow.getNativeWindowHandle());
  const candidates = [...new Set([...(pids || []), appRecord.pid].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (candidates.length === 0 || !parentHandle) return null;
  let released = 0;
  for (const pid of candidates) {
    try {
      const result = await runWindowHostScript(buildWindowHostScriptArgs(ensureWindowHostScript(), {
        mode: 'release',
        processId: pid,
        parentHandle,
      }));
      released += Number(result?.released) || 0;
    } catch (error) {
      appendLog(logPath, `Could not move the app window back to the desktop: ${error.message}`);
    }
  }
  if (released > 0) appendLog(logPath, `Returned ${released} app window(s) to the desktop.`);
  return released;
}

// The launcher reports failures as a JSON result line on stdout, so a non-zero exit code is
// turned back into the launcher's own explanation instead of a raw command failure.
async function runIsolationScript(args) {
  try {
    return parseAppContainerOutput((await executeFile('powershell.exe', args, { timeout: 60000 })).stdout);
  } catch (error) {
    try {
      return parseAppContainerOutput(String(error.message));
    } catch (unreadable) {
      throw error;
    }
  }
}

// Removes the AppContainer profile created for this app and the container storage that
// belongs to it. Windows returns success when the profile does not exist, and documents
// that an open handle inside the container can leave storage behind, so a failure here is
// reported and retried rather than silently ignored.
async function deleteAppContainerProfile(appRecord, logPath) {
  const containerName = appRecord.appContainerName
    || (appRecord.launchMode === 'appcontainer' || appRecord.activeEngine === 'appcontainer' ? appContainerName(appRecord.id) : null);
  if (!containerName || !isAppContainerSupported()) return { deleted: false, skipped: true };
  try {
    const result = await runIsolationScript(buildAppContainerScriptArgs(ensureIsolationScript(), { mode: 'delete', containerName }));
    if (!result?.deleted) throw new Error('Windows did not confirm that the container profile was removed.');
    appendLog(logPath, `Removed AppContainer profile ${containerName}.`);
    return { deleted: true, containerName };
  } catch (error) {
    appendLog(logPath, `AppContainer profile ${containerName} could not be confirmed removed: ${error.message} Container storage may remain under %LOCALAPPDATA%\\Packages until the profile is deleted; retry Delete to finish the cleanup.`);
    return { deleted: false, containerName, error: error.message };
  }
}

// Creates (or reuses) the per-app AppContainer, gives it access to its own folder, and
// launches the app with the container token. The process is only reported as isolated when
// the created process token really carries the container SID (fail closed).
async function runWithAppContainer(appRecord, sandboxRoot, logPath) {
  const scriptPath = ensureIsolationScript();
  const containerName = appContainerName(appRecord.id);
  let pid = null;
  try {
    const sidResult = await runIsolationScript(buildAppContainerScriptArgs(scriptPath, { mode: 'sid', containerName }));
    const containerSid = sidResult.sid;
    if (!containerSid) throw new Error('Windows did not return an AppContainer identity for this app.');

    for (const ancestor of listAncestorDirectories(sandboxRoot, sandboxRootBase)) {
      await executeFile('icacls.exe', buildAppContainerAncestorAclArgs(ancestor, containerSid)).catch(() => {});
    }
    await executeFile('icacls.exe', buildAppContainerFolderAclArgs(sandboxRoot, containerSid));

    const caps = Array.isArray(appRecord.appContainerCapabilities) ? appRecord.appContainerCapabilities : ['internetClient'];
    const argCheck = require('./hyperv-runtime').validateLaunchArgs(appRecord.launchArgs);
    if (!argCheck.ok) throw new Error(`Saved launch arguments are invalid: ${argCheck.reason} Nothing was launched.`);
    const launch = await runIsolationScript(buildAppContainerScriptArgs(scriptPath, {
      mode: 'launch',
      containerName,
      executablePath: appRecord.source,
      workingDirectory: sandboxRoot,
      capabilities: caps,
      appArgs: argCheck.args || undefined,
    }));

    if (!launch.verified || launch.processSid !== launch.containerSid) {
      throw new Error('The app started, but Windows did not confirm it is running inside its container. RunContainer stopped it instead of reporting an unisolated launch.');
    }
    pid = launch.pid;

    let pids = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      pids = findAppProcessIds(await listProcessTable(), sandboxRoot, [pid]);
      if (pids.length > 0) break;
      await delay(400);
    }
    if (pids.length === 0) throw new Error('The container process exited before RunContainer could confirm it.');

    const base = getStoredApp(appRecord.id) || appRecord;
    const updatedApp = {
      ...withTrackedPids(base, pids),
      status: 'Running',
      launchMode: 'appcontainer',
      activeEngine: 'appcontainer',
      isolated: true,
      appContainerName: containerName,
      sandboxieInitialized: false,
      sandboxieCleanupPending: false,
      pid,
      sandboxPids: pids,
      lastLaunchedAt: new Date().toISOString(),
      launchCleanupPending: false,
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updatedApp : entry)));
    appendLog(logPath, `Launched inside AppContainer ${containerName} (${launch.containerSid}), verified token SID, PIDs: ${pids.join(', ')}`);
    monitorAppProcesses(appRecord.id, logPath);
    broadcastContainerStatus(updatedApp);
    // Hosting is presentation only and must never hold up the launch or fail it, so it runs
    // after the launch result is already decided.
    hostAppWindow(updatedApp, pid, logPath).then(() => {
      const latest = getStoredApp(appRecord.id);
      if (latest) broadcastContainerStatus(latest);
    }).catch(() => {});
    return {
      id: appRecord.id,
      status: 'Running',
      pid,
      sandboxPids: pids,
      launchMode: 'appcontainer',
      activeEngine: 'appcontainer',
      isolated: true,
      embedded: false,
      reason: `Running inside AppContainer ${containerName}. The process token was verified as an AppContainer token, so the app cannot reach the rest of your profile, registry or processes.`,
    };
  } catch (error) {
    appendLog(logPath, `Isolated launch failed: ${error.message}`);
    let cleanupPending = false;
    if (pid) {
      const remaining = await stopProcessesUnder(sandboxRoot, [pid], { logPath });
      if (remaining.length > 0) cleanupPending = true;
    }
    return failedLaunch(appRecord, cleanupPending
      ? `${error.message} A process may still be running; Delete this app or close it before retrying. Nothing was launched without isolation.`
      : `${error.message} If this app needs administrator rights, drivers, or services, it cannot run in an AppContainer: mark it for Hyper-V VM isolation instead. Nothing was launched without isolation.`);
  }
}

// Fail-closed engine selection. There is no 'profile' (unguarded) or 'sandboxie' launch
// path: unisolated execution is never selected, even on request. 'rcvm' is the default
// (works on all editions); 'hyperv' means the live Hyper-V readiness check still has to
// pass inside runWithHyperV; anything else refuses.
function selectEngine(appRecord) {
  // hypervReady:true here marks VM eligibility; the LIVE readiness + credential
  // checks run inside runWithHyperV and fail closed (never fall back). qemuReady
  // is a cheap sync store check; runWithQemu re-verifies live and fails closed.
  const decision = selectIsolationEngine({
    platform: process.platform,
    appRecord,
    hypervReady: true,
    qemuReady: isQemuProvisioned(),
  });
  if (decision.engine === 'appcontainer') return 'appcontainer';
  if (decision.engine === 'rcvm') return 'rcvm';
  if (decision.engine === 'qemu' || decision.engine === 'qemu-unavailable') return 'qemu';
  if (decision.engine === 'hyperv' || decision.engine === 'hyperv-unavailable') return 'hyperv';
  return 'refused';
}

// RCVM launchers stay alive holding the app's Job Object, so caps apply for the app's
// lifetime. Killing a launcher ends its whole app tree (kill-on-job-close).
const rcvmLaunchers = new Map();

function rcvmProfileDirs(sandboxRoot) {
  const profileRoot = path.join(sandboxRoot, 'profile');
  return {
    profileRoot,
    appData: path.join(profileRoot, 'Roaming'),
    localAppData: path.join(profileRoot, 'Local'),
    temp: path.join(profileRoot, 'Temp'),
    userProfile: profileRoot,
  };
}

function ensureRcvmProfile(sandboxRoot) {
  const dirs = rcvmProfileDirs(sandboxRoot);
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

// Ends the RCVM launcher (which ends the contained tree via kill-on-job-close).
// Safe to call for non-RCVM apps: without a launcher it only taskkills a stale PID.
async function stopRcvmLauncher(appRecord, logPath) {
  if (!appRecord) return;
  const child = rcvmLaunchers.get(appRecord.id);
  if (child) {
    try {
      child.kill();
    } catch (error) {
      if (logPath) appendLog(logPath, `RCVM launcher was already gone: ${error.message}`);
    }
    rcvmLaunchers.delete(appRecord.id);
  }
  const launcherPid = appRecord.rcvmLauncherPid;
  if (Number.isSafeInteger(launcherPid) && launcherPid > 0) {
    try {
      await executeFile('taskkill.exe', ['/F', '/PID', String(launcherPid)]);
      if (logPath) appendLog(logPath, `Ended the RCVM launcher (PID ${launcherPid}); its job object ends the app tree with it.`);
    } catch (error) {
      // Already gone: the tree is verified separately by stopProcessesUnder.
    }
  }
}

// Launches the app inside RCVM containment: suspended start, Job Object assignment
// (kill-on-close, memory/CPU/process caps), resume, per-app profile folders.
// Anything that cannot be contained fails closed; nothing runs uncontained.
async function runWithRcvm(appRecord, sandboxRoot, logPath) {
  const rcvm = require('./rcvm-runtime');
  let launcherChild = null;
  try {
    const limitCheck = rcvm.validateRcvmLimits({
      memoryMB: appRecord.vmMemoryMB,
      cpuCount: appRecord.vmCpuCount,
      maxProcesses: 32,
      processorCount: os.cpus().length,
    });
    if (!limitCheck.ok) throw new Error(`Saved tweaks are invalid for RCVM containment: ${limitCheck.reason} Nothing was launched.`);
    const argCheck = require('./hyperv-runtime').validateLaunchArgs(appRecord.launchArgs);
    if (!argCheck.ok) throw new Error(`Saved launch arguments are invalid: ${argCheck.reason} Nothing was launched.`);
    const profile = ensureRcvmProfile(sandboxRoot);
    const scriptText = rcvm.buildRcvmLaunchScript({
      jobName: rcvm.rcvmJobName(appRecord.id),
      executablePath: appRecord.source,
      workingDirectory: sandboxRoot,
      appDataDir: profile.appData,
      localAppDataDir: profile.localAppData,
      tempDir: profile.temp,
      userProfileDir: profile.userProfile,
      launchArgs: argCheck.args || '',
      memoryCapBytes: limitCheck.limits.memoryCapBytes,
      cpuRate: limitCheck.limits.cpuRate,
      maxProcesses: limitCheck.limits.maxProcesses,
    });
    const scriptPath = path.join(app.getPath('userData'), `runcontainer-rcvm-${appRecord.id}.ps1`);
    fs.writeFileSync(scriptPath, scriptText, 'utf8');

    launcherChild = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true });
    const launcherPid = launcherChild.pid;
    rcvmLaunchers.set(appRecord.id, launcherChild);
    let launcherOutput = '';
    const verifyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The RCVM launcher did not report verification in time.')),
        90000);
      const poll = setInterval(() => {
        const parsed = rcvm.parseRcvmLauncherOutput(launcherOutput);
        if (parsed.error) {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(parsed.error));
        } else if (parsed.verified !== undefined) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(parsed.verified);
        }
      }, 300);
      launcherChild.once('exit', () => {
        clearTimeout(timer);
        clearInterval(poll);
        const parsed = rcvm.parseRcvmLauncherOutput(launcherOutput);
        if (parsed.verified !== undefined) resolve(parsed.verified);
        else reject(new Error(parsed.error || 'The RCVM launcher exited before verification.'));
      });
    });
    // Never an unhandled rejection when Run fails earlier on pidPromise.
    verifyPromise.catch(() => {});
    const pidPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The RCVM launcher did not report a process in time.')), 60000);
      launcherChild.stdout.on('data', (chunk) => {
        launcherOutput += String(chunk);
        const parsed = rcvm.parseRcvmLauncherOutput(launcherOutput);
        if (parsed.error) {
          clearTimeout(timer);
          reject(new Error(parsed.error));
        } else if (parsed.pid) {
          clearTimeout(timer);
          resolve(parsed.pid);
        }
      });
      launcherChild.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      launcherChild.once('exit', (code) => {
        clearTimeout(timer);
        const parsed = rcvm.parseRcvmLauncherOutput(launcherOutput);
        reject(new Error(parsed.error || `The RCVM launcher exited before the app started (code ${code}).`));
      });
    });
    launcherChild.stderr.on('data', (chunk) => appendLog(logPath, `RCVM launcher: ${String(chunk).trim()}`));
    launcherChild.on('exit', (code) => {
      rcvmLaunchers.delete(appRecord.id);
      appendLog(logPath, `RCVM launcher exited (code ${code}); its job object ends the app tree with it.`);
    });

    const pid = await pidPromise;

    // Post-launch verification of the ACTUAL process (IsProcessInJob against
    // our job + enforced limits). Anything unverified is killed, never reported.
    const verified = await verifyPromise;
    if (!verified || verified.inJob !== true || verified.limits !== true) {
      const why = !verified
        ? 'the launcher never reported verification'
        : verified.inJob !== true
          ? 'the app process is not inside its Job Object'
          : 'the Job Object limits do not match the enforced policy';
      throw new Error(`Containment verification failed: ${why}.`);
    }
    appendLog(logPath, `Verified: PID ${pid} is inside its Job Object with enforced limits (token integrity RID ${verified.integrityRid ?? 'unknown'}).`);

    let pids = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      pids = findAppProcessIds(await listProcessTable(), sandboxRoot, [pid]);
      if (pids.length > 0) break;
      await delay(400);
    }
    if (pids.length === 0) throw new Error('The contained process exited before RunContainer could confirm it.');

    const base = getStoredApp(appRecord.id) || appRecord;
    const updatedApp = {
      ...withTrackedPids(base, pids),
      status: 'Running',
      launchMode: 'rcvm',
      activeEngine: 'rcvm',
      isolated: true,
      isolationLevel: 'container',
      rcvmJob: rcvm.rcvmJobName(appRecord.id),
      rcvmLauncherPid: launcherPid,
      pid,
      sandboxPids: pids,
      lastLaunchedAt: new Date().toISOString(),
      launchCleanupPending: false,
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updatedApp : entry)));
    appendLog(logPath, `Launched contained (RCVM job ${updatedApp.rcvmJob}, memory cap ${limitCheck.limits.memoryMB} MB, ${limitCheck.limits.cpuCount} CPUs of compute, ${limitCheck.limits.maxProcesses} processes), PID ${pid}. Profile folders redirected under the environment.`);
    monitorAppProcesses(appRecord.id, logPath);
    broadcastContainerStatus(updatedApp);
    // Hosting is presentation only and must never hold up the launch or fail it, so it runs
    // after the launch result is already decided.
    hostAppWindow(updatedApp, pid, logPath).then(() => {
      const latest = getStoredApp(appRecord.id);
      if (latest) broadcastContainerStatus(latest);
    }).catch(() => {});
    return {
      id: appRecord.id,
      status: 'Running',
      pid,
      sandboxPids: pids,
      launchMode: 'rcvm',
      activeEngine: 'rcvm',
      isolated: true,
      isolationLevel: 'container',
      embedded: false,
      reason: `Running contained (RCVM): Job Object caps hold its lifetime and resources, and its profile folders stay inside its environment. Works on all Windows editions. This is process containment, not a hardware VM, and it does not cut network access.`,
    };
  } catch (error) {
    appendLog(logPath, `RCVM launch failed: ${error.message}`);
    if (launcherChild) {
      try {
        launcherChild.kill();
      } catch (killError) {
        appendLog(logPath, `RCVM launcher cleanup: ${killError.message}`);
      }
      rcvmLaunchers.delete(appRecord.id);
    }
    const remaining = await stopProcessesUnder(sandboxRoot, trackedPids(appRecord), { logPath }).catch(() => []);
    return failedLaunch(appRecord, remaining.length > 0
      ? `${error.message} A process may still be running; Delete this app or close it before retrying. Nothing was launched without containment.`
      : `${error.message} Nothing was launched without containment.`);
  }
}

// --- RCVM genuine-VM backend (QEMU) ------------------------------------------
// A REAL virtual machine per environment, managed by RunContainer with QEMU as
// the engine. Per-env overlay disk on a read-only base image, QMP management on
// localhost, guest-agent channel for readiness/install/exec/shutdown, no virtual
// network by default. QEMU is a detected dependency (not bundled); the Windows
// guest image and licence always come from media the user owns.
const qemuProcs = new Map();
const qemuMonitors = new Map();
const qemuAgentHolders = new Map();

function qemuStorePath() {
  return path.join(app.getPath('userData'), 'runcontainer-qemu.json');
}

function loadQemuStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(qemuStorePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveQemuStore(store) {
  fs.writeFileSync(qemuStorePath(), JSON.stringify(store || {}, null, 2), 'utf8');
}

function isQemuEnv(appRecord) {
  if (!appRecord) return false;
  if (appRecord.launchMode === 'qemu' || appRecord.activeEngine === 'qemu') return true;
  if (appRecord.isolationEngine === 'qemu') return true;
  try {
    const qemu = require('./qemu-runtime');
    return fs.existsSync(qemu.qemuEnvPaths(appRecord.sandboxRoot || '').diskPath);
  } catch (error) {
    return false;
  }
}

// Provisioned = detected QEMU binary (supported version) + base image file.
function isQemuProvisioned() {
  try {
    const store = loadQemuStore();
    if (!store.qemuSystem || !store.qemuImg || !store.baseImage) return false;
    if (!fs.existsSync(store.qemuSystem) || !fs.existsSync(store.qemuImg)) return false;
    if (!fs.existsSync(store.baseImage)) return false;
    return true;
  } catch (error) {
    return false;
  }
}

function discoverQemu() {
  const qemu = require('./qemu-runtime');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const bundled = path.join(process.resourcesPath || '', 'qemu');
  for (const dir of qemu.candidateQemuDirs({ bundledDir: bundled, programFiles, programFilesX86 })) {
    try {
      const system = path.join(dir, qemu.QEMU_SYSTEM_BINARY);
      const img = path.join(dir, qemu.QEMU_IMG_BINARY);
      if (!fs.existsSync(system) || !fs.existsSync(img)) continue;
      return { qemuSystem: system, qemuImg: img };
    } catch (error) {
      // Try the next candidate.
    }
  }
  // Last resort: PATH lookup for qemu-img (proves a usable install).
  return null;
}

async function qemuBinaryVersion(qemuSystem) {
  const qemu = require('./qemu-runtime');
  const { stdout } = await executeFile(qemuSystem, ['--version'], { timeout: 15000 });
  return qemu.parseQemuVersion(stdout);
}

async function probeQemuAccel(qemuSystem, accel) {
  const qemu = require('./qemu-runtime');
  return new Promise((resolve) => {
    const child = spawn(qemuSystem, qemu.buildAccelProbeArgs({ accel }), { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (error) { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(qemu.parseAccelProbe({ accel, timedOut: true, stderr })), 12000);
    child.on('error', () => {
      clearTimeout(timer);
      finish({ supported: false, reason: `${accel}: QEMU could not be started.` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(qemu.parseAccelProbe({ accel, timedOut: false, exitCode: code, stderr }));
    });
  });
}

async function refreshQemuStatus() {
  const qemu = require('./qemu-runtime');
  const store = loadQemuStore();
  const missing = [];
  let { qemuSystem, qemuImg, version } = store;
  if (!qemuSystem || !fs.existsSync(qemuSystem)) {
    const found = discoverQemu();
    if (found) {
      qemuSystem = found.qemuSystem;
      qemuImg = found.qemuImg;
    } else {
      missing.push('QEMU is not installed. Install it (https://www.qemu.org/download/ — Windows builds) or set QEMU_HOME, then press Detect.');
    }
  }
  if (qemuSystem && (!version || !qemu.isSupportedQemuVersion(version))) {
    try {
      version = await qemuBinaryVersion(qemuSystem);
    } catch (error) {
      version = null;
    }
    if (!qemu.isSupportedQemuVersion(version)) {
      missing.push(`QEMU ${version || 'unknown'} is too old or unreadable (need ${qemu.QEMU_MIN_VERSION}+).`);
    }
  }
  let accel = store.accel;
  if (qemuSystem && qemu.isSupportedQemuVersion(version) && !qemu.QEMU_ACCELS.includes(accel)) {
    const whpx = await probeQemuAccel(qemuSystem, 'whpx');
    accel = whpx.supported ? 'whpx' : 'tcg';
    if (accel === 'tcg') {
      missing.push(`WHPX acceleration is unavailable (${whpx.reason}); TCG software emulation will be used and a Windows guest will feel slow.`);
    }
  }
  const baseImage = store.baseImage && fs.existsSync(store.baseImage) ? store.baseImage : null;
  if (!baseImage) {
    missing.push('No base image provisioned. Supply a Windows disk image you own (Settings → QEMU VM setup); QEMU ships no guest OS or licence.');
  }
  const status = {
    available: missing.filter((m) => !m.startsWith('WHPX')).length === 0,
    qemuSystem: qemuSystem || null,
    qemuImg: qemuImg || null,
    version: version || null,
    accel: accel || null,
    baseImage,
    missing,
  };
  saveQemuStore({ ...store, qemuSystem, qemuImg, version, accel, baseImage: baseImage || store.baseImage || null });
  return status;
}

// One-shot QMP request: connect, handshake, command, close. Localhost only.
function qmpRequest({ port, command, args, timeoutMs = 15000 }) {
  const qemu = require('./qemu-runtime');
  const net = require('net');
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buf = '';
    let step = 'greeting';
    const id = Math.floor(Math.random() * 1000000) + 1;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`QMP ${command} timed out.`));
    }, timeoutMs);
    const finish = (fn) => { clearTimeout(timer); try { sock.destroy(); } catch (error) { /* closed */ } fn(); };
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const { messages, rest } = qemu.parseQmpStream(buf);
      buf = rest;
      for (const msg of messages) {
        if (msg.QMP && step === 'greeting') {
          step = 'capabilities';
          sock.write(`${JSON.stringify({ execute: 'qmp_capabilities' })}\n`);
        } else if (step === 'capabilities' && msg.return !== undefined) {
          step = 'command';
          const frame = { execute: command, id };
          if (args) frame.arguments = args;
          sock.write(`${JSON.stringify(frame)}\n`);
        } else if (step === 'command' && msg.id === id) {
          if (msg.error) finish(() => reject(new Error(`QMP ${command} failed: ${msg.error.desc || JSON.stringify(msg.error)}`)));
          else finish(() => resolve(msg.return));
        }
      }
    });
    sock.on('error', (error) => finish(() => reject(error)));
    sock.connect(port, '127.0.0.1');
  });
}

async function waitQemuQmp(port, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const status = await qmpRequest({ port, command: 'query-status', timeoutMs: 8000 });
      if (status && (status.status === 'running' || status.status === 'prelaunch')) return status;
      lastError = new Error(`VM status is ${status?.status || 'unknown'}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(2000);
  }
  throw lastError || new Error('QMP did not answer.');
}

async function waitQemuAgent(port, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await qmpRequest({ port, command: 'guest-ping', timeoutMs: 10000 });
      return true;
    } catch (error) {
      lastError = error;
    }
    await delay(5000);
  }
  throw new Error(`Guest agent did not answer: ${lastError?.message || 'no agent'}. Install Windows with qemu-guest-agent in the base image first.`);
}

function qemuVmConfigFor(appRecord) {
  const qemu = require('./qemu-runtime');
  const stored = (() => {
    try {
      const raw = fs.readFileSync(qemu.qemuEnvPaths(appRecord.sandboxRoot || '').vmConfigPath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      return {};
    }
  })();
  return qemu.validateQemuVmConfig({
    memoryMB: stored.memoryMB ?? appRecord.vmMemoryMB ?? 4096,
    cpuCount: stored.cpuCount ?? appRecord.vmCpuCount ?? 2,
    diskGB: stored.diskGB ?? 40,
  });
}

async function ensureQemuEnvDisk(appRecord, vmConfig) {
  const qemu = require('./qemu-runtime');
  const store = loadQemuStore();
  if (!store.baseImage || !fs.existsSync(store.baseImage)) {
    throw new Error('No base image provisioned. Open Settings → QEMU VM setup and provision one from Windows media you own.');
  }
  const paths = qemu.qemuEnvPaths(appRecord.sandboxRoot);
  fs.mkdirSync(paths.qemuDir, { recursive: true });
  fs.writeFileSync(paths.vmConfigPath, JSON.stringify({ ...vmConfig, accel: store.accel || 'tcg' }, null, 2), 'utf8');
  if (fs.existsSync(paths.diskPath)) return paths;
  await executeFile(store.qemuImg, qemu.buildImgCreateOverlayArgs({ overlayPath: paths.diskPath, basePath: store.baseImage }), { timeout: 120000 });
  if (!fs.existsSync(paths.diskPath)) throw new Error('qemu-img did not create the environment disk.');
  return paths;
}

function stopQemuMonitor(appId) {
  const monitor = qemuMonitors.get(appId);
  if (monitor) clearInterval(monitor);
  qemuMonitors.delete(appId);
}

async function bootQemuEnv(appRecord, { display = 'sdl' } = {}) {
  const qemu = require('./qemu-runtime');
  const store = loadQemuStore();
  const configCheck = qemuVmConfigFor(appRecord);
  if (!configCheck.ok) throw new Error(`${configCheck.reason} Nothing was launched.`);
  const paths = await ensureQemuEnvDisk(appRecord, configCheck.config);
  const stored = JSON.parse(fs.readFileSync(paths.vmConfigPath, 'utf8'));
  const port = qemu.qmpPortFor(appRecord.id);
  // Stale state: a dead QEMU leaves a pidfile and record behind. Reap it.
  try {
    const stalePid = Number(fs.readFileSync(paths.pidfilePath, 'utf8'));
    let alive = false;
    if (Number.isSafeInteger(stalePid) && stalePid > 0) {
      try { process.kill(stalePid, 0); alive = true; } catch (error) { alive = false; }
    }
    if (alive) {
      try {
        await qmpRequest({ port, command: 'query-status', timeoutMs: 5000 });
        return { port, reused: true };
      } catch (error) {
        try { await executeFile('taskkill.exe', ['/F', '/PID', String(stalePid)]); } catch (killError) { /* gone */ }
      }
    }
    fs.rmSync(paths.pidfilePath, { force: true });
  } catch (error) {
    // No pidfile: fresh boot.
  }
  const args = qemu.buildQemuBootArgs({
    accel: stored.accel || store.accel || 'tcg',
    memoryMB: configCheck.config.memoryMB,
    cpuCount: configCheck.config.cpuCount,
    diskPath: paths.diskPath,
    qmpPort: port,
    agentPipe: qemu.agentPipeFor(appRecord.id),
    pidfilePath: paths.pidfilePath,
    vmName: qemu.shortVmName(appRecord.id),
    display,
  });
  const logPath = path.join(appRecord.logsRoot || path.join(appRecord.sandboxRoot, 'logs'), 'qemu.log');
  appendLog(logPath, `Booting genuine VM (QEMU ${stored.accel || store.accel || 'tcg'}): ${store.qemuSystem} ${args.join(' ')}`);
  const child = spawn(store.qemuSystem, args, { windowsHide: true });
  qemuProcs.set(appRecord.id, child);
  child.stderr.on('data', (chunk) => appendLog(logPath, `qemu: ${String(chunk).trim()}`));
  child.on('exit', (code) => {
    qemuProcs.delete(appRecord.id);
    const holder = qemuAgentHolders.get(appRecord.id);
    if (holder) {
      try { holder.destroy(); } catch (error) { /* closed */ }
      qemuAgentHolders.delete(appRecord.id);
    }
    appendLog(logPath, `QEMU exited (code ${code}).`);
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  // The pipe-backend agent channel stalls machine init until the host connects,
  // so hold it open from boot until the VM stops (verified against real QEMU).
  const agentSocket = await (async () => {
    const net = require('net');
    const pipePath = qemu.agentPipePath(qemu.agentPipeFor(appRecord.id));
    const deadline = Date.now() + 30000;
    let lastError = null;
    while (Date.now() < deadline) {
      const connected = await new Promise((resolve) => {
        const sock = new net.Socket();
        sock.once('connect', () => resolve(sock));
        sock.once('error', (error) => { lastError = error; sock.destroy(); resolve(null); });
        sock.connect(pipePath);
      });
      if (connected) return connected;
      await delay(500);
    }
    throw new Error(`Agent pipe did not accept the host connection: ${lastError?.message || 'pipe missing'}.`);
  })();
  qemuAgentHolders.set(appRecord.id, agentSocket);
  agentSocket.once('error', () => {});
  agentSocket.once('close', () => qemuAgentHolders.delete(appRecord.id));
  const status = await waitQemuQmp(port);
  appendLog(logPath, `VM QMP status: ${status.status}.`);
  return { port, reused: false, qemuPid: child.pid };
}

async function qemuGuestExec(port, exePath, args = [], { timeoutMs = 1800000, captureOutput = false } = {}) {
  const spawnResult = await qmpRequest({ port, command: 'guest-exec', args: { path: exePath, arg: args, 'capture-output': captureOutput }, timeoutMs: 30000 });
  const guestPid = spawnResult?.pid;
  if (!Number.isSafeInteger(guestPid)) throw new Error('Guest agent did not return a process id.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await qmpRequest({ port, command: 'guest-exec-status', args: { pid: guestPid }, timeoutMs: 15000 });
    if (state?.exited) return { guestPid, exitCode: state.exitcode, stdout: state['out-data'], stderr: state['err-data'] };
    await delay(2000);
  }
  throw new Error(`Guest process ${guestPid} did not exit in time.`);
}

async function qemuTransferFile(port, hostPath, guestPath, logPath) {
  const stat = fs.statSync(hostPath);
  const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
  if (stat.size > MAX_TRANSFER_BYTES) {
    throw new Error(`Installer is ${(stat.size / 1024 / 1024).toFixed(0)} MB; guest transfer supports up to 512 MB. Split it or install from ISO media.`);
  }
  const handle = await qmpRequest({ port, command: 'guest-file-open', args: { path: guestPath, mode: 'wb' }, timeoutMs: 30000 });
  if (!Number.isSafeInteger(handle)) throw new Error('Guest agent refused the file transfer.');
  try {
    const fd = fs.openSync(hostPath, 'r');
    try {
      const CHUNK = 192 * 1024; // base64-safe multiple of 3
      const buffer = Buffer.alloc(CHUNK);
      let offset = 0;
      let bytes = 0;
      do {
        bytes = fs.readSync(fd, buffer, 0, CHUNK, offset);
        if (bytes > 0) {
          await qmpRequest({ port, command: 'guest-file-write', args: { handle, 'buf-b64': buffer.subarray(0, bytes).toString('base64') }, timeoutMs: 60000 });
          offset += bytes;
          if (logPath && offset % (CHUNK * 16) === 0) appendLog(logPath, `Transfer ${(offset / 1024 / 1024).toFixed(0)} MB / ${(stat.size / 1024 / 1024).toFixed(0)} MB…`);
        }
      } while (bytes > 0);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    await qmpRequest({ port, command: 'guest-file-close', args: { handle }, timeoutMs: 30000 }).catch(() => {});
  }
}

function stagedQemuInstaller(appRecord) {
  const candidates = [];
  if (appRecord.source && fs.existsSync(appRecord.source) && /\.exe$/i.test(appRecord.source)) {
    candidates.push(appRecord.source);
  }
  const incoming = path.join(appRecord.sandboxRoot || '', 'incoming');
  try {
    for (const entry of fs.readdirSync(incoming)) {
      if (/\.exe$/i.test(entry)) candidates.push(path.join(incoming, entry));
    }
  } catch (error) {
    // No staged installer.
  }
  return candidates[0] || null;
}

async function qemuInstallApp(appRecord, logPath, port) {
  const installerHostPath = stagedQemuInstaller(appRecord);
  if (!installerHostPath) {
    throw new Error('No staged installer found for guest installation. Reinstall the app so its installer is staged, then Run again.');
  }
  const guestDir = 'C:/RunContainer/incoming';
  await qemuGuestExec(port, 'C:\\Windows\\System32\\cmd.exe', ['/c', 'mkdir', guestDir.replace(/\//g, '\\')], { timeoutMs: 60000 }).catch(() => {});
  const guestPath = `${guestDir}/${path.win32.basename(installerHostPath)}`;
  appendLog(logPath, `Copying installer into the guest (${(fs.statSync(installerHostPath).size / 1024 / 1024).toFixed(1)} MB)…`);
  await qemuTransferFile(port, installerHostPath, guestPath.replace(/\//g, '\\'), logPath);
  appendLog(logPath, `Running installer inside the guest with its display window. Complete any setup dialogs there.`);
  const result = await qemuGuestExec(port, guestPath.replace(/\//g, '\\'), [], { timeoutMs: 1800000 });
  appendLog(logPath, `Guest installer exited with code ${result.exitCode}.`);
  const apps = loadApps().map((entry) => (entry.id === appRecord.id
    ? { ...entry, qemuInstalledReceipt: { exitCode: result.exitCode, at: new Date().toISOString(), installer: guestPath } }
    : entry));
  saveApps(apps);
  return result;
}

async function runWithQemu(appRecord, sandboxRoot, logPath) {
  const qemu = require('./qemu-runtime');
  try {
    const status = await refreshQemuStatus();
    if (!status.available) {
      throw new Error(`QEMU backend is not ready: ${status.missing.join(' ')}`);
    }
    const { port } = await bootQemuEnv(appRecord);
    appendLog(logPath, 'Waiting for the guest agent (Windows must be installed in the base image with qemu-guest-agent)…');
    await waitQemuAgent(port);
    const fresh = getStoredApp(appRecord.id) || appRecord;
    if (!fresh.qemuInstalledReceipt) {
      appendLog(logPath, 'First run: installing the app inside the guest.');
      await qemuInstallApp(fresh, logPath, port);
    }
    const target = (getStoredApp(appRecord.id) || fresh).installedExeGuestPath;
    if (!target) {
      throw new Error('Guest installation finished, but no guest exe path is set. Open Manage → guest exe path and set where the app installed inside the guest (browse it in the VM window), then Run again.');
    }
    const argCheck = require('./hyperv-runtime').validateLaunchArgs(fresh.launchArgs);
    if (!argCheck.ok) throw new Error(`Saved launch arguments are invalid: ${argCheck.reason} Nothing was launched.`);
    appendLog(logPath, `Launching inside the guest: ${target}`);
    const launched = await qmpRequest({ port, command: 'guest-exec', args: { path: target, arg: argCheck.args ? [argCheck.args] : [] }, timeoutMs: 30000 });
    if (!Number.isSafeInteger(launched?.pid)) throw new Error('Guest agent did not start the app.');
    await delay(3000);
    const state = await qmpRequest({ port, command: 'guest-exec-status', args: { pid: launched.pid }, timeoutMs: 15000 });
    if (state?.exited) throw new Error(`Guest app exited immediately (code ${state.exitcode}).`);
    const hostQemu = qemuProcs.get(appRecord.id);
    const base = getStoredApp(appRecord.id) || appRecord;
    const updatedApp = {
      ...withTrackedPids(base, hostQemu?.pid ? [hostQemu.pid] : []),
      status: 'Running',
      launchMode: 'qemu',
      activeEngine: 'qemu',
      isolated: true,
      isolationLevel: 'vm',
      qemuPid: hostQemu?.pid || null,
      qemuPort: port,
      guestPid: launched.pid,
      guestPids: [launched.pid],
      pid: hostQemu?.pid || null,
      sandboxPids: hostQemu?.pid ? [hostQemu.pid] : [],
      lastLaunchedAt: new Date().toISOString(),
      launchCleanupPending: false,
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updatedApp : entry)));
    appendLog(logPath, `App running inside genuine VM (host QEMU PID ${updatedApp.qemuPid}, guest PID ${launched.pid}). View it in the VM window.`);
    monitorQemuApp(appRecord.id, port, launched.pid, logPath);
    broadcastContainerStatus(updatedApp);
    return {
      id: appRecord.id,
      status: 'Running',
      pid: updatedApp.qemuPid,
      sandboxPids: updatedApp.sandboxPids,
      launchMode: 'qemu',
      activeEngine: 'qemu',
      isolated: true,
      isolationLevel: 'vm',
      guestPid: launched.pid,
      embedded: false,
      reason: `Running inside a genuine QEMU virtual machine (guest PID ${launched.pid}, verified via the guest agent). The app executes in the guest OS, never on the host.`,
    };
  } catch (error) {
    appendLog(logPath, `QEMU launch failed: ${error.message}`);
    return failedLaunch(appRecord, `${error.message} Nothing was launched outside a VM.`);
  }
}

function monitorQemuApp(appId, port, guestPid, logPath) {
  stopQemuMonitor(appId);
  const timer = setInterval(async () => {
    try {
      const state = await qmpRequest({ port, command: 'guest-exec-status', args: { pid: guestPid }, timeoutMs: 10000 });
      if (state?.exited) {
        stopQemuMonitor(appId);
        const apps = loadApps().map((entry) => (entry.id === appId
          ? { ...withTrackedPids(entry, []), status: 'Stopped', guestPid: null, guestPids: [], lastExitAt: new Date().toISOString() }
          : entry));
        saveApps(apps);
        appendLog(logPath, `Guest app exited (code ${state.exitcode}).`);
        const updated = apps.find((entry) => entry.id === appId);
        if (updated) broadcastContainerStatus(updated);
      }
    } catch (error) {
      // Guest unreachable: leave state alone; Run reconciles, Stop/Reset recover.
    }
  }, 15000);
  qemuMonitors.set(appId, timer);
}

// Graceful shutdown first (guest agent, then ACPI), power-off escalation only
// after timeouts, host kill last. Safe no-op for non-QEMU apps.
async function stopQemuEnv(appRecord, logPath) {
  if (!isQemuEnv(appRecord)) return { stopped: true, skipped: true };
  const qemu = require('./qemu-runtime');
  stopQemuMonitor(appRecord.id);
  const port = appRecord.qemuPort || qemu.qmpPortFor(appRecord.id);
  const child = qemuProcs.get(appRecord.id);
  const recordPid = appRecord.qemuPid;
  try {
    try {
      await qmpRequest({ port, command: 'guest-shutdown', args: { mode: 'powerdown' }, timeoutMs: 10000 });
      if (logPath) appendLog(logPath, 'Guest shutdown requested via agent; waiting up to 120s.');
    } catch (agentError) {
      try {
        await qmpRequest({ port, command: 'system_powerdown', timeoutMs: 10000 });
        if (logPath) appendLog(logPath, 'Agent shutdown unavailable; ACPI powerdown requested; waiting up to 120s.');
      } catch (acpiError) {
        if (logPath) appendLog(logPath, `No graceful path answered (${acpiError.message}); terminating the VM process.`);
      }
    }
    const deadline = Date.now() + 120000;
    let off = false;
    while (Date.now() < deadline) {
      const alive = (() => {
        if (child && child.exitCode === null) return true;
        if (Number.isSafeInteger(recordPid) && recordPid > 0) {
          try { process.kill(recordPid, 0); return true; } catch (error) { return false; }
        }
        return false;
      })();
      if (!alive) { off = true; break; }
      try {
        const st = await qmpRequest({ port, command: 'query-status', timeoutMs: 5000 });
        if (st?.status === 'shutdown') { off = true; break; }
      } catch (error) {
        // QMP gone: process likely exiting; re-check liveness next loop.
      }
      await delay(3000);
    }
    if (!off) {
      if (logPath) appendLog(logPath, 'VM did not shut down in 120s; forcing termination.');
      try { await qmpRequest({ port, command: 'quit', timeoutMs: 8000 }); } catch (error) { /* closing */ }
      await delay(3000);
    }
  } finally {
    const holder = qemuAgentHolders.get(appRecord.id);
    if (holder) {
      try { holder.destroy(); } catch (error) { /* closed */ }
      qemuAgentHolders.delete(appRecord.id);
    }
    if (child) {
      try { child.kill(); } catch (error) { /* gone */ }
      qemuProcs.delete(appRecord.id);
    }
    if (Number.isSafeInteger(recordPid) && recordPid > 0) {
      try { await executeFile('taskkill.exe', ['/F', '/PID', String(recordPid)]); } catch (error) { /* gone */ }
    }
  }
  return { stopped: true };
}

async function qemuDeleteEnv(appRecord, logPath) {
  if (!isQemuEnv(appRecord)) return { deleted: false, skipped: true };
  const qemu = require('./qemu-runtime');
  await stopQemuEnv(appRecord, logPath);
  const store = loadQemuStore();
  const paths = qemu.qemuEnvPaths(appRecord.sandboxRoot || '');
  for (const candidate of [paths.diskPath, path.join(paths.qemuDir, 'transfer.qcow2')]) {
    if (!fs.existsSync(candidate)) continue;
    const check = qemu.validateQemuDiskTarget({ candidate, envDir: appRecord.sandboxRoot, baseImagePath: store.baseImage });
    if (!check.ok) throw new Error(check.reason);
    fs.unlinkSync(candidate);
    if (fs.existsSync(candidate)) throw new Error(`Could not confirm removal of ${candidate}.`);
    if (logPath) appendLog(logPath, `Removed environment disk ${candidate} (base image untouched).`);
  }
  fs.rmSync(paths.vmConfigPath, { force: true });
  fs.rmSync(paths.pidfilePath, { force: true });
  return { deleted: true };
}

// Reset keeps the overlay disk (installed apps + data) and boots the guest fresh.
async function resetQemuEnv(appRecord, appLog) {
  try {
    return await withOpLock(appRecord.id, 'reset', async () => {
      await stopQemuEnv(appRecord, appLog);
      const apps = loadApps().map((entry) => (entry.id === appRecord.id
        ? { ...withTrackedPids(entry, []), status: 'Stopped', pid: null, sandboxPids: [], guestPid: null, guestPids: [], qemuPid: null, lastResetAt: new Date().toISOString() }
        : entry));
      saveApps(apps);
      appendLog(appLog, 'Environment reset: VM stopped, overlay disk and data kept. Next Run boots fresh.');
      const updated = apps.find((entry) => entry.id === appRecord.id);
      if (updated) broadcastContainerStatus(updated);
      return { id: appRecord.id, status: 'Stopped', reset: true };
    });
  } catch (error) {
    appendLog(appLog, `QEMU reset failed: ${error.message}`);
    return { id: appRecord.id, status: 'Failed', error: error.message };
  }
}

function guestCredentialFile() {
  const hv = require('./hyperv-runtime');
  return hv.guestCredentialFilePath(app.getPath('userData'));
}

function hyperVBaseImagePath() {
  return process.env.RUNCONTAINER_HYPERV_BASE_IMAGE || null;
}

async function checkHyperVReady() {
  if (process.platform !== 'win32') return { ready: false, missing: ['Isolation requires Windows 10/11.'] };
  try {
    const script = buildHyperVPrereqScript({ dataDir: app.getPath('userData'), requiredFreeGB: 40 });
    const tmp = path.join(app.getPath('userData'), 'runcontainer-hyperv-prereq.ps1');
    fs.writeFileSync(tmp, script, 'utf8');
    const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { timeout: 60000 });
    const detail = parseHyperVPrereqOutput(stdout);
    const missing = hyperVMissingRequirements(detail);
    return { ready: missing.length === 0, missing, detail };
  } catch (error) {
    return { ready: false, missing: [`Hyper-V readiness could not be confirmed: ${error.message}`] };
  }
}

async function runHyperVScript(scriptText, logPath) {
  const tmp = path.join(app.getPath('userData'), `runcontainer-hyperv-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, scriptText, 'utf8');
  try {
    const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { timeout: 300000 });
    return parseHyperVOutput(stdout);
  } catch (error) {
    try {
      return parseHyperVOutput(String(error.message));
    } catch (unreadable) {
      throw error;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (cleanupError) {}
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    title: 'RunContainer',
    show: false,
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'runcontainer-icon.svg'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
  });

  mainWindow.setTitle('RunContainer');
  // Links open in the default browser, never in a new RunContainer window. Only https is passed on.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `render-process-gone: ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on('unresponsive', () => {
    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), 'renderer unresponsive');
  });
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    appendLog(path.join(app.getPath('userData'), 'runcontainer-console.log'), `console:${level} ${message} (${sourceId}:${line})`);
  });

  const buildCandidates = [
    path.join(__dirname, '..', 'build', 'index.html'),
    path.join(__dirname, '..', 'build', 'build', 'index.html'),
    path.join(process.resourcesPath || '', 'app', 'build', 'index.html'),
    path.join(process.resourcesPath || '', 'app', 'build', 'build', 'index.html'),
  ].filter(Boolean);
  const devServerUrl = 'http://localhost:3000';

  const buildPath = buildCandidates.find((candidate) => fs.existsSync(candidate));

  if (app.isPackaged || buildPath) {
    mainWindow.loadFile(buildPath || buildCandidates[0]).catch((error) => {
      console.error('Failed to load packaged UI:', error);
    });
  } else {
    mainWindow.loadURL(devServerUrl).catch((error) => {
      console.error('Failed to load dev server:', error);
      const fallbackPath = buildCandidates.find((candidate) => fs.existsSync(candidate));
      if (fallbackPath) {
        mainWindow.loadFile(fallbackPath).catch((fallbackError) => {
          console.error('Failed to load fallback UI:', fallbackError);
        });
      }
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.send('app:boot-sequence', { stage: 'ready' });
  });
}

app.whenReady().then(() => {
  try {
    const apps = loadApps();
    let changed = false;
    const reconciled = apps.map((entry) => {
      if (entry.status === 'Running') {
        changed = true;
        return { ...entry, status: 'Unknown', statusNote: 'RunContainer restarted while this app was marked Running. Its live state is unknown: Run reconciles and resumes, Stop attempts a clean stop.' };
      }
      return entry;
    });
    if (changed) saveApps(reconciled);
  } catch (error) {
    // A corrupt store must not prevent startup; list-apps surfaces it per record.
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Executables', extensions: ['exe'] }],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('list-apps', async () => {
  const snapshot = loadApps().filter((entry) => entry.status === 'Running');
  const updatesById = new Map();
  await Promise.all(snapshot.map(async (entry) => {
    try {
      const pids = await listRunningPids(entry);
      if (pids.length === 0) {
        stopMonitor(entry.id);
        updatesById.set(entry.id, { status: 'Stopped', pid: null, sandboxPids: [], lastExitAt: new Date().toISOString() });
      } else if (JSON.stringify(pids) !== JSON.stringify(entry.sandboxPids || [])) {
        updatesById.set(entry.id, { pid: pids[0], sandboxPids: pids });
      }
    } catch (error) {
      // Keep the persisted state if the process query is temporarily unavailable.
    }
  }));
  const reconciled = loadApps().map((entry) => {
    const root = entry.sandboxRoot || (entry.source ? path.dirname(entry.source) : '');
    return {
      ...entry,
      envDirPresent: root ? fs.existsSync(root) : false,
      sourcePresent: entry.source ? fs.existsSync(entry.source) : false,
      diskPresent: entry.hypervVhd ? fs.existsSync(entry.hypervVhd) : null,
    };
  });
  if (updatesById.size === 0) return reconciled;
  // Re-read the store after the async checks so apps deleted or added in the meantime are not resurrected.
  const current = mergeStatusUpdates(reconciled, updatesById);
  saveApps(current.map(({ envDirPresent, sourcePresent, diskPresent, ...rest }) => rest));
  return current;
});

async function installExe(exePath) {
  const validation = validateExe(exePath);
  if (!validation.isValid) throw new Error(validation.reason);

  const appId = crypto.randomUUID();
  const baseName = sanitizeName(path.basename(exePath, path.extname(exePath)));
  const sandboxRoot = path.join(sandboxRootBase, `app-${appId}`);
  const sandboxLayout = ensureSandboxLayout(sandboxRoot);
  const destination = path.join(sandboxRoot, path.basename(exePath));
  fs.copyFileSync(exePath, destination);

  const metadata = await getExeMetadata(exePath);
  const iconPath = path.join(sandboxRoot, 'icon.ico');
  const extractedIcon = await extractExeIcon(exePath, iconPath);
  const profile = getSandboxProfile('default');
  const record = {
    id: appId,
    name: metadata.title || baseName,
    status: 'Installed',
    source: destination,
    sandboxRoot,
    runtimeRoot: sandboxLayout.runtime,
    appDataRoot: sandboxLayout.appData,
    tempRoot: sandboxLayout.temp,
    logsRoot: sandboxLayout.logs,
    desktopRoot: sandboxLayout.desktop,
    documentsRoot: sandboxLayout.documents,
    downloadsRoot: sandboxLayout.downloads,
    programFilesRoot: sandboxLayout.programFiles,
    programDataRoot: sandboxLayout.programData,
    metadata,
    iconPath: extractedIcon || null,
    permissions: { network: profile.network, filesystem: profile.filesystem, registry: profile.registry },
    profile: 'default',
    sandboxConfig: profile,
    createdAt: new Date().toISOString(),
  };
  saveApps([...loadApps(), record]);
  return record;
}

ipcMain.handle('install-exe', async (_event, exePath) => installExe(exePath));

ipcMain.handle('import-url', async (_event, url) => {
  if (!url || typeof url !== 'string') {
    throw new Error('A valid URL is required.');
  }

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') throw new Error('Only HTTPS download URLs are supported.');
  const originalName = path.basename(parsedUrl.pathname) || 'downloaded-app.exe';
  const fileName = `${sanitizeName(path.basename(originalName, path.extname(originalName)))}.exe`;
  const downloadsRoot = path.join(app.getPath('userData'), 'downloads');
  ensureDirectory(downloadsRoot);
  const outputPath = path.join(downloadsRoot, fileName);
  const downloadedPath = await downloadUrl(parsedUrl.toString(), outputPath);

  return installExe(downloadedPath);
});

ipcMain.handle('duplicate-container', async (_event, appRecord) => {
  if (!appRecord?.id || !fs.existsSync(appRecord.source || '')) throw new Error('The installed executable is missing.');
  const appId = crypto.randomUUID();
  const sandboxRoot = path.join(sandboxRootBase, `app-${appId}`);
  const layout = ensureSandboxLayout(sandboxRoot);
  const destination = path.join(sandboxRoot, path.basename(appRecord.source));
  fs.copyFileSync(appRecord.source, destination);
  const iconPath = appRecord.iconPath && fs.existsSync(appRecord.iconPath)
    ? path.join(sandboxRoot, path.basename(appRecord.iconPath))
    : null;
  if (iconPath) fs.copyFileSync(appRecord.iconPath, iconPath);
  const hv = require('./hyperv-runtime');
  let clonedVhd = null;
  let cloneWarning = null;
  if ((appRecord.launchMode === 'hyperv' || appRecord.activeEngine === 'hyperv') && appRecord.hypervVhd && fs.existsSync(appRecord.hypervVhd)) {
    try {
      const newHvDir = path.join(sandboxRoot, 'hyperv');
      ensureDirectory(newHvDir);
      clonedVhd = path.join(newHvDir, `${hv.vmName(appId)}.vhdx`);
      fs.copyFileSync(appRecord.hypervVhd, clonedVhd);
    } catch (cloneError) {
      cloneWarning = `The VM disk could not be cloned (${cloneError.message}); the copy starts without guest data and reinstalls on first Run.`;
      clonedVhd = null;
    }
  }
  const duplicate = {
    ...appRecord,
    id: appId,
    name: `${appRecord.name} Copy`,
    source: destination,
    sandboxRoot,
    runtimeRoot: layout.runtime,
    appDataRoot: layout.appData,
    tempRoot: layout.temp,
    logsRoot: layout.logs,
    desktopRoot: layout.desktop,
    documentsRoot: layout.documents,
    downloadsRoot: layout.downloads,
    programFilesRoot: layout.programFiles,
    programDataRoot: layout.programData,
    iconPath,
    createdAt: new Date().toISOString(),
    hypervVm: hv.vmName(appId),
    hypervVhd: clonedVhd,
    guestPid: null,
    guestPids: [],
    installedNeedsReboot: false,
    cloneWarning: cloneWarning || undefined,
  };
  const cleanCopy = resetLaunchState(duplicate);
  saveApps([...loadApps(), cleanCopy]);
  return cleanCopy;
});

ipcMain.handle('export-container', async (_event, appRecord) => {
  const exportRoot = path.join(app.getPath('documents'), 'RunContainerExports');
  ensureDirectory(exportRoot);
  const archivePath = path.join(exportRoot, `${sanitizeName(appRecord.name)}.json`);
  fs.writeFileSync(archivePath, JSON.stringify(appRecord, null, 2), 'utf8');
  return { path: archivePath, exported: true };
});

ipcMain.handle('get-app-logs', async (_event, appRecord) => {
  const logPath = path.join(appRecord.logsRoot || path.join(appRecord.sandboxRoot || path.dirname(appRecord.source), 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
  if (!fs.existsSync(logPath)) {
    return [];
  }

  return fs.readFileSync(logPath, 'utf8').trim().split(/\n/).filter(Boolean);
});

ipcMain.handle('run-exe', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id || !appRecord?.source) {
    return { id: requestedAppRecord?.id, status: 'Failed', embedded: false, error: 'Installed app record is missing its id or executable path.' };
  }

  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source);
  if (deleteJobs.has(appRecord.id)) {
    return failedLaunch(appRecord, 'Deletion is in progress for this environment; launches are blocked until it finishes. Nothing was launched.');
  }
  if (!isWithinDirectory(sandboxRootBase, sandboxRoot)) {
    return failedLaunch(appRecord, 'The app container path is outside RunContainer’s managed directory; refusing to launch it.');
  }
  // VM environments track state in the GUEST, not the host table: probe the guest
  // before deciding the app is already running or needs a fresh launch.
  if ((appRecord.launchMode === 'hyperv' || appRecord.activeEngine === 'hyperv') && appRecord.status === 'Running' && appRecord.hypervVm && process.platform === 'win32') {
    try {
      const hv = require('./hyperv-runtime');
      const guestExe = appRecord.installedExeGuestPath || appRecord.source;
      const exeBase = path.win32.basename(guestExe, path.win32.extname(guestExe));
      const probe = await runHyperVScript(hv.buildGuestProcessQueryScript({ vm: appRecord.hypervVm, credFile: guestCredentialFile(), exeName: exeBase }), path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), 'probe.log'));
      const gpids = Array.isArray(probe.pids) ? probe.pids.filter((n) => Number.isSafeInteger(n) && n > 0) : [];
      if (gpids.length > 0) {
        const already = { ...(getStoredApp(appRecord.id) || appRecord), status: 'Running', guestPids: gpids, guestPid: gpids[0] };
        saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? already : entry)));
        monitorHyperVApp(appRecord.id, path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`));
        broadcastContainerStatus(already);
        return { id: appRecord.id, status: 'Running', guestPid: gpids[0], guestPids: gpids, hypervVm: appRecord.hypervVm, launchMode: 'hyperv', activeEngine: 'hyperv', isolationLevel: 'vm', isolated: true, embedded: false, reason: 'This app is already running inside its VM, so RunContainer did not start a second copy.' };
      }
      const stopped = { ...(getStoredApp(appRecord.id) || appRecord), status: 'Stopped', guestPid: null, guestPids: [], lastExitAt: new Date().toISOString() };
      saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? stopped : entry)));
    } catch (probeError) {
      appendLog(path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`), `Guest state probe: ${probeError.message}; proceeding to ensured launch.`);
    }
  }
  if (appRecord.launchCleanupPending) {
    return failedLaunch(appRecord, 'A previous launch could not be confirmed stopped. Delete this app or close its processes before trying Run again.');
  }
  const validation = validateExe(appRecord.source);
  if (!validation.isValid) return failedLaunch(appRecord, validation.reason);

  const logsRoot = appRecord.logsRoot || path.join(sandboxRoot, 'logs');
  const logPath = path.join(logsRoot, `${sanitizeName(appRecord.name || 'app')}.log`);
  ensureSandboxLayout(sandboxRoot);

  const existingPids = appRecord.status === 'Running'
    ? await listProcessTable().then((table) => findAppProcessIds(table, sandboxRoot, trackedPids(appRecord))).catch(() => (appRecord.pid ? [appRecord.pid] : []))
    : [];
  if (existingPids.length > 0) {
    const base = getStoredApp(appRecord.id) || appRecord;
    const alreadyRunning = { ...base, status: 'Running', pid: existingPids[0], sandboxPids: existingPids };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? alreadyRunning : entry)));
    monitorAppProcesses(appRecord.id, logPath);
    broadcastContainerStatus(alreadyRunning);
    return {
      id: appRecord.id,
      status: 'Running',
      pid: existingPids[0],
      sandboxPids: existingPids,
      launchMode: appRecord.launchMode || 'isolated-profile',
      activeEngine: appRecord.activeEngine || appRecord.launchMode || 'profile',
      isolated: Boolean(appRecord.isolated),
      embedded: false,
      reason: 'This app is already running, so RunContainer did not start a second copy.',
    };
  }
  fs.writeFileSync(logPath, `Launch started at ${new Date().toISOString()}\n`, 'utf8');
  appendLog(logPath, `Using container ${sandboxRoot}`);
  stopMonitor(appRecord.id);

  appendLog(logPath, 'Launch requested; dispatching the selected engine under an operation lock.');
  return withOpLock(appRecord.id, 'run', async () => {
    const lockedEngine = selectEngine(getStoredApp(appRecord.id) || appRecord);
    if (lockedEngine === 'refused') {
      const decision = selectIsolationEngine({ platform: process.platform, appRecord, hypervReady: true });
      return failedLaunch(appRecord, `${decision.reason} Nothing was launched.`);
    }
    if (lockedEngine === 'hyperv') {
      appendLog(logPath, 'Isolation engine: Hyper-V virtual machine (full guest OS boundary).');
      return runWithHyperV(appRecord, sandboxRoot, logPath);
    }
    if (lockedEngine === 'qemu') {
      appendLog(logPath, 'Isolation engine: RCVM genuine VM (QEMU guest, overlay disk, guest agent).');
      return runWithQemu(appRecord, sandboxRoot, logPath);
    }
    if (lockedEngine === 'appcontainer') {
      if (!isAppContainerSupported()) {
        return failedLaunch(appRecord, 'AppContainer isolation requires Windows 10/11. Use RCVM containment (all editions) or a Hyper-V VM (Pro/Enterprise/Education + virtualization). Nothing was launched.');
      }
      appendLog(logPath, 'Isolation engine: Windows AppContainer (verified container token).');
      return runWithAppContainer(appRecord, sandboxRoot, logPath);
    }
    if (lockedEngine === 'rcvm') {
      appendLog(logPath, 'Isolation engine: RCVM containment (Job Object caps + per-app profile, all Windows editions).');
      return runWithRcvm(appRecord, sandboxRoot, logPath);
    }
    return failedLaunch(appRecord, 'No isolation engine is available for this app. Nothing was launched.');
  });
});

ipcMain.handle('reset-container', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) {
    return { id: requestedAppRecord?.id, status: 'Failed', removed: false, error: 'App is not in RunContainer’s persistent app list.' };
  }

  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source || '');
  if (!sandboxRoot || !isWithinDirectory(sandboxRootBase, sandboxRoot)) {
    return { id: appRecord.id, status: 'Failed', removed: false, error: 'Refusing to delete a path outside RunContainer’s managed directory.' };
  }

  const errorLogPath = path.join(app.getPath('userData'), 'runcontainer-error.log');
  const appLogPath = path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
  // A deletion can be cancelled from the UI while it is waiting for Windows to release files.
  const job = { appId: appRecord.id, aborted: false };
  deleteJobs.set(appRecord.id, job);
  return withOpLock(appRecord.id, 'delete', async () => {
  try {
    await releaseAppWindow(appRecord, trackedPids(appRecord), errorLogPath);
    stopMonitor(appRecord.id);
    const seeds = trackedPids(appRecord);
    // Pre-refactor records may still carry a legacy sandboxieBox name. RunContainer
    // never executes Sandboxie (no backend, no tools lookup): the name is logged
    // so nothing is silently skipped, and host-file removal below still runs.
    let legacySandboxieWarning = null;
    if (appRecord.sandboxieBox) {
      legacySandboxieWarning = `Legacy Sandboxie box name ${appRecord.sandboxieBox} is ignored: RunContainer has no Sandboxie backend. Remove any Sandboxie data yourself if you created it outside RunContainer.`;
      appendLog(errorLogPath, `Sandbox cleanup note for ${appRecord.name || appRecord.id}: ${legacySandboxieWarning}`);
    }
    // Ordered VM deletion: guest app -> graceful shutdown (wait Off) -> power-off
    // escalation only after timeout -> remove VM config (verify absent) -> remove
    // ONLY this environment's differencing VHD (validated, base image never
    // touched, verify absent) -> host files. Launches are blocked throughout
    // (deleteJobs entry); success is reported only when everything is confirmed.
    let hypervWarning = null;
    const isHyperVEnv = (appRecord.launchMode === 'hyperv' || appRecord.activeEngine === 'hyperv') && appRecord.hypervVm;
    if (isHyperVEnv && process.platform === 'win32') {
      const hv = require('./hyperv-runtime');
      const baseImage = hyperVBaseImagePath();
      try {
        const guestExe = appRecord.installedExeGuestPath || appRecord.source;
        const exeBase = path.win32.basename(guestExe, path.win32.extname(guestExe));
        appendLog(errorLogPath, `Delete step stop-guest-app: closing ${exeBase} inside ${appRecord.hypervVm}.`);
        try {
          await runHyperVScript(hv.buildStopGuestAppScript({ vm: appRecord.hypervVm, credFile: guestCredentialFile(), exeName: exeBase, gracefulTimeoutSec: 15 }), errorLogPath);
        } catch (appStopError) {
          appendLog(errorLogPath, `Guest app did not exit cleanly, continuing to shutdown: ${appStopError.message}`);
        }
        appendLog(errorLogPath, 'Delete step graceful-shutdown: shutting down the guest OS (120s timeout).');
        try {
          await runHyperVScript(hv.buildGracefulShutdownScript({ vm: appRecord.hypervVm, timeoutSec: 120 }), errorLogPath);
        } catch (gracefulError) {
          appendLog(errorLogPath, `Graceful shutdown timed out (${gracefulError.message}); escalating to power-off. Guest data loss inside the deleted VM is expected.`);
          await runHyperVScript(hv.buildPowerOffScript(appRecord.hypervVm), errorLogPath);
          const offInfo = await runHyperVScript(hv.buildGetVmScript(appRecord.hypervVm), errorLogPath).catch(() => ({ exists: false }));
          if (offInfo.exists && offInfo.state !== 'Off') throw new Error(`VM ${appRecord.hypervVm} is still ${offInfo.state} after power-off; refusing to detach its disk.`);
        }
        appendLog(errorLogPath, 'Delete step remove-vm-config.');
        await runHyperVScript(hv.buildRemoveVmConfigScript(appRecord.hypervVm), errorLogPath);
        const vhd = appRecord.hypervVhd || (appRecord.sandboxRoot ? path.join(appRecord.sandboxRoot, 'hyperv', `${appRecord.hypervVm}.vhdx`) : null);
        const hvDir = appRecord.sandboxRoot ? path.join(appRecord.sandboxRoot, 'hyperv') : null;
        const targetCheck = hv.validateDeletionTarget({ candidate: vhd || '', envDir: hvDir || '', baseImagePath: baseImage || '' });
        const exactCheck = vhd && hvDir ? hv.isEnvVhdPath(vhd, hvDir, appRecord.id) : false;
        if (!targetCheck.ok || !exactCheck) {
          throw new Error(`Refusing to delete an unsafe disk path (${vhd || 'empty'}): ${targetCheck.reason || 'not this environment\'s differencing disk'}. The VM config was removed; delete the disk manually after verifying it.`);
        }
        appendLog(errorLogPath, `Delete step remove-env-vhd: ${vhd} (this environment's differencing disk only; base image untouched).`);
        let diskRemoved = false;
        let diskError = null;
        for (let attempt = 0; attempt < 5 && !diskRemoved; attempt += 1) {
          try {
            fs.unlinkSync(vhd);
            diskRemoved = !fs.existsSync(vhd);
          } catch (retryError) {
            diskError = retryError;
            await delay(2000);
          }
        }
        if (!diskRemoved) {
          throw new Error(`Could not remove the environment disk ${vhd}: ${diskError ? diskError.message : 'still present'}. The VM config is gone so Hyper-V no longer holds it; close anything else holding the file (antivirus/backup/indexer) and run Delete again. Exact path above.`);
        }
        appendLog(errorLogPath, `Removed Hyper-V VM ${appRecord.hypervVm} and its disk. Base image preserved.`);
      } catch (hypervError) {
        hypervWarning = hypervError.message;
        appendLog(errorLogPath, `Hyper-V deletion failed: ${hypervError.message} Nothing is reported as deleted.`);
        throw new Error(`Delete stopped during VM removal: ${hypervError.message}`);
      }
    } else if (isHyperVEnv && process.platform !== 'win32') {
      throw new Error('This environment is a Hyper-V VM and can only be deleted on Windows. Nothing was removed.');
    }
    // Stop only this environment's processes: folder match + persisted installer lineage.
    // The RCVM launcher goes first: killing it ends the contained tree via kill-on-job-close.
    await stopQemuEnv(appRecord, appLogPath);
    await qemuDeleteEnv(appRecord, appLogPath);
    await stopRcvmLauncher(appRecord, appLogPath);
    let remainingPids = await stopProcessesUnder(sandboxRoot, seeds, { logPath: appLogPath });
    await removeSandboxDirectory(sandboxRoot, { shouldAbort: () => job.aborted, logPath: errorLogPath });
    if (legacySandboxieWarning) appendLog(errorLogPath, `Legacy Sandboxie note: ${legacySandboxieWarning}`);

    if (remainingPids.length > 0) {
      throw new Error(describeCleanupFailure({
        directory: sandboxRoot,
        error: new Error('Some processes for this app are still running.'),
        blockers: await listBlockingProcesses(sandboxRoot),
        remainingPids,
      }));
    }
    if (fs.existsSync(sandboxRoot)) {
      throw new Error(`RunContainer could not confirm that ${sandboxRoot} was removed, so the app record was kept.`);
    }
    // The app's processes are confirmed stopped, so the container profile can be removed.
    const containerCleanup = await deleteAppContainerProfile(appRecord, errorLogPath);

    const remainingApps = removeAppRecord(appRecord);
    if (loadApps().some((entry) => entry.id === appRecord.id)) {
      throw new Error('App record remains in RunContainer’s persistent store after deletion.');
    }
    // Logged outside the sandbox: appendLog creates its directory, which would recreate
    // the folder that was just deleted.
    appendLog(errorLogPath, `Deleted ${appRecord.name || appRecord.id} and sandbox ${sandboxRoot}.`);
    return {
      id: appRecord.id,
      status: 'Reset',
      removed: true,
      remainingCount: remainingApps.length,
      containerProfileRemoved: containerCleanup.deleted,
      containerCleanupWarning: [containerCleanup.deleted || containerCleanup.skipped ? null : containerCleanup.error, typeof hypervWarning !== 'undefined' ? hypervWarning : null, typeof legacySandboxieWarning !== 'undefined' ? legacySandboxieWarning : null].filter(Boolean).join(' ') || null,
    };
  } catch (error) {
    if (error instanceof CleanupCancelledError) {
      appendLog(appLogPath, error.message);
      return { id: appRecord.id, status: 'Cancelled', removed: false, error: error.message };
    }
    appendLog(errorLogPath, `Delete failed for ${appRecord.name || appRecord.id}: ${error.message}`);
    return { id: appRecord.id, status: 'Failed', removed: false, error: error.message };
  } finally {
    deleteJobs.delete(appRecord.id);
  }
  });
});

ipcMain.handle('set-window-hosting', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const windowHosting = requestedAppRecord?.windowHosting !== false;
  const updated = { ...appRecord, windowHosting };
  saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updated : entry)));
  if (!windowHosting) {
    await releaseAppWindow(appRecord, trackedPids(appRecord), path.join(app.getPath('userData'), 'runcontainer-error.log'));
  }
  return { id: appRecord.id, status: updated.status, windowHosting };
});

// Installers run inside the environment, never on the host directly. The installer binary
// is copied into the app's managed folder, launched under the selected boundary
// (AppContainer for compatible software, Hyper-V guest for arbitrary installers), and every
// child PID it spawns is persisted (knownPids) so Delete can still find processes that
// outlive the installer itself. This is how RunContainer behaves like a VM manager.
ipcMain.handle('install-in-environment', async (_event, requestedAppRecord, installerPath) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const validation = validateExe(installerPath);
  if (!validation.isValid) return { id: appRecord.id, status: 'Failed', error: validation.reason };
  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source);
  if (!isWithinDirectory(sandboxRootBase, sandboxRoot)) {
    return { id: appRecord.id, status: 'Failed', error: 'Refusing to run an installer outside RunContainer’s managed directory.' };
  }
  return withOpLock(appRecord.id, 'install', async () => {
  const engine = selectEngine({ ...appRecord, requiresVm: appRecord.requiresVm || appRecord.preferVm || requestedAppRecord?.requiresVm });
  const installerDir = path.join(sandboxRoot, 'installers');
  ensureDirectory(installerDir);
  const staged = path.join(installerDir, path.basename(installerPath));
  try { fs.copyFileSync(installerPath, staged); } catch (copyError) {
    return { id: appRecord.id, status: 'Failed', error: `Could not stage the installer: ${copyError.message}` };
  }
  const logsRoot = appRecord.logsRoot || path.join(sandboxRoot, 'logs');
  const logPath = path.join(logsRoot, `${sanitizeName(appRecord.name || 'app')}.log`);
  appendLog(logPath, `Running installer inside environment (engine: ${engine}): ${staged}`);
  if (engine === 'hyperv') {
    // Real installer flow INSIDE the guest: ensure VM+guest ready, copy the
    // installer in, execute it there with the caller's args, wait for its ACTUAL
    // exit code, then record the installed app path for later launches.
    const hv = require('./hyperv-runtime');
    const installArgs = String(requestedAppRecord?.installArgs || '');
    const installedGuestPath = String(requestedAppRecord?.installedExeGuestPath || '').trim();
    try {
      const { files, credFile } = await ensureHyperVGuestReady(appRecord, sandboxRoot, logPath);
      const guestInstaller = `C:\\RunContainer\\${appRecord.id}\\installers\\${path.win32.basename(staged)}`;
      appendLog(logPath, `Copying installer into the guest: ${guestInstaller}`);
      await runHyperVScript(hv.buildCopyToGuestScript({ vm: files.vmName, hostPath: staged, guestPath: guestInstaller }), logPath);
      appendLog(logPath, `Executing installer INSIDE the guest (args: ${installArgs || '(none)'}); waiting for its real result.`);
      const done = await runHyperVScript(hv.buildRunInstallerInGuestScript({ vm: files.vmName, credFile, guestInstallerPath: guestInstaller, installArgs, timeoutSec: 1800 }), logPath);
      const code = Number(done.exitCode);
      appendLog(logPath, `Installer exited in-guest with code ${code}.`);
      if (code === 3010 || code === 1641) {
        const base = getStoredApp(appRecord.id) || appRecord;
        saveApps(loadApps().map((e) => (e.id === appRecord.id ? { ...withTrackedPids(base, []), installedNeedsReboot: true, lastInstallerAt: new Date().toISOString(), lastInstallerExitCode: code } : e)));
        return { id: appRecord.id, status: 'InstalledNeedsReboot', engine: 'hyperv', detail: `The installer finished but the guest needs a reboot (exit code ${code}). Use Reset to reboot the guest, then Run the app. Nothing was executed on the host.` };
      }
      if (!Number.isSafeInteger(code) || code !== 0) {
        throw new Error(`The installer failed inside the guest (exit code ${done.exitCode}). Check the installer arguments and guest requirements; nothing was installed.`);
      }
      // Record the installed application path: explicit caller path wins,
      // otherwise verify the conventional per-app location in the guest.
      const candidates = [installedGuestPath, `C:\\RunContainer\\${appRecord.id}\\${path.win32.basename(appRecord.source, path.win32.extname(appRecord.source))}.exe`].filter(Boolean);
      let confirmed = null;
      for (const cand of candidates) {
        try {
          const chk = await runHyperVScript(hv.buildGuestFileExistsScript({ vm: files.vmName, credFile, guestPath: cand }), logPath);
          if (chk.exists) { confirmed = cand; break; }
        } catch (checkError) { appendLog(logPath, `Guest path check for ${cand}: ${checkError.message}`); }
      }
      const base = getStoredApp(appRecord.id) || appRecord;
      const updated = { ...withTrackedPids(base, []), installedExeGuestPath: confirmed || installedGuestPath || null, lastInstallerAt: new Date().toISOString(), lastInstallerExitCode: code };
      saveApps(loadApps().map((e) => (e.id === appRecord.id ? updated : e)));
      if (!confirmed) {
        return { id: appRecord.id, status: 'Installed', engine: 'hyperv', detail: `Installer succeeded (exit 0) but no installed EXE could be confirmed in the guest. Set the installed app path before running. Tried: ${candidates.join(', ')}` };
      }
      appendLog(logPath, `Recorded installed app path in guest: ${confirmed}`);
      return { id: appRecord.id, status: 'Installed', engine: 'hyperv', installedExeGuestPath: confirmed, detail: `Installer finished inside the guest (exit 0); installed app recorded at ${confirmed}.` };
    } catch (error) {
      appendLog(logPath, `In-guest install failed: ${error.message}`);
      return { id: appRecord.id, status: 'Failed', error: `${error.message} The installer was never executed on the host.` };
    }
  }
  if (engine === 'refused' || !isAppContainerSupported()) {
    const decision = selectIsolationEngine({ platform: process.platform, appRecord, hypervReady: true });
    return { id: appRecord.id, status: 'Failed', error: `${decision.reason} The installer was not run on the host.` };
  }
  // AppContainer installer run: same verified launch path as apps, result tracked.
  const installerRecord = { ...appRecord, source: staged };
  const scriptPath = ensureIsolationScript();
  const containerName = appContainerName(appRecord.id);
  try {
    const sidResult = await runIsolationScript(buildAppContainerScriptArgs(scriptPath, { mode: 'sid', containerName }));
    const containerSid = sidResult.sid;
    if (!containerSid) throw new Error('Windows did not return an AppContainer identity.');
    for (const ancestor of listAncestorDirectories(sandboxRoot, sandboxRootBase)) {
      await executeFile('icacls.exe', buildAppContainerAncestorAclArgs(ancestor, containerSid)).catch(() => {});
    }
    await executeFile('icacls.exe', buildAppContainerFolderAclArgs(sandboxRoot, containerSid));
    const launch = await runIsolationScript(buildAppContainerScriptArgs(scriptPath, { mode: 'launch', containerName, executablePath: staged, workingDirectory: sandboxRoot }));
    if (!launch.verified || launch.processSid !== launch.containerSid) {
      throw new Error('The installer started, but Windows did not confirm it is inside its container. It was stopped.');
    }
    const pids = findAppProcessIds(await listProcessTable(), sandboxRoot, [launch.pid]);
    const base = getStoredApp(appRecord.id) || appRecord;
    saveApps(loadApps().map((e) => (e.id === appRecord.id ? { ...withTrackedPids(base, pids.length ? pids : [launch.pid]), lastInstallerAt: new Date().toISOString(), lastInstallerPid: launch.pid } : e)));
    appendLog(logPath, `Installer running inside AppContainer ${containerName} (PID ${launch.pid}); children tracked for Delete.`);
    monitorAppProcesses(appRecord.id, logPath);
    return { id: appRecord.id, status: 'Running', engine: 'appcontainer', pid: launch.pid, detail: 'Installer is running inside the AppContainer; its children stay tracked after it exits.' };
  } catch (error) {
    appendLog(logPath, `Installer launch failed: ${error.message}`);
    return { id: appRecord.id, status: 'Failed', error: `${error.message} The installer was not run without isolation.` };
  }
  });
});

ipcMain.handle('hyperv-status', async () => {
  const readiness = await checkHyperVReady();
  return { ready: readiness.ready, missing: readiness.missing, detail: readiness.detail || null, baseImage: hyperVBaseImagePath() };
});

// One-time provisioning: shows the Windows credential dialog for the guest local
// administrator and stores it DPAPI-encrypted (same user, same host). PowerShell
// Direct cannot run non-interactively without it.
ipcMain.handle('hyperv-provision-credential', async () => {
  if (process.platform !== 'win32') return { provisioned: false, error: 'Guest credential provisioning requires Windows.' };
  const hv = require('./hyperv-runtime');
  const credFile = guestCredentialFile();
  ensureDirectory(path.dirname(credFile));
  try {
    await executeFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (() => { const t = path.join(app.getPath('userData'), 'runcontainer-hyperv-cred-provision.ps1'); fs.writeFileSync(t, hv.buildProvisionCredentialScript(credFile), 'utf8'); return t; })()], { timeout: 300000 });
    if (!fs.existsSync(credFile)) throw new Error('The credential file was not created (dialog may have been cancelled).');
    return { provisioned: true, credFile };
  } catch (error) {
    return { provisioned: false, error: error.message };
  }
});

// Profiles assign real, enforced settings. locked = offline VM + container with no
// capabilities; relaxed = online + wider container capabilities; default = online +
// internetClient. Changing network attachment needs the VM Off, so a running VM
// keeps its NICs until Reset and the change is reported, not silently dropped.
ipcMain.handle('set-app-profile', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const profile = requestedAppRecord?.profile;
  if (!['default', 'relaxed', 'locked'].includes(profile)) {
    return { id: appRecord.id, status: 'Failed', error: 'Unknown profile. Choose default, relaxed, or locked.' };
  }
  const sandboxProfile = getSandboxProfile(profile);
  const updated = {
    ...appRecord,
    profile,
    permissions: { network: sandboxProfile.network, filesystem: sandboxProfile.filesystem, registry: sandboxProfile.registry },
    networkEnabled: profile !== 'locked',
    appContainerCapabilities: profile === 'locked' ? [] : profile === 'relaxed' ? ['internetClient', 'privateNetworkClientServer'] : ['internetClient'],
  };
  saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updated : entry)));
  return { id: appRecord.id, status: updated.status, profile, networkEnabled: updated.networkEnabled };
});

// Tweaks: launch arguments, VM CPU/memory, networking. All validated; bad values
// are rejected with the reason, never stored.
ipcMain.handle('set-app-config', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const hv = require('./hyperv-runtime');
  const patch = {};
  if (requestedAppRecord?.launchArgs !== undefined) {
    const checked = hv.validateLaunchArgs(requestedAppRecord.launchArgs);
    if (!checked.ok) return { id: appRecord.id, status: 'Failed', error: checked.reason };
    patch.launchArgs = checked.args;
  }
  if (requestedAppRecord?.vmMemoryMB !== undefined) {
    const mem = Number(requestedAppRecord.vmMemoryMB);
    if (!Number.isSafeInteger(mem) || mem < 512 || mem > 32768) {
      return { id: appRecord.id, status: 'Failed', error: 'Memory must be 512–32768 MB.' };
    }
    patch.vmMemoryMB = mem;
  }
  if (requestedAppRecord?.vmCpuCount !== undefined) {
    const cpu = Number(requestedAppRecord.vmCpuCount);
    if (!Number.isSafeInteger(cpu) || cpu < 1 || cpu > 16) {
      return { id: appRecord.id, status: 'Failed', error: 'CPU count must be 1–16.' };
    }
    patch.vmCpuCount = cpu;
  }
  if (requestedAppRecord?.networkEnabled !== undefined) {
    patch.networkEnabled = requestedAppRecord.networkEnabled !== false;
  }
  if (Object.keys(patch).length === 0) return { id: appRecord.id, status: 'Failed', error: 'No tweak values were provided.' };
  const updated = { ...appRecord, ...patch };
  saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updated : entry)));
  return { id: appRecord.id, status: updated.status, ...patch };
});

// Reset (distinct from Delete): stop the guest app, reboot the guest OS fresh,
// verify readiness, keep the disk, installed apps and data. Clears crashed or
// wedged guest runtime state without touching the base image or other envs.
ipcMain.handle('reset-environment', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  if (appRecord.launchMode !== 'hyperv' && appRecord.activeEngine !== 'hyperv' && !appRecord.hypervVm) {
    // AppContainer mode: fresh container state = stop processes + drop the profile.
    const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source || '');
    const appLog = path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
    try {
      if (isQemuEnv(appRecord)) {
        return resetQemuEnv(appRecord, appLog);
      }
      return await withOpLock(appRecord.id, 'reset', async () => {
        await stopRcvmLauncher(appRecord, appLog);
        await stopProcessesUnder(sandboxRoot, trackedPids(appRecord), { logPath: appLog });
        await deleteAppContainerProfile(appRecord, appLog).catch(() => ({}));
        const apps = loadApps().map((entry) => (entry.id === appRecord.id
          ? { ...withTrackedPids(entry, []), status: 'Stopped', pid: null, sandboxPids: [], lastResetAt: new Date().toISOString() }
          : entry));
        saveApps(apps);
        appendLog(appLog, 'Environment reset: processes stopped, container profile dropped (recreated on next Run).');
        return { id: appRecord.id, status: 'Stopped', reset: true };
      });
    } catch (error) {
      return { id: appRecord.id, status: 'Failed', error: error.message };
    }
  }
  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source || '');
  const appLog = path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
  try {
    return await withOpLock(appRecord.id, 'reset', async () => {
      const hv = require('./hyperv-runtime');
      stopMonitor(appRecord.id);
      const guestExe = appRecord.installedExeGuestPath || appRecord.source;
      const exeBase = path.win32.basename(guestExe, path.win32.extname(guestExe));
      try {
        await runHyperVScript(hv.buildStopGuestAppScript({ vm: appRecord.hypervVm, credFile: guestCredentialFile(), exeName: exeBase, gracefulTimeoutSec: 15 }), appLog);
      } catch (appStopError) {
        appendLog(appLog, `Reset: guest app did not exit cleanly, continuing to reboot: ${appStopError.message}`);
      }
      try {
        await runHyperVScript(hv.buildGracefulShutdownScript({ vm: appRecord.hypervVm, timeoutSec: 120 }), appLog);
      } catch (gracefulError) {
        appendLog(appLog, `Reset: graceful shutdown timed out, powering off (data loss inside the VM is possible): ${gracefulError.message}`);
        await runHyperVScript(hv.buildPowerOffScript(appRecord.hypervVm), appLog);
      }
      await runHyperVScript(hv.buildStartVmScript(appRecord.hypervVm), appLog);
      await runHyperVScript(hv.buildWaitForGuestReadyScript({ vm: appRecord.hypervVm, credFile: guestCredentialFile(), timeoutSec: 300 }), appLog);
      const apps = loadApps().map((entry) => (entry.id === appRecord.id
        ? { ...entry, status: 'Stopped', guestPid: null, guestPids: [], installedNeedsReboot: false, lastResetAt: new Date().toISOString() }
        : entry));
      saveApps(apps);
      appendLog(appLog, `Environment reset: guest OS rebooted fresh, disk and installed apps kept.`);
      const updated = apps.find((entry) => entry.id === appRecord.id);
      if (updated) broadcastContainerStatus(updated);
      return { id: appRecord.id, status: 'Stopped', reset: true };
    });
  } catch (error) {
    appendLog(appLog, `Reset failed: ${error.message}`);
    return { id: appRecord.id, status: 'Failed', error: error.message };
  }
});

// Guest display: opens the supported VM console (VMConnect) for this
// environment's VM. This is a separate display window, not embedding, and is
// never presented as isolation.
ipcMain.handle('open-guest-display', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  if (!appRecord.hypervVm) return { id: appRecord.id, status: 'Failed', error: 'Guest display needs a Hyper-V environment (this app has no VM yet — Run it once first).' };
  if (process.platform !== 'win32') return { id: appRecord.id, status: 'Failed', error: 'Guest display requires Windows.' };
  try {
    const hv = require('./hyperv-runtime');
    const vmInfo = await runHyperVScript(hv.buildGetVmScript(appRecord.hypervVm), path.join(app.getPath('userData'), 'runcontainer-error.log'));
    if (!vmInfo.exists) throw new Error(`VM ${appRecord.hypervVm} does not exist. Run the app to recreate it from its disk.`);
    if (vmInfo.state !== 'Running') {
      await runHyperVScript(hv.buildStartVmScript(appRecord.hypervVm), path.join(app.getPath('userData'), 'runcontainer-error.log'));
      await runHyperVScript(hv.buildWaitForGuestReadyScript({ vm: appRecord.hypervVm, credFile: guestCredentialFile(), timeoutSec: 300 }), path.join(app.getPath('userData'), 'runcontainer-error.log'));
    }
    const child = spawn('vmconnect.exe', ['localhost', appRecord.hypervVm], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return { id: appRecord.id, status: 'Displaying', vm: appRecord.hypervVm };
  } catch (error) {
    return { id: appRecord.id, status: 'Failed', error: `Could not open the guest display: ${error.message}` };
  }
});

// The UI asks the main process for the version, so package.json stays the single source.
ipcMain.handle('get-app-version', async () => ({ version: app.getVersion() }));

// Update checks against GitHub Releases (stable only). Cached so launch and the
// Updates tab share one result; force:true re-checks. Never throws: failures
// resolve to { status: 'unavailable' } and the UI simply hides the notice.
let lastUpdateCheck = null;
let downloadedUpdatePath = null;
function updateStatePath() {
  return path.join(app.getPath('userData'), 'runcontainer-updates.json');
}
function loadUpdateState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}
function saveUpdateState(state) {
  try {
    fs.writeFileSync(updateStatePath(), JSON.stringify(state || {}, null, 2), 'utf8');
  } catch (error) {
    // Update state is a convenience; never fail the check for it.
  }
}
function applySnooze(result) {
  const state = loadUpdateState();
  if (result?.status === 'update-available'
    && state.snoozedVersion === result.latestVersion
    && Number(state.snoozeUntil) > Date.now()) {
    return { ...result, snoozed: true };
  }
  return result;
}
ipcMain.handle('check-app-updates', async (_event, options = {}) => {
  const now = Date.now();
  if (lastUpdateCheck && !options?.force && now - lastUpdateCheck.at < 15 * 60 * 1000) {
    return applySnooze(lastUpdateCheck.result);
  }
  const updateCheck = require('./update-check');
  const result = await updateCheck.checkForUpdates({ currentVersion: app.getVersion() });
  lastUpdateCheck = { at: now, result };
  saveUpdateState({ ...loadUpdateState(), lastCheck: lastUpdateCheck });
  appendLog(
    path.join(app.getPath('userData'), 'runcontainer-error.log'),
    `Update check: repo=${updateCheck.resolveUpdateRepo()} installed=${app.getVersion()} status=${result.status}${result.latestVersion ? ` latest=${result.latestVersion}` : ''}${result.reason ? ` (${result.reason})` : ''}`,
  );
  return applySnooze(result);
});

ipcMain.handle('snooze-update', async (_event, { version, untilMs } = {}) => {
  if (!version) return { snoozed: false };
  saveUpdateState({ ...loadUpdateState(), snoozedVersion: version, snoozeUntil: Number(untilMs) || 0 });
  if (lastUpdateCheck?.result) lastUpdateCheck.result = applySnooze(lastUpdateCheck.result);
  return { snoozed: true };
});

// Max installer size: refuses absurd payloads before they fill the disk.
const UPDATE_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
let updateDownloadAbort = null;

function sendUpdateProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-download-progress', progress);
  }
}

function downloadViaHttps(url, destPath, { expectedSize, expectedDigest, redirectsLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      updateDownloadAbort = null;
      try { fs.unlinkSync(destPath); } catch (cleanupError) { /* partial removed */ }
      reject(error);
    };
    const request = https.get(url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'RunContainer' },
      timeout: 30000,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectsLeft > 0) {
        const next = String(response.headers.location);
        // Test-server override is http; production stays https-only.
        const allowHttp = (process.env.RUNCONTAINER_UPDATE_API || '').trim() !== '';
        if (!next.startsWith('https://') && !(allowHttp && next.startsWith('http://127.0.0.1'))) {
          response.resume();
          fail(new Error('Download redirect left the trusted host.'));
          return;
        }
        response.resume();
        downloadViaHttps(next, destPath, { expectedSize, expectedDigest, redirectsLeft: redirectsLeft - 1 })
          .then((r) => { if (!settled) { settled = true; updateDownloadAbort = null; resolve(r); } })
          .catch(fail);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Download answered HTTP ${response.statusCode}.`));
        return;
      }
      const headerTotal = Number(response.headers['content-length']) || null;
      const total = headerTotal || expectedSize || null;
      if (total && total > UPDATE_MAX_DOWNLOAD_BYTES) {
        response.resume();
        fail(new Error('Installer is larger than the 1 GB safety cap.'));
        return;
      }
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastSent = 0;
      const file = fs.createWriteStream(destPath);
      updateDownloadAbort = () => {
        response.destroy(new Error('Download cancelled.'));
        try { file.destroy(); } catch (abortError) { /* closing */ }
      };
      response.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (received > UPDATE_MAX_DOWNLOAD_BYTES) {
          fail(new Error('Installer exceeded the 1 GB safety cap during download.'));
          try { response.destroy(); } catch (destroyError) { /* closing */ }
          return;
        }
        // Throttle progress: ~5 IPC messages per second, always with percent.
        const now = Date.now();
        if (now - lastSent > 200 || (total && received >= total)) {
          lastSent = now;
          sendUpdateProgress({ received, total, percent: total ? Math.floor((received * 100) / total) : null });
        }
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => {
        if (settled) return;
        if (expectedSize && received !== expectedSize) {
          fail(new Error(`Installer size mismatch: expected ${expectedSize} bytes, got ${received}. It may be truncated; refusing to run it.`));
          return;
        }
        const actual = `sha256:${hash.digest('hex')}`;
        if (expectedDigest && actual.toLowerCase() !== String(expectedDigest).toLowerCase()) {
          fail(new Error('Installer checksum does not match the release metadata. Refusing to run it.'));
          return;
        }
        settled = true;
        updateDownloadAbort = null;
        sendUpdateProgress({ received, total: total || received, percent: 100 });
        resolve({ received, total: total || received, sha256: actual });
      }));
      file.on('error', (error) => fail(error));
      response.on('error', (error) => fail(error));
    });
    request.on('timeout', () => { request.destroy(new Error('Download timed out.')); });
    request.on('error', (error) => fail(error));
  });
}

ipcMain.handle('download-update', async () => {
  const result = lastUpdateCheck?.result;
  const url = result?.installerUrl;
  if (result?.status !== 'update-available' || !url || !UPDATE_LINK_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return { downloaded: false, error: 'No verified installer is available. Check for updates first.' };
  }
  const destPath = path.join(app.getPath('temp'), `RunContainer-Setup-${result.latestVersion}.exe`);
  downloadedUpdatePath = null;
  try {
    // A size/digest check over HTTPS catches corruption, not a hostile mirror;
    // signing guidance lives in docs/qemu-integration-plan.md. Fail closed either way.
    const info = await downloadViaHttps(url, destPath, { expectedSize: result.installerSize, expectedDigest: result.installerDigest });
    downloadedUpdatePath = destPath;
    return { downloaded: true, bytes: info.received };
  } catch (error) {
    return { downloaded: false, error: error?.message || 'Download failed.' };
  }
});

// Cancel an in-flight installer download; the partial file is removed.
ipcMain.on('cancel-download-update', () => {
  try {
    if (updateDownloadAbort) updateDownloadAbort();
  } catch (error) {
    // Already finished: nothing to cancel.
  }
});

// Rebuild the wizard after it reopens mid-download: main owns the operation,
// the renderer only presents it.
ipcMain.handle('get-update-state', async () => ({
  check: lastUpdateCheck?.result || null,
  downloaded: Boolean(downloadedUpdatePath && fs.existsSync(downloadedUpdatePath)),
}));

ipcMain.handle('install-downloaded-update', async () => {
  const destPath = downloadedUpdatePath;
  const tempDir = path.resolve(app.getPath('temp'));
  if (!destPath || path.resolve(destPath) !== path.join(tempDir, path.basename(destPath)) || !/\.exe$/i.test(destPath) || !fs.existsSync(destPath)) {
    return { started: false, error: 'No downloaded installer is ready. Download it first.' };
  }
  // Same Inno AppId installs over the existing directory (update, not a second
  // install). Visible wizard with a log file; CloseApplications lets Inno ask
  // to close the running app instead of failing on locked files.
  const logPath = path.join(app.getPath('temp'), `RunContainer-update-${Date.now()}.log`);
  const child = spawn(destPath, ['/SP-', '/NORESTART', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS', `/LOG=${logPath}`], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  app.quit();
  return { started: true };
});

// The renderer never passes a URL: it only names which verified link to open, and
// the main process opens a stored result limited to GitHub release hosts.
const UPDATE_LINK_PREFIXES = ['https://github.com/', 'https://objects.githubusercontent.com/', 'https://release-assets.githubusercontent.com/'];
// QEMU provisioning + status. The base image always comes from media the user
// owns: provision a blank disk, boot it with the ISO for a manual Windows
// install (drivers + qemu-guest-agent), shut the guest down, then set it as base.
// QEMU ships no guest OS and no licence, and none is downloaded or bundled.
ipcMain.handle('qemu-status', async () => refreshQemuStatus());

ipcMain.handle('qemu-detect', async () => {
  const store = loadQemuStore();
  delete store.qemuSystem;
  delete store.qemuImg;
  delete store.version;
  delete store.accel;
  saveQemuStore(store);
  return refreshQemuStatus();
});

ipcMain.handle('qemu-browse-base', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select provisioned base image (qcow2)',
    filters: [{ name: 'QEMU disk images', extensions: ['qcow2'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { path: null };
  return { path: result.filePaths[0] };
});

ipcMain.handle('qemu-set-base', async (_event, imagePath) => {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { saved: false, error: 'That image path does not exist.' };
  }
  if (!/\.qcow2$/i.test(imagePath)) {
    return { saved: false, error: 'Base image must be a qcow2 file.' };
  }
  const store = loadQemuStore();
  saveQemuStore({ ...store, baseImage: imagePath });
  return { saved: true, ...(await refreshQemuStatus()) };
});

ipcMain.handle('qemu-provision-create', async (_event, { sizeGB } = {}) => {
  const qemu = require('./qemu-runtime');
  const status = await refreshQemuStatus();
  if (!status.qemuImg) return { created: false, error: 'QEMU is not detected yet. Install it, then press Detect.' };
  const size = Number(sizeGB) || 60;
  if (!Number.isSafeInteger(size) || size < 20 || size > 500) {
    return { created: false, error: 'Provisioning disk must be 20–500 GB.' };
  }
  const stageDir = path.join(app.getPath('userData'), 'qemu-base');
  fs.mkdirSync(stageDir, { recursive: true });
  const diskPath = path.join(stageDir, 'staged-disk.qcow2');
  if (fs.existsSync(diskPath)) return { created: false, error: `Staging disk already exists at ${diskPath}. Set it as base or delete it first.` };
  await executeFile(status.qemuImg, qemu.buildImgCreateArgs({ diskPath, sizeGB: size }), { timeout: 120000 });
  return { created: true, diskPath };
});

ipcMain.handle('qemu-provision-boot', async (_event, { isoPath } = {}) => {
  const qemu = require('./qemu-runtime');
  const status = await refreshQemuStatus();
  if (!status.qemuSystem) return { booted: false, error: 'QEMU is not detected yet.' };
  if (!isoPath || !fs.existsSync(isoPath)) return { booted: false, error: 'Select your Windows ISO first (media and licence you own).' };
  const diskPath = path.join(app.getPath('userData'), 'qemu-base', 'staged-disk.qcow2');
  if (!fs.existsSync(diskPath)) return { booted: false, error: 'Create the staging disk first.' };
  const args = qemu.buildQemuBootArgs({
    accel: status.accel || 'tcg',
    memoryMB: 4096,
    cpuCount: 2,
    diskPath,
    qmpPort: 44999,
    agentPipe: '\\\\.\\pipe\\rc-qemu-provision',
    pidfilePath: path.join(app.getPath('userData'), 'qemu-base', 'provision.pid'),
    vmName: 'RunContainer-provision',
    display: 'sdl',
    cdrom: isoPath,
    bootOrder: 'd',
  });
  const child = spawn(status.qemuSystem, args, { detached: true, windowsHide: false });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return {
    booted: true,
    note: 'Install Windows in the VM window (your own ISO/licence), add virtio drivers and qemu-guest-agent, then shut Windows down. Afterwards set the staging disk as the base image.',
  };
});

ipcMain.handle('qemu-set-guest-exe', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const guestPath = String(requestedAppRecord?.installedExeGuestPath || '').trim();
  if (!guestPath || !/^[A-Za-z]:\\/.test(guestPath) || !/\.exe$/i.test(guestPath)) {
    return { id: appRecord.id, status: 'Failed', error: 'Guest exe path must look like C:\\Program Files\\App\\app.exe.' };
  }
  const updated = { ...appRecord, installedExeGuestPath: guestPath };
  saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updated : entry)));
  return { id: appRecord.id, status: updated.status, installedExeGuestPath: guestPath };
});

ipcMain.handle('open-update-link', async (_event, which) => {
  const result = lastUpdateCheck?.result;
  const url = which === 'installer' ? result?.installerUrl : result?.releaseUrl;
  if (!url || !UPDATE_LINK_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return { opened: false, error: 'No verified update link is available. Open the Updates tab and check again.' };
  }
  await shell.openExternal(url);
  return { opened: true };
});

ipcMain.handle('cancel-delete', async (_event, requestedAppRecord) => {
  const job = deleteJobs.get(requestedAppRecord?.id);
  if (!job) return { id: requestedAppRecord?.id, cancelled: false, reason: 'No deletion is running for this app.' };
  job.aborted = true;
  return { id: requestedAppRecord.id, cancelled: true };
});

// Fail-closed: 'profile' (unguarded) and 'sandboxie' are rejected, never saved. Allowed:
// 'rcvm'/'auto' (RCVM containment, the default on all editions), 'hyperv' (full VM),
// 'appcontainer' (explicit opt-in token mode).
ipcMain.handle('set-isolation-engine', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const requested = requestedAppRecord?.isolationEngine;
  if (requested === 'profile' || requested === 'sandboxie') {
    return { id: appRecord.id, status: 'Failed', error: 'That mode is not a security boundary and is no longer offered. Use RCVM containment (all editions), Hyper-V VM (arbitrary software), or AppContainer (compatible apps). Nothing was changed.' };
  }
  if (requested !== 'hyperv' && requested !== 'appcontainer' && requested !== 'rcvm' && requested !== 'qemu' && requested !== 'auto' && requested !== undefined) {
    return { id: appRecord.id, status: 'Failed', error: `Unknown isolation engine "${requested}". Use the QEMU VM, RCVM containment, Hyper-V VM, or AppContainer. Nothing was changed.` };
  }
  const engine = requested === 'hyperv' ? 'hyperv' : requested === 'appcontainer' ? 'appcontainer' : requested === 'rcvm' ? 'rcvm' : 'qemu';
  const updated = { ...appRecord, isolationEngine: engine, preferVm: engine === 'hyperv', requiresVm: engine === 'hyperv' };
  saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updated : entry)));
  return { id: appRecord.id, status: updated.status, isolationEngine: engine, preferVm: updated.preferVm };
});

ipcMain.handle('kill-exe', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  if (opLocks.has(appRecord.id)) {
    return { id: appRecord.id, status: 'Failed', error: `Cannot stop while ${opLocks.get(appRecord.id)} is running for this environment. Wait for it to finish, or Delete the environment if the operation is wedged.` };
  }
  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source);
  const appLog = path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
  try {
    // Put any hosted window back on the desktop before the process is terminated.
    await releaseAppWindow(appRecord, trackedPids(appRecord), appLog);
    stopMonitor(appRecord.id);
    if ((appRecord.launchMode === 'hyperv' || appRecord.activeEngine === 'hyperv') && appRecord.hypervVm && process.platform === 'win32') {
      const hv = require('./hyperv-runtime');
      try {
        const vmInfo = await runHyperVScript(hv.buildGetVmScript(appRecord.hypervVm), appLog);
        if (!vmInfo.exists) {
          appendLog(appLog, `VM ${appRecord.hypervVm} no longer exists; marking the app Stopped. Its disk (if present) is kept for re-attach on next Run.`);
          const gone = loadApps().map((entry) => (entry.id === appRecord.id
            ? { ...entry, status: 'Stopped', guestPid: null, guestPids: [], statusNote: 'The VM was already gone; nothing was running.' }
            : entry));
          saveApps(gone);
          const stoppedGone = gone.find((entry) => entry.id === appRecord.id);
          if (stoppedGone) broadcastContainerStatus(stoppedGone);
          return { id: appRecord.id, status: 'Stopped', note: 'The VM was already gone.' };
        }
        const guestExe = appRecord.installedExeGuestPath || appRecord.source;
        const exeBase = path.win32.basename(guestExe, path.win32.extname(guestExe));
        appendLog(appLog, `Stopping guest app ${exeBase} inside VM ${appRecord.hypervVm} (graceful close first, force after 15s). The VM itself keeps running.`);
        const stopped = await runHyperVScript(hv.buildStopGuestAppScript({ vm: appRecord.hypervVm, credFile: guestCredentialFile(), exeName: exeBase, gracefulTimeoutSec: 15 }), appLog);
        const leftovers = Array.isArray(stopped.remaining) ? stopped.remaining.filter((n) => Number.isSafeInteger(n) && n > 0) : [];
        if (leftovers.length > 0) throw new Error(`Guest PIDs ${leftovers.join(', ')} did not exit inside the VM.`);
      } catch (guestError) {
        appendLog(appLog, `Guest app stop failed: ${guestError.message}`);
        return { id: appRecord.id, status: 'Failed', error: `The guest app could not be confirmed stopped: ${guestError.message} The VM was left running; retry Stop or use Delete (graceful shutdown, then power-off escalation).` };
      }
      const apps = loadApps().map((entry) => (entry.id === appRecord.id
        ? { ...entry, status: 'Stopped', guestPid: null, guestPids: [], lastExitAt: new Date().toISOString() }
        : entry));
      saveApps(apps);
      appendLog(appLog, `Guest app stopped; VM ${appRecord.hypervVm} kept running with its disk for fast relaunch.`);
      const updatedVm = apps.find((entry) => entry.id === appRecord.id);
      if (updatedVm) broadcastContainerStatus(updatedVm);
      return { id: appRecord.id, status: 'Stopped' };
    }
    await stopQemuEnv(appRecord, appLog);
    await stopRcvmLauncher(appRecord, appLog);
    const remaining = await stopProcessesUnder(sandboxRoot, trackedPids(appRecord), { logPath: appLog });
    if (remaining.length > 0) {
      throw new Error(describeCleanupFailure({
        directory: sandboxRoot,
        error: new Error('Some processes for this app are still running.'),
        blockers: await listBlockingProcesses(sandboxRoot),
        remainingPids: remaining,
      }));
    }
    // The app is confirmed stopped, so a previously blocked launch can be retried safely.
    const apps = loadApps().map((entry) => (entry.id === appRecord.id
      ? { ...withTrackedPids(entry, []), status: 'Stopped', pid: null, sandboxPids: [], launchCleanupPending: false }
      : entry));
    saveApps(apps);
    appendLog(appLog, `App ${appRecord.id} stopped.`);
    const updated = apps.find((entry) => entry.id === appRecord.id);
    if (updated) broadcastContainerStatus(updated);
    return { id: appRecord.id, status: 'Stopped' };
  } catch (error) {
    appendLog(appLog, `Stop failed: ${error.message}`);
    return { id: appRecord.id, status: 'Failed', error: error.message };
  }
});
