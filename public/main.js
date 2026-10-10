const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const https = require('https');

let mainWindow;
const appStorePath = path.join(app.getPath('userData'), 'runcontainer-apps.json');
const sessionHosts = new Map();

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

function removeAppRecord(appRecord) {
  const apps = loadApps();
  const remainingApps = apps.filter((entry) => {
    if (appRecord?.id && entry.id && entry.id === appRecord.id) return false;
    if (appRecord?.source && entry.source && entry.source === appRecord.source) return false;
    if (appRecord?.sandboxRoot && entry.sandboxRoot && entry.sandboxRoot === appRecord.sandboxRoot) return false;
    if (!appRecord?.id && appRecord?.name && entry.name && entry.name === appRecord.name) return false;
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

function getSandboxEnvironment(sandboxRoot, appDataRoot, tempRoot, runtimeRoot) {
  const desktopRoot = path.join(sandboxRoot, 'Desktop');
  const documentsRoot = path.join(sandboxRoot, 'Documents');
  const downloadsRoot = path.join(sandboxRoot, 'Downloads');
  const picturesRoot = path.join(sandboxRoot, 'Pictures');
  const musicRoot = path.join(sandboxRoot, 'Music');
  const videosRoot = path.join(sandboxRoot, 'Videos');
  const programFilesRoot = path.join(sandboxRoot, 'Program Files');
  const programDataRoot = path.join(sandboxRoot, 'ProgramData');

  return {
    ...process.env,
    APPDATA: appDataRoot,
    LOCALAPPDATA: appDataRoot,
    USERPROFILE: sandboxRoot,
    HOME: sandboxRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    DESKTOP: desktopRoot,
    Desktop: desktopRoot,
    DOCUMENTS: documentsRoot,
    Documents: documentsRoot,
    DOWNLOADS: downloadsRoot,
    Downloads: downloadsRoot,
    PICTURES: picturesRoot,
    Pictures: picturesRoot,
    MUSIC: musicRoot,
    Music: musicRoot,
    VIDEOS: videosRoot,
    Videos: videosRoot,
    PROGRAMFILES: programFilesRoot,
    ProgramFiles: programFilesRoot,
    PROGRAMDATA: programDataRoot,
    ProgramData: programDataRoot,
    PUBLIC: path.join(sandboxRoot, 'Public'),
    Public: path.join(sandboxRoot, 'Public'),
    HOMEDRIVE: process.env.HOMEDRIVE || 'C:',
    HOMEPATH: path.join(path.sep, 'Users', sanitizeName(path.basename(sandboxRoot)) || 'RunContainerSandbox'),
    RUNCONTAINER_SANDBOX_ROOT: sandboxRoot,
    RUNCONTAINER_RUNTIME_ROOT: runtimeRoot,
    RUNCONTAINER_APPDATA_ROOT: appDataRoot,
  };
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

  const buffer = fs.readFileSync(exePath);
  const signature = buffer.toString('hex', 0, 2);
  if (signature !== '4d5a') {
    return { isValid: false, reason: 'The file is not a valid Windows executable.' };
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

function getParentWindowHandle(targetWindow) {
  const windowRef = targetWindow || mainWindow;
  if (!windowRef || windowRef.isDestroyed()) {
    return null;
  }

  try {
    const handle = windowRef.getNativeWindowHandle();
    if (!handle || handle.length === 0) {
      return null;
    }

    if (handle.length >= 8) {
      return `0x${handle.readBigUInt64LE(0).toString(16)}`;
    }

    return `0x${handle.readUInt32LE(0).toString(16)}`;
  } catch (error) {
    return null;
  }
}

function ensureSessionHost(appRecord) {
  const existing = sessionHosts.get(appRecord.id);
  if (existing && !existing.isDestroyed()) {
    return existing;
  }

  const hostWindow = new BrowserWindow({
    parent: mainWindow || undefined,
    width: 960,
    height: 640,
    show: true,
    frame: true,
    titleBarStyle: 'default',
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    title: `RunContainer · ${appRecord.name}`,
    backgroundColor: '#020617',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
  });

  hostWindow.setMenuBarVisibility(false);
  hostWindow.setSkipTaskbar(false);
  hostWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <html>
      <body style="margin:0;background:#020617;color:#f8fafc;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="text-align:center;padding:24px;border:1px solid rgba(96,165,250,0.2);border-radius:18px;background:rgba(2,6,23,0.95);box-shadow:0 16px 42px rgba(0,0,0,0.28);">
          <div style="font-size:46px;margin-bottom:10px;">▣</div>
          <div style="font-size:16px;font-weight:700;">${appRecord.name}</div>
          <div style="margin-top:8px;color:#94a3b8;font-size:13px;">Launching inside RunContainer…</div>
        </div>
      </body>
    </html>
  `));

  hostWindow.on('closed', () => {
    sessionHosts.delete(appRecord.id);
  });

  sessionHosts.set(appRecord.id, hostWindow);
  return hostWindow;
}

function closeSessionHost(appRecord) {
  const existing = sessionHosts.get(appRecord?.id);
  if (existing && !existing.isDestroyed()) {
    existing.close();
  }
  sessionHosts.delete(appRecord?.id);
}

function promptDesktopFallback(appRecord, parentWindow) {
  return new Promise((resolve) => {
    const preferredParent = parentWindow && !parentWindow.isDestroyed() ? parentWindow : mainWindow;
    if (!preferredParent || preferredParent.isDestroyed()) {
      resolve(false);
      return;
    }

    const scriptPath = path.join(__dirname, 'show-windows-fallback.ps1');
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Title',
      'RunContainer',
      '-Message',
      `${appRecord.name} did not appear inside the sandbox after 5 seconds.`,
      '-Detail',
      'Would you like to launch it on the desktop instead?',
    ];

    execFile('powershell.exe', args, { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }

      const response = String(stdout || '').trim().toUpperCase();
      resolve(response === 'YES');
    });
  });
}

function launchSandboxedProcess(appRecord, sandboxRoot, runtimeRoot, appDataRoot, tempRoot, logsRoot, hostWindow) {
  const executablePath = appRecord.source;
  const launchEnv = getSandboxEnvironment(sandboxRoot, appDataRoot, tempRoot, runtimeRoot);
  const logPath = path.join(logsRoot, `${sanitizeName(appRecord.name || 'app')}.log`);
  const launcherScriptPath = path.join(__dirname, 'launch-sandboxed.ps1');
  const parentHwnd = getParentWindowHandle(hostWindow);

  return new Promise((resolve) => {
    try {
      const commandArgs = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        launcherScriptPath,
        '-ExePath',
        executablePath,
        '-SandboxRoot',
        sandboxRoot,
        '-RuntimeRoot',
        runtimeRoot,
        '-AppDataRoot',
        appDataRoot,
        '-TempRoot',
        tempRoot,
        '-LogsRoot',
        logsRoot,
      ];

      if (parentHwnd) {
        commandArgs.push('-ParentHwnd', parentHwnd);
      }

      execFile('powershell.exe', commandArgs, { windowsHide: true }, (error, stdout, stderr) => {
        appendLog(logPath, `PowerShell launcher exited with error=${Boolean(error)} stderr=${(stderr || '').slice(0, 400)}`);

        if (error) {
          resolve({
            pid: null,
            embedded: false,
            needsDesktopChoice: true,
            error: error.message,
            reason: 'RunContainer could not start this app with the Windows sandbox launcher.',
          });
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({
            pid: parsed.pid || null,
            embedded: Boolean(parsed.embedded),
            needsDesktopChoice: Boolean(parsed.needsDesktopChoice),
            promptDesktopFallback: Boolean(parsed.needsDesktopChoice),
            reason: parsed.reason || 'The sandbox launcher completed.',
            name: parsed.name || null,
          });
        } catch (parseError) {
          resolve({
            pid: null,
            embedded: false,
            needsDesktopChoice: true,
            error: parseError.message,
            reason: 'RunContainer could not parse the sandbox launcher response.',
          });
        }
      });
    } catch (error) {
      appendLog(logPath, `Sandbox launcher failed: ${error.message}`);
      resolve({
        pid: null,
        embedded: false,
        needsDesktopChoice: true,
        error: error.message,
        reason: 'RunContainer could not start this app from the sandbox.',
      });
    }
  });
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

ipcMain.handle('list-apps', async () => loadApps());

ipcMain.handle('install-exe', async (_event, exePath) => {
  const validation = validateExe(exePath);
  if (!validation.isValid) {
    throw new Error(validation.reason);
  }

  const baseName = sanitizeName(path.basename(exePath, path.extname(exePath)));
  const sandboxRoot = path.join(app.getPath('userData'), 'sandboxes', baseName);
  const sandboxLayout = ensureSandboxLayout(sandboxRoot);
  const runtimeRoot = sandboxLayout.runtime;
  const appDataRoot = sandboxLayout.appData;
  const tempRoot = sandboxLayout.temp;
  const logsRoot = sandboxLayout.logs;

  const destination = path.join(sandboxRoot, path.basename(exePath));
  fs.copyFileSync(exePath, destination);

  const metadata = await getExeMetadata(exePath);
  const iconPath = path.join(sandboxRoot, 'icon.ico');
  const extractedIcon = await extractExeIcon(exePath, iconPath);

  const profile = getSandboxProfile('default');
  const record = {
    id: `${Date.now()}`,
    name: metadata.title || baseName,
    status: 'Installed',
    source: destination,
    sandboxRoot,
    runtimeRoot,
    appDataRoot,
    tempRoot,
    logsRoot,
    desktopRoot: sandboxLayout.desktop,
    documentsRoot: sandboxLayout.documents,
    downloadsRoot: sandboxLayout.downloads,
    programFilesRoot: sandboxLayout.programFiles,
    programDataRoot: sandboxLayout.programData,
    metadata,
    iconPath: extractedIcon || null,
    permissions: {
      network: profile.network,
      filesystem: profile.filesystem,
      registry: profile.registry,
    },
    profile: 'default',
    sandboxConfig: profile,
    createdAt: new Date().toISOString(),
  };

  const apps = loadApps();
  apps.push(record);
  saveApps(apps);
  return record;
});

ipcMain.handle('import-url', async (_event, url) => {
  if (!url || typeof url !== 'string') {
    throw new Error('A valid URL is required.');
  }

  const parsedUrl = new URL(url);
  const fileName = sanitizeName(path.basename(parsedUrl.pathname) || 'downloaded-app.exe');
  const downloadsRoot = path.join(app.getPath('userData'), 'downloads');
  ensureDirectory(downloadsRoot);
  const outputPath = path.join(downloadsRoot, `${fileName}.exe`);
  const downloadedPath = await downloadUrl(parsedUrl.toString(), outputPath);

  return ipcMain.handle('install-exe', null, downloadedPath);
});

ipcMain.handle('update-permissions', async (_event, appRecord, permissions) => {
  const apps = loadApps().map((entry) => (entry.id === appRecord?.id ? { ...entry, permissions } : entry));
  saveApps(apps);
  return apps.find((entry) => entry.id === appRecord?.id) || appRecord;
});

ipcMain.handle('duplicate-container', async (_event, appRecord) => {
  const apps = loadApps();
  const duplicate = {
    ...appRecord,
    id: `${Date.now()}`,
    name: `${appRecord.name} Copy`,
    status: 'Installed',
    createdAt: new Date().toISOString(),
  };
  apps.push(duplicate);
  saveApps(apps);
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

async function launchAppOnDesktop(appRecord) {
  const executablePath = appRecord?.source;
  if (!executablePath) return null;

  const child = spawn(executablePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(executablePath),
    env: process.env,
    shell: true,
  });
  child.unref();
  return { pid: child.pid, embedded: false, reason: 'Opened directly on the desktop because the app could not be embedded into RunContainer.' };
}

ipcMain.handle('run-exe', async (_event, appRecord) => {
  if (!appRecord?.source) return null;

  const sandboxRoot = appRecord.sandboxRoot || path.dirname(appRecord.source);
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

  const hostWindow = ensureSessionHost(appRecord);
  const launchResult = await launchSandboxedProcess(appRecord, sandboxRoot, runtimeRoot, appDataRoot, tempRoot, logsRoot, hostWindow);
  appendLog(logPath, `Process launched with pid ${launchResult.pid}${launchResult.embedded ? ' (embedded into RunContainer)' : ''}`);
  appendLog(logPath, `Launch outcome: embedded=${Boolean(launchResult.embedded)} needsDesktopChoice=${Boolean(launchResult.needsDesktopChoice)} reason=${launchResult.reason || 'none'}`);

  if (launchResult.promptDesktopFallback) {
    const shouldUseDesktop = await promptDesktopFallback(appRecord, hostWindow);
    if (shouldUseDesktop) {
      const desktopLaunchResult = await launchAppOnDesktop(appRecord);
      closeSessionHost(appRecord);
      const apps = loadApps().map((entry) => (entry.id === appRecord.id ? { ...entry, status: 'Running', pid: desktopLaunchResult?.pid || null, lastLaunchedAt: new Date().toISOString() } : entry));
      saveApps(apps);
      return {
        id: appRecord.id,
        status: 'Running',
        pid: desktopLaunchResult?.pid || null,
        embedded: false,
        reason: desktopLaunchResult?.reason || 'Opened on the desktop instead.',
      };
    }
  }

  if (launchResult.needsDesktopChoice || (!launchResult.embedded && launchResult.reason && launchResult.reason.toLowerCase().includes('embed'))) {
    return {
      id: appRecord.id,
      status: 'NeedsDesktopChoice',
      embedded: false,
      pid: launchResult.pid,
      needsDesktopChoice: true,
      reason: launchResult.reason || 'RunContainer could not embed this app into its host surface.',
    };
  }

  const apps = loadApps().map((entry) => (entry.id === appRecord.id ? { ...entry, status: 'Running', pid: launchResult.pid, lastLaunchedAt: new Date().toISOString() } : entry));
  saveApps(apps);

  if (launchResult.error) {
    return {
      id: appRecord.id,
      status: 'Failed',
      error: launchResult.error,
      embedded: false,
    };
  }

  if (!launchResult.embedded) {
    return {
      id: appRecord.id,
      status: 'Running',
      pid: launchResult.pid,
      embedded: false,
      reason: launchResult.reason || 'The app launched from the sandbox and will run normally.',
    };
  }

  return {
    id: appRecord.id,
    status: 'Running',
    pid: launchResult.pid,
    embedded: true,
  };
});

ipcMain.handle('launch-desktop', async (_event, appRecord) => {
  const desktopLaunchResult = await launchAppOnDesktop(appRecord);
  closeSessionHost(appRecord);
  const apps = loadApps().map((entry) => (entry.id === appRecord.id ? { ...entry, status: 'Running', pid: desktopLaunchResult?.pid || null, lastLaunchedAt: new Date().toISOString() } : entry));
  saveApps(apps);
  return {
    id: appRecord.id,
    status: 'Running',
    pid: desktopLaunchResult?.pid || null,
    embedded: false,
    reason: desktopLaunchResult?.reason || 'Opened on the desktop instead.',
  };
});

ipcMain.handle('reset-container', async (_event, appRecord) => {
  try {
    const appId = appRecord?.id;
    const sandboxRoot = appRecord?.sandboxRoot;
    if (sandboxRoot && fs.existsSync(sandboxRoot)) {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }

    const remainingApps = removeAppRecord(appRecord);

    const logPath = path.join(appRecord?.logsRoot || path.join(appRecord?.sandboxRoot || path.dirname(appRecord?.source || ''), 'logs'), `${sanitizeName(appRecord?.name || 'app')}.log`);
    if (logPath) {
      try {
        appendLog(logPath, `Container removed from RunContainer.`);
      } catch (_error) {
        // ignore log cleanup failures
      }
    }

    if (appRecord?.id) {
      sessionHosts.delete(appRecord.id);
    }

    return { id: appId, status: 'Reset', removed: true, remainingCount: remainingApps.length };
  } catch (error) {
    return { id: appRecord?.id, status: 'Reset', removed: true, error: error.message };
  }
});

ipcMain.handle('kill-exe', async (_event, appRecord) => {
  if (!appRecord?.pid) {
    const apps = loadApps().map((entry) => (entry.id === appRecord?.id ? { ...entry, status: 'Stopped', pid: null } : entry));
    saveApps(apps);
    return { id: appRecord?.id, status: 'Stopped' };
  }

  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(appRecord.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.unref();
    } else {
      process.kill(appRecord.pid);
    }
  } catch (error) {
    // ignore termination failures and still update the UI
  }

  const logPath = path.join(appRecord.logsRoot || path.join(appRecord.sandboxRoot || path.dirname(appRecord.source), 'logs'), `${sanitizeName(appRecord.name || 'app')}.log`);
  appendLog(logPath, `Process ${appRecord.pid} terminated`);

  const sessionHost = sessionHosts.get(appRecord?.id);
  if (sessionHost && !sessionHost.isDestroyed()) {
    sessionHost.close();
  }
  sessionHosts.delete(appRecord?.id);

  const apps = loadApps().map((entry) => (entry.id === appRecord?.id ? { ...entry, status: 'Stopped', pid: null } : entry));
  saveApps(apps);
  return { id: appRecord?.id, status: 'Stopped' };
});
