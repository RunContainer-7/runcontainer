const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
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

let mainWindow;
const appStorePath = path.join(app.getPath('userData'), 'runcontainer-apps.json');
const sandboxMonitors = new Map();
const sandboxRootBase = path.join(app.getPath('userData'), 'sandboxes');

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

function downloadUrl(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(url, (response) => {
      if (response.statusCode >= 400) {
        response.destroy();
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
    }).on('error', (error) => {
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

async function monitorSandboxedContainer(appRecord, tools, boxName, logsRoot) {
  const prior = sandboxMonitors.get(appRecord.id);
  if (prior) clearInterval(prior);
  const interval = setInterval(async () => {
    try {
      const { stdout } = await executeFile(tools.startExe, buildListPidsArgs(boxName));
      const pids = parseSandboxPids(stdout);
      if (pids === null) {
        appendLog(path.join(logsRoot, `${sanitizeName(appRecord.name)}.log`), 'Sandboxie returned an invalid process list; keeping the running state until it can be confirmed.');
        return;
      }
      const apps = loadApps();
      const current = apps.find((entry) => entry.id === appRecord.id);
      if (!current || current.status !== 'Running') {
        clearInterval(interval);
        sandboxMonitors.delete(appRecord.id);
        return;
      }
      if (pids.length === 0) {
        const updated = { ...current, status: 'Stopped', pid: null, sandboxPids: [], lastExitAt: new Date().toISOString() };
        saveApps(apps.map((entry) => entry.id === appRecord.id ? updated : entry));
        appendLog(path.join(logsRoot, `${sanitizeName(appRecord.name)}.log`), 'Sandboxie reports all processes in this app box have exited.');
        clearInterval(interval);
        sandboxMonitors.delete(appRecord.id);
        broadcastContainerStatus(updated);
        return;
      }
      if (JSON.stringify(pids) !== JSON.stringify(current.sandboxPids || [])) {
        const updated = { ...current, pid: pids[0], sandboxPids: pids };
        saveApps(apps.map((entry) => entry.id === appRecord.id ? updated : entry));
        broadcastContainerStatus(updated);
      }
    } catch (error) {
      appendLog(path.join(logsRoot, `${sanitizeName(appRecord.name)}.log`), `Unable to query Sandboxie process state: ${error.message}`);
    }
  }, 1500);
  sandboxMonitors.set(appRecord.id, interval);
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
  const apps = loadApps();
  const tools = resolveSandboxieTools();
  if (!tools) return apps;
  let changed = false;
  const refreshed = await Promise.all(apps.map(async (entry) => {
    if (entry.status !== 'Running' || !entry.sandboxieBox) return entry;
    try {
      const { stdout } = await executeFile(tools.startExe, buildListPidsArgs(entry.sandboxieBox));
      const pids = parseSandboxPids(stdout);
      if (pids && pids.length === 0) {
        changed = true;
        const monitor = sandboxMonitors.get(entry.id);
        if (monitor) clearInterval(monitor);
        sandboxMonitors.delete(entry.id);
        return { ...entry, status: 'Stopped', pid: null, sandboxPids: [], lastExitAt: new Date().toISOString() };
      }
      if (pids && JSON.stringify(pids) !== JSON.stringify(entry.sandboxPids || [])) {
        changed = true;
        return { ...entry, pid: pids[0], sandboxPids: pids };
      }
    } catch (error) {
      // Keep the persisted state if Sandboxie is temporarily unavailable; logs capture details when actively monitored.
    }
    return entry;
  }));
  if (changed) saveApps(refreshed);
  return refreshed;
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

ipcMain.handle('update-permissions', async (_event, appRecord, permissions) => {
  const apps = loadApps().map((entry) => (entry.id === appRecord?.id ? { ...entry, permissions } : entry));
  saveApps(apps);
  return apps.find((entry) => entry.id === appRecord?.id) || appRecord;
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
    status: 'Installed',
    pid: null,
    sandboxPids: [],
    createdAt: new Date().toISOString(),
  };
  saveApps([...loadApps(), duplicate]);
  return duplicate;
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
    return { id: appRecord?.id, status: 'Failed', embedded: false, error: 'Installed app record is missing its id or executable path.' };
  }

  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source);
  if (!isWithinDirectory(sandboxRootBase, sandboxRoot)) {
    return { id: appRecord.id, status: 'Failed', error: 'The app sandbox path is outside RunContainer’s managed sandbox directory; refusing to launch it.', embedded: false };
  }
  const executableValidation = validateExe(appRecord.source);
  if (!executableValidation.isValid) {
    return { id: appRecord.id, status: 'Failed', error: executableValidation.reason, embedded: false };
  }
  const runtimeRoot = appRecord.runtimeRoot || path.join(sandboxRoot, 'runtime');
  const appDataRoot = appRecord.appDataRoot || path.join(sandboxRoot, 'AppData');
  const tempRoot = appRecord.tempRoot || path.join(sandboxRoot, 'Temp');
  const logsRoot = appRecord.logsRoot || path.join(sandboxRoot, 'logs');
  const logPath = path.join(logsRoot, `${sanitizeName(appRecord.name || 'app')}.log`);

  ensureDirectory(runtimeRoot);
  ensureDirectory(appDataRoot);
  ensureDirectory(tempRoot);
  ensureDirectory(logsRoot);
  fs.writeFileSync(logPath, `Launch started at ${new Date().toISOString()}\n`, 'utf8');
  appendLog(logPath, `Using sandbox root ${sandboxRoot}`);

  const tools = resolveSandboxieTools();
  if (!tools) {
    const reason = 'Sandboxie-Plus is required to run apps in an OS-managed sandbox. Install Sandboxie-Plus, or set RUNCONTAINER_SANDBOXIE_DIR to its folder containing Start.exe and SbieIni.exe.';
    appendLog(logPath, reason);
    return { id: appRecord.id, status: 'Failed', error: reason, reason, embedded: false };
  }
  const boxName = appRecord.sandboxieBox || sandboxBoxName(appRecord.id);
  const fileRootPath = appRecord.sandboxieFileRoot || path.join(sandboxRoot, 'SandboxieFiles');
  if (!isWithinDirectory(sandboxRoot, fileRootPath)) {
    const reason = 'The Sandboxie file root is outside this app’s managed directory; refusing to launch it.';
    appendLog(logPath, reason);
    return { id: appRecord.id, status: 'Failed', error: reason, reason, embedded: false };
  }
  ensureDirectory(fileRootPath);
  let boxConfigurationAttempted = true;
  try {
    const launchResult = await launchInSandboxie({
      tools,
      boxName,
      executablePath: appRecord.source,
      fileRootPath,
      execute: executeFile,
      onConfigured: async () => {
        const configuredRecord = { ...appRecord, sandboxieBox: boxName, sandboxieFileRoot: fileRootPath, sandboxieInitialized: true };
        saveApps(loadApps().map((entry) => entry.id === appRecord.id ? configuredRecord : entry));
      },
    });
    const updatedApp = {
      ...appRecord,
      sandboxieBox: boxName,
      sandboxieFileRoot: fileRootPath,
      sandboxieInitialized: true,
      status: 'Running',
      pid: launchResult.pids[0],
      sandboxPids: launchResult.pids,
      lastLaunchedAt: new Date().toISOString(),
    };
    saveApps(loadApps().map((entry) => entry.id === appRecord.id ? updatedApp : entry));
    appendLog(logPath, `Sandboxie launched app in box ${boxName}, PIDs: ${launchResult.pids.join(', ')}`);
    await monitorSandboxedContainer(updatedApp, tools, boxName, logsRoot);
    broadcastContainerStatus(updatedApp);
    return {
      id: updatedApp.id,
      status: 'Running',
      pid: updatedApp.pid,
      sandboxPids: updatedApp.sandboxPids,
      sandboxieBox: boxName,
      embedded: false,
      reason: 'Running in a dedicated Sandboxie-Plus box. The app uses its own Windows window; generic in-window embedding is not supported.',
    };
  } catch (error) {
    appendLog(logPath, `Sandboxie launch failed: ${error.message}`);
    if (boxConfigurationAttempted) {
      let cleanupSucceeded = false;
      try {
        await deleteSandboxieBox({ tools, boxName, execute: executeFile });
        cleanupSucceeded = true;
      } catch (cleanupError) {
        appendLog(logPath, `Sandboxie cleanup after failed launch also failed: ${cleanupError.message}`);
      }
      saveApps(loadApps().map((entry) => entry.id === appRecord.id
        ? { ...entry, sandboxieInitialized: !cleanupSucceeded, status: 'Installed', pid: null, sandboxPids: [] }
        : entry));
    }
    return { id: appRecord.id, status: 'Failed', error: error.message, reason: error.message, embedded: false };
  }
});

ipcMain.handle('launch-desktop', async () => ({
  status: 'Failed',
  error: 'Direct desktop launch is disabled so RunContainer does not bypass its isolation engine.',
  reason: 'Direct desktop launch is disabled so RunContainer does not bypass its isolation engine.',
  embedded: false,
}));

ipcMain.handle('reset-container', async (_event, requestedAppRecord) => {
  const appRecord = getStoredApp(requestedAppRecord?.id);
  if (!appRecord?.id) {
    return { id: requestedAppRecord?.id, status: 'Failed', removed: false, error: 'App is not in RunContainer’s persistent app list.' };
  }

  const sandboxRoot = appRecord.sandboxRoot;
  if (!sandboxRoot) {
    return { id: appRecord.id, status: 'Failed', removed: false, error: 'The app has no managed sandbox path; refusing to report deletion.' };
  }
  if (!isWithinDirectory(sandboxRootBase, sandboxRoot)) {
    return { id: appRecord.id, status: 'Failed', removed: false, error: 'Refusing to delete a path outside RunContainer’s managed sandbox directory.' };
  }

  try {
    if (appRecord.sandboxieBox && appRecord.sandboxieInitialized) {
      const tools = resolveSandboxieTools();
      if (!tools) throw new Error('Sandboxie-Plus is required to stop and remove this app’s sandbox.');
      await deleteSandboxieBox({ tools, boxName: appRecord.sandboxieBox, execute: executeFile });
    } else if (appRecord.pid) {
      if (process.platform === 'win32') {
        await executeFile('taskkill.exe', ['/PID', String(appRecord.pid), '/T', '/F']);
      } else {
        try { process.kill(appRecord.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }

    const monitor = sandboxMonitors.get(appRecord.id);
    if (monitor) clearInterval(monitor);
    sandboxMonitors.delete(appRecord.id);

    if (sandboxRoot && fs.existsSync(sandboxRoot)) {
      fs.rmSync(sandboxRoot, { recursive: true, force: false, maxRetries: 3, retryDelay: 250 });
    }
    if (sandboxRoot && fs.existsSync(sandboxRoot)) {
      throw new Error(`Sandbox files remain after deletion: ${sandboxRoot}`);
    }

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
  const appLog = path.join(appRecord.logsRoot || app.getPath('userData'), `${sanitizeName(appRecord.name || 'app')}.log`);
  try {
    if (appRecord.sandboxieBox && appRecord.sandboxieInitialized) {
      const tools = resolveSandboxieTools();
      if (!tools) throw new Error('Sandboxie-Plus is required to stop this app’s sandbox.');
      await terminateSandboxieBox({ tools, boxName: appRecord.sandboxieBox, execute: executeFile });
    } else if (appRecord.pid) {
      if (process.platform === 'win32') {
        await executeFile('taskkill.exe', ['/PID', String(appRecord.pid), '/T', '/F']);
      } else {
        try { process.kill(appRecord.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    const monitor = sandboxMonitors.get(appRecord.id);
    if (monitor) clearInterval(monitor);
    sandboxMonitors.delete(appRecord.id);
    const apps = loadApps().map((entry) => entry.id === appRecord.id ? { ...entry, status: 'Stopped', pid: null, sandboxPids: [] } : entry);
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
