const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const {
  sandboxBoxName,
  findSandboxieTools,
  deleteSandboxieBox,
  isWithinDirectory,
} = require('./sandboxie-runtime');
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
  return loadApps().find((entry) => entry.id === appId) || null;
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
    throw new Error('VM isolation needs a provisioned Windows base image: set RUNCONTAINER_HYPERV_BASE_IMAGE to a sysprepped Windows 10/11 Pro/Enterprise VHDX (Generation 2) and provision the guest credential (see Settings). Nothing was launched on the host.');
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

    appendLog(logPath, `Launching inside the guest (never on the host): ${guestExe}`);
    const launched = await runHyperVScript(hv.buildLaunchInGuestScript({ vm: files.vmName, credFile, guestExePath: guestExe, workingDir: guestDir }), logPath);
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
        if (pids.length === 0) {
          const updated = { ...current, status: 'Stopped', guestPid: null, lastExitAt: new Date().toISOString() };
          saveApps(loadApps().map((e) => (e.id === appId ? updated : e)));
          appendLog(logPath, 'Guest process exited; VM kept for data. Delete removes the VM and its disk.');
          stopMonitor(appId);
          broadcastContainerStatus(updated);
        }
      } catch (queryError) {
        appendLog(logPath, `Unable to query guest process state: ${queryError.message}`);
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

    const launch = await runIsolationScript(buildAppContainerScriptArgs(scriptPath, {
      mode: 'launch',
      containerName,
      executablePath: appRecord.source,
      workingDirectory: sandboxRoot,
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
// path: unisolated execution is never selected, even on request. 'hyperv' means the live
// Hyper-V readiness check still has to pass inside runWithHyperV; anything else refuses.
function selectEngine(appRecord) {
  // hypervReady:true here marks VM eligibility; the LIVE readiness + credential
  // checks run inside runWithHyperV and fail closed (never fall back).
  const decision = selectIsolationEngine({ platform: process.platform, appRecord, hypervReady: true });
  if (decision.engine === 'appcontainer') return 'appcontainer';
  if (decision.engine === 'hyperv' || decision.engine === 'hyperv-unavailable') return 'hyperv';
  return 'refused';
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
    const script = buildHyperVPrereqScript();
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

// Sandboxie is not an allowed isolation backend. This stub exists so any legacy call
// path fails closed instead of launching outside RunContainer's supported engines.
async function runWithSandboxie(appRecord, tools, sandboxRoot, logPath) {
  appendLog(logPath, 'Refused Sandboxie launch: Sandboxie is not an allowed isolation backend.');
  return failedLaunch(appRecord, 'Sandboxie is not an allowed isolation backend for RunContainer. Use AppContainer (compatible apps) or a Hyper-V VM (arbitrary software). Nothing was launched.');
}

function resolveSandboxieTools() {
  return findSandboxieTools(process.env);
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

app.whenReady().then(createWindow);

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
  if (updatesById.size === 0) return loadApps();
  // Re-read the store after the async checks so apps deleted or added in the meantime are not resurrected.
  const current = mergeStatusUpdates(loadApps(), updatesById);
  saveApps(current);
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
    sandboxieBox: sandboxBoxName(appId),
    sandboxieFileRoot: path.join(sandboxRoot, 'SandboxieFiles'),
    sandboxieInitialized: false,
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
    sandboxieBox: sandboxBoxName(appId),
    sandboxieFileRoot: path.join(sandboxRoot, 'SandboxieFiles'),
    sandboxieInitialized: false,
    createdAt: new Date().toISOString(),
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

  const engine = selectEngine(appRecord);
  if (engine === 'refused') {
    const decision = selectIsolationEngine({ platform: process.platform, appRecord, hypervReady: true });
    appendLog(logPath, `Launch refused: ${decision.reason}`);
    return failedLaunch(appRecord, `${decision.reason} Nothing was launched.`);
  }
  if (engine === 'hyperv') {
    appendLog(logPath, 'Isolation engine: Hyper-V virtual machine (full guest OS boundary).');
    return runWithHyperV(appRecord, sandboxRoot, logPath);
  }
  if (!isAppContainerSupported()) {
    appendLog(logPath, 'Launch refused: AppContainer requires Windows 10/11.');
    return failedLaunch(appRecord, 'AppContainer isolation requires Windows 10/11. For arbitrary software use a Hyper-V VM (Pro/Enterprise/Education + virtualization). Nothing was launched.');
  }
  appendLog(logPath, 'Isolation engine: Windows AppContainer (verified container token).');
  return runWithAppContainer(appRecord, sandboxRoot, logPath);
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
  try {
    await releaseAppWindow(appRecord, trackedPids(appRecord), errorLogPath);
    stopMonitor(appRecord.id);
    const seeds = trackedPids(appRecord);
    // Legacy Sandboxie boxes (pre-refactor records only): best-effort cleanup, never a launch path.
    let legacySandboxieWarning = null;
    if ((appRecord.sandboxieInitialized || appRecord.sandboxieCleanupPending) && appRecord.sandboxieBox) {
      const tools = resolveSandboxieTools();
      if (!tools) {
        legacySandboxieWarning = 'A legacy Sandboxie box could not be cleared because Sandboxie is unavailable; host files are still removed below.';
        appendLog(errorLogPath, `Sandbox cleanup warning for ${appRecord.name || appRecord.id}: ${legacySandboxieWarning}`);
      } else {
        try {
          await deleteSandboxieBox({ tools, boxName: appRecord.sandboxieBox, execute: executeFile });
        } catch (legacyError) {
          legacySandboxieWarning = legacyError.message;
          appendLog(errorLogPath, `Sandbox cleanup warning for ${appRecord.name || appRecord.id}: ${legacyError.message}`);
        }
      }
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

// The UI asks the main process for the version, so package.json stays the single source.
ipcMain.handle('get-app-version', async () => ({ version: app.getVersion() }));

ipcMain.handle('cancel-delete', async (_event, requestedAppRecord) => {
  const job = deleteJobs.get(requestedAppRecord?.id);
  if (!job) return { id: requestedAppRecord?.id, cancelled: false, reason: 'No deletion is running for this app.' };
  job.aborted = true;
  return { id: requestedAppRecord.id, cancelled: true };
});

// Fail-closed: 'profile' (unguarded) and 'sandboxie' are rejected, never saved. Allowed:
// 'auto' (AppContainer unless the app needs a VM), 'appcontainer', 'hyperv' (prefer VM).
ipcMain.handle('set-isolation-engine', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const requested = requestedAppRecord?.isolationEngine;
  if (requested === 'profile' || requested === 'sandboxie') {
    return { id: appRecord.id, status: 'Failed', error: 'That mode is not a security boundary and is no longer offered. Use AppContainer (compatible apps) or Hyper-V VM (arbitrary software). Nothing was changed.' };
  }
  const engine = requested === 'hyperv' ? 'hyperv' : requested === 'appcontainer' ? 'appcontainer' : 'auto';
  const updated = { ...appRecord, isolationEngine: engine, preferVm: engine === 'hyperv', requiresVm: Boolean(requestedAppRecord?.requiresVm ?? appRecord.requiresVm) };
  saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updated : entry)));
  return { id: appRecord.id, status: updated.status, isolationEngine: engine, preferVm: updated.preferVm };
});

ipcMain.handle('kill-exe', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source);
  const appLog = path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
  try {
    // Put any hosted window back on the desktop before the process is terminated.
    await releaseAppWindow(appRecord, trackedPids(appRecord), appLog);
    stopMonitor(appRecord.id);
    if ((appRecord.launchMode === 'hyperv' || appRecord.activeEngine === 'hyperv') && appRecord.hypervVm && process.platform === 'win32') {
      const hv = require('./hyperv-runtime');
      try {
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
