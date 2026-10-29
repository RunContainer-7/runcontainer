const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn, spawnSync } = require('child_process');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
// Derive the channel from packaged metadata, not a renderer or user-controlled switch.
const IS_NIGHTLY = /-nightly\.\d+$/.test(app.getVersion());
const PRODUCT_NAME = IS_NIGHTLY ? 'RunContainer Nightly' : 'RunContainer';
const PRODUCT_ICON = IS_NIGHTLY ? 'runcontainer-nightly-icon.ico' : 'runcontainer-icon.ico';
// Set before any userData path is resolved; stable and nightly never share stores.
// An explicit --user-data-dir (Chromium's own switch, used by the Windows verification
// check and by portable launches) wins, so a test run can never touch real user data.
const explicitUserData = app.commandLine.getSwitchValue('user-data-dir');
if (explicitUserData) app.setPath('userData', path.resolve(explicitUserData));
else if (IS_NIGHTLY) app.setPath('userData', path.join(app.getPath('appData'), 'RunContainer Nightly'));
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
  clearReparsePoints,
  listReparsePoints,
  detectStoreHandoff,
  describeStoreHandoff,
  isUntrustedMountPointError,
  isWithinDirectory,
} = require('./isolated-launch');
const {
  buildWindowHostCSharp,
  buildWindowHostProgram,
  buildWindowHostScript,
  buildWindowHostProgramArgs,
  buildWindowHostScriptArgs,
  launchShowState,
  parseWindowHostOutput,
  parseWindowHostEvents,
  nativeHandleToInt,
} = require('./window-host');
const {
  buildBehaviorProbeScript,
  buildBehaviorProbeArgs,
  parseBehaviorProbeOutput,
  summarizeProbe,
} = require('./behavioral-probe');
const behavioralMonitor = require('../src/utils/behavioralMonitor');
const { createBrain, REGISTRY_PATH: AI_REGISTRY_PATH, createAgentCoordinator } = require('../src/ai/engine');
const { detectLogSignals } = require('../src/ai/features');
const { createExperienceStore } = require('../src/ai/experiences');
const { extractIconToFile } = require('../src/services/exeIcon');
const { planSetupRun, findInstalledCandidates } = require('../src/services/setupInstall');
const repairVerification = require('../src/utils/repairVerifier');
const runtimeProfile = require('../src/services/runtimeProfile');
const aiKnowledge = require('../src/ai/knowledge.json');

// A failure while loading the main process would otherwise surface as Electron's
// raw "A JavaScript error occurred" dialog with no log entry, which is exactly
// how 0.6.5 failed to start. Record it, then explain it once, calmly.
function logStartupFailure(error) {
  try {
    const target = path.join(app.getPath('userData'), 'runcontainer-error.log');
    fs.appendFileSync(target, `[${new Date().toISOString()}] startup failure: ${error?.stack || error?.message || error}\n`);
  } catch (logError) {
    // The error log is best-effort.
  }
}

process.on('uncaughtException', (error) => {
  logStartupFailure(error);
  try {
    dialog.showErrorBox(
      'RunContainer could not finish starting',
      `${error?.message || error}\n\nRunContainer kept its data. A log was written to:\n${path.join(app.getPath('userData'), 'runcontainer-error.log')}\n\nReinstall RunContainer from the official release page if this keeps happening.`,
    );
  } catch (dialogError) {
    // Without a ready app there may be no dialog; the log is what matters.
  }
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logStartupFailure(reason instanceof Error ? reason : new Error(String(reason)));
});
const { createTelemetryLogger } = require('../src/utils/telemetryLogger');
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
// One-time, app-wide state for this installation (see loadPreferences below).
const preferencesPath = path.join(app.getPath('userData'), 'runcontainer-preferences.json');
// Only these keys may be written: a preference write is not a general settings
// back door, and an unknown key is dropped rather than stored.
const PREFERENCE_KEYS = new Set(['beginnerSetupSeen', 'beginnerSetupSeenAt', 'beginnerSetupSeenVersion', 'developerMode', 'developerModeEnabledAt', 'installerMode', 'theme']);

function loadPreferences() {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function savePreferences(patch = {}) {
  const updated = { ...loadPreferences() };
  for (const [key, value] of Object.entries(patch)) {
    if (!PREFERENCE_KEYS.has(key)) continue;
    updated[key] = value;
  }
  try {
    fs.writeFileSync(preferencesPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  } catch (error) {
    // Best effort: a failed write only means the introduction is offered again.
  }
  return updated;
}
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

app.setName(PRODUCT_NAME);
app.setAppUserModelId(IS_NIGHTLY ? 'com.runcontainer.nightly' : 'RunContainer');

// Reads only the PE header area of the copied executable: no launching, no disk
// scan. The result is what the Tweaks panel reports, so the claim about JIT
// comes from the file itself rather than from its name or extension.
function detectAppRuntime(sourcePath) {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;
    const handle = fs.openSync(sourcePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
      return runtimeProfile.detectRuntime(buffer.subarray(0, read));
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    return null;
  }
}

// A GUI app can be started with a hidden first window, so its window is hosted before
// it is ever drawn on the desktop. A console app must not be started hidden: its
// console window is the only thing the user would see.
function startsHidden(sourcePath) {
  return detectAppRuntime(sourcePath)?.subsystem === 'Windows GUI';
}

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

    const escapedPath = path.win32.normalize(String(exePath)).replace(/'/g, "''");
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Diagnostics",
      "Add-Type -AssemblyName System.Drawing",
      `$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo('${escapedPath}')`,
      "$obj = [pscustomobject]@{",
      "title = if ($info.FileDescription) { $info.FileDescription } elseif ($info.ProductName) { $info.ProductName } else { $null }",
      "version = if ($info.FileVersion) { $info.FileVersion } else { $null }",
      "company = if ($info.CompanyName) { $info.CompanyName } else { $null }",
      `originalName = if ($info.OriginalFilename) { $info.OriginalFilename } else { [System.IO.Path]::GetFileName('${escapedPath}') }`,
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

// A failed icon extraction is retried only occasionally: an executable can carry no icon at
// all, and the extraction runs a helper process.
const ICON_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Which icon extractor wrote a record's icon. Bumping this is how a record from
// an older build is upgraded: deciding by file extension was wrong, because the
// old extractor also wrote .ico files, so those records kept a single stale image
// forever and the list kept showing letters for apps whose executable carries six
// frames. 2 = the executable's own resources, with the shell as a fallback.
// 3 = the same resources, limited to the frames the interface can show: the 128 and
// 256 pixel frames were most of a 150 KB data URL per app, sent with every list read.
const ICON_EXTRACTOR_VERSION = 3;

// The largest frame worth carrying: the app tile is 42 CSS pixels, and 64 covers it on
// a high-DPI display without shipping a frame that is mostly thrown away.
const ICON_MAX_FRAME_SIDE = 64;

// The executable's own icon resources, read from the file. This is what Windows
// Explorer shows, and it is the only source that carries the sizes the app declares.
// It needs no helper process.
function extractResourceIcon(exePath, sandboxRoot) {
  const extracted = extractIconToFile(exePath, path.join(sandboxRoot, 'icon.ico'), { maxSide: ICON_MAX_FRAME_SIDE });
  if (!extracted) return null;
  return { path: extracted.path, sizes: extracted.sizes, source: 'resources', version: ICON_EXTRACTOR_VERSION };
}

// Fallback for an executable whose image carries no icon resources at all: ask the
// shell for the associated icon. It only ever returns one 32x32 image, which is why
// it is the second choice rather than the first.
async function extractExeIcon(exePath, sandboxRoot) {
  ensureDirectory(sandboxRoot);
  const fromResources = extractResourceIcon(exePath, sandboxRoot);
  if (fromResources) return { ...fromResources, from: exePath };
  const fromShell = await extractShellIcon(exePath, path.join(sandboxRoot, 'icon.png'));
  if (fromShell) return { path: fromShell, sizes: ['32x32'], source: 'shell', version: ICON_EXTRACTOR_VERSION, from: exePath };
  return null;
}

function extractShellIcon(exePath, outputPath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }

    ensureDirectory(path.dirname(outputPath));
    // .NET's icon extractor rejects forward slashes, and an imported path can carry
    // them. Normalising first means the icon exists for every way an app was added.
    const escapedPath = path.win32.normalize(String(exePath)).replace(/'/g, "''");
    const escapedOutput = String(outputPath).replace(/'/g, "''");
    // Save a real PNG: the renderer shows the icon from a data URL, and PNG is the
    // one format every Electron build decodes the same way.
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Drawing",
      `$icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${escapedPath}')`,
      `if ($icon) { $bitmap = $icon.ToBitmap(); $bitmap.Save('${escapedOutput}', [System.Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose(); $icon.Dispose(); 'ok' } else { 'missing' }`,
    ].join('; ');

    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true }, (error, stdout) => {
      if (error || stdout?.trim() !== 'ok') {
        try {
          fs.appendFileSync(
            path.join(app.getPath('userData'), 'runcontainer-error.log'),
            `[${new Date().toISOString()}] icon extraction failed for ${exePath}: ${error?.message || 'no icon reported'} ${String(stdout || '').trim()}\n`,
          );
        } catch (logError) { /* best-effort */ }
        resolve(null);
        return;
      }

      resolve(outputPath);
    });
  });
}

// The renderer's Content-Security-Policy allows data: images but not file:, so an
// icon extracted next to the app is handed over inline instead of as a file path.
function iconDataUrl(iconPath) {
  try {
    if (!iconPath || !fs.existsSync(iconPath)) return null;
    const extension = path.extname(iconPath).toLowerCase();
    const mime = extension === '.ico' ? 'image/x-icon' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
    const data = fs.readFileSync(iconPath).toString('base64');
    if (!data) return null;
    return `data:${mime};base64,${data}`;
  } catch (error) {
    return null;
  }
}

async function backfillAppIcons() {
  // Records created before icon extraction existed (or whose icon file was lost)
  // get one extracted from the installed copy the next time RunContainer starts.
  const apps = loadApps();
  let changed = false;
  for (const entry of apps) {
    if (!entry?.sandboxRoot || !entry?.source || !fs.existsSync(entry.source)) continue;
    // An icon from an older extractor is upgraded once, whatever it is called: the
    // executable's own resources are what Explorer shows, and they carry every size.
    if (Number(entry.iconVersion) === ICON_EXTRACTOR_VERSION && entry.iconFrom === entry.source
      && entry.iconPath && fs.existsSync(entry.iconPath)) continue;
    if (entry.iconPath && fs.existsSync(entry.iconPath) && Number.isFinite(Date.parse(entry.iconAttemptedAt || ''))
      && Date.now() - Date.parse(entry.iconAttemptedAt) < ICON_RETRY_INTERVAL_MS) continue;
    const extracted = await extractExeIcon(entry.source, entry.sandboxRoot);
    if (extracted) {
      entry.iconPath = extracted.path;
      entry.iconSource = extracted.source;
      entry.iconVersion = extracted.version;
      entry.iconFrom = extracted.from || entry.source;
      changed = true;
    }
  }
  if (changed) saveApps(apps);
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

// Everything the interface is told about an app is derived here, once:
//
//   iconUrl        the app's real icon, inlined because the page's CSP allows data:
//                  images and not file: ones.
//   envDirPresent  whether this app's own folder still exists.
//   sourcePresent  whether the installed executable still exists.
//   diskPresent    whether a VM disk this app needs still exists.
//
// A bare stored record carries none of them. That is not cosmetic: the app card reads
// a missing iconUrl as "no icon" and a missing envDirPresent as "folder missing", so an
// app that had just been installed showed a letter and a warning about a folder that was
// there all along. Every path that hands a record to the interface goes through this.
function decorateAppRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const root = record.sandboxRoot || (record.source ? path.dirname(record.source) : '');
  return {
    ...record,
    iconUrl: iconDataUrl(record.iconPath),
    envDirPresent: root ? fs.existsSync(root) : false,
    sourcePresent: record.source ? fs.existsSync(record.source) : false,
    diskPresent: record.hypervVhd ? fs.existsSync(record.hypervVhd) : null,
  };
}

function broadcastContainerStatus(record) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('container:status', decorateAppRecord(record));
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

// One Windows process-table query costs roughly 0.6s (see
// scripts/benchmark-launch.js). Polling every 1.5s therefore kept a PowerShell
// process busy almost half the time an app was open. Five seconds still notices
// a closed app quickly and matches RC-Brain's own observation cadence.
const PROCESS_POLL_INTERVAL_MS = 5000;

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
  }, PROCESS_POLL_INTERVAL_MS);
  sandboxMonitors.set(appId, interval);
}

// Measured launch timings for the Settings card. These are observations from
// this PC, never estimates, and the file is bounded so it cannot grow forever.
const performancePath = path.join(app.getPath('userData'), 'runcontainer-performance.json');
function loadPerformance() {
  try {
    const parsed = JSON.parse(fs.readFileSync(performancePath, 'utf8'));
    return Array.isArray(parsed?.launches) ? parsed : { launches: [] };
  } catch (error) {
    return { launches: [] };
  }
}
function recordLaunchTiming(entry) {
  try {
    const data = loadPerformance();
    data.launches = [...data.launches, entry].slice(-50);
    fs.writeFileSync(performancePath, JSON.stringify(data), 'utf8');
  } catch (error) {
    // Timings are best-effort; a launch never fails because of them.
  }
}
function performanceSummary() {
  const launches = loadPerformance().launches.filter((entry) => Number.isFinite(entry?.totalMs));
  const values = launches.map((entry) => entry.totalMs).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length === 0
    ? null
    : (values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2));
  const last = launches[launches.length - 1] || null;
  return {
    sampleCount: launches.length,
    medianLaunchMs: median,
    lastLaunchMs: last?.totalMs ?? null,
    lastLaunchAt: last?.at || null,
    lastAppName: last?.name || null,
    backend: 'RCVM containment (Job Object caps + per-app profile)',
    monitorIntervalMs: PROCESS_POLL_INTERVAL_MS,
  };
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
      const updated = { ...withTrackedPids(current, []), status: 'Stopped', pid: null, sandboxPids: [], hostedWindowPid: null, windowHosted: false, lastExitAt: new Date().toISOString() };
      saveApps(loadApps().map((entry) => (entry.id === appId ? updated : entry)));
      appendLog(logPath, 'All processes for this app have exited.');
      stopMonitor(appId);
      // A VM keeps its console (and the guest it shows) alive after the app inside it exits.
      const isVm = updated.launchMode === 'hyperv' || updated.activeEngine === 'hyperv' || isQemuEnv(updated);
      if (!isVm) {
        await stopAppWindowWatcher(appId);
        closeGuestWindow(appId);
      }
      broadcastContainerStatus(updated);
      return;
    }
    if (JSON.stringify(pids) !== JSON.stringify(current.sandboxPids || [])) {
      const updated = { ...withTrackedPids(current, pids), pid: pids[0], sandboxPids: pids };
      saveApps(loadApps().map((entry) => (entry.id === appId ? updated : entry)));
      // New child processes may own the next window to appear; let the watcher see them.
      if (appWindowHosts.has(appId)) writeWindowHostPids(updated);
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
      // Windows' own IE cache creates a junction inside the profile (Content.IE5 -> IE) and
      // installers create more. Deleting the tree while one exists fails with "untrusted
      // mount point" on every attempt, so the links are removed first — the link only,
      // never what it points at.
      clearLinks: async () => {
        const result = clearReparsePoints(sandboxRoot);
        if (logPath && result.removed.length > 0) {
          appendLog(logPath, `Removed ${result.removed.length} reparse point${result.removed.length === 1 ? '' : 's'} left inside ${sandboxRoot} before deleting the folder (the link only, not what it pointed at).`);
        }
        if (logPath && result.failed.length > 0) {
          appendLog(logPath, `Windows refused to remove ${result.failed.length} reparse point${result.failed.length === 1 ? '' : 's'} inside ${sandboxRoot}: ${result.failed.slice(0, 3).join(', ')}`);
        }
        return result;
      },
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
    // The app's window lives in the guest desktop, so it is shown in a RunContainer
    // window; otherwise the user would see nothing after pressing Run.
    showHyperVGuestDisplay(appRecord, logPath).catch((error) => {
      appendLog(logPath, `The app is running, but its window could not be opened automatically: ${error.message} Use Show app window.`);
    });
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

// Runs one host operation (embed, release, resize) with the fastest host available.
async function runWindowHostScript(options) {
  const exePath = await ensureWindowHostExe();
  const command = exePath || 'powershell.exe';
  const args = exePath
    ? buildWindowHostProgramArgs(options)
    : buildWindowHostScriptArgs(ensureWindowHostScript(), { ...options, cachePath: windowHostCachePath() });
  try {
    return parseWindowHostOutput((await executeFile(command, args, { timeout: 90000 })).stdout);
  } catch (error) {
    try {
      return parseWindowHostOutput(String(error.message));
    } catch (unreadable) {
      throw error;
    }
  }
}

// --- Behavioural monitor ------------------------------------------------------
// The supervisor in src/utils/behavioralMonitor.js owns the state machine; this
// side supplies the three live vectors (window handles, CPU/IO, log tail) and
// performs the repair it asks for. Nothing here can launch an app uncontained.
const liveLogs = new Map();
const probeSamples = new Map();
const lastObservations = new Map();
const aiLogPath = path.join(app.getPath('userData'), 'runcontainer-error.log');
const experienceStore = createExperienceStore({
  dir: app.getPath('userData'),
  username: os.userInfo().username,
  hostname: os.hostname(),
  logger: (message) => {
    try { appendLog(aiLogPath, message); } catch (error) { /* best-effort */ }
  },
});
let aiBrain = createBrain({
  retrieve: ({ features }) => experienceStore.retrieve({ features, k: 3 }),
  logger: (message) => {
    try {
      appendLog(aiLogPath, message);
    } catch (error) {
      // The error log is best-effort.
    }
  },
});
const repairVerifier = repairVerification.createRepairVerifier({ minObservations: 3, timeoutMs: 45000 });
const pendingRepairs = new Map();
let aiMonitoringEnabled = true;
// Local diagnostic history: temporary context for the safety gate and the
// RC-Brain section in Settings. It is not training data and nothing here
// changes the model's weights.
// The separate experience store holds verified outcomes; neither one updates
// weights without an explicit, offline, gated training run.
const aiHistoryPath = path.join(app.getPath('userData'), 'runcontainer-ai-history.json');
let aiHistory = [];
try {
  const saved = JSON.parse(fs.readFileSync(aiHistoryPath, 'utf8'));
  if (Array.isArray(saved)) aiHistory = saved.slice(0, 40);
} catch (error) {
  aiHistory = [];
}
try {
  appendLog(
    path.join(app.getPath('userData'), 'runcontainer-error.log'),
    aiBrain.available
      ? `RC-Brain ${aiBrain.model.name} ${aiBrain.model.version} loaded (${aiBrain.model.parameters} parameters, model built ${aiBrain.model.createdAt}).`
      : `RC-Brain is unavailable: ${aiBrain.error}`,
  );
} catch (error) {
  // Diagnostics are best-effort; Settings reports the same state.
}
const anomalyTelemetry = createTelemetryLogger({
  userDataDir: app.getPath('userData'),
  appVersion: app.getVersion(),
  logger: (message) => {
    try {
      appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), message);
    } catch (error) {
      // The error log is best-effort.
    }
  },
});
let behavioralSupervisor = null;

function liveLogBuffer(appId) {
  if (!liveLogs.has(appId)) liveLogs.set(appId, behavioralMonitor.createLiveLogBuffer());
  return liveLogs.get(appId);
}

function clearLiveLog(appId) {
  liveLogs.delete(appId);
}

function appLogPath(appRecord) {
  const sandboxRoot = appRecord?.sandboxRoot || (appRecord?.source ? path.dirname(appRecord.source) : '');
  const logsRoot = appRecord?.logsRoot || path.join(sandboxRoot, 'logs');
  return path.join(logsRoot, `${sanitizeName(appRecord?.name || 'app')}.log`);
}

function ensureBehaviorProbeScript() {
  const scriptPath = path.join(app.getPath('userData'), 'runcontainer-behaviour-probe.ps1');
  const text = buildBehaviorProbeScript();
  try {
    if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf8') !== text) {
      fs.writeFileSync(scriptPath, text, 'utf8');
    }
  } catch (error) {
    // A stale script still works; a missing one surfaces as an unavailable probe.
  }
  return scriptPath;
}

// An engine whose own process has exited while the app is still reported Running
// cannot be answering for it any more.
function behavioralEngineResponsive(appRecord) {
  const engine = appRecord?.activeEngine || appRecord?.launchMode;
  if (engine === 'qemu') {
    const child = qemuProcs.get(appRecord.id);
    if (child && child.exitCode !== null) return false;
  }
  if (engine === 'rcvm') {
    const child = rcvmLaunchers.get(appRecord.id);
    if (child && child.exitCode !== null) return false;
  }
  return true;
}

// A setup program that was started in its documented unattended mode, inside this
// environment, and has not produced an app yet. It shows no window on purpose while it
// works, so it must not be read as an app whose window never appeared: that reading is
// what made RC-Brain restart a working installer in the middle of its own setup.
function backgroundSetupRunning(appRecord) {
  return Boolean(appRecord?.setupProgram
    && appRecord.setupPlanMode === 'silent'
    && !appRecord.installedExePath
    && appRecord.status === 'Running');
}

async function probeAppBehavior(appRecord, state) {
  const engine = appRecord.activeEngine || appRecord.launchMode || 'rcvm';
  const isVm = engine === 'qemu' || engine === 'hyperv';
  const logLines = [
    ...behavioralMonitor.readLogTail(appLogPath(appRecord)),
    ...(liveLogs.get(appRecord.id)?.lines() || []),
  ].slice(-behavioralMonitor.RULES.logLines);
  const pids = (appRecord.sandboxPids || []).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  let probe = null;
  if (!isVm && process.platform === 'win32' && pids.length > 0) {
    try {
      // A hosted window is a child of RunContainer's host window; the probe needs the
      // PID of the process that owns that host to recognise it instead of reporting the
      // app as windowless. A normal launch is hosted by this process; an elevated app is
      // hosted by its elevated launcher, and its window would otherwise look missing and
      // be "repaired" by restarting a working installer mid-setup.
      const hostPid = appRecord.elevated && Number.isSafeInteger(appRecord.rcvmLauncherPid)
        ? appRecord.rcvmLauncherPid
        : process.pid;
      const { stdout } = await executeFile('powershell.exe', buildBehaviorProbeArgs(ensureBehaviorProbeScript(), pids, hostPid), {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      probe = summarizeProbe(parseBehaviorProbeOutput(stdout));
    } catch (error) {
      probe = null;
    }
  }
  const now = Date.now();
  const previous = probeSamples.get(appRecord.id) || null;
  let cpuPercent = 0;
  if (probe && previous && probe.cpuMs !== null && previous.cpuMs !== null && now > previous.now) {
    cpuPercent = Math.max(0, Math.min(100, (100 * (probe.cpuMs - previous.cpuMs)) / (now - previous.now)));
  }
  const ioIdle = Boolean(probe && previous && probe.ioBytes !== null && previous.ioBytes !== null && probe.ioBytes <= previous.ioBytes);
  probeSamples.set(appRecord.id, { now, cpuMs: probe ? probe.cpuMs : null, ioBytes: probe ? probe.ioBytes : null });
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  // The window age must restart with the app. Without this, a restart inherited the
  // old launch's age, so the first sample taken before the new window was hosted looked
  // like a window that had been missing for minutes and RC-Brain restarted the app again.
  const launchedAt = Date.parse(appRecord.lastLaunchedAt || '') || 0;
  const windowSince = Math.max(state?.firstSeenAt || 0, launchedAt) || now;
  return {
    now,
    running: true,
    engine,
    pidCount: pids.length,
    // GUI-subsystem images are expected to show a window; console tools are not. An
    // unattended setup is the documented exception: no window is expected from it yet.
    windowExpected: !isVm && behavioralMonitor.isGuiExecutable(appRecord.source) && !backgroundSetupRunning(appRecord),
    windowVisible: probe ? Boolean(probe.windowVisible) : null,
    windowHung: probe ? Boolean(probe.windowHung) : false,
    windowAgeMs: now - windowSince,
    ageMs: now - (state?.firstSeenAt || now),
    engineResponsive: behavioralEngineResponsive(appRecord),
    cpuPercent,
    ioIdle,
    cpuMs: probe ? probe.cpuMs : null,
    ioBytes: probe ? probe.ioBytes : null,
    environment: {
      qemuProvisioned: isQemuProvisioned(),
      hypervReady: Boolean(appRecord.hypervVm),
      appContainerSupported: isAppContainerSupported(),
      // Read by the model's evidence list so the diagnosis can say why no window is
      // expected instead of leaving the user to guess.
      setupInBackground: backgroundSetupRunning(appRecord),
      runtimePresent: fs.existsSync(path.join(system32, 'vcruntime140.dll')) && fs.existsSync(path.join(system32, 'msvcp140.dll')),
    },
    logLines,
  };
}

// Bounded, read-only scan for executables that appeared in a folder after a given
// time. Used by the setup agent to answer "has setup produced a real app yet?"
// without assuming where an installer decided to put it.
function findExecutablesIn(root, { since = 0, exclude = [], maxDepth = 6, maxEntries = 4000 } = {}) {
  const found = [];
  const skip = new Set(exclude.filter(Boolean).map((entry) => String(entry).toLowerCase()));
  let visited = 0;
  const walk = (directory, depth) => {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) return;
      visited += 1;
      const child = path.join(directory, entry.name);
      if (skip.has(child.toLowerCase())) continue;
      if (entry.isDirectory()) {
        walk(child, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.exe')) continue;
      try {
        const stats = fs.statSync(child);
        if (!since || stats.mtimeMs >= since) found.push(child);
      } catch (error) {
        // A file that vanished mid-scan is simply not evidence.
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.length - b.length);
}

// --- Specialist evidence agents -------------------------------------------
// RC-Brain's `spawn_agents` action runs these. Every probe below is READ-ONLY: it
// measures and reports. None of them starts, stops, restarts, repairs, deletes or
// writes inside the app's folder, and none of them can be given an argument by the
// model — the model only chooses which of the fixed agents to dispatch.

function agentApp(observation) {
  const id = observation?.app?.id;
  return (id && getStoredApp(id)) || null;
}

function appAgentPids(appRecord) {
  return [...new Set([...(appRecord?.sandboxPids || []), appRecord?.pid].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
}

// Engine agent: is the containment engine still alive for this app?
async function agentProbeEngine({ observation }) {
  const appRecord = agentApp(observation);
  if (!appRecord?.id) return { signals: {}, facts: ['no stored record for this app, so the engine could not be identified'] };
  const engine = appRecord.activeEngine || appRecord.launchMode || 'rcvm';
  const facts = [`the app runs on the ${engine} engine`];
  let dead = false;
  if (engine === 'rcvm') {
    const launcher = rcvmLaunchers.get(appRecord.id);
    if (launcher && launcher.exitCode !== null) {
      dead = true;
      facts.push(`the contained launcher has exited (code ${launcher.exitCode})`);
    } else if (launcher) {
      facts.push('the contained launcher process is still running');
    } else {
      facts.push('no launcher process is tracked for this app in this session');
    }
  } else if (engine === 'qemu') {
    const child = qemuProcs.get(appRecord.id);
    if (child && child.exitCode !== null) {
      dead = true;
      facts.push(`the QEMU process has exited (code ${child.exitCode})`);
    } else {
      facts.push('the QEMU process is present');
    }
  } else if (engine === 'hyperv') {
    const ready = await checkHyperVReady().catch(() => ({ ready: false }));
    dead = !ready.ready;
    facts.push(ready.ready ? 'Hyper-V is ready' : `Hyper-V is not ready: ${ready.detail || 'no detail'}`);
  } else {
    facts.push('the AppContainer engine has no separate process to check; containment is a token on the app itself');
  }
  if (dead) facts.push('the engine that owns this app is no longer alive, so it cannot be answering for it');
  return { signals: { engine_dead: dead }, facts };
}

// Window agent: does the app actually have a visible window, and is one of them
// owned through a host we cannot see?
async function agentProbeWindow({ observation }) {
  const appRecord = agentApp(observation);
  if (process.platform !== 'win32') return { signals: {}, facts: ['window measurement requires Windows'] };
  const pids = appAgentPids(appRecord);
  if (pids.length === 0) return { signals: {}, facts: ['no process ids are recorded for this app, so there is nothing to enumerate windows for'] };
  const hostPid = appRecord?.elevated && Number.isSafeInteger(appRecord.rcvmLauncherPid) ? appRecord.rcvmLauncherPid : process.pid;
  try {
    const { stdout } = await executeFile('powershell.exe', buildBehaviorProbeArgs(ensureBehaviorProbeScript(), pids, hostPid), { timeout: 15000, maxBuffer: 1024 * 1024 });
    const probe = summarizeProbe(parseBehaviorProbeOutput(stdout));
    const facts = [
      `${pids.length} process(es) were enumerated`,
      probe.windowVisible ? `${probe.windowCount} visible window(s) are attributable to the app or its host` : 'no visible window is attributable to the app or its host',
    ];
    if (probe.windowForeign > 0) {
      facts.push(`${probe.windowForeign} visible window(s) belong to neither the app nor the expected host, which is what an app hosted by another RunContainer window looks like`);
    }
    if (probe.windowHung) facts.push('Windows reports one of those windows as not responding');
    return { signals: { window_elsewhere: probe.windowForeign > 0 }, facts };
  } catch (error) {
    throw new Error(`the window enumeration did not answer: ${error.message}`);
  }
}

// Process agent: what is actually running out of the app's folder?
async function agentProbeProcess({ observation }) {
  const appRecord = agentApp(observation);
  if (!appRecord?.sandboxRoot) return { signals: {}, facts: ['no managed folder is recorded for this app'] };
  const table = await listProcessTable();
  const pids = findAppProcessIds(table, appRecord.sandboxRoot, appAgentPids(appRecord));
  const facts = pids.length > 0
    ? [`${pids.length} process(es) are running from the app's own folder: ${pids.slice(0, 6).join(', ')}`]
    : ['no running process executes from the app\u2019s folder'];
  if (pids.length === 0 && appRecord.status === 'Running') {
    facts.push('the app is still recorded as running while nothing of it is executing, so the record is stale');
  }
  return { signals: {}, facts };
}

// Filesystem agent: the app's own folder, measured. Read-only: the write test
// creates and removes one file inside the folder, which is the only way to learn
// whether writes are actually denied.
async function agentProbeFilesystem({ observation }) {
  const appRecord = agentApp(observation);
  const root = appRecord?.sandboxRoot;
  if (!root) return { signals: {}, facts: ['no managed folder is recorded for this app'] };
  const facts = [];
  if (!fs.existsSync(root)) {
    return { signals: {}, facts: [`the app's folder does not exist any more (${root})`], detail: 'folder-missing' };
  }
  let aclDenied = false;
  const probeFile = path.join(root, `.rc-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probeFile, 'probe', 'utf8');
    fs.unlinkSync(probeFile);
    facts.push('the app\u2019s own folder accepted a write');
  } catch (error) {
    aclDenied = true;
    facts.push(`writing inside the app\u2019s own folder was denied: ${error.code || error.message}`);
  }
  const links = listReparsePoints(root);
  if (links.length > 0) facts.push(`${links.length} reparse point(s) (junctions or links) are inside the folder, for example ${path.basename(links[0])}`);
  try {
    const stats = fs.statfsSync(root);
    const freeGb = (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
    facts.push(`${freeGb.toFixed(1)} GB free on the drive holding the app`);
    if (freeGb < 2) facts.push('that is below the 2 GB the installer and VM paths need');
  } catch (error) {
    // Older runtimes may not report filesystem statistics; that is not a failure.
  }
  return { signals: { acl_denied: aclDenied, reparse_link: links.length > 0 }, facts };
}

// Log agent: the signal classes in the live log tail, including log text that
// tries to give the monitor orders (reported as evidence, never followed).
async function agentProbeLogs({ observation }) {
  const appRecord = agentApp(observation);
  const lines = Array.isArray(observation?.logLines) ? observation.logLines : [];
  const signals = detectLogSignals(lines);
  const matched = Object.entries(signals)
    .filter(([key, value]) => value === true && !['present'].includes(key))
    .map(([key]) => key);
  const facts = [];
  if (!appRecord?.id) facts.push('no stored record for this app, so only the observation log tail could be read');
  if (lines.length === 0) facts.push('the log is empty: the app has produced no output at all');
  else facts.push(`${lines.length} log line(s), matching signal classes: ${matched.join(', ') || 'none of the known classes'}`);
  if (signals.injection) facts.push('the log contains instructions aimed at the monitor; they were treated as data and never followed');
  return { signals: {}, facts, detail: matched.join(',') || 'none' };
}

// Setup agent: is an installer staged or running for this app, and has setup
// produced a real executable yet?
async function agentProbeSetup({ observation }) {
  const appRecord = agentApp(observation);
  const root = appRecord?.sandboxRoot;
  if (!root) return { signals: {}, facts: ['no managed folder is recorded for this app'] };
  const facts = [];
  const installerDir = path.join(root, 'installers');
  const staged = fs.existsSync(installerDir) ? fs.readdirSync(installerDir).filter((name) => name.toLowerCase().endsWith('.exe')) : [];
  if (staged.length > 0) facts.push(`${staged.length} setup program(s) are staged in the app's folder: ${staged.slice(0, 3).join(', ')}`);
  const pids = appAgentPids(appRecord);
  const installerRunning = Boolean(appRecord?.lastInstallerPid) && pids.includes(appRecord.lastInstallerPid);
  if (installerRunning) facts.push(`the setup program (PID ${appRecord.lastInstallerPid}) is still running`);
  const since = Date.parse(appRecord?.lastInstallerAt || '') || 0;
  const produced = findExecutablesIn(root, { since, exclude: [appRecord?.source, ...staged.map((name) => path.join(installerDir, name))] });
  if (produced.length > 0) facts.push(`setup produced ${produced.length} executable(s) in the app's folder, for example ${path.basename(produced[0])}`);
  if (staged.length > 0 && produced.length === 0 && !installerRunning) facts.push('the staged setup program is neither running nor finished');
  return { signals: { new_exe_present: produced.length > 0, installer_running: installerRunning }, facts };
}

let agentCoordinator = null;
function ensureAgentCoordinator() {
  if (agentCoordinator) return agentCoordinator;
  agentCoordinator = createAgentCoordinator({
    probes: {
      engine: agentProbeEngine,
      window: agentProbeWindow,
      process: agentProbeProcess,
      filesystem: agentProbeFilesystem,
      logs: agentProbeLogs,
      setup: agentProbeSetup,
    },
    logger: (message) => {
      try {
        appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `RC-Brain agent: ${message}`);
      } catch (error) {
        // The error log is best-effort.
      }
    },
  });
  return agentCoordinator;
}

function emitToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, payload);
    } catch (error) {
      // The window may be closing; a missed notice is not worth an error.
    }
  }
}

function recordAiHistory(entry) {
  // Replace the same decision when its repair result arrives, so one diagnosis
  // is one row rather than two.
  const existing = aiHistory.findIndex((item) => item.id === entry.id && item.detectedAt === entry.detectedAt);
  if (existing >= 0) aiHistory.splice(existing, 1);
  aiHistory.unshift(entry);
  aiHistory.splice(40);
  try {
    fs.writeFileSync(aiHistoryPath, JSON.stringify(aiHistory, null, 2), 'utf8');
  } catch (error) {
    // History is best-effort; losing it never affects monitoring.
  }
  emitToRenderer('ai:history', aiHistory);
}

async function handleAiDecision(notice) {
  const appRecord = getStoredApp(notice.id);
  if (appRecord) {
    appendLog(appLogPath(appRecord), `RC-Brain: ${notice.diagnosis.id} (${notice.diagnosis.confidenceText}) chose ${notice.action.id}${notice.uncertain ? ' from uncertain evidence' : ''}.`);
  }
  const entry = { ...notice, outcome: notice.autoExecute ? 'repairing' : notice.decision };
  recordAiHistory(entry);
  emitToRenderer('ai:diagnosis', entry);
  if (!notice.autoExecute) return;
  const result = await repairAppBehavior({ appId: notice.id, decision: notice });
  entry.outcome = result.status;
  entry.result = result;
  recordAiHistory(entry);
  emitToRenderer('ai:repair-result', { id: notice.id, result, diagnosis: notice.diagnosis, action: notice.action });
}

function startBehavioralSupervisor() {
  if (!aiMonitoringEnabled) return;
  if (behavioralSupervisor) {
    behavioralSupervisor.start();
    return;
  }
  behavioralSupervisor = behavioralMonitor.createBehavioralSupervisor({
    brain: aiBrain,
    listApps: async () => loadApps(),
    probe: probeAppBehavior,
    onDecision: handleAiDecision,
    onRecovered: ({ id }) => emitToRenderer('ai:recovered', { id }),
    onUnavailable: ({ error }) => emitToRenderer('ai:unavailable', { error }),
    onSample: handleRepairSample,
    agents: ensureAgentCoordinator(),
    // The research agent's second source. These are incidents verified on this
    // machine, already scrubbed when they were stored, and they never leave it.
    experiencesFor: () => {
      try {
        return experienceStore.list({ limit: 6, verifiedOnly: true });
      } catch (error) {
        return [];
      }
    },
    logger: (message) => {
      try {
        appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), message);
      } catch (error) {
        // The error log is best-effort.
      }
    },
    intervalMs: 5000,
  });
  behavioralSupervisor.start();
}

function aiRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(AI_REGISTRY_PATH, 'utf8'));
    return {
      current: raw.current || null,
      previous: raw.previous || null,
      updatedAt: raw.updatedAt || null,
      history: Array.isArray(raw.history) ? raw.history.slice(-4) : [],
    };
  } catch (error) {
    return { current: null, previous: null, history: [] };
  }
}

function aiCandidateInfo() {
  const curated = experienceStore.curated();
  const examples = Array.isArray(curated.examples) ? curated.examples.length : 0;
  let candidateModel = null;
  try {
    // The candidate belongs to whichever model is active, so its name is derived
    // from the registry rather than hard-coded: after a retrain a fixed name would
    // silently stop finding candidates at all.
    const current = aiRegistry().current || 'rc-brain-5.json';
    const file = path.join(__dirname, '..', 'src', 'ai', 'model', current.replace(/\.json$/, '-candidate.json'));
    if (fs.existsSync(file)) {
      const artefact = JSON.parse(fs.readFileSync(file, 'utf8'));
      candidateModel = { id: artefact.id, version: artefact.version, createdAt: artefact.createdAt, parameters: artefact.parameterCount };
    }
  } catch (error) {
    candidateModel = null;
  }
  return {
    examples,
    canTrain: examples >= 20,
    minExamples: 20,
    candidateModel,
    note: 'Promoted examples stay local. Training a candidate is an offline command (scripts/train-ai-candidate.js) and activation is a separate gated step; monitoring never trains on its own.',
  };
}

function aiStatus() {
  const stats = experienceStore.stats();
  return {
    available: aiBrain.available,
    error: aiBrain.error,
    model: aiBrain.model,
    registry: aiRegistry(),
    monitoring: Boolean(aiMonitoringEnabled && behavioralSupervisor),
    // Live proof that the supervisor is ticking, shown in Settings.
    monitor: behavioralSupervisor?.status?.() || {
      running: false, intervalMs: null, startedAt: null, lastTickAt: null, ticks: 0, watchedApps: 0,
    },
    enabled: aiMonitoringEnabled,
    knowledgeVersion: aiKnowledge.knowledgeVersion,
    limits: aiKnowledge.limits,
    permissions: aiKnowledge.actions.map(({ id, label, risk, autonomous, requiresApproval }) => ({ id, label, risk, autonomous, requiresApproval: Boolean(requiresApproval) })),
    capabilities: aiBrain.model?.capabilities || null,
    // The fixed agents the model may dispatch, and which of them this build can
    // actually run. Listed for the interface; no agent can be added at runtime.
    agents: {
      catalogue: ensureAgentCoordinator().catalogue.map(({ id, label, purpose, available, basis }) => ({ id, label, purpose, available, basis })),
      // The second tier: the agents that reason over the completed evidence (no
      // probe to run, so no availability flag), and the two tools themselves.
      specialists: ensureAgentCoordinator().specialistCatalogue.map(({ id, label, purpose, basis }) => ({ id, label, purpose, basis })),
      tools: [
        {
          id: 'spawn_agents',
          label: 'Dispatch specialist agents',
          description: 'Measure the components that were not measured, then ask the research, expert and harmony agents what the completed evidence means.',
        },
        {
          id: 'consult_runbook',
          label: 'Consult the Runbook',
          description: 'Look an exact documented signature up in a fixed table (Windows errors, setup exit codes, documented RunContainer states). A table is either right or silent, never a guess.',
        },
      ],
      dispatched: (() => {
        const recent = aiHistory.find((entry) => entry.agents);
        return recent ? { name: recent.name, spawned: recent.agents.spawned || [], facts: recent.agents.facts || [] } : null;
      })(),
    },
    experiences: stats,
    recentExperiences: experienceStore.list({ limit: 5 }),
    candidate: aiCandidateInfo(),
    verification: {
      pending: pendingRepairs.size,
      minObservations: repairVerifier.minObservations,
      timeoutMs: repairVerifier.timeoutMs,
    },
    privacy: 'RC-Brain runs locally. Experience history stays in this PC\'s app data and is redacted (paths, names, hosts, e-mails removed). Nothing is uploaded unless this build configures an explicit registry endpoint; nothing is uploaded by default.',
  };
}

// A repair is only counted as a success after the original condition clears for
// several consecutive observations. Anything else is recorded honestly.
function completeVerifiedOutcome(appId, verdict) {
  const pending = pendingRepairs.get(appId) || null;
  const observation = pending?.observation || lastObservations.get(appId) || null;
  const decision = pending?.decision || null;
  pendingRepairs.delete(appId);
  repairVerifier.clear(appId);
  if (pending) pendingRepairs.delete(appId);

  let experience = null;
  if (observation && decision) {
    const outcome = verdict.status === repairVerification.STATUS.VERIFIED
      ? 'success'
      : verdict.status === repairVerification.STATUS.UNRESOLVED ? 'failure' : 'inconclusive';
    const recorded = experienceStore.record({
      observation,
      decision,
      execution: {
        performed: true,
        completed: true,
        steps: pending?.steps || [],
      },
      verification: verdict,
      outcome,
    });
    experience = recorded.stored ? recorded.entry : null;
  }

  emitToRenderer('ai:verified', {
    id: appId,
    verdict,
    diagnosis: decision?.diagnosis || null,
    action: decision?.action || null,
    experience,
  });
  emitToRenderer('ai:status', aiStatus());
}

function handleRepairSample({ id, observation }) {
  lastObservations.set(id, observation);
  const verdict = repairVerifier.observe(id, observation);
  if (verdict) completeVerifiedOutcome(id, verdict);
}

function reloadBrain() {
  aiBrain = createBrain({
    retrieve: ({ features }) => experienceStore.retrieve({ features, k: 3 }),
    logger: (message) => {
      try { appendLog(aiLogPath, message); } catch (error) { /* best-effort */ }
    },
  });
  if (behavioralSupervisor) {
    behavioralSupervisor.stop();
    behavioralSupervisor = null;
    startBehavioralSupervisor();
  }
}

// Clears the data RunContainer keeps for one app: its RCVM profile, redirected
// AppData/Temp/ProgramData, and the per-app registry key RunContainer owns (if a
// previous version created one). Registry writes an app makes outside its own
// folder are not reverted, and the repair result says so.
function clearAppProfile(appRecord, logPath) {
  const sandboxRoot = appRecord.sandboxRoot;
  const cleared = [];
  if (!sandboxRoot) return cleared;
  for (const target of ['profile', 'AppData', 'Temp', 'ProgramData']) {
    const targetPath = path.join(sandboxRoot, target);
    if (!isWithinDirectory(sandboxRoot, targetPath) || !fs.existsSync(targetPath)) continue;
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      cleared.push(target);
    } catch (error) {
      appendLog(logPath, `Repair could not clear ${target}: ${error.message}`);
    }
  }
  ensureSandboxLayout(sandboxRoot);
  return cleared;
}

function missingMicrosoftRuntimeNote(logLines) {
  const text = (logLines || []).join('\n');
  if (!/(vcruntime\d+|msvcp\d+|ucrtbase)\.dll/i.test(text)) return null;
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const missing = ['vcruntime140.dll', 'msvcp140.dll', 'ucrtbase.dll'].filter((dll) => !fs.existsSync(path.join(system32, dll)));
  if (missing.length === 0) return null;
  return `This PC is missing ${missing.join(', ')} from System32. Install the official Microsoft Visual C++ Redistributable, then press Run again. RunContainer does not install system runtimes on its own.`;
}

// Re-grants access to the app's own folder only. This is the executor for the
// model's repair_permissions action; it never touches any other path.
async function repairFolderPermissions(appRecord, logPath) {
  if (!appRecord.sandboxRoot) return { repaired: false, error: 'The app has no managed folder.' };
  const steps = buildAclRepairPlan(appRecord.sandboxRoot);
  for (const step of steps) {
    try {
      await executeFile(step.command, step.args);
    } catch (error) {
      appendLog(logPath, `Permission repair step (${step.command}) failed: ${error.message}`);
    }
  }
  appendLog(logPath, 'Re-granted access to this app’s managed folder; nothing outside it was touched.');
  return { repaired: true };
}

function telemetryAnomalyFromDecision(decision, actionId) {
  return {
    rule: decision?.diagnosis?.id || actionId,
    title: decision?.diagnosis?.summary || actionId,
    detail: decision?.explanation || '',
    snippet: decision?.observation?.logLine || '',
    confidence: decision?.diagnosis?.confidence,
  };
}

function settleAiRepair(appRecord, decision, actionId, outcome, detail) {
  if (behavioralSupervisor) {
    behavioralSupervisor.recordRepair(appRecord.id, { diagnosis: decision?.diagnosis?.id, outcome });
    if (outcome === 'repaired') behavioralSupervisor.clearActive(appRecord.id);
  }
  const anomaly = telemetryAnomalyFromDecision(decision, actionId);
  if (anomalyTelemetry.enabled) {
    anomalyTelemetry.recordHandled({
      anomaly,
      appRecord,
      resolution: { action: actionId, outcome, detail },
    }).catch(() => {});
  }
}

async function repairAppBehavior(payload = {}) {
  const appRecord = getStoredApp(payload.appId);
  if (!appRecord?.id) {
    return { status: 'failed', error: 'This app is no longer in RunContainer’s list.' };
  }
  const decision = payload.decision || null;
  const actionId = decision?.action?.id || payload.actionId || null;
  const plan = behavioralMonitor.repairPlanFor(actionId);
  const logPath = appLogPath(appRecord);
  if (!plan) {
    return {
      status: 'not-executable',
      id: appRecord.id,
      action: actionId,
      error: decision?.action?.requiresApproval
        ? 'That repair needs a person: use Reset or Delete in Manage, and read the diagnosis first.'
        : 'RC-Brain did not choose a repair that RunContainer can execute. Its explanation and evidence are shown instead.',
    };
  }
  if (plan.requiresApproval && payload.approved !== true) {
    return {
      status: 'awaiting_approval',
      id: appRecord.id,
      action: actionId,
      error: 'This repair changes app-local data and needs your approval before it runs.',
    };
  }
  const monitored = behavioralSupervisor?.getState(appRecord.id);
  if (monitored && !behavioralMonitor.canRepair(monitored)) {
    return {
      status: 'failed',
      id: appRecord.id,
      action: actionId,
      error: 'Automatic repair has already run twice for this app in the last ten minutes. Close it and start it again, or use Reset in Manage.',
    };
  }
  return withOpLock(appRecord.id, 'repair', async () => {
    appendLog(logPath, `RC-Brain repair requested: ${actionId} after ${decision?.diagnosis?.id || 'a diagnosis'}.`);
    // Verification starts before the repair, using the last real observation as
    // the baseline. It finishes several ticks later, not on this return value.
    const before = lastObservations.get(appRecord.id) || null;
    repairVerifier.start({ appId: appRecord.id, diagnosisId: decision?.diagnosis?.id || null, actionId, before });
    pendingRepairs.set(appRecord.id, { decision, observation: before, steps: [`${actionId} executed`] });
    await releaseAppWindow(appRecord, appRecord.sandboxPids, logPath).catch(() => {});
    await stopRcvmLauncher(appRecord, logPath).catch(() => {});
    const qemuChild = qemuProcs.get(appRecord.id);
    if (qemuChild) {
      try { qemuChild.kill(); } catch (error) { /* already gone */ }
      qemuProcs.delete(appRecord.id);
    }
    const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source || '');
    let remaining = [];
    try {
      remaining = await stopProcessesUnder(sandboxRoot, trackedPids(appRecord), { logPath });
    } catch (error) {
      appendLog(logPath, `Repair could not verify that the app stopped: ${error.message}`);
      remaining = trackedPids(appRecord);
    }
    if (remaining.length > 0) {
      const error = `Repair could not stop this app (PIDs ${remaining.join(', ')}). Close it and try again.`;
      settleAiRepair(appRecord, decision, actionId, 'failed', error);
      return { status: 'failed', id: appRecord.id, action: actionId, error };
    }

    let permissions = null;
    if (plan.repairAcl) permissions = await repairFolderPermissions(appRecord, logPath);
    const cleared = plan.resetProfile ? clearAppProfile(appRecord, logPath) : [];
    const updated = resetLaunchState(getStoredApp(appRecord.id) || appRecord);
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updated : entry)));
    const launched = await runApp(updated, { lockHeld: true });
    const repaired = launched?.status === 'Running';
    const runtimeNote = missingMicrosoftRuntimeNote([
      decision?.observation?.logLine || '',
      ...(await Promise.resolve(behavioralMonitor.readLogTail(logPath))),
    ]);
    const note = repaired
      ? null
      : runtimeNote || launched?.error || launched?.reason || 'The app did not start again after the repair.';
    appendLog(logPath, repaired
      ? `Repair finished: the app is running again after ${actionId}.`
      : `Repair did not start the app again: ${note}`);
    const detail = repaired
      ? `App restarted after ${actionId}${cleared.length > 0 ? ` with a clean profile (${cleared.join(', ')})` : ''}${permissions?.repaired ? ' and repaired folder permissions' : ''}.`
      : note || '';
    settleAiRepair(appRecord, decision, actionId, repaired ? 'repaired' : 'failed', detail);
    if (!repaired) {
      repairVerifier.clear(appRecord.id);
      pendingRepairs.delete(appRecord.id);
    }
    return {
      status: repaired ? 'repaired' : 'failed',
      id: appRecord.id,
      action: actionId,
      engine: launched?.activeEngine || launched?.launchMode || null,
      clearedProfile: cleared,
      permissionsRepaired: Boolean(permissions?.repaired),
      verification: repaired ? 'pending' : 'not-applicable',
      verificationNote: repaired
        ? 'The app restarted. RC-Brain is now checking that the original problem cleared before calling this a success.'
        : null,
      note,
      error: repaired ? null : note,
    };
  });
}

// --- Second RunContainer window ------------------------------------------------
// Not every app can be presented inside the main window: a VM console runs in its
// own console process, and Windows sometimes refuses to re-parent a window. In those
// cases RunContainer opens a second window of its own and hosts the app's window
// under a RunContainer header there, instead of leaving it as a bare desktop window.
// Hosting is presentation only and adds no isolation.
const guestWindows = new Map();
const GUEST_WINDOW_HEADER_PX = 56;

// One watcher per app. It hosts windows as they appear, keeps the main one fitted,
// and stops when its host window closes, RunContainer asks it to, or its app ends.
const appWindowHosts = new Map();

// One guard per app: after the host has proved it cannot start, later hosting calls
// for the same launch are skipped instead of reopening a window that cannot be used.
const windowHostBackoff = new Map();

function windowHostStateDir() {
  const dir = path.join(app.getPath('userData'), 'window-host');
  ensureDirectory(dir);
  return dir;
}

function windowHostPidFile(appId) {
  return path.join(windowHostStateDir(), `${sanitizeName(appId || 'app')}.pids`);
}

function windowHostStopFile(appId) {
  return path.join(windowHostStateDir(), `${sanitizeName(appId || 'app')}.stop`);
}

// The Win32 host is C# compiled by Add-Type. Compiling it on every launch cost about a
// second between pressing Run and the app's window moving inside RunContainer; the
// compiled assembly is cached per source revision instead.
function windowHostCachePath() {
  const digest = crypto.createHash('sha1').update(buildWindowHostCSharp()).digest('hex').slice(0, 12);
  return path.join(windowHostStateDir(), `RunContainerWindowHost-${digest}.dll`);
}

// The host as a small native executable, compiled once per revision.
//
// Every launch used to start Windows PowerShell and load the compiled assembly before the
// watcher could adopt anything, which cost about half a second each time. The executable
// starts in milliseconds, so the app's first window is adopted almost immediately instead
// of appearing on the desktop while the host is still loading. PowerShell remains the
// fallback whenever this file cannot be built or run.
function windowHostProgramPath() {
  const digest = crypto.createHash('sha1').update(buildWindowHostProgram()).digest('hex').slice(0, 12);
  return path.join(windowHostStateDir(), `RunContainerWindowHost-${digest}.exe`);
}

let windowHostExePromise = null;

// Proves the helper can start at all. An antivirus or policy that blocks a newly written
// executable must fall back to PowerShell rather than lose window hosting.
function windowHostExeWorks(exePath) {
  try {
    const check = spawnSync(exePath, ['-Mode', 'prewarm', '-Parent', '0'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    return check.status === 0 && String(check.stdout || '').includes('ready');
  } catch (error) {
    return false;
  }
}

function buildWindowHostExe(exePath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const sourcePath = `${exePath}.cs`;
      fs.writeFileSync(sourcePath, buildWindowHostProgram(), 'utf8');
      const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
      // Remove a half-written file first: the compiler refuses to overwrite one.
      try { fs.rmSync(exePath, { force: true }); } catch (error) { /* absent is fine */ }
      // Add-Type compiles with the .NET Framework compiler that ships with Windows, so
      // this needs nothing installed. A console build launched with windowsHide has no
      // console window.
      const command = "$ErrorActionPreference = 'Stop'; "
        + `Add-Type -TypeDefinition ([System.IO.File]::ReadAllText(${quote(sourcePath)})) `
        + `-Language CSharp -OutputAssembly ${quote(exePath)} -OutputType ConsoleApplication`;
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-2000);
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch (error) { /* already gone */ }
        finish(null);
      }, 120000);
      child.once('error', () => { clearTimeout(timer); finish(null); });
      child.once('exit', () => {
        clearTimeout(timer);
        const built = fs.existsSync(exePath);
        if (!built && stderr.trim()) {
          // The reason a launch fell back to PowerShell is worth keeping: an offline
          // compiler or a policy that blocks new executables is diagnosable here.
          try {
            appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `The native window host could not be built: ${stderr.trim()}`);
          } catch (error) { /* logging is best-effort */ }
        }
        finish(built ? exePath : null);
      });
    } catch (error) {
      finish(null);
    }
  });
}

function ensureWindowHostExe() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (windowHostExePromise) return windowHostExePromise;
  windowHostExePromise = (async () => {
    const exePath = windowHostProgramPath();
    if (fs.existsSync(exePath)) {
      if (windowHostExeWorks(exePath)) return exePath;
      try { fs.rmSync(exePath, { force: true }); } catch (error) { /* rebuild below */ }
    }
    const built = await buildWindowHostExe(exePath);
    if (built && windowHostExeWorks(built)) return built;
    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), 'The native window host did not start; using the PowerShell host instead.');
    return null;
  })();
  return windowHostExePromise;
}

// How long a Run waits for the host to prove it is watching before the app is started.
//
// The wait exists so the app's first window can be created hidden and hosted before it is
// ever drawn on the desktop. A host whose assembly is already compiled answers in well
// under a second, so a warm cache must not cost seconds before the app even starts. Only
// a cold cache - the first Run after an install or update - can take longer, and that is
// the one case where waiting is cheaper than a window that appears outside RunContainer.
const WINDOW_HOST_WARM_WAIT_MS = 1200;
const WINDOW_HOST_COLD_WAIT_MS = 6000;

function windowHostReadyBudget() {
  try {
    return fs.existsSync(windowHostProgramPath()) || fs.existsSync(windowHostCachePath())
      ? WINDOW_HOST_WARM_WAIT_MS
      : WINDOW_HOST_COLD_WAIT_MS;
  } catch (error) {
    return WINDOW_HOST_COLD_WAIT_MS;
  }
}

// Compiles the host once per revision in the background, so the first Run after an
// install or update is as fast as every later one.
function prewarmWindowHost() {
  if (process.platform !== 'win32') return;
  // Building the native helper is the prewarm: once it exists every launch starts it
  // directly. The PowerShell cache is only prepared when the helper cannot be built.
  ensureWindowHostExe().then((exePath) => {
    if (exePath) return;
    try {
      const scriptPath = ensureWindowHostScript();
      const child = spawn('powershell.exe', buildWindowHostScriptArgs(scriptPath, {
        mode: 'prewarm',
        parentHandle: 0,
        cachePath: windowHostCachePath(),
        timeoutMs: 60000,
      }), { windowsHide: true, stdio: 'ignore' });
      child.once('error', () => {});
      if (child.unref) child.unref();
    } catch (error) {
      // Prewarming is an optimisation; hosting still compiles the host when it runs.
    }
  }).catch(() => {});
}

// The watcher re-reads this file while it runs, so PIDs discovered later (an installer's
// second process, an app's child process) are matched without restarting it.
function writeWindowHostPids(appRecord) {
  if (!appRecord?.id) return;
  try {
    const seeds = [...new Set([
      ...(appRecord.sandboxPids || []),
      appRecord.pid,
      appRecord.lastInstallerPid,
    ].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
    fs.writeFileSync(windowHostPidFile(appRecord.id), seeds.join('\n'), 'utf8');
  } catch (error) {
    // Best effort: the watcher also matches windows by the app's own folder.
  }
}

function recordWindowHosted(appId, embedded, extra = {}) {
  const current = getStoredApp(appId);
  if (!current) return;
  const updated = { ...current, windowHosted: Boolean(embedded), ...extra };
  saveApps(loadApps().map((entry) => (entry.id === appId ? updated : entry)));
  broadcastContainerStatus(updated);
}

function handleWindowHostEvent(appRecord, state, event, logPath) {
  if (!event) return;
  if (event.event === 'watching') {
    // Proof from the host itself, not an assumption: the host loaded and the watch
    // loop is running, so a window this app opens from now on will be adopted. This
    // is what a hidden launch is allowed to depend on.
    state.ready = true;
    state.readyAt = Date.now();
    if (!state.watchStartedAt) state.watchStartedAt = Date.now();
    // Measured, so "Run feels slow" can be answered with numbers instead of a guess.
    if (state.createdAt) appendLog(logPath, `Window host ready in ${Date.now() - state.createdAt} ms.`);
    // A host that was slow to start (its assembly is compiled on first use, and the cache
    // is cold on a new install or after an update) must not cost the whole launch: the
    // wait before launching can time out and still leave the host watching a moment later.
    // Clearing the backoff lets the hosting call that follows the launch adopt the live
    // host instead of giving up on this Run because of a clock.
    windowHostBackoff.delete(appRecord.id);
    appendLog(logPath, 'Window host is watching for this app’s window.');
  } else if (event.event === 'embedded') {
    state.embedded = true;
    state.embeddedPid = event.pid || state.embeddedPid;
    const win = guestWindows.get(appRecord.id);
    if (win && !win.isDestroyed()) {
      win.__rcHostPid = event.pid || null;
      setGuestWindowStatus(win, 'Shown inside RunContainer.');
      // Bring the window forward: the user pressed Run, so this is where the app should
      // be. Without this a slow app could be hosted behind the main window.
      win.show();
      win.focus();
    }
    appendLog(logPath, 'Hosted a window inside RunContainer (window hosting only; it does not change isolation).');
    recordWindowHosted(appRecord.id, true, {
      hostedWindowPid: event.pid || null,
      windowHostTarget: state.target,
    });
  } else if (event.event === 'refused') {
    if (!state.refused) {
      state.refused = 'Windows refused to re-parent the window (expected for a wizard that runs at a higher integrity level)';
      appendLog(logPath, `The window stays on the desktop: ${state.refused}. Isolation is unaffected.`);
      const win = state.target === 'guest' ? guestWindows.get(appRecord.id) : null;
      if (win) setGuestWindowStatus(win, 'Windows refused to host this window here, so it stays on your desktop. Isolation is unaffected.');
    }
  } else if (event.event === 'revealed') {
    // A hidden launch with nowhere to host it: showing the window on the desktop is
    // better than leaving the app running invisibly. Hosting keeps being attempted.
    const shown = Number(event.shown) || 0;
    if (shown > 0) appendLog(logPath, `The app window could not be hosted yet, so ${shown} window(s) were shown on the desktop. RunContainer keeps trying to host it.`);
    const win = guestWindows.get(appRecord.id);
    if (win && !win.isDestroyed()) {
      setGuestWindowStatus(win, shown > 0
        ? 'The app’s window is on your desktop for now. RunContainer keeps trying to bring it in here.'
        : 'Waiting for the app to open a window…');
    }
  } else if (event.event === 'error') {
    state.error = event.error || 'The window host failed.';
    appendLog(logPath, `Window hosting failed: ${state.error}`);
  } else if (event.event === 'end') {
    state.exited = true;
  }
}

async function startAppWindowWatcher(appRecord, { parentHandle, target, insetTop = 0, logPath }) {
  // A launch starts its window host before the app does (so the watcher is already
  // running when the app's first window exists). The later call with the real PID must
  // adopt that watcher, not stop and restart it: restarting would lose that head start.
  const live = appWindowHosts.get(appRecord?.id);
  if (live && !live.exited && !live.error && live.parentHandle === parentHandle && live.insetTop === insetTop) {
    writeWindowHostPids(appRecord);
    return live;
  }
  await stopAppWindowWatcher(appRecord.id);
  const pidFile = windowHostPidFile(appRecord.id);
  const stopFile = windowHostStopFile(appRecord.id);
  try {
    fs.rmSync(stopFile, { force: true });
  } catch (error) {
    // A missing stop file is the normal case.
  }
  writeWindowHostPids(appRecord);
  const state = {
    child: null,
    target,
    pidFile,
    stopFile,
    parentHandle,
    insetTop,
    embedded: false,
    embeddedPid: null,
    refused: null,
    error: null,
    exited: false,
    // Set only by the host's own `watching` event (see handleWindowHostEvent).
    ready: false,
    readyAt: null,
    watchStartedAt: null,
    createdAt: Date.now(),
  };
  if (process.platform !== 'win32' || !parentHandle) return state;
  try {
    const hostOptions = {
      mode: 'watch',
      parentHandle,
      insetTop,
      pidFile,
      sandboxRoot: appRecord.sandboxRoot || (appRecord.source ? path.dirname(appRecord.source) : ''),
      stopFile,
      // A hidden launch must not leave an app invisible if Windows refuses to host it.
      revealAfterMs: 9000,
    };
    // The native helper starts in milliseconds; the PowerShell script is the fallback.
    const exePath = await ensureWindowHostExe();
    const child = exePath
      ? spawn(exePath, buildWindowHostProgramArgs(hostOptions), { windowsHide: true })
      : spawn('powershell.exe', buildWindowHostScriptArgs(ensureWindowHostScript(), { ...hostOptions, cachePath: windowHostCachePath() }), { windowsHide: true });
    state.child = child;
    appWindowHosts.set(appRecord.id, state);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const event of parseWindowHostEvents(lines.join('\n'))) {
        handleWindowHostEvent(appRecord, state, event, logPath);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) appendLog(logPath, `Window host: ${text}`);
    });
    child.once('error', (error) => {
      state.error = error.message;
      appendLog(logPath, `Window host could not start: ${error.message}`);
    });
    child.once('exit', () => {
      state.exited = true;
      if (appWindowHosts.get(appRecord.id) === state) appWindowHosts.delete(appRecord.id);
    });
  } catch (error) {
    state.error = error.message;
    appendLog(logPath, `Window host could not start: ${error.message}`);
  }
  return state;
}

// The watcher is asked to stop before it is terminated, so it cannot re-parent a window
// that is being released. The wait is short: its loop checks the flag every 400 ms.
async function stopAppWindowWatcher(appId) {
  const state = appWindowHosts.get(appId);
  if (!state) return;
  appWindowHosts.delete(appId);
  try {
    fs.writeFileSync(state.stopFile, 'stop', 'utf8');
  } catch (error) {
    // The process is terminated below either way.
  }
  await delay(600);
  if (state.child) {
    try {
      state.child.kill();
    } catch (error) {
      // Already gone.
    }
  }
}

async function waitForWindowHost(state, timeoutMs) {
  const deadline = Date.now() + Math.max(Number(timeoutMs) || 0, 0);
  while (Date.now() < deadline) {
    if (state.embedded || state.refused || state.error || state.exited) return state;
    await delay(150);
  }
  return state;
}

// Waits, briefly, for the host to say it is watching. Compiling the host assembly
// is the only reason this is not instant, and it is cached after the first launch.
async function waitForWindowHostReady(state, timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(Number(timeoutMs) || 0, 0);
  while (Date.now() < deadline) {
    if (state.ready || state.error || state.exited) return state;
    await delay(60);
  }
  return state;
}

// Whether a live, watching host exists for this app right now. A hidden launch is
// only ever allowed when this is true: otherwise the app would create its first
// window hidden with nobody to adopt it, and it would stay invisible while looking
// like a window hang to the monitor. This is measured, never assumed.
function windowHostingAllowed(appRecord) {
  if (process.platform !== 'win32') return false;
  if (appRecord?.windowHosting === false) return false;
  const state = appWindowHosts.get(appRecord?.id);
  return Boolean(state && state.ready && !state.error && !state.exited);
}

// A short, honest reason for the interface when a window cannot be hosted here.
function windowHostingRefusal(appRecord) {
  if (process.platform !== 'win32') return 'window hosting is a Windows feature';
  if (appRecord?.windowHosting === false) return 'window hosting is switched off in Settings for this app';
  const state = appWindowHosts.get(appRecord?.id);
  if (!state) return 'the window host is not running';
  if (state.error) return `the window host failed: ${state.error}`;
  if (state.exited) return 'the window host stopped';
  if (!state.ready) return 'the window host did not report that it is watching in time';
  return null;
}

// The show-state an app is actually launched with, and the reason when it is not hidden.
// The rule itself lives in public/window-host.js so it can be tested on its own.
function showStateForLaunch(appRecord, logPath) {
  const state = launchShowState({
    isGui: startsHidden(appRecord.source),
    platform: process.platform,
    windowHosting: appRecord?.windowHosting,
    host: appWindowHosts.get(appRecord?.id) || null,
  });
  if (state !== 0 && startsHidden(appRecord.source)) {
    const reason = windowHostingRefusal(appRecord) || 'window hosting is unavailable';
    if (logPath) appendLog(logPath, `This app is started with its window shown rather than hidden, because ${reason}. It cannot be left invisible.`);
  }
  return state;
}

// Only safe once this app's processes are gone: destroying the host destroys a hosted child.
function closeGuestWindow(appId) {
  const win = guestWindows.get(appId);
  if (!win || win.isDestroyed()) return;
  win.__rcClosing = true;
  // Windows destroys a child window together with its parent, and a hosted app window IS a
  // child of this one. So a window that is still hosting something releases it to the
  // desktop first: without that, closing this window would close the app's own window, and
  // a WinForms or WPF app whose last window is destroyed simply exits.
  if (win.__rcHostPid) {
    const record = getStoredApp(appId) || { id: appId };
    releaseGuestWindowWindows(record, [...trackedPids(record), win.__rcHostPid])
      .catch(() => {})
      .finally(() => {
        if (!win.isDestroyed()) win.destroy();
      });
    return;
  }
  win.destroy();
}

function guestWindowPagePath() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'guest-window.html'),
    path.join(__dirname, '..', 'build', 'build', 'guest-window.html'),
    path.join(process.resourcesPath || '', 'app', 'build', 'guest-window.html'),
    path.join(process.resourcesPath || '', 'app', 'build', 'build', 'guest-window.html'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function setGuestWindowStatus(win, text) {
  if (!win || win.isDestroyed()) return;
  win.__rcStatus = text;
  // Messages sent before the page finishes loading are dropped, so the page asks
  // for the latest status on load (see did-finish-load below).
  if (!win.webContents.isLoading()) win.webContents.send('guest-window-status', { text });
}

function ensureGuestWindow(appRecord, note) {
  const existing = guestWindows.get(appRecord.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    if (note) setGuestWindowStatus(existing, note);
    return existing;
  }
  const title = `${PRODUCT_NAME} — ${appRecord.name || 'App window'}`;
  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 760,
    minHeight: 480,
    title,
    // Shown on the first hosted window: an empty duplicate window would be a flash.
    show: false,
    backgroundColor: '#0e1116',
    icon: path.join(__dirname, PRODUCT_ICON),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.__rcNote = note || '';
  win.setTitle(title);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  guestWindows.set(appRecord.id, win);

  win.webContents.once('did-finish-load', () => {
    if (win.__rcStatus) win.webContents.send('guest-window-status', { text: win.__rcStatus });
  });
  // The window watcher re-fits the hosted window itself when this window resizes,
  // so no renderer round-trip is needed here.

  const pagePath = guestWindowPagePath();
  const search = `appId=${encodeURIComponent(appRecord.id)}&name=${encodeURIComponent(appRecord.name || 'App window')}`
    + `&note=${encodeURIComponent(note || 'This window belongs to RunContainer.')}`
    + `&autosetup=0&channel=${IS_NIGHTLY ? 'nightly' : 'stable'}`;
  if (pagePath) {
    win.loadFile(pagePath, { search }).catch((error) => {
      appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `Guest window failed to load: ${error.message}`);
    });
  } else {
    // Development without a build: the dev server serves public/ directly.
    win.loadURL(`http://localhost:3000/guest-window.html?${search}`).catch((error) => {
      appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `Guest window failed to load from the dev server: ${error.message}`);
    });
  }

  // A hosted child window must be released before its parent disappears, so closing
  // the window runs the release in the main process first.
  win.on('close', (event) => {
    if (win.__rcClosing) return;
    event.preventDefault();
    win.__rcClosing = true;
    const record = getStoredApp(appRecord.id) || appRecord;
    releaseGuestWindowWindows(record, [...trackedPids(record), record.hostedWindowPid])
      .catch((error) => {
        appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `Guest-window release on close: ${error.message}`);
      })
      .finally(() => {
        if (!win.isDestroyed()) win.destroy();
      });
  });
  win.on('closed', () => {
    if (guestWindows.get(appRecord.id) === win) guestWindows.delete(appRecord.id);
    win.__rcClosing = false;
  });
  return win;
}

// Hosts the app's (or the VM console's) window under a second RunContainer window and
// leaves a watcher running, so windows that appear later are hosted too instead of
// sitting on the desktop. Returns what happened by the time the caller stops waiting.
// readyMs is the budget for the host to say it is watching before the launch decision
// is taken. It costs nothing when the host answers (the wait ends on the event) and
// only takes this long when the host cannot start at all, where the alternative is
// launching an app nobody can adopt.
async function hostInGuestWindow(appRecord, pid, logPath, { note, timeoutMs = 4000, readyMs = 2500 } = {}) {
  if (process.platform !== 'win32') return null;
  if (appRecord?.windowHosting === false) return null;
  // A host that has just proved it cannot start is not retried on every early call:
  // that would only flash a second window open and shut. The next Run clears this.
  const backoffUntil = windowHostBackoff.get(appRecord?.id) || 0;
  if (backoffUntil > Date.now()) return null;
  const win = ensureGuestWindow(appRecord, note);
  // Show the window as soon as Run is pressed. The app's own window appears inside it a
  // moment later; until then the window says what is happening instead of leaving the
  // user with no visible response (or a stray app window on the desktop).
  if (!win.isVisible()) win.showInactive();
  setGuestWindowStatus(win, 'Starting the app. Its window appears here as soon as it opens.');
  const parentHandle = nativeHandleToInt(win.getNativeWindowHandle());
  if (!parentHandle) return null;
  const state = await startAppWindowWatcher({ ...appRecord, pid }, {
    parentHandle,
    target: 'guest',
    insetTop: GUEST_WINDOW_HEADER_PX,
    logPath,
  });
  win.__rcHostState = state;
  // Whether the app may be started with a hidden first window depends on the host
  // actually watching. Ask it, and wait for its answer before anything is launched.
  await waitForWindowHostReady(state, readyMs);
  if (!state.ready && !state.error && !state.exited && state.child) {
    // A cold host can take longer to compile. Keep its window and watcher alive:
    // destroying the parent here prevents the eventual watcher from hosting anything.
    setGuestWindowStatus(win, 'Preparing the window host. RunContainer will keep watching for the app window.');
    return { embedded: false, ready: false, reason: 'the window host is still starting' };
  }
  // The launch that follows reads this: only a host that has said, itself, that it is
  // watching may start an app with a hidden first window.
  if (!state.ready) {
    const reason = windowHostingRefusal(appRecord) || 'the window host did not start';
    windowHostBackoff.set(appRecord.id, Date.now() + 20000);
    appendLog(logPath, `Window hosting is unavailable (${reason}). This app is launched normally and keeps its own window; isolation is unaffected.`);
    setGuestWindowStatus(win, `RunContainer could not host this app’s window (${reason}), so it opens on your desktop instead. Isolation is unaffected.`);
    recordWindowHosted(appRecord.id, false, { windowHostReason: reason, hostedWindowPid: null, windowHostState: 'unavailable' });
    // No blank RunContainer window is left behind when nothing will be hosted in it.
    closeGuestWindow(appRecord.id);
    return { embedded: false, ready: false, reason };
  }
  await waitForWindowHost(state, timeoutMs);
  if (state.embedded) {
    win.__rcHostPid = state.embeddedPid || pid;
    return { embedded: true, pid: win.__rcHostPid, target: 'guest', ready: true };
  }
  setGuestWindowStatus(win, state.refused
    ? 'Windows refused to host the window RunContainer found, so it stays on your desktop. RunContainer keeps watching in case the app opens another one.'
    : 'Waiting for the app’s window. It is hosted here as soon as it appears.');
  if (state.refused && !win.isVisible()) win.show();
  if (state.error || state.exited) {
    closeGuestWindow(appRecord.id);
    return { embedded: false, ready: Boolean(state.ready), reason: state.error || 'the window host stopped' };
  }
  return { embedded: false, ready: Boolean(state.ready), reason: state.refused || 'the app has not opened a window yet' };
}

async function releaseGuestWindowWindows(appRecord, pids, logPath) {
  const win = guestWindows.get(appRecord?.id);
  if (!win || win.isDestroyed()) return 0;
  // Stop watching first, or the watcher would re-host the window being released.
  await stopAppWindowWatcher(appRecord?.id);
  const parentHandle = nativeHandleToInt(win.getNativeWindowHandle());
  if (!parentHandle) return 0;
  const candidates = [...new Set([...(pids || []), appRecord?.hostedWindowPid]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  let released = 0;
  for (const pid of candidates) {
    try {
      const result = await runWindowHostScript({
        mode: 'release',
        processId: pid,
        parentHandle,
      });
      released += Number(result?.released) || 0;
    } catch (error) {
      if (logPath) appendLog(logPath, `Could not move the window out of the second RunContainer window: ${error.message}`);
    }
  }
  return released;
}

// Every launch is presented the same way: its window is hosted under a second
// RunContainer window, whose header keeps Stop, Release window and a way back to the
// main window reachable. Hosting into the main window was removed: once an app covers
// the main window, RunContainer's own controls are unreachable for as long as it
// stays open. The watcher keeps running after this returns, so windows that appear
// later (a splash, an installer's second process) are hosted too.
async function hostAppWindowEverywhere(appRecord, pid, logPath, { note, timeoutMs = 2500, readyMs } = {}) {
  if (appRecord?.windowHosting === false) return null;
  if (process.platform !== 'win32') return null;
  return hostInGuestWindow({ ...appRecord, pid }, pid, logPath, { note, timeoutMs, readyMs });
}

// Installers use the same surface: the wizard is the whole interaction, and it closes
// when setup finishes. A longer wait gives a slow self-extractor time to open its window.
async function hostInstallerWindow(appRecord, pid, logPath) {
  if (appRecord?.windowHosting === false) return null;
  if (process.platform !== 'win32') return null;
  const hosted = await hostInGuestWindow(appRecord, pid, logPath, {
    note: 'Installer wizard: complete it here — it installs into this environment, not your PC.',
    timeoutMs: 15000,
  });
  if (hosted?.embedded) appendLog(logPath, 'Installer wizard hosted inside a RunContainer window.');
  return hosted;
}

// Puts the app's window back on the desktop before the app is stopped or its sandbox deleted,
// so no window is left parented to a window that is about to be destroyed.
async function releaseAppWindow(appRecord, pids, logPath) {
  if (process.platform !== 'win32') return null;
  // Stop watching first, or the watcher would put the window straight back in.
  await stopAppWindowWatcher(appRecord?.id);
  const candidates = [...new Set([...(pids || []), appRecord?.pid, appRecord?.hostedWindowPid].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (!appRecord?.windowHosted && candidates.length === 0 && !guestWindows.has(appRecord?.id)) return null;
  let released = 0;
  released += await releaseGuestWindowWindows(appRecord, candidates, logPath);
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
      showState: showStateForLaunch(appRecord, logPath),
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
      windowHosted: false,
      hostedWindowPid: null,
      windowHostTarget: null,
      lastLaunchedAt: new Date().toISOString(),
      launchCleanupPending: false,
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updatedApp : entry)));
    appendLog(logPath, `Launched inside AppContainer ${containerName} (${launch.containerSid}), verified token SID, PIDs: ${pids.join(', ')}`);
    monitorAppProcesses(appRecord.id, logPath);
    broadcastContainerStatus(updatedApp);
    // Hosting is presentation only and must never hold up the launch or fail it, so it runs
    // after the launch result is already decided.
    hostAppWindowEverywhere(updatedApp, pid, logPath, {
      note: 'This app runs in its own environment. Its window is hosted here.',
    }).then(() => {
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
  // An elevated launcher cannot be killed from here (access denied), so Stop is
  // delivered through the file it polls. Its job object then ends the app tree.
  if (appRecord.rcvmStopFile) {
    try {
      fs.writeFileSync(appRecord.rcvmStopFile, 'stop', 'utf8');
      if (logPath) appendLog(logPath, 'Asked the elevated launcher to stop through its stop file.');
      // Give the elevated launcher a moment to honour it before the caller's own
      // taskkill pass runs; killing an elevated PID from here is not permitted.
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const still = await listRunningPids(appRecord).catch(() => []);
        if (still.length === 0) break;
        await delay(300);
      }
    } catch (error) {
      if (logPath) appendLog(logPath, `Stop file could not be written: ${error.message}`);
    }
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

// An app whose manifest requests administrator rights cannot be created by a
// medium-integrity process at all (Win32 740). Windows' answer is a UAC prompt, so
// the same contained launcher is started elevated: the Job Object, its caps and the
// per-app profile folders then apply to the elevated app exactly as they do below.
// The only difference the user sees is a UAC prompt and a window that Windows will
// not let a medium-integrity process re-parent, so it stays on the desktop.
function rcvmStatePaths(appId) {
  const root = path.join(app.getPath('userData'), 'rcvm-state');
  ensureDirectory(root);
  return {
    resultFile: path.join(root, `${appId}.result.jsonl`),
    stopFile: path.join(root, `${appId}.stop`),
  };
}

// The caption of the window the elevated launcher creates. It is the only thing the
// user has to identify the window by, so it names the app and says why it needed
// approval.
function rcvmAdminHostTitle(appRecord) {
  const name = String(appRecord?.name || 'App').slice(0, 80);
  // PRODUCT_NAME, not a literal, so a Nightly window is identified as Nightly.
  return `${PRODUCT_NAME} — ${name} (administrator approved)`;
}

function powerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function rcvmLauncherError(parsed) {
  const error = new Error(parsed.error);
  if (parsed.code) error.launcherCode = parsed.code;
  return error;
}

async function startElevatedRcvmLauncher(scriptPath, resultFile, logPath) {
  const rcvm = require('./rcvm-runtime');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ${powerShellLiteral(scriptPath)}) -Verb RunAs -WindowStyle Hidden -PassThru`,
    "if ($p) { 'pid=' + $p.Id }",
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  // Start-Process returns as soon as the UAC prompt is answered; the elevated
  // launcher's output is unreadable from here, so its result file is the channel.
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    let raw = '';
    try {
      raw = fs.readFileSync(resultFile, 'utf8');
    } catch (error) {
      raw = '';
    }
    const parsed = rcvm.parseRcvmLauncherOutput(raw);
    if (parsed.error) {
      const error = new Error(parsed.error);
      error.launcherCode = parsed.code;
      throw error;
    }
    if (parsed.pid && parsed.verified !== undefined) {
      const launcherPid = /pid=(\d+)/.exec(stdout);
      return { pid: parsed.pid, verified: parsed.verified, launcherPid: launcherPid ? Number(launcherPid[1]) : null, output: raw };
    }
    // A declined UAC prompt ends the wrapper immediately. Waiting the full timeout
    // would leave the Run button spinning for three minutes with nothing happening.
    if (child.exitCode !== null) {
      await delay(400);
      try { raw = fs.readFileSync(resultFile, 'utf8'); } catch (error) { raw = ''; }
      const late = rcvm.parseRcvmLauncherOutput(raw);
      if (late.pid && late.verified !== undefined) {
        return { pid: late.pid, verified: late.verified, launcherPid: null, output: raw };
      }
      break;
    }
    await delay(250);
  }
  const code = child.exitCode;
  const reason = stderr.trim() || (code ? `Start-Process exited with code ${code}.` : 'The elevated launcher did not report a result in time.');
  throw new Error(/cancel|denied|1223/i.test(reason)
    ? 'Administrator approval was declined, so the app was not started. Press Run and approve the Windows prompt to run it contained.'
    : reason);
}

// Launches the app inside RCVM containment: suspended start, Job Object assignment
// (kill-on-close, memory/CPU/process caps), resume, per-app profile folders.
// Anything that cannot be contained fails closed; nothing runs uncontained.
async function runWithRcvm(appRecord, sandboxRoot, logPath, { elevated = false } = {}) {
  const rcvm = require('./rcvm-runtime');
  const launchStartedAt = Date.now();
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
    const statePaths = elevated ? rcvmStatePaths(appRecord.id) : null;
    if (elevated) {
      for (const filePath of [statePaths.resultFile, statePaths.stopFile]) {
        try { fs.unlinkSync(filePath); } catch (error) { /* absent is fine */ }
      }
    }
    // The only runtime knobs RunContainer sets are documented .NET ones, and
    // only for a managed app. Native code gets no environment changes.
    const runtimeEnv = runtimeProfile.sanitizeEnvironment(
      runtimeProfile.runtimeEnvironment(appRecord.runtimeJit, appRecord.runtime?.kind),
    );
    const scriptText = rcvm.buildRcvmLaunchScript({
      jobName: rcvm.rcvmJobName(appRecord.id),
      executablePath: appRecord.source,
      workingDirectory: sandboxRoot,
      appDataDir: profile.appData,
      localAppDataDir: profile.localAppData,
      tempDir: profile.temp,
      userProfileDir: profile.userProfile,
      launchArgs: argCheck.args || '',
      runtimeEnv,
      // An elevated window cannot be re-parented by this medium-integrity process, so
      // the elevated launcher hosts it instead (same integrity level). It must not start
      // hidden: the window has to exist before the host can adopt it. An ordinary launch
      // is hidden only when a watching host is there to adopt the first window.
      startHidden: !elevated && showStateForLaunch(appRecord, logPath) === 0,
      resultFile: elevated ? statePaths.resultFile : '',
      stopFile: elevated ? statePaths.stopFile : '',
      hostWindowTitle: elevated ? rcvmAdminHostTitle(appRecord) : '',
      memoryCapBytes: limitCheck.limits.memoryCapBytes,
      cpuRate: limitCheck.limits.cpuRate,
      maxProcesses: limitCheck.limits.maxProcesses,
      // Compiling the launcher's C# dominated launch latency; the compiled
      // assembly is cached per launcher version under RunContainer's data.
      launcherCacheDir: path.join(app.getPath('userData'), 'rcvm-cache'),
      launcherCacheKey: rcvm.rcvmLauncherCacheKey(),
    });
    const scriptPath = path.join(app.getPath('userData'), `runcontainer-rcvm-${appRecord.id}.ps1`);
    fs.writeFileSync(scriptPath, scriptText, 'utf8');

    let pid;
    let verified;
    let launcherPid = null;
    let launcherOutput = '';
    if (elevated) {
      const started = await startElevatedRcvmLauncher(scriptPath, statePaths.resultFile, logPath);
      pid = started.pid;
      verified = started.verified;
      launcherPid = started.launcherPid;
      launcherOutput = started.output;
      appendLog(logPath, 'Windows approved an elevated launch; the contained app runs with administrator rights.');
    } else {
    launcherChild = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true });
    // The launcher's pipes are the only live stdout/stderr a detached GUI app has;
    // the monitor reads them alongside the app's log file.
    launcherChild.stdout?.on('data', (chunk) => liveLogBuffer(appRecord.id).push(String(chunk)));
    if (Object.keys(runtimeEnv).length > 0) {
      appendLog(logPath, `Runtime strategy “${runtimeProfile.strategyLabel(appRecord.runtimeJit)}” applied to this managed .NET app: ${Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`).join(', ')}.`);
    }
    launcherPid = launcherChild.pid;
    rcvmLaunchers.set(appRecord.id, launcherChild);
    const verifyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The RCVM launcher did not report verification in time.')),
        90000);
      const poll = setInterval(() => {
        const parsed = rcvm.parseRcvmLauncherOutput(launcherOutput);
        if (parsed.error) {
          clearTimeout(timer);
          clearInterval(poll);
          reject(rcvmLauncherError(parsed));
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
        else reject(parsed.error ? rcvmLauncherError(parsed) : new Error('The RCVM launcher exited before verification.'));
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
          reject(rcvmLauncherError(parsed));
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
        reject(parsed.error ? rcvmLauncherError(parsed) : new Error(`The RCVM launcher exited before the app started (code ${code}).`));
      });
    });
    launcherChild.stderr.on('data', (chunk) => {
      liveLogBuffer(appRecord.id).push(String(chunk));
      appendLog(logPath, `RCVM launcher: ${String(chunk).trim()}`);
    });
    launcherChild.on('exit', (code) => {
      rcvmLaunchers.delete(appRecord.id);
      appendLog(logPath, `RCVM launcher exited (code ${code}); its job object ends the app tree with it.`);
    });

    pid = await pidPromise;

    // Post-launch verification of the ACTUAL process (IsProcessInJob against
    // our job + enforced limits). Anything unverified is killed, never reported.
    verified = await verifyPromise;
    }
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
    if (pids.length === 0) {
      // The launcher reports the app's own exit code when the process it started
      // ends. Naming it turns "it exited" into something a user can act on.
      const launcherState = rcvm.parseRcvmLauncherOutput(launcherOutput);
      const exitCode = Number.isInteger(launcherState.exitCode) ? ` (exit code ${launcherState.exitCode})` : '';
      throw new Error(`The contained process exited before RunContainer could confirm it${exitCode}. Nothing is left running in its environment. Installers and launchers that refuse to start inside a Job Object need a virtual machine environment instead.`);
    }

    const base = getStoredApp(appRecord.id) || appRecord;
    const updatedApp = {
      ...withTrackedPids(base, pids),
      status: 'Running',
      launchMode: 'rcvm',
      activeEngine: 'rcvm',
      isolated: true,
      isolationLevel: 'container',
      elevated: elevated || undefined,
      statusNote: elevated ? 'administrator-approved, shown in a RunContainer administrator window' : undefined,
      rcvmStopFile: elevated ? statePaths.stopFile : undefined,
      rcvmJob: rcvm.rcvmJobName(appRecord.id),
      rcvmLauncherPid: launcherPid,
      pid,
      sandboxPids: pids,
      windowHosted: Boolean(elevated),
      hostedWindowPid: elevated ? pid : null,
      windowHostTarget: elevated ? 'admin-window' : null,
      lastLaunchedAt: new Date().toISOString(),
      launchCleanupPending: false,
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updatedApp : entry)));
    appendLog(logPath, `Launched contained (RCVM job ${updatedApp.rcvmJob}, memory cap ${limitCheck.limits.memoryMB} MB, ${limitCheck.limits.cpuCount} CPUs of compute, ${limitCheck.limits.maxProcesses} processes), PID ${pid}. Profile folders redirected under the environment.`);
    const totalMs = Date.now() - launchStartedAt;
    appendLog(logPath, `Launch confirmed ${totalMs} ms after the request (measured on this PC).`);
    recordLaunchTiming({ at: new Date().toISOString(), appId: appRecord.id, name: appRecord.name, totalMs });
    monitorAppProcesses(appRecord.id, logPath);
    broadcastContainerStatus(updatedApp);
    // Hosting is presentation only and must never hold up the launch or fail it, so it runs
    // after the launch result is already decided. An elevated app's window is hosted by the
    // elevated launcher itself (Windows blocks this process from re-parenting it), so only
    // a normal launch needs the Electron host window here.
    if (elevated) {
      // The medium-integrity host window cannot adopt an elevated window, and leaving it
      // open produced a second RunContainer window that stayed empty while the app was
      // shown in the administrator host. Close it instead of showing an empty surface.
      await stopAppWindowWatcher(appRecord.id);
      closeGuestWindow(appRecord.id);
    }
    if (!elevated) {
      const hosted = await hostAppWindowEverywhere(updatedApp, pid, logPath, {
        note: 'This app runs in its own environment. Its window is hosted here.',
      });
      const again = getStoredApp(appRecord.id);
      if (again && !again.windowHosted && hosted?.embedded) {
        // The hosted PID may differ from the launch PID when the app's real window is in a
        // child process. Persist the hosted PID so Stop/Delete can release it.
        saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? { ...entry, windowHosted: true, hostedWindowPid: hosted.pid || pid } : entry)));
      }
      if (again) broadcastContainerStatus(again);
    }
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
      elevated,
      reason: elevated
        ? `Running contained (RCVM) with Windows administrator approval: the Job Object caps and per-app profile folders still apply. Windows does not let RunContainer's normal window host an elevated window, so the elevated launcher opens a RunContainer administrator window and hosts the app (or its installer wizard) inside it.`
        : `Running contained (RCVM): Job Object caps hold its lifetime and resources, and its profile folders stay inside its environment. Works on all Windows editions. This is process containment, not a hardware VM, and it does not cut network access.`,
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
    // A refused CreateProcess started nothing, so the expensive process sweep is
    // skipped for the elevation retry; every other failure still sweeps.
    const remaining = error.launcherCode === 'elevation_required'
      ? []
      : await stopProcessesUnder(sandboxRoot, trackedPids(appRecord), { logPath }).catch(() => []);
    if (!elevated && error.launcherCode === 'elevation_required' && remaining.length === 0) {
      appendLog(logPath, 'The app asks for administrator rights (Win32 740). Relaunching the contained launcher elevated once Windows approves it.');
      return runWithRcvm(appRecord, sandboxRoot, logPath, { elevated: true });
    }
    if (error.launcherCode === 'elevation_required') {
      return failedLaunch(appRecord, 'Windows refused to start this app because it requires administrator rights, and the elevated attempt did not complete. Approve the Windows prompt when it appears, or run this app in a virtual machine environment.');
    }
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
    missing.push('No VM image is set on this PC, so apps run in their own contained space.');
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
    throw new Error('No VM image is set on this PC. Add a prepared image in Settings → Advanced, or let the app run contained.');
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
    // Put the VM's display in a RunContainer window while it boots, so the guest
    // desktop (and any setup wizard inside it) is visible there from the start.
    const qemuPidForDisplay = qemuProcs.get(appRecord.id)?.pid;
    if (qemuPidForDisplay) {
      hostInGuestWindow(appRecord, qemuPidForDisplay, logPath, {
        note: 'The app and any installer wizard run inside this virtual machine.',
        timeoutMs: 30000,
      }).catch((error) => {
        appendLog(logPath, `The VM window could not be hosted: ${error.message}`);
      });
    }
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
    title: PRODUCT_NAME,
    show: false,
    titleBarStyle: 'hiddenInset',
    // Windows only renders .ico/.png window icons; an SVG path silently falls
    // back to the stock Electron icon in the taskbar and Alt-Tab switcher.
    icon: path.join(__dirname, PRODUCT_ICON),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
  });

  mainWindow.setTitle(PRODUCT_NAME);
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

  let shown = false;
  const showWindow = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
    mainWindow.webContents.send('app:boot-sequence', { stage: 'ready' });
  };
  mainWindow.once('ready-to-show', showWindow);
  // ready-to-show never fires when the renderer dies before its first paint.
  // Showing anyway means the user sees the app (and its own error state) rather
  // than a process running with no window at all.
  const showFallback = setTimeout(showWindow, 4000);
  if (showFallback.unref) showFallback.unref();
  mainWindow.webContents.once('did-finish-load', showWindow);
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
  startBehavioralSupervisor();
  // A virtual machine from a previous session still holds its disk and its console port,
  // so it is stopped rather than left running invisibly (see reconcileVirtualMachines).
  try {
    reconcileVirtualMachines();
  } catch (error) {
    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `Virtual machines could not be reconciled at startup: ${error.message}`);
  }
  // Icon extraction is one short PowerShell call per app and keeps startup fast.
  backfillAppIcons().catch(() => {});
  // Warm the window host in the background after the UI is up, so the first Run does
  // not pay for compiling it.
  const warm = setTimeout(prewarmWindowHost, 1500);
  if (warm.unref) warm.unref();
});

app.on('before-quit', () => {
  // Closing RunContainer stops the machines it started: each one owns a disk and a console
  // port, and there is no window left to show it in once the app is gone.
  if (vmProcs.size > 0 || loadVmStore().vms.some((record) => record.qemuPid)) {
    try {
      reconcileVirtualMachines();
    } catch (error) {
      // Quitting must not be blocked by a machine that refuses to stop.
    }
  }
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
  let runtimeFilled = false;
  const reconciled = loadApps().map((entry) => {
    // Apps installed before runtime detection existed get classified once, then
    // the answer is stored with the record.
    const runtime = entry.runtime || (entry.source ? detectAppRuntime(entry.source) : null);
    if (!entry.runtime && runtime) runtimeFilled = true;
    return { ...decorateAppRecord(entry), runtime };
  });
  // An icon file can go missing (an interrupted delete, a repair, a copied record). Extracting
  // it again from the executable the app actually runs keeps the real icon in the list instead
  // of a bare initial for the rest of the record's life.
  let iconRepaired = false;
  const withIcons = await Promise.all(reconciled.map(async (entry) => {
    // A record keeps its icon only when the current extractor wrote it. Anything
    // older - a shell PNG, or an .ico from an earlier version of the resource
    // reader - is replaced by the executable's own multi-size icon the next time
    // the list is read, which is what makes the icon actually appear.
    const iconIsCurrent = Number(entry.iconVersion) === ICON_EXTRACTOR_VERSION
      && entry.iconFrom === entry.source
      && Boolean(entry.iconPath)
      && fs.existsSync(entry.iconPath);
    if (iconIsCurrent || !entry.source || !entry.sandboxRoot || !fs.existsSync(entry.source)) return entry;
    // An executable can genuinely carry no icon. Extracting it again on every list read would
    // spawn a helper process each time, so a failed attempt is remembered and retried rarely.
    const lastAttempt = Date.parse(entry.iconAttemptedAt || '');
    if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < ICON_RETRY_INTERVAL_MS) return entry;
    iconRepaired = true;
    const attemptedAt = new Date().toISOString();
    const extracted = await extractExeIcon(entry.source, entry.sandboxRoot);
    if (!extracted) return { ...entry, iconAttemptedAt: attemptedAt };
    return {
      ...entry,
      iconPath: extracted.path,
      iconUrl: iconDataUrl(extracted.path),
      iconSource: extracted.source,
      iconVersion: extracted.version,
      iconFrom: extracted.from || entry.source,
      iconAttemptedAt: attemptedAt,
    };
  }));
  if (updatesById.size === 0 && !runtimeFilled && !iconRepaired) return withIcons;
  // Re-read the store after the async checks so apps deleted or added in the meantime are not resurrected.
  const current = updatesById.size ? mergeStatusUpdates(withIcons, updatesById) : withIcons;
  saveApps(current.map(({ envDirPresent, sourcePresent, diskPresent, iconUrl, ...rest }) => rest));
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
  const extractedIcon = await extractExeIcon(exePath, sandboxRoot);
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
    runtime: detectAppRuntime(destination),
    iconPath: extractedIcon?.path || null,
    iconVersion: extractedIcon?.version || null,
    iconFrom: extractedIcon?.from || null,
    iconSource: extractedIcon?.source || null,
    iconSizes: extractedIcon?.sizes || null,
    permissions: { network: profile.network, filesystem: profile.filesystem, registry: profile.registry },
    profile: 'default',
    sandboxConfig: profile,
    createdAt: new Date().toISOString(),
  };
  saveApps([...loadApps(), record]);
  // The card for a freshly installed app is built from this answer, so it carries the
  // same derived fields (its icon, its folder state) as the next app-list read.
  return decorateAppRecord(record);
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
  return decorateAppRecord(cleanCopy);
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

// lockHeld is used by the repair path, which already holds the app's operation
// lock while it stops the app and clears its profile.
async function runApp(requestedAppRecord, { lockHeld = false } = {}) {
  let appRecord = getStoredApp(requestedAppRecord?.id);
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
  // Run is a fresh attempt at hosting, including after the host failed to start on a
  // previous launch. The backoff only exists to stop one launch flapping.
  windowHostBackoff.delete(appRecord.id);

  // A JIT run is an explicit request from the JIT launcher: the strategy is recorded
  // first, then the app is started immediately with it. A native executable has no
  // intermediate language to translate, so it is still started right away and the log
  // says plainly that no JIT strategy applied, rather than implying one did.
  if (requestedAppRecord?.jitRun === true) {
    const runtime = appRecord.runtime || detectAppRuntime(appRecord.source);
    const requested = runtimeProfile.normalizeStrategy(requestedAppRecord.runtimeJit);
    const applied = runtime?.kind === 'dotnet' ? requested : 'auto';
    const updated = {
      ...appRecord,
      runtimeJit: applied,
      ...(runtime ? { runtime } : {}),
      lastRunWithJit: true,
      jitRequestedAt: new Date().toISOString(),
      jitRuntimeKind: runtime?.kind || 'unknown',
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updated : entry)));
    appRecord = updated;
    if (runtime?.kind === 'dotnet') {
      const env = runtimeProfile.sanitizeEnvironment(runtimeProfile.runtimeEnvironment(applied, runtime.kind));
      appendLog(logPath, `JIT run requested. Strategy “${runtimeProfile.strategyLabel(applied)}” applied to this managed .NET app`
        + `${Object.keys(env).length ? `: ${Object.entries(env).map(([key, value]) => `${key}=${value}`).join(', ')}` : ' (runtime defaults)'}. Starting it now.`);
    } else if (runtime?.kind === 'native') {
      appendLog(logPath, 'JIT run requested, but this app is already machine code: there is no JIT translation to enable, so it is started now with the normal launch path.');
    } else {
      appendLog(logPath, 'JIT run requested, but RunContainer could not read this executable’s header, so no JIT strategy was applied. It is started now with the normal launch path.');
    }
  }

  // A Microsoft Store bridge installs into WindowsApps, outside every boundary this app can
  // enforce, and its window is a UWP frame no host window can adopt. Refusing before the
  // launch is the only honest option on a host engine; inside a VM the install is contained.
  const selectedEngine = selectEngine(getStoredApp(appRecord.id) || appRecord);
  if (selectedEngine !== 'hyperv' && selectedEngine !== 'qemu') {
    const storeHandoff = detectStoreHandoff(appRecord.source);
    if (storeHandoff) {
      appendLog(logPath, `Refusing to launch ${appRecord.source}: it is a ${storeHandoff.marker} Microsoft Store bridge (${storeHandoff.sizeBytes} bytes).`);
      return failedLaunch(appRecord, describeStoreHandoff(storeHandoff.marker));
    }
  }

  // Settings decide how a supported installer is handled: completed unattended inside
  // its environment (the default), or shown as its own wizard inside RunContainer. The
  // choice is one preference, not a button on every app card.
  if (requestedAppRecord?.backgroundSetup !== true && loadPreferences().installerMode !== 'manual') {
    const automatic = planSetupRun({
      source: appRecord.source,
      name: appRecord.name,
      metadata: appRecord.metadata,
      installedExePath: appRecord.installedExePath,
      setupMode: 'silent',
      installDir: setupInstallDir(sandboxRoot),
    });
    if (automatic.isSetup && automatic.mode === 'silent' && appRecord.status !== 'Running') {
      appendLog(logPath, 'Settings complete supported installers unattended, so this setup runs in the background inside its environment.');
      emitToRenderer('app:setup', { id: appRecord.id, name: appRecord.name, phase: 'planned', ...automatic });
      let announce;
      const launchedPromise = new Promise((resolve) => { announce = resolve; });
      setupAppInBackground(appRecord, { onLaunched: (result) => announce(result) }).catch((error) => {
        appendLog(logPath, `Unattended setup failed: ${error.message}`);
        announce({ status: 'Failed', error: error.message });
      });
      // Run must not sit on "Starting" for the whole install. The window reports the
      // setup's progress while it runs, so a short wait answers the button and the
      // install continues in the environment.
      const started = await Promise.race([
        launchedPromise,
        delay(8000).then(() => ({ status: 'SettingUp', detail: 'Setup is still starting inside its environment.' })),
      ]);
      if (started?.status === 'Running') {
        return {
          ...started,
          backgroundSetup: true,
          detail: automatic.summary,
          reason: 'Setup is completing unattended inside its environment. The RunContainer window shows its progress, and the app starts in that same window when setup finishes.',
        };
      }
      if (started?.status === 'SettingUp') {
        // Never fall through to the wizard here: the unattended setup is already being
        // started, and two installers in one environment is worse than an honest wait.
        return {
          id: appRecord.id,
          status: 'SettingUp',
          backgroundSetup: true,
          reason: 'Setup is still starting inside its environment. The RunContainer window reports its progress, and the app starts there when setup finishes.',
        };
      }
      appendLog(logPath, `The unattended setup did not start${started?.error ? ` (${started.error})` : ''}; opening the installer wizard instead.`);
    }
  }

  // An app that is really its own setup program must not look like a frozen app.
  // The plan says which of the two honest answers applies: set up unattended in
  // the background, or show the wizard in a RunContainer window and say so.
  const setupPlan = planSetupRun({
    source: appRecord.source,
    name: appRecord.name,
    metadata: appRecord.metadata,
    installedExePath: appRecord.installedExePath,
    setupMode: requestedAppRecord?.backgroundSetup === true ? 'silent' : 'wizard',
    installDir: setupInstallDir(sandboxRoot),
  });
  if (setupPlan.isSetup) {
    appendLog(logPath, `Setup program: ${setupPlan.summary}`);
    emitToRenderer('app:setup', { id: appRecord.id, name: appRecord.name, phase: 'planned', ...setupPlan });
    const stored = getStoredApp(appRecord.id) || appRecord;
    const withSetup = {
      ...stored,
      setupProgram: setupPlan.mode !== 'installed',
      setupFamily: setupPlan.family?.id || null,
      setupFamilyName: setupPlan.family?.name || null,
      setupPlanMode: setupPlan.mode,
      // When this setup started, so a long one can be reported as still working
      // rather than as an app that is stuck. It is a timestamp, not a promise:
      // RunContainer never claims progress it has not observed.
      setupStartedAt: new Date().toISOString(),
      setupCancelledAt: null,
      setupSummary: setupPlan.summary,
      setupSilentArgs: setupPlan.mode === 'silent' ? setupPlan.args.join(' ') : null,
      installedExePath: setupPlan.installedExePath || stored.installedExePath || null,
      // Setup already produced the app: from now on Run starts that executable, and
      // the setup program stays in the environment for repair or reinstall.
      ...(setupPlan.mode === 'installed' ? { source: setupPlan.installedExePath, setupState: 'complete' } : {}),
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? withSetup : entry)));
    appRecord = withSetup;
    // What exists in the environment right now. Whatever setup adds after this point is
    // the app it installed, whatever timestamp the installer copied with it.
    if (withSetup.setupProgram) captureSetupBaseline(withSetup);
  }

  const existingPids = appRecord.status === 'Running'
    ? await listProcessTable().then((table) => findAppProcessIds(table, sandboxRoot, trackedPids(appRecord))).catch(() => (appRecord.pid ? [appRecord.pid] : []))
    : [];
  if (existingPids.length > 0) {
    const base = getStoredApp(appRecord.id) || appRecord;
    const alreadyRunning = { ...base, status: 'Running', pid: existingPids[0], sandboxPids: existingPids };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? alreadyRunning : entry)));
    monitorAppProcesses(appRecord.id, logPath);
    broadcastContainerStatus(alreadyRunning);
    // Pressing Run on an app that is already running must still present it inside
    // RunContainer; otherwise its window sits on the desktop and Run appears to do nothing.
    const hostResult = await hostAppWindowEverywhere(alreadyRunning, existingPids[0], logPath, {
      note: 'This app was already running. Its window is hosted here.',
    });
    const latest = getStoredApp(appRecord.id);
    if (latest) broadcastContainerStatus(latest);
    return {
      id: appRecord.id,
      status: 'Running',
      pid: existingPids[0],
      sandboxPids: existingPids,
      launchMode: appRecord.launchMode || 'isolated-profile',
      activeEngine: appRecord.activeEngine || appRecord.launchMode || 'profile',
      isolated: Boolean(appRecord.isolated),
      embedded: false,
      reason: 'This app is already running, so RunContainer did not start a second copy. Its window is being hosted here.',
    };
  }
  fs.writeFileSync(logPath, `Launch started at ${new Date().toISOString()}\n`, 'utf8');
  appendLog(logPath, `Using container ${sandboxRoot}`);
  stopMonitor(appRecord.id);
  clearLiveLog(appRecord.id);

  appendLog(logPath, 'Launch requested; dispatching the selected engine under an operation lock.');
  // Start the second RunContainer window AND WAIT until its host says it is watching,
  // before the app's process exists. This is the difference between the app appearing
  // inside RunContainer on the first press and appearing on the desktop first: a host
  // that is still compiling cannot adopt anything, so the app was started visible and
  // only adopted later (or not at all). The wait is bounded, and a host that is not
  // ready only means the app starts visible instead of invisible.
  if (appRecord.windowHosting !== false && process.platform === 'win32') {
    const launchHost = await hostAppWindowEverywhere({ ...appRecord, pid: null }, null, logPath, {
      note: appRecord.setupProgram && appRecord.setupPlanMode === 'silent'
        ? 'Setup is completing in the background inside this environment. This window reports its progress, and the app starts here when setup finishes.'
        : 'This app runs in its own environment. Its window is hosted here.',
      timeoutMs: 0,
      readyMs: windowHostReadyBudget(),
    }).catch((error) => {
      appendLog(logPath, `The window host could not be started: ${error.message}`);
      return null;
    });
    appendLog(logPath, launchHost?.ready
      ? 'Window host is watching; the app’s first window will be hosted the moment it exists.'
      : `The app will start with its window visible: the window host is not watching yet${launchHost?.reason ? ` (${launchHost.reason})` : ''}. RunContainer keeps watching for it.`);
  }

  const performLaunch = async () => {
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
  };
  const result = await (lockHeld ? performLaunch() : withOpLock(appRecord.id, 'run', performLaunch));
  // A launch that did not start an app must not leave an empty RunContainer window behind.
  if (result?.status !== 'Running') {
    await stopAppWindowWatcher(appRecord.id);
    closeGuestWindow(appRecord.id);
  }
  // Setup is not finished when its process has started: follow it to the end, then
  // look for the app it produced. This is what turns "Run did nothing for ages"
  // into a named result.
  if (result?.status === 'Running' && appRecord.setupProgram) {
    // An unattended setup has no window of its own, so the second RunContainer window
    // is its progress surface: it must show that setup is still working rather than
    // sit empty for as long as the install takes.
    if (appRecord.setupPlanMode === 'silent' && !appRecord.installedExePath) {
      startSetupProgressReporting(appRecord, logPath);
    }
    if (requestedAppRecord?.backgroundSetup !== true) watchSetupCompletion(appRecord.id, logPath).catch((error) => appendLog(logPath, `Setup monitoring failed: ${error.message}`));
  }
  return result;
}

// Waits (bounded) for a setup program to exit, then records whatever executable it
// produced inside the environment. It never guesses: an empty result is reported as
// an empty result.
async function waitForSetupExit(appId, { timeoutMs = 20 * 60 * 1000, pollMs = 3000, logPath = null } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const record = getStoredApp(appId);
    if (!record) return { exited: true, reason: 'the app was removed while setup was running', waitedMs: Date.now() - startedAt };
    if (record.setupCancelledAt && Date.parse(record.setupCancelledAt) >= (Date.parse(record.setupStartedAt || '') || startedAt)) return { exited: false, cancelled: true, waitedMs: Date.now() - startedAt };
    const pids = record.status === 'Running' ? await listRunningPids(record) : [];
    if (pids.length === 0) {
      if (logPath) appendLog(logPath, `Setup finished after ${Math.round((Date.now() - startedAt) / 1000)}s (its process tree has exited).`);
      return { exited: true, waitedMs: Date.now() - startedAt };
    }
    if (record.status !== 'Running') {
      return { exited: true, reason: `setup ended with status ${record.status}`, waitedMs: Date.now() - startedAt };
    }
  }
  if (logPath) appendLog(logPath, `Setup is still running after ${Math.round(timeoutMs / 60000)} minutes; RunContainer stopped waiting for it but keeps the environment as it is.`);
  return { exited: false, timedOut: true, waitedMs: Date.now() - startedAt };
}

// --- Setup: where did the app actually land? -------------------------------
//
// An installer is a black box: it chooses its own destination, and a Windows installer
// that asks Windows for "the user's program folder" gets the REAL one -- the known-folder
// API does not read the environment variables RunContainer sets for the app. The install
// was therefore correct and still looked like a failure: "setup finished, but no
// executable was found in this environment", because the files were placed in
// C:\Users\<you>\AppData. Three things fix that:
//
//   1. a documented destination switch is passed to supported silent installers;
//   2. discovery compares against a snapshot, so an installer that copies files with
//      their original (old) timestamps is still seen as having installed something;
//   3. when a silent or wizard install genuinely escaped, the installer's own record of
//      where it put the app is read, and the app is brought into its environment.

function setupInstallDir(sandboxRoot) {
  const dir = path.join(sandboxRoot, 'installed');
  ensureDirectory(dir);
  return dir;
}

function setupBaselineRoot() {
  const root = path.join(app.getPath('userData'), 'setup-baselines');
  ensureDirectory(root);
  return root;
}

// A snapshot of the executables that exist in the app's environment BEFORE setup runs.
// Only its paths matter; it is deliberately not read as a promise about the install.
function captureSetupBaseline(appRecord) {
  if (!appRecord?.id || !appRecord.sandboxRoot) return null;
  try {
    const files = findExecutablesIn(appRecord.sandboxRoot, { maxDepth: 8, maxEntries: 20000 });
    fs.writeFileSync(
      path.join(setupBaselineRoot(), `${appRecord.id}.json`),
      JSON.stringify({ capturedAt: new Date().toISOString(), files }),
      'utf8',
    );
    return files;
  } catch (error) {
    return null;
  }
}

function loadSetupBaseline(appId) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(setupBaselineRoot(), `${appId}.json`), 'utf8'));
    return Array.isArray(raw.files) ? raw.files : null;
  } catch (error) {
    return null;
  }
}

// One uninstall record per line group from `reg query`.
function parseUninstallEntries(text) {
  const entries = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^HKEY_/i.test(line)) {
      current = { key: line };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const match = /^(DisplayIcon|InstallLocation|DisplayName)\s+REG_\w+\s+(.*)$/i.exec(line);
    if (match) current[match[1].toLowerCase()] = match[2].trim();
  }
  return entries;
}

function exeFromDisplayIcon(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '').trim();
  return cleaned.toLowerCase().endsWith('.exe') ? cleaned : null;
}

async function recentInstallEntries() {
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const entries = [];
  for (const key of keys) {
    try {
      const { stdout } = await executeFile('reg.exe', ['query', key, '/s'], { maxBuffer: 8 * 1024 * 1024 });
      entries.push(...parseUninstallEntries(stdout));
    } catch (error) {
      // A missing key or a key this user may not read is not a failure.
    }
  }
  return entries;
}

// A copied tree is bounded: an app that installs a whole game engine should not turn
// one press of Run into a gigabyte copy with no way to stop it.
function copyTreeBounded(sourceDir, destDir, { maxFiles = 20000, maxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const copyDir = (from, to) => {
    if (truncated) return;
    fs.mkdirSync(to, { recursive: true });
    let children = [];
    try {
      children = fs.readdirSync(from, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of children) {
      if (truncated) return;
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      try {
        if (entry.isDirectory()) {
          copyDir(source, target);
        } else if (entry.isFile()) {
          bytes += Number(fs.statSync(source).size) || 0;
          files += 1;
          if (files > maxFiles || bytes > maxBytes) {
            truncated = true;
            return;
          }
          fs.copyFileSync(source, target);
        }
      } catch (error) {
        // A file held open by another process is skipped; the rest still copies.
      }
    }
  };
  copyDir(sourceDir, destDir);
  return { files, bytes, truncated };
}

function isInsideSandbox(record, filePath) {
  const roots = [record.sandboxRoot, path.join(record.sandboxRoot || '', 'profile')]
    .filter(Boolean)
    .map((root) => `${root.toLowerCase()}${path.sep}`);
  const lowered = String(filePath).toLowerCase();
  return roots.some((root) => lowered.startsWith(root));
}

// The name of a helper is not an app. Uninstallers, updaters and crashed-process
// reporters live beside the real executable and must never become "the app".
function looksLikeMainExecutable(filePath) {
  const base = path.basename(String(filePath)).toLowerCase();
  if (!base.endsWith('.exe')) return false;
  if (/^(unins|uninstall|setup|install(er)?|update|updater|helper|crash|report|elevate|createdump|vcredist|vc_redist|dotnet|msiexec)/.test(base)) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

// Read where Windows says the app was installed, and if that is outside this app's
// environment, copy it in. Copying (not referencing) is what keeps "running in an
// environment" true: the executable Run starts really lives inside the environment.
// If the tree is too large to copy, the installed path is used and that is logged
// rather than hidden.
async function adoptEscapedInstall(record, { since = 0, logPath = null } = {}) {
  const entries = await recentInstallEntries();
  const found = [];
  for (const entry of entries) {
    const location = entry.installlocation ? entry.installlocation.replace(/^"|"$/g, '') : '';
    const candidates = [];
    const icon = exeFromDisplayIcon(entry.displayicon);
    if (icon) candidates.push(icon);
    if (location && entry.displayname) candidates.push(path.join(location, `${entry.displayname}.exe`));
    for (const candidate of candidates) {
      if (!candidate || isInsideSandbox(record, candidate) || !looksLikeMainExecutable(candidate)) continue;
      try {
        const stats = fs.statSync(candidate);
        if (since && stats.mtimeMs < since) continue;
        found.push({ path: candidate, sizeBytes: Number(stats.size) || 0, modifiedMs: stats.mtimeMs, location: location || path.dirname(candidate) });
      } catch (error) {
        // Gone between the registry read and now: not a candidate.
      }
      break;
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.modifiedMs - a.modifiedMs);
  const chosen = found[0];
  const sourceDir = chosen.location && fs.existsSync(chosen.location) ? chosen.location : path.dirname(chosen.path);
  const folderName = sanitizeName(path.basename(sourceDir) || record.name || 'app');
  const destDir = path.join(setupInstallDir(record.sandboxRoot), folderName);
  if (logPath) {
    appendLog(logPath, `Setup installed ${chosen.path}, outside this app's environment (${path.dirname(chosen.path)}). The installer used Windows' known folders, which ignore the environment's profile variables.`);
  }
  try {
    const copy = copyTreeBounded(sourceDir, destDir);
    const relative = path.relative(sourceDir, chosen.path);
    const copiedExe = path.join(destDir, relative);
    if (!copy.truncated && fs.existsSync(copiedExe)) {
      if (logPath) appendLog(logPath, `Copied ${copy.files} file(s) into the environment; Run starts ${copiedExe}.`);
      return { path: copiedExe, sizeBytes: Number(fs.statSync(copiedExe).size) || chosen.sizeBytes, outside: false };
    }
  } catch (error) {
    if (logPath) appendLog(logPath, `The installed app could not be copied into the environment: ${error.message}`);
  }
  if (logPath) appendLog(logPath, `Run starts the installed copy at ${chosen.path}; its files stayed where the installer put them because the folder was too large to copy.`);
  return { path: chosen.path, sizeBytes: chosen.sizeBytes, outside: true };
}

async function recordInstalledExecutable(appId, { logPath, since = 0 } = {}) {
  const record = getStoredApp(appId);
  if (!record?.sandboxRoot) return null;
  const installerDir = path.join(record.sandboxRoot, 'installers');
  const staged = fs.existsSync(installerDir)
    ? fs.readdirSync(installerDir).map((name) => path.join(installerDir, name))
    : [];
  const baseline = loadSetupBaseline(appId);
  const candidates = findInstalledCandidates(record.sandboxRoot, {
    since,
    exclude: [record.source, ...staged],
    knownPaths: baseline,
  });
  const escaped = candidates.length === 0
    ? await adoptEscapedInstall(record, { since, logPath })
    : null;
  const chosen = candidates[0] || escaped;
  if (!chosen) {
    if (logPath) {
      appendLog(logPath, 'Setup finished but produced no executable inside this environment, and Windows has no new uninstall record pointing at an app it installed. There is nothing new to run.');
    }
    emitToRenderer('app:setup-complete', {
      id: appId,
      name: record.name,
      installed: false,
      detail: 'Setup finished, but no new app was found. If this installer needs a wizard, set Settings → Installers to “Show the installer wizard”, then press Run and complete it in the RunContainer window.',
    });
    return null;
  }
  saveApps(loadApps().map((entry) => (entry.id === appId ? {
    ...entry,
    installedExePath: chosen.path,
    installedAppName: path.basename(chosen.path, path.extname(chosen.path)),
    installedAt: new Date().toISOString(),
    setupState: 'complete',
    // Run now starts a different executable, so the tile must show THAT file's
    // icon rather than the setup program's. Clearing the marker makes the next
    // list read extract it; nothing else has to know.
    iconVersion: null,
    iconFrom: null,
  } : entry)));
  if (logPath) appendLog(logPath, `Setup produced ${chosen.path} (${Math.round(chosen.sizeBytes / 1024)} KB); Run starts that executable now.`);
  emitToRenderer('app:setup-complete', {
    id: appId,
    name: record.name,
    installed: true,
    installedExePath: chosen.path,
    installedAppName: path.basename(chosen.path, path.extname(chosen.path)),
    detail: `Setup finished. ${path.basename(chosen.path)} was installed inside this environment and is now the app Run starts.`,
  });
  return chosen.path;
}

async function watchSetupCompletion(appId, logPath) {
  const outcome = await waitForSetupExit(appId, { logPath });
  if (!outcome.exited) return null;
  const current = getStoredApp(appId);
  if (current?.status === 'Running') await checkAppProcesses(appId, logPath);
  const record = getStoredApp(appId);
  if (!record?.setupProgram || record.installedExePath) return null;
  const installed = await recordInstalledExecutable(appId, {
    logPath,
    // The whole of setup, not just its last launch: an installer can install its app
    // before it exits, and an app installed a second ago is still new.
    since: Date.parse(record.setupStartedAt || record.lastInstallerAt || record.lastLaunchedAt || '') || 0,
  });
  stopSetupProgressReporting(appId);
  // Setup finished with nobody waiting at a wizard: start what it installed, so pressing
  // Run once reaches the app instead of asking for a second press.
  const updated = installed ? getStoredApp(appId) : null;
  if (updated?.installedExePath && updated.status !== 'Running') {
    appendLog(logPath, `Setup has finished; starting ${path.basename(updated.installedExePath)} with its own window now.`);
    emitToRenderer('app:setup', {
      id: appId,
      name: updated.name,
      phase: 'starting-app',
      detail: `Setup finished. Starting ${path.basename(updated.installedExePath)} now.`,
    });
    const started = await runApp({ id: appId }).catch(() => null);
    if (started?.status === 'Running' && started?.pid) {
      // The app the installer produced is running in its own environment. Its window has
      // to end up here, not on the desktop: the launch was asked for once and the user is
      // waiting at this RunContainer window for it. An elevated app is the one exception -
      // Windows will not let this process parent an elevated window, and the elevated
      // launcher already opened a RunContainer administrator window that hosts it.
      const fresh = getStoredApp(appId);
      if (started.elevated) {
        if (fresh) broadcastContainerStatus(fresh);
      } else {
        const hostResult = await hostAppWindowEverywhere(started, started.pid, logPath, {
          note: `Setup finished. ${path.basename(updated.installedExePath)} is starting here.`,
          // A longer budget than a normal launch: an installer that starts the real app a
          // moment after it exits would otherwise get a host that had already stopped
          // looking, and the app would open on the desktop instead.
          timeoutMs: 45000,
        });
        if (hostResult?.embedded) {
          saveApps(loadApps().map((entry) => (entry.id === appId
            ? { ...entry, windowHosted: true, hostedWindowPid: hostResult.pid || started.pid }
            : entry)));
        }
        const latest = getStoredApp(appId);
        if (latest) broadcastContainerStatus(latest);
      }
    }
  }
  return installed;
}

// "4m 07s" - a long setup is described in the same units everywhere it is reported.
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

// One reporter per app while an unattended setup runs. It says which installer is
// working, how long it has been working, and the newest line of its own log. Nothing
// here invents progress: the clock is real and the line is quoted.
const setupProgressTimers = new Map();

function stopSetupProgressReporting(appId) {
  const timer = setupProgressTimers.get(appId);
  if (timer) clearInterval(timer);
  setupProgressTimers.delete(appId);
}

function startSetupProgressReporting(appRecord, logPath) {
  stopSetupProgressReporting(appRecord.id);
  const startedAt = Date.parse(appRecord.setupStartedAt || '') || Date.now();
  const tick = () => {
    const record = getStoredApp(appRecord.id);
    if (!record) {
      stopSetupProgressReporting(appRecord.id);
      return;
    }
    if (!backgroundSetupRunning(record)) {
      stopSetupProgressReporting(appRecord.id);
      return;
    }
    const win = guestWindows.get(appRecord.id);
    if (!win || win.isDestroyed()) return;
    const lines = behavioralMonitor.readLogTail(logPath, { maxLines: 4 }) || [];
    const latest = [...lines].reverse().find((line) => line && !/^(Launch started|Using container|Isolation engine|RC-Brain)/.test(line));
    const elapsed = formatDuration(Date.now() - startedAt);
    const trimmed = latest && latest.length > 120 ? `${latest.slice(0, 119)}…` : latest;
    setGuestWindowStatus(win, `Setup is working in the background (${record.setupFamilyName || 'installer'}), running for ${elapsed}.`
      + (trimmed ? ` Latest: ${trimmed}` : '')
      + ' The app you pressed Run on starts here as soon as setup finishes.');
  };
  tick();
  const timer = setInterval(tick, 4000);
  if (timer.unref) timer.unref();
  setupProgressTimers.set(appRecord.id, timer);
}

ipcMain.handle('run-exe', async (_event, requestedAppRecord) => runApp(requestedAppRecord));

// Complete an app's setup in the background, inside the same environment the app
// would run in, and then point Run at whatever it installed. Only offered for
// installer families whose unattended switches are documented (see
// src/services/setupInstall.js); anything else keeps its wizard in a RunContainer
// window, and this handler refuses rather than guessing at switches.
ipcMain.handle('setup-in-background', async (_event, requestedAppRecord) => setupAppInBackground(requestedAppRecord));

async function setupAppInBackground(requestedAppRecord, { onLaunched } = {}) {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const plan = planSetupRun({
    source: appRecord.source,
    name: appRecord.name,
    metadata: appRecord.metadata,
    installedExePath: appRecord.installedExePath,
    setupMode: 'silent',
    installDir: setupInstallDir(appRecord.sandboxRoot),
  });
  if (!plan.isSetup) {
    return { id: appRecord.id, status: 'Failed', error: `${plan.summary} Nothing was run.` };
  }
  if (plan.mode === 'installed') {
    return { id: appRecord.id, status: 'Installed', installedExePath: plan.installedExePath, detail: plan.summary };
  }
  if (plan.mode !== 'silent') {
    return { id: appRecord.id, status: 'Failed', error: `${plan.summary} This installer has to be completed by hand.` };
  }
  if (appRecord.status === 'Running') return { id: appRecord.id, status: 'Failed', error: 'Close the running installer before starting background setup.' };
  const logsRoot = appRecord.logsRoot || path.join(appRecord.sandboxRoot, 'logs');
  const logPath = path.join(logsRoot, `${sanitizeName(appRecord.name || 'app')}.log`);
  appendLog(logPath, plan.summary);
  emitToRenderer('app:setup', { id: appRecord.id, name: appRecord.name, phase: 'starting', ...plan });
  // The unattended switches are passed the same way saved launch arguments are, so
  // the ordinary contained launch path is reused rather than duplicated: same
  // engine, same Job Object, same per-app profile.
  const previousArgs = appRecord.launchArgs || '';
  const silentRecord = { ...appRecord, launchArgs: plan.args.join(' '), setupProgram: true, setupCancelledAt: null, setupStartedAt: new Date().toISOString() };
  saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? silentRecord : entry)));
  const launched = await runApp({ id: appRecord.id, backgroundSetup: true }, {}).catch((error) => ({ status: 'Failed', error: error.message }));
  // A caller that asked for this from the Run button needs the launch result now, while
  // the setup itself may run for minutes: it is told the moment the installer is running.
  if (typeof onLaunched === 'function') {
    try { onLaunched(launched); } catch (error) { /* the caller is only being informed */ }
  }
  saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? { ...entry, launchArgs: previousArgs } : entry)));
  if (launched?.status !== 'Running') {
    const error = launched?.error || 'The unattended setup did not start inside its environment.';
    emitToRenderer('app:setup', { id: appRecord.id, name: appRecord.name, phase: 'failed', detail: error });
    return { id: appRecord.id, status: 'Failed', error: `${error} Use the wizard instead: press Run and complete setup in the RunContainer window.` };
  }
  emitToRenderer('app:setup', { id: appRecord.id, name: appRecord.name, phase: 'running', detail: 'Setup is running inside this environment; this window stays empty until it finishes.' });
  let outcome;
  try {
    outcome = await waitForSetupExit(appRecord.id, { logPath });
  } catch (error) {
    stopSetupProgressReporting(appRecord.id);
    appendLog(logPath, `Could not monitor setup: ${error.message}`);
    return { id: appRecord.id, status: 'Failed', error: `Could not monitor setup: ${error.message}` };
  }
  if (!outcome.exited) {
    stopSetupProgressReporting(appRecord.id);
    return { id: appRecord.id, status: outcome.timedOut ? 'SettingUp' : 'Failed', detail: outcome.timedOut ? 'Setup is still running; RunContainer stopped waiting after 20 minutes.' : 'Setup was stopped before it completed.' };
  }
  const latestSetup = getStoredApp(appRecord.id);
  if (latestSetup?.status === 'Running') await checkAppProcesses(appRecord.id, logPath);
  const installedExePath = await recordInstalledExecutable(appRecord.id, {
    logPath,
    since: Date.parse(getStoredApp(appRecord.id)?.setupStartedAt || '') || 0,
  });
  if (!installedExePath) {
    return {
      id: appRecord.id,
      status: outcome.timedOut ? 'SettingUp' : 'Installed',
      detail: outcome.timedOut
        ? `${plan.family.name} setup is still running after 20 minutes; RunContainer stopped waiting. Its log is in ${logPath}.`
        : 'Setup finished, but no installed executable was found in this environment.',
    };
  }
  stopSetupProgressReporting(appRecord.id);
  // Setup is finished and the app exists, so it is started: the point of pressing Run
  // was to see the app, and it should not need a second press once setup is done.
  emitToRenderer('app:setup', {
    id: appRecord.id,
    name: appRecord.name,
    phase: 'starting-app',
    detail: `Setup completed in the background. Starting ${path.basename(installedExePath)} now.`,
  });
  const started = await runApp({ id: appRecord.id }).catch(() => null);
  return {
    id: appRecord.id,
    status: started?.status === 'Running' ? 'Running' : 'Installed',
    installedExePath,
    launch: started || null,
    detail: started?.status === 'Running'
      ? `Setup completed in the background and ${path.basename(installedExePath)} is starting in a RunContainer window.`
      : `Setup completed in the background. Run now starts ${path.basename(installedExePath)}.`,
  };
}

// RC-Brain runs continuously in the main process while monitoring is enabled;
// these are the only renderer-facing entry points it has.
ipcMain.handle('ai-status', async () => aiStatus());
ipcMain.handle('ai-history', async () => aiHistory);
ipcMain.handle('ai-experiences', async (_event, payload = {}) => experienceStore.list({ limit: payload.limit || 20 }));
ipcMain.handle('ai-promote-experiences', async (_event, payload = {}) => {
  // Promotion requires an explicit action from the user; the UI asks first.
  const result = experienceStore.promote(payload.ids, { consent: payload.consent === true });
  emitToRenderer('ai:status', aiStatus());
  return result;
});
ipcMain.handle('ai-correct-experience', async (_event, payload = {}) => {
  const result = experienceStore.correct(payload.id, payload);
  emitToRenderer('ai:status', aiStatus());
  return result;
});
ipcMain.handle('ai-rollback-model', async () => {
  try {
    const raw = JSON.parse(fs.readFileSync(AI_REGISTRY_PATH, 'utf8'));
    if (!raw.previous) return { rolledBack: false, reason: 'No previous model is recorded.' };
    const previousFile = path.join(path.dirname(AI_REGISTRY_PATH), path.basename(raw.previous));
    if (!fs.existsSync(previousFile)) return { rolledBack: false, reason: 'The previous model file is no longer on disk.' };
    const updated = {
      ...raw,
      current: raw.previous,
      previous: raw.current,
      updatedAt: new Date().toISOString(),
      history: [...(raw.history || []), { file: raw.previous, status: 'active', activatedAt: new Date().toISOString(), source: 'in-app-rollback' }].slice(-10),
    };
    fs.writeFileSync(AI_REGISTRY_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    reloadBrain();
    emitToRenderer('ai:status', aiStatus());
    return { rolledBack: true, registry: aiRegistry() };
  } catch (error) {
    return { rolledBack: false, reason: error.message };
  }
});
ipcMain.handle('ai-set-monitoring', async (_event, payload = {}) => {
  aiMonitoringEnabled = payload.enabled !== false;
  if (aiMonitoringEnabled) {
    startBehavioralSupervisor();
  } else if (behavioralSupervisor) {
    behavioralSupervisor.stop();
  }
  emitToRenderer('ai:status', aiStatus());
  return aiStatus();
});

ipcMain.handle('repair-app-behaviour', async (_event, payload = {}) => {
  try {
    return await repairAppBehavior(payload);
  } catch (error) {
    return { status: 'failed', id: payload.appId || null, error: error.message };
  }
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
      appendLog(logPath, 'Opening the guest display inside RunContainer so the installer wizard is visible.');
      await showHyperVGuestDisplay(appRecord, logPath).catch((displayError) => {
        appendLog(logPath, `Guest display could not be opened automatically: ${displayError.message}`);
      });
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
  // AppContainer installer run: same verified launch path as apps, result tracked.    const scriptPath = ensureIsolationScript();
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
    // The installer's wizard is the only thing the user can interact with, so it is
    // hosted in RunContainer like any app window — never left as a bare desktop window.
    // Installers can take longer to show a window than an app, so the wait is longer.
    hostInstallerWindow(getStoredApp(appRecord.id) || appRecord, launch.pid, logPath).catch(() => {});
    return { id: appRecord.id, status: 'Running', engine: 'appcontainer', pid: launch.pid, detail: 'Installer is running inside the AppContainer; its wizard is hosted in RunContainer, and its children stay tracked after it exits.' };
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

// Profiles decide what an app may reach. locked = no network + no container
// capabilities; relaxed = online + wider capabilities; default = online +
// internetClient. Blocks are only real where the selected backend can enforce
// them (a VM, or an AppContainer without the internet capability); the UI says
// so instead of promising an offline switch containment cannot honour.
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
  if (requestedAppRecord?.runtimeJit !== undefined) {
    const strategy = runtimeProfile.normalizeStrategy(requestedAppRecord.runtimeJit);
    const runtime = appRecord.runtime || detectAppRuntime(appRecord.source);
    if (runtime && !appRecord.runtime) patch.runtime = runtime;
    if (strategy !== 'auto' && runtime?.kind !== 'dotnet') {
      return { id: appRecord.id, status: 'Failed', error: 'This app is not a managed .NET program, so there is no JIT strategy to set.' };
    }
    patch.runtimeJit = strategy;
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

// Guest display: shows the VM console for this environment inside a second
// RunContainer window when Windows lets RunContainer host it. This is presentation
// only and is never presented as isolation.
async function showHyperVGuestDisplay(appRecord, logPath) {
  const existing = guestWindows.get(appRecord.id);
  if (existing && !existing.isDestroyed() && existing.__rcHostPid) {
    existing.show();
    existing.focus();
    return { vm: appRecord.hypervVm, embedded: true, reused: true };
  }
  const hv = require('./hyperv-runtime');
  const vmInfo = await runHyperVScript(hv.buildGetVmScript(appRecord.hypervVm), logPath);
  if (!vmInfo.exists) throw new Error(`VM ${appRecord.hypervVm} does not exist. Run the app to recreate it from its disk.`);
  if (vmInfo.state !== 'Running') {
    await runHyperVScript(hv.buildStartVmScript(appRecord.hypervVm), logPath);
    await runHyperVScript(hv.buildWaitForGuestReadyScript({ vm: appRecord.hypervVm, credFile: guestCredentialFile(), timeoutSec: 300 }), logPath);
  }
  const child = spawn('vmconnect.exe', ['localhost', appRecord.hypervVm], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  // VMConnect is the supported console for Hyper-V. Hosting it puts the guest
  // desktop — and any installer wizard running inside it — in a RunContainer window.
  const hosted = await hostInGuestWindow(appRecord, child.pid, logPath, {
    note: 'The app and any installer wizard run inside this virtual machine.',
    timeoutMs: 45000,
  });
  return { vm: appRecord.hypervVm, vmconnectPid: child.pid, embedded: Boolean(hosted?.embedded) };
}

ipcMain.handle('open-guest-display', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  if (process.platform !== 'win32') return { id: appRecord.id, status: 'Failed', error: 'Opening an app window requires Windows.' };
  const appLog = path.join(appRecord.logsRoot || path.join(appRecord.sandboxRoot || '', 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
  try {
    if (isQemuEnv(appRecord)) {
      const qemuPid = qemuProcs.get(appRecord.id)?.pid || appRecord.qemuPid || appRecord.pid;
      if (!qemuPid) throw new Error('The virtual machine is not running. Run the app first.');
      const hosted = await hostInGuestWindow(appRecord, qemuPid, appLog, {
        note: 'The app and any installer wizard run inside this virtual machine.',
        timeoutMs: 30000,
      });
      return {
        id: appRecord.id,
        status: 'Displaying',
        engine: 'qemu',
        embedded: Boolean(hosted?.embedded),
        note: hosted?.embedded
          ? 'Shown inside RunContainer.'
          : 'Windows refused to host the VM window, so it stays on your desktop.',
      };
    }
    if (appRecord.hypervVm) {
      const shown = await showHyperVGuestDisplay(appRecord, appLog);
      return {
        id: appRecord.id,
        status: 'Displaying',
        engine: 'hyperv',
        vm: shown.vm,
        embedded: Boolean(shown.embedded),
        note: shown.embedded
          ? 'Shown inside RunContainer.'
          : 'Windows refused to host the VM console, so it stays on your desktop.',
      };
    }
    const pids = trackedPids(appRecord);
    if (pids.length === 0) throw new Error('This app is not running. Run it first, then open its window.');
    const hosted = await hostInGuestWindow(appRecord, appRecord.pid || pids[0], appLog, {
      note: 'This app runs in its own environment. Its window is hosted here.',
      timeoutMs: 30000,
    });
    if (!hosted?.embedded) {
      throw new Error(hosted?.reason
        ? `The app’s window is not hosted inside RunContainer: ${hosted.reason}. Isolation is unaffected.`
        : 'Windows refused to host this app’s window inside RunContainer, so it keeps its own window. Isolation is unaffected.');
    }
    return { id: appRecord.id, status: 'Displaying', embedded: true, note: 'Shown inside RunContainer.' };
  } catch (error) {
    return { id: appRecord.id, status: 'Failed', error: `Could not open the app window: ${error.message}` };
  }
});

ipcMain.handle('guest-window-action', async (_event, payload = {}) => {
  const appRecord = getStoredApp(payload.appId);
  if (!appRecord?.id) return { ok: false, error: 'That app is no longer in RunContainer’s app list.' };
  const win = guestWindows.get(appRecord.id);
  if (payload.action === 'focus-main') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    return { ok: true };
  }
  if (payload.action === 'background-setup') {
    const result = await setupAppInBackground({ id: appRecord.id }).catch((error) => ({ status: 'Failed', error: error.message }));
    return { ok: result?.status !== 'Failed', result, error: result?.error };
  }
  if (payload.action === 'release') {
    const released = await releaseGuestWindowWindows(appRecord, [...trackedPids(appRecord), appRecord.hostedWindowPid]);
    if (win && !win.isDestroyed()) {
      win.__rcHostPid = null;
      win.__rcHostState = null;
    }
    recordWindowHosted(appRecord.id, false, { hostedWindowPid: null, windowHostTarget: null });
    return { ok: true, released };
  }
  return { ok: false, error: 'Unknown window action.' };
});

// The beginner introduction is shown once for this installation and never again —
// not once per version. The answer therefore lives in an app-wide file, not on an
// app record, and it outlives every app being deleted.
ipcMain.handle('get-preferences', async () => ({ ...loadPreferences(), channel: IS_NIGHTLY ? 'nightly' : 'stable' }));
ipcMain.handle('set-preference', async (_event, payload = {}) => {
  const updated = savePreferences(payload);
  emitToRenderer('app:preferences', updated);
  return updated;
});

// The UI asks the main process for the version, so package.json stays the single source.
ipcMain.handle('get-app-version', async () => ({ version: app.getVersion() }));

// Measured launch timings for the Settings card (this PC only, no telemetry).
ipcMain.handle('get-performance', async () => performanceSummary());

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
  const result = await updateCheck.checkForUpdates({ currentVersion: app.getVersion(), channel: IS_NIGHTLY ? 'nightly' : 'stable' });
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
  const destPath = path.join(app.getPath('temp'), result.installerName);
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

// --- Virtual machines (developer mode) ----------------------------------------
// A VM here is a whole operating system, installed from media the user owns, running
// on the same custom QEMU backend as the VM engine. QEMU draws no window of its own:
// its display is a VNC server bound to loopback, and the main process proxies that
// socket to the renderer, which paints the guest inside a RunContainer window and
// sends its keyboard and mouse input back. This is experimental, and the interface
// says so where a VM is created.
const vmStorePath = path.join(app.getPath('userData'), 'runcontainer-vms.json');
const vmProcs = new Map();
const vmSockets = new Map();
const vmSlots = new Map();

function loadVmStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(vmStorePath, 'utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.vms) ? parsed : { vms: [] };
  } catch (error) {
    return { vms: [] };
  }
}

function saveVmStore(store) {
  fs.writeFileSync(vmStorePath, `${JSON.stringify({ vms: store.vms || [] }, null, 2)}\n`, 'utf8');
}

function findVm(id) {
  return loadVmStore().vms.find((entry) => entry.id === id) || null;
}

function saveVmRecord(updated) {
  const store = loadVmStore();
  saveVmStore({ vms: store.vms.map((entry) => (entry.id === updated.id ? updated : entry)) });
  return updated;
}

function isVmRunning(id) {
  const child = vmProcs.get(id);
  return Boolean(child) && child.exitCode === null && !child.killed;
}

// Lowest free console slot, so two VMs never claim one port.
function claimVmSlot(id) {
  const vm = require('./vm-runtime');
  const taken = new Set();
  for (const [other, slot] of vmSlots.entries()) {
    if (other !== id) taken.add(slot);
  }
  for (let slot = 0; slot < vm.VM_CONSOLE_SLOTS; slot += 1) {
    if (!taken.has(slot)) {
      vmSlots.set(id, slot);
      return slot;
    }
  }
  throw new Error('Every VM console slot is in use. Stop another virtual machine first.');
}

function releaseVmSlot(id) {
  vmSlots.delete(id);
}

// Whether a pid still exists. Windows offers no direct call for this, so signal 0 is used:
// it throws ESRCH when the process is gone and EPERM when it exists but is not ours.
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A machine whose QEMU process is alive but was not started by this session: the app was
// closed (or killed) while it ran, and its detached process kept the disk and the console
// port. Nothing may start it again until that process is gone.
function vmLeftoverPid(record) {
  const vm = require('./vm-runtime');
  const pid = vm.readVmPid(record?.qemuPid);
  return Number.isSafeInteger(pid) && isProcessAlive(pid) ? pid : null;
}

function forgetVmPid(id, logPath) {
  const latest = findVm(id);
  if (!latest || !latest.qemuPid) return;
  saveVmRecord({ ...latest, qemuPid: null });
  if (logPath) appendLog(logPath, `Virtual machine ${latest.name} no longer has a running QEMU process; its record was cleared.`);
}

function describeVms() {
  const vm = require('./vm-runtime');
  const stored = loadVmStore().vms;
  const reconciled = vm.reconcileVmRecords(stored, { isAlive: isProcessAlive });
  return stored.map((record, index) => vm.summarizeVm(record, {
    // A machine that outlived the app is running, whatever this session's process map
    // knows: saying "Stopped" is what let a second machine be started on one disk.
    running: isVmRunning(record.id) || Boolean(reconciled[index]?.leftover),
    consoleSlot: vmSlots.has(record.id) ? vmSlots.get(record.id) : null,
  })).filter(Boolean);
}

function notifyVmStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vm-status', describeVms());
  }
}

function closeVmConsole(id) {
  const socket = vmSockets.get(id);
  if (!socket) return;
  vmSockets.delete(id);
  try { socket.destroy(); } catch (error) { /* already closed */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vm-console-status', { id, state: 'closed' });
  }
}

function stopVmProcess(id) {
  const child = vmProcs.get(id);
  if (child) {
    vmProcs.delete(id);
    try { child.kill(); } catch (error) { /* already gone */ }
  } else {
    // No handle: the machine was left running by a previous session, and the pid in its
    // record is the only way to stop it. Leaving it alive would keep the disk locked, so
    // the stop is attempted here rather than only reported.
    const pid = vmLeftoverPid(findVm(id));
    if (pid) {
      try {
        const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {});
      } catch (error) {
        // The caller reports what is still running; nothing here can do more.
      }
    }
  }
  forgetVmPid(id);
  closeVmConsole(id);
  releaseVmSlot(id);
}

// A machine holds a disk and a console port, so RunContainer does not leave one behind
// when it closes. Called once at startup as well, for the case where the app was killed
// rather than closed and the previous session never got the chance.
function reconcileVirtualMachines() {
  const vm = require('./vm-runtime');
  const logPath = path.join(app.getPath('userData'), 'runcontainer-error.log');
  const leftovers = vm.reconcileVmRecords(loadVmStore().vms, { isAlive: isProcessAlive })
    .filter((row) => row.leftover);
  if (leftovers.length === 0) return 0;
  appendLog(logPath, `${leftovers.length} virtual machine(s) were still running from a previous session; stopping them, because each one holds its disk and its console port.`);
  for (const row of leftovers) stopVmProcess(row.id);
  notifyVmStatus();
  return leftovers.length;
}

// Where a virtual machine's QEMU writes its diagnostics. Kept out of the app's own error
// log because QEMU is chatty at startup and its output is only interesting when a machine
// misbehaves.
function vmQemuLogPath() {
  return path.join(app.getPath('userData'), 'vm-qemu.log');
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    return 0;
  }
}

// The end of what a program wrote after `offset`: what a failure needs is the last thing
// said, not the first.
function logTextSince(filePath, offset, maxChars = 400) {
  try {
    const descriptor = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(descriptor).size;
      const start = Math.max(0, Math.min(offset, size));
      const length = Math.min(size - start, 4096);
      if (length <= 0) return '';
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, start);
      return buffer.toString('utf8').replace(/\s+/g, ' ').trim().slice(-maxChars);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    return '';
  }
}

// Is anything already listening on the console port? QEMU would fail to bind and the
// reason would only reach the log, so the port is checked before QEMU is started.
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => resolve(error.code !== 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

function waitForPort(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

ipcMain.handle('vm-list', async () => ({ vms: describeVms() }));

ipcMain.handle('vm-browse-iso', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select installation media (an operating system you own)',
    filters: [{ name: 'Disk images', extensions: ['iso', 'img'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { path: null };
  return { path: result.filePaths[0] };
});

ipcMain.handle('vm-create', async (_event, config = {}) => {
  const vm = require('./vm-runtime');
  const qemu = require('./qemu-runtime');
  const isoPath = config.isoPath ? String(config.isoPath) : null;
  if (isoPath && !fs.existsSync(isoPath)) {
    return { created: false, error: 'That installation media is no longer there.' };
  }
  const check = vm.validateVmConfig({
    name: config.name,
    memoryMB: config.memoryMB,
    cpuCount: config.cpuCount,
    diskGB: config.diskGB,
    isoPath,
  });
  if (!check.ok) return { created: false, error: check.errors.join(' ') };
  if (loadVmStore().vms.some((entry) => entry.name.toLowerCase() === String(config.name).trim().toLowerCase())) {
    return { created: false, error: 'A virtual machine with that name already exists.' };
  }
  const status = await refreshQemuStatus();
  if (!status.qemuSystem) {
    return { created: false, error: 'QEMU is not detected on this PC yet. Install it, then press Detect.' };
  }
  if (!status.qemuImg) {
    return { created: false, error: 'qemu-img was not found next to qemu-system, so the virtual disk cannot be created.' };
  }
  const record = vm.defaultVmRecord({
    name: config.name,
    memoryMB: config.memoryMB,
    cpuCount: config.cpuCount,
    diskGB: config.diskGB,
    isoPath,
    accel: status.accel || 'tcg',
  });
  const vmDir = path.join(app.getPath('userData'), 'vms');
  fs.mkdirSync(vmDir, { recursive: true });
  const diskPath = vm.vmDiskPath(vmDir, record.id);
  if (fs.existsSync(diskPath)) {
    return { created: false, error: `A disk image already exists at ${diskPath}.` };
  }
  try {
    await executeFile(status.qemuImg, qemu.buildImgCreateArgs({ diskPath, sizeGB: record.diskGB }), { timeout: 180000 });
  } catch (error) {
    return { created: false, error: `The virtual disk could not be created: ${String(error.message).slice(0, 300)}` };
  }
  const created = { ...record, diskPath };
  const store = loadVmStore();
  saveVmStore({ vms: [...store.vms, created] });
  appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `Created virtual machine ${created.name} (${created.diskGB} GB disk, ${created.memoryMB} MB memory).`);
  return { created: true, vms: describeVms(), vm: vm.summarizeVm(created, { running: false }) };
});

ipcMain.handle('vm-start', async (_event, requested = {}) => {
  const vm = require('./vm-runtime');
  const record = findVm(requested.id);
  if (!record) return { started: false, error: 'That virtual machine is not in RunContainer\u2019s list.' };
  // Two machines on one disk is the one mistake here that cannot be repaired afterwards,
  // so this refuses before QEMU is touched — including when the previous session's QEMU
  // process is still holding the disk.
  const refusal = vm.vmStartRefusal({
    running: isVmRunning(record.id),
    leftover: Boolean(vmLeftoverPid(record)),
    diskPath: record.diskPath,
    diskExists: Boolean(record.diskPath && fs.existsSync(record.diskPath)),
  });
  if (refusal) return { started: false, error: refusal };
  const status = await refreshQemuStatus();
  if (!status.qemuSystem) return { started: false, error: 'QEMU is not detected on this PC yet.' };

  // Media is re-attached only when it is still there. A VM whose system is already
  // installed boots from its disk; the checkbox in the interface decides whether the
  // attached media is tried first.
  const isoPath = record.isoPath && fs.existsSync(record.isoPath) ? record.isoPath : null;
  const bootFromMedia = Boolean(isoPath) && record.bootFromMedia !== false;

  let slot;
  try {
    slot = claimVmSlot(record.id);
  } catch (error) {
    return { started: false, error: error.message };
  }
  const consolePort = vm.consolePortFor(slot);
  if (!(await isPortFree(consolePort))) {
    releaseVmSlot(record.id);
    return { started: false, error: `Console port ${consolePort} is already in use by another program.` };
  }

  const vmDir = path.dirname(record.diskPath);
  let args;
  try {
    args = vm.buildVmBootArgs({
      accel: status.accel || 'tcg',
      memoryMB: record.memoryMB,
      cpuCount: record.cpuCount,
      diskPath: record.diskPath,
      vmName: `RunContainer-${record.name}`.slice(0, 60),
      consoleSlot: slot,
      qmpPort: 44800 + slot,
      pidfilePath: vm.vmPidFile(vmDir, record.id),
      isoPath: bootFromMedia ? isoPath : null,
      bootFromMedia,
    });
  } catch (error) {
    releaseVmSlot(record.id);
    return { started: false, error: error.message };
  }

  // QEMU's own words, on disk. Its reasons for not producing a guest ("no ide bus", an
  // unusable accelerator, unreadable media) are printed to stderr, which 'ignore' threw
  // away: that silence is what made a blank console impossible to explain.
  const qemuLogPath = vmQemuLogPath();
  appendLog(qemuLogPath, `Starting "${record.name}" (QEMU ${status.qemuSystem}): ${args.join(' ')}`);
  // Where this start begins in the log, so a failure is explained by what QEMU said this
  // time rather than by a message from an older start.
  const logStart = fileSize(qemuLogPath);
  let stderrFd = null;
  try {
    stderrFd = fs.openSync(qemuLogPath, 'a');
  } catch (error) {
    stderrFd = null;
  }

  let child;
  try {
    // No native window: the guest is drawn by RunContainer through the console below.
    child = spawn(status.qemuSystem, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', stderrFd === null ? 'ignore' : stderrFd],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    if (stderrFd !== null) { try { fs.closeSync(stderrFd); } catch (closeError) { /* gone */ } }
    releaseVmSlot(record.id);
    return { started: false, error: `QEMU could not be started: ${String(error.message).slice(0, 300)}` };
  }
  // The child holds its own handle, so this process closes its copy: the machine then keeps
  // running and keeps logging even if RunContainer is killed.
  if (stderrFd !== null) { try { fs.closeSync(stderrFd); } catch (closeError) { /* gone */ } }
  child.unref();
  vmProcs.set(record.id, child);
  let qemuExitCode = null;
  child.on('exit', (code) => {
    qemuExitCode = code;
    if (vmProcs.get(record.id) === child) {
      vmProcs.delete(record.id);
      appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `Virtual machine ${record.name} stopped (QEMU exit code ${code}).`);
    }
    // The machine is gone, so its record must stop pointing at a pid that no longer
    // exists: a stale pid is what makes the next Start refuse for the wrong reason.
    forgetVmPid(record.id);
    closeVmConsole(record.id);
    releaseVmSlot(record.id);
    notifyVmStatus();
  });

  const ready = await waitForPort(consolePort);
  // The pid is stored so a machine that outlives this session is recognisable at the next
  // startup — and so Pressing Start cannot boot a second QEMU on the same disk.
  const updated = saveVmRecord({
    ...record,
    lastBootAt: new Date().toISOString(),
    accel: status.accel || 'tcg',
    qemuPid: child.pid,
  });
  notifyVmStatus();
  if (!ready) {
    stopVmProcess(record.id);
    notifyVmStatus();
    // QEMU's own words rather than a guess. A console that never opens is nearly always
    // QEMU refusing an argument and exiting at once — a QEMU that runs but cannot draw is
    // rare — and saying "check hardware acceleration" sent the reader in the wrong
    // direction when the real answer was already on disk.
    const said = logTextSince(qemuLogPath, logStart);
    return {
      started: false,
      error: `The machine did not open its console${qemuExitCode === null ? '' : ` (QEMU exited with code ${qemuExitCode})`}${said ? `: ${said}` : '.'} It was stopped. Details are in vm-qemu.log.`,
    };
  }
  return {
    started: true,
    consolePort,
    vms: describeVms(),
    vm: vm.summarizeVm(updated, { running: true, consoleSlot: slot }),
    note: bootFromMedia
      ? 'The virtual machine is booting from the attached media. Install the system as you would in VirtualBox, then shut it down — later boots can start from its disk.'
      : 'The virtual machine is booting from its own disk.',
  };
});

ipcMain.handle('vm-stop', async (_event, requested = {}) => {
  const record = findVm(requested.id);
  if (!record) return { stopped: false, error: 'That virtual machine is not in RunContainer\u2019s list.' };
  if (!isVmRunning(record.id)) return { stopped: false, error: 'That virtual machine is not running.' };
  stopVmProcess(record.id);
  notifyVmStatus();
  return { stopped: true, vms: describeVms() };
});

ipcMain.handle('vm-delete', async (_event, requested = {}) => {
  const record = findVm(requested.id);
  if (!record) return { deleted: false, error: 'That virtual machine is not in RunContainer\u2019s list.' };
  stopVmProcess(record.id);
  // The disk is this VM's whole operating system: removing it is the point of Delete,
  // so it is attempted after the process is gone and its failure is reported rather
  // than hidden.
  let diskRemoved = true;
  if (record.diskPath && fs.existsSync(record.diskPath)) {
    try {
      fs.rmSync(record.diskPath, { force: true });
    } catch (error) {
      diskRemoved = false;
    }
  }
  const store = loadVmStore();
  saveVmStore({ vms: store.vms.filter((entry) => entry.id !== record.id) });
  notifyVmStatus();
  return {
    deleted: true,
    diskRemoved,
    vms: describeVms(),
    note: diskRemoved ? null : 'The VM was removed from the list but its disk image is still on this PC.',
  };
});

// The guest console: one loopback TCP socket per VM, bridged to the window that draws
// it. Nothing outside 127.0.0.1 is ever connected to, and the socket only exists while
// that VM is running.
ipcMain.handle('vm-console-connect', async (_event, requested = {}) => {
  const vm = require('./vm-runtime');
  const record = findVm(requested.id);
  if (!record) return { connected: false, error: 'That virtual machine is not in RunContainer\u2019s list.' };
  if (!isVmRunning(record.id)) return { connected: false, error: 'Start the virtual machine first.' };
  const slot = vmSlots.get(record.id);
  if (!Number.isSafeInteger(slot)) return { connected: false, error: 'This VM has no console port assigned.' };
  closeVmConsole(record.id);
  const port = vm.consolePortFor(slot);
  const socket = net.connect(port, '127.0.0.1');
  vmSockets.set(record.id, socket);
  socket.on('data', (chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vm-console-data', { id: record.id, bytes: chunk });
    }
  });
  socket.on('error', (error) => {
    if (vmSockets.get(record.id) === socket) vmSockets.delete(record.id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vm-console-status', { id: record.id, state: 'error', error: String(error.message || error) });
    }
  });
  socket.on('close', () => {
    if (vmSockets.get(record.id) === socket) vmSockets.delete(record.id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vm-console-status', { id: record.id, state: 'closed' });
    }
  });
  socket.once('connect', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vm-console-status', { id: record.id, state: 'connected', port });
    }
  });
  return { connected: true, port };
});

ipcMain.handle('vm-console-write', async (_event, requested = {}) => {
  const socket = vmSockets.get(requested.id);
  if (!socket || socket.destroyed) return { written: false, error: 'The console is not connected.' };
  const bytes = requested.bytes;
  if (!bytes || typeof bytes.length !== 'number') return { written: false, error: 'No console input was provided.' };
  socket.write(Buffer.from(bytes));
  return { written: true };
});

ipcMain.handle('vm-console-disconnect', async (_event, requested = {}) => {
  closeVmConsole(requested.id);
  return { disconnected: true };
});

// Documented project links only (docs site, YouTube channel, Discord, source). The
// renderer never gets to open an arbitrary URL: anything else is refused with a reason.
const EXTERNAL_LINK_HOSTS = ['runcontainer-7.github.io', 'youtube.com', 'www.youtube.com', 'discord.gg', 'discord.com', 'github.com'];
ipcMain.handle('open-external-url', async (_event, url) => {
  let parsed = null;
  try {
    parsed = new URL(String(url || ''));
  } catch (error) {
    return { opened: false, error: 'That link is not a valid address.' };
  }
  if (parsed.protocol !== 'https:' || !EXTERNAL_LINK_HOSTS.includes(parsed.hostname)) {
    return { opened: false, error: `RunContainer only opens documented project links, not ${parsed.hostname || 'that address'}.` };
  }
  await shell.openExternal(parsed.toString());
  return { opened: true };
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
// 'auto' (VM when one is ready, containment otherwise — the default), 'rcvm',
// 'qemu', 'hyperv' (full VM), and 'appcontainer' (explicit opt-in token mode).
ipcMain.handle('set-isolation-engine', async (_event, requestedAppRecord) => {
  const { requestedIsolationEngine } = require('./engine-select');
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const requested = requestedAppRecord?.isolationEngine;
  if (requested === 'profile' || requested === 'sandboxie') {
    return { id: appRecord.id, status: 'Failed', error: 'That mode is not a security boundary and is no longer offered. Use RCVM containment (all editions), Hyper-V VM (arbitrary software), or AppContainer (compatible apps). Nothing was changed.' };
  }
  if (requested !== 'hyperv' && requested !== 'appcontainer' && requested !== 'rcvm' && requested !== 'qemu' && requested !== 'auto' && requested !== undefined) {
    return { id: appRecord.id, status: 'Failed', error: `Unknown isolation engine "${requested}". Use the QEMU VM, RCVM containment, Hyper-V VM, or AppContainer. Nothing was changed.` };
  }
  // 'auto' must stay automatic: coercing it to 'qemu' left apps pinned to a VM
  // they could no longer fall back from when no VM was available.
  const engine = requestedIsolationEngine(requested);
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
    // Stop the window watcher first, so nothing is hosted again while the app closes.
    // The hosted window itself dies with its process; moving it back to the desktop first
    // only made it flash on screen as it was being closed.
    await stopAppWindowWatcher(appRecord.id);
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
      ? { ...withTrackedPids(entry, []), status: 'Stopped', pid: null, sandboxPids: [], launchCleanupPending: false, ...(entry.setupProgram ? { setupCancelledAt: new Date().toISOString() } : {}) }
      : entry));
    saveApps(apps);
    appendLog(appLog, `App ${appRecord.id} stopped.`);
    // The window belonged to the process that was just confirmed stopped. Release it back
    // to the desktop first, then close the second RunContainer window once the release is
    // finished, so the renderer is never torn down mid-release (which left the screen blank).
    await releaseAppWindow(appRecord, trackedPids(appRecord), appLog);
    closeGuestWindow(appRecord.id);
    const updated = apps.find((entry) => entry.id === appRecord.id);
    if (updated) broadcastContainerStatus(updated);
    return { id: appRecord.id, status: 'Stopped' };
  } catch (error) {
    appendLog(appLog, `Stop failed: ${error.message}`);
    return { id: appRecord.id, status: 'Failed', error: error.message };
  }
});
