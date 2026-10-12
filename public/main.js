const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const {
  sandboxBoxName,
  findSandboxieTools,
  buildListPidsArgs,
  launchInSandboxie,
  terminateSandboxieBox,
  deleteSandboxieBox,
  parseSandboxPids,
  isWithinDirectory,
} = require('./sandboxie-runtime');
const {
  buildIsolatedEnvironment,
  buildProcessListArgs,
  buildTaskkillArgs,
  mergeStatusUpdates,
  parseProcessIds,
  resolveDownloadRedirect,
  resetLaunchState,
} = require('./isolated-launch');

let mainWindow;
const appStorePath = path.join(app.getPath('userData'), 'runcontainer-apps.json');
const sandboxMonitors = new Map();
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

function getLaunchMode(appRecord) {
  return appRecord.launchMode || (appRecord.sandboxieInitialized ? 'sandboxie' : 'isolated-profile');
}

function stopMonitor(appId) {
  const monitor = sandboxMonitors.get(appId);
  if (monitor) clearInterval(monitor);
  sandboxMonitors.delete(appId);
}

async function listProcessIdsUnder(directory) {
  if (process.platform !== 'win32') throw new Error('Process inspection requires Windows.');
  const { stdout } = await executeFile('powershell.exe', buildProcessListArgs(directory));
  return parseProcessIds(stdout);
}

async function listRunningPids(appRecord) {
  if (getLaunchMode(appRecord) === 'sandboxie') {
    const tools = resolveSandboxieTools();
    if (!tools) throw new Error('Sandboxie-Plus is not installed, so this app box cannot be inspected.');
    const { stdout } = await executeFile(tools.startExe, buildListPidsArgs(appRecord.sandboxieBox));
    const pids = parseSandboxPids(stdout);
    if (pids === null) throw new Error('Sandboxie returned an unreadable process list.');
    return pids;
  }
  return listProcessIdsUnder(appRecord.sandboxRoot || path.dirname(appRecord.source));
}

function monitorAppProcesses(appId, logPath) {
  stopMonitor(appId);
  const interval = setInterval(async () => {
    const current = getStoredApp(appId);
    if (!current || current.status !== 'Running') {
      stopMonitor(appId);
      return;
    }
    try {
      const pids = await listRunningPids(current);
      if (pids.length === 0) {
        const updated = { ...current, status: 'Stopped', pid: null, sandboxPids: [], lastExitAt: new Date().toISOString() };
        saveApps(loadApps().map((entry) => (entry.id === appId ? updated : entry)));
        appendLog(logPath, 'All processes for this app have exited.');
        stopMonitor(appId);
        broadcastContainerStatus(updated);
        return;
      }
      if (JSON.stringify(pids) !== JSON.stringify(current.sandboxPids || [])) {
        const updated = { ...current, pid: pids[0], sandboxPids: pids };
        saveApps(loadApps().map((entry) => (entry.id === appId ? updated : entry)));
        broadcastContainerStatus(updated);
      }
    } catch (error) {
      appendLog(logPath, `Unable to query process state: ${error.message}`);
    }
  }, 1500);
  sandboxMonitors.set(appId, interval);
}

async function stopProcessesUnder(directory) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pids = await listProcessIdsUnder(directory);
    if (pids.length === 0) return;
    for (const pid of pids) {
      // taskkill fails if the process already exited; the re-check below is what decides success.
      await executeFile('taskkill.exe', buildTaskkillArgs(pid)).catch(() => {});
    }
    await delay(800);
  }
  const remaining = await listProcessIdsUnder(directory);
  if (remaining.length > 0) throw new Error(`Could not stop this app’s running processes (PIDs ${remaining.join(', ')}).`);
}

async function removeSandboxDirectory(sandboxRoot) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!fs.existsSync(sandboxRoot)) return;
    try {
      fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch (error) {
      lastError = error;
    }
    if (!fs.existsSync(sandboxRoot)) return;
    await delay(700);
  }
  const code = lastError?.code || 'unknown';
  throw new Error(`Windows is still holding files in ${sandboxRoot} (${code}). Close any window from this app and try Delete again.`);
}

async function runWithSandboxie(appRecord, tools, sandboxRoot, logPath) {
  const boxName = appRecord.sandboxieBox || sandboxBoxName(appRecord.id);
  const fileRootPath = appRecord.sandboxieFileRoot || path.join(sandboxRoot, 'SandboxieFiles');
  if (!isWithinDirectory(sandboxRoot, fileRootPath)) {
    return failedLaunch(appRecord, 'The Sandboxie file root is outside this app’s managed directory; refusing to launch it.');
  }
  ensureDirectory(fileRootPath);
  try {
    const launchResult = await launchInSandboxie({
      tools,
      boxName,
      executablePath: appRecord.source,
      fileRootPath,
      execute: executeFile,
      onConfigured: async () => {
        saveApps(loadApps().map((entry) => (entry.id === appRecord.id
          ? { ...entry, sandboxieBox: boxName, sandboxieFileRoot: fileRootPath, sandboxieInitialized: true, launchMode: 'sandboxie' }
          : entry)));
      },
    });
    const base = getStoredApp(appRecord.id) || appRecord;
    const updatedApp = {
      ...base,
      sandboxieBox: boxName,
      sandboxieFileRoot: fileRootPath,
      sandboxieInitialized: true,
      launchMode: 'sandboxie',
      status: 'Running',
      pid: launchResult.pids[0],
      sandboxPids: launchResult.pids,
      lastLaunchedAt: new Date().toISOString(),
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updatedApp : entry)));
    appendLog(logPath, `Sandboxie launched app in box ${boxName}, PIDs: ${launchResult.pids.join(', ')}`);
    monitorAppProcesses(appRecord.id, logPath);
    broadcastContainerStatus(updatedApp);
    return {
      id: appRecord.id,
      status: 'Running',
      pid: updatedApp.pid,
      sandboxPids: updatedApp.sandboxPids,
      launchMode: 'sandboxie',
      embedded: false,
      reason: 'Running in a dedicated Sandboxie-Plus box (OS-level isolation).',
    };
  } catch (error) {
    appendLog(logPath, `Sandboxie launch failed: ${error.message}`);
    try {
      await deleteSandboxieBox({ tools, boxName, execute: executeFile });
    } catch (cleanupError) {
      appendLog(logPath, `Sandboxie cleanup after failed launch also failed: ${cleanupError.message}`);
    }
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id
      ? { ...entry, sandboxieInitialized: false, launchMode: 'isolated-profile', status: 'Installed', pid: null, sandboxPids: [] }
      : entry)));
    return failedLaunch(appRecord, error.message);
  }
}

async function runWithIsolatedProfile(appRecord, sandboxRoot, logPath, sandboxieFailure) {
  const layout = ensureSandboxLayout(sandboxRoot);
  const env = buildIsolatedEnvironment(process.env, sandboxRoot, layout);
  let exitInfo = null;
  try {
    const child = spawn(appRecord.source, [], {
      cwd: path.dirname(appRecord.source),
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      appendLog(logPath, `Launched process exited with code ${code}${signal ? ` (signal ${signal})` : ''}.`);
    });
    child.unref();
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    let pids = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      pids = await listProcessIdsUnder(sandboxRoot);
      if (pids.length > 0 || exitInfo) break;
      await delay(400);
    }
    if (pids.length === 0) {
      throw new Error(exitInfo
        ? `The app exited right after starting (code ${exitInfo.code}).`
        : 'The app started, but no process running from its container was found.');
    }

    const base = getStoredApp(appRecord.id) || appRecord;
    const updatedApp = {
      ...base,
      status: 'Running',
      launchMode: 'isolated-profile',
      pid: pids[0],
      sandboxPids: pids,
      lastLaunchedAt: new Date().toISOString(),
    };
    saveApps(loadApps().map((entry) => (entry.id === appRecord.id ? updatedApp : entry)));
    appendLog(logPath, `Running in RunContainer profile container, PIDs: ${pids.join(', ')}`);
    monitorAppProcesses(appRecord.id, logPath);
    broadcastContainerStatus(updatedApp);
    const fallbackNote = sandboxieFailure ? `Sandboxie-Plus could not start it (${sandboxieFailure}). ` : '';
    return {
      id: appRecord.id,
      status: 'Running',
      pid: updatedApp.pid,
      sandboxPids: pids,
      launchMode: 'isolated-profile',
      embedded: false,
      reason: `${fallbackNote}Running in RunContainer’s per-app container (its AppData and Temp are redirected into the app’s own folders). This is not an OS security boundary; install Sandboxie-Plus for OS-level isolation.`,
    };
  } catch (error) {
    appendLog(logPath, `Launch failed: ${error.message}`);
    return failedLaunch(appRecord, error.message);
  }
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
  if (!isWithinDirectory(sandboxRootBase, sandboxRoot)) {
    return failedLaunch(appRecord, 'The app container path is outside RunContainer’s managed directory; refusing to launch it.');
  }
  const validation = validateExe(appRecord.source);
  if (!validation.isValid) return failedLaunch(appRecord, validation.reason);

  const logsRoot = appRecord.logsRoot || path.join(sandboxRoot, 'logs');
  const logPath = path.join(logsRoot, `${sanitizeName(appRecord.name || 'app')}.log`);
  ensureSandboxLayout(sandboxRoot);

  const existingPids = await listRunningPids(appRecord).catch(() => []);
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
      launchMode: getLaunchMode(alreadyRunning),
      embedded: false,
      reason: 'This app is already running, so RunContainer did not start a second copy.',
    };
  }
  fs.writeFileSync(logPath, `Launch started at ${new Date().toISOString()}\n`, 'utf8');
  appendLog(logPath, `Using container ${sandboxRoot}`);
  stopMonitor(appRecord.id);

  let sandboxieFailure = null;
  const tools = resolveSandboxieTools();
  if (tools) {
    const result = await runWithSandboxie(appRecord, tools, sandboxRoot, logPath);
    if (result.status === 'Running') return result;
    sandboxieFailure = result.reason;
  }
  return runWithIsolatedProfile(appRecord, sandboxRoot, logPath, sandboxieFailure);
});

ipcMain.handle('reset-container', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) {
    return { id: requestedAppRecord?.id, status: 'Failed', removed: false, error: 'App is not in RunContainer’s persistent app list.' };
  }

  const sandboxRoot = appRecord.sandboxRoot;
  if (!sandboxRoot || !isWithinDirectory(sandboxRootBase, sandboxRoot)) {
    return { id: appRecord.id, status: 'Failed', removed: false, error: 'Refusing to delete a path outside RunContainer’s managed directory.' };
  }

  try {
    stopMonitor(appRecord.id);
    await stopProcessesUnder(sandboxRoot);
    if (appRecord.sandboxieBox && appRecord.sandboxieInitialized) {
      const tools = resolveSandboxieTools();
      if (tools) await deleteSandboxieBox({ tools, boxName: appRecord.sandboxieBox, execute: executeFile });
    }
    await removeSandboxDirectory(sandboxRoot);

    const remainingApps = removeAppRecord(appRecord);
    if (loadApps().some((entry) => entry.id === appRecord.id)) {
      throw new Error('App record remains in RunContainer’s persistent store after deletion.');
    }
    return { id: appRecord.id, status: 'Reset', removed: true, remainingCount: remainingApps.length };
  } catch (error) {
    appendLog(path.join(app.getPath('userData'), 'runcontainer-error.log'), `Delete failed for ${appRecord.name || appRecord.id}: ${error.message}`);
    return { id: appRecord.id, status: 'Failed', removed: false, error: error.message };
  }
});

ipcMain.handle('kill-exe', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) return { id: requestedAppRecord?.id, status: 'Failed', error: 'App is not in RunContainer’s persistent app list.' };
  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source);
  const appLog = path.join(appRecord.logsRoot || path.join(sandboxRoot, 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
  try {
    stopMonitor(appRecord.id);
    if (getLaunchMode(appRecord) === 'sandboxie') {
      const tools = resolveSandboxieTools();
      if (tools) await terminateSandboxieBox({ tools, boxName: appRecord.sandboxieBox, execute: executeFile });
    }
    await stopProcessesUnder(sandboxRoot);
    const apps = loadApps().map((entry) => (entry.id === appRecord.id ? { ...entry, status: 'Stopped', pid: null, sandboxPids: [] } : entry));
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
