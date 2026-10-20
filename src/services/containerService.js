const electronModule = typeof window !== 'undefined' && window.require
  ? window.require('electron')
  : typeof require === 'function'
    ? require('electron')
    : null;

const ipcRenderer = electronModule?.ipcRenderer || null;

if (ipcRenderer && !window.electron) {
  window.electron = {
    openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  };
}

function createContainerRecord(source, status = 'Installed') {
  const name =
    typeof source === 'string'
      ? source.split(/[\\/]/).pop() || source
      : source?.name || 'Unknown app';

  return {
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name,
    status,
    source: typeof source === 'string' ? source : source?.name || 'unknown',
  };
}

function requireIpc(operation) {
  if (!ipcRenderer) {
    throw new Error(`${operation} is available only in the RunContainer desktop app.`);
  }
  return ipcRenderer;
}

export async function installContainer(exePathOrFile) {
  const ipc = requireIpc('Installing apps');
  const exePath = typeof exePathOrFile === 'string' ? exePathOrFile : exePathOrFile?.path || exePathOrFile?.name;
  const record = await ipc.invoke('install-exe', exePath);
  return record;
}

export async function importFromUrl(url) {
  return requireIpc('Importing apps').invoke('import-url', url);
}

export async function resetContainer(container) {
  return requireIpc('Deleting apps').invoke('reset-container', container);
}

export async function duplicateContainer(container) {
  return requireIpc('Duplicating apps').invoke('duplicate-container', container);
}

export async function exportContainer(container) {
  return requireIpc('Exporting apps').invoke('export-container', container);
}

export async function getAppLogs(container) {
  return requireIpc('Reading app logs').invoke('get-app-logs', container);
}

export async function runContainer(container) {
  return requireIpc('Running apps').invoke('run-exe', container);
}

export async function killContainer(container) {
  return requireIpc('Stopping apps').invoke('kill-exe', container);
}

export async function cancelDeleteContainer(container) {
  return requireIpc('Cancelling deletion').invoke('cancel-delete', container);
}

export async function setIsolationEngine(container) {
  return requireIpc('Changing the isolation engine').invoke('set-isolation-engine', container);
}

export async function runInstallerInEnvironment(container, installerPath, options = {}) {
  return requireIpc('Running installers').invoke('install-in-environment', container, installerPath, options);
}

export async function getHyperVStatus() {
  return requireIpc('Checking Hyper-V').invoke('hyperv-status');
}

export async function provisionGuestCredential() {
  return requireIpc('Provisioning guest credential').invoke('hyperv-provision-credential');
}

export async function setAppConfig(container) {
  return requireIpc('Changing app tweaks').invoke('set-app-config', container);
}

export async function setAppProfile(container) {
  return requireIpc('Changing app profile').invoke('set-app-profile', container);
}

export async function resetEnvironment(container) {
  return requireIpc('Resetting environments').invoke('reset-environment', container);
}

export async function openGuestDisplay(container) {
  return requireIpc('Opening guest display').invoke('open-guest-display', container);
}

export async function setWindowHosting(container) {
  return requireIpc('Changing window hosting').invoke('set-window-hosting', container);
}

export async function getAppVersion() {
  if (!ipcRenderer) return null;
  try {
    const result = await ipcRenderer.invoke('get-app-version');
    return result?.version || null;
  } catch (error) {
    return null;
  }
}

export async function checkAppUpdates(options = {}) {
  if (!ipcRenderer) return { status: 'unavailable' };
  try {
    return await ipcRenderer.invoke('check-app-updates', options);
  } catch (error) {
    return { status: 'unavailable' };
  }
}

export async function snoozeUpdate({ version, untilMs } = {}) {
  if (!ipcRenderer) return { snoozed: false };
  try {
    return await ipcRenderer.invoke('snooze-update', { version, untilMs });
  } catch (error) {
    return { snoozed: false };
  }
}

export async function downloadUpdate() {
  return requireIpc('Downloading updates').invoke('download-update');
}

export function cancelUpdateDownload() {
  if (!ipcRenderer) return;
  try {
    ipcRenderer.send('cancel-download-update');
  } catch (error) {
    // Download already finished: nothing to cancel.
  }
}

export async function getUpdateState() {
  if (!ipcRenderer) return { check: null, downloaded: false };
  try {
    return await ipcRenderer.invoke('get-update-state');
  } catch (error) {
    return { check: null, downloaded: false };
  }
}

export async function installDownloadedUpdate() {
  return requireIpc('Installing updates').invoke('install-downloaded-update');
}

export function onUpdateDownloadProgress(callback) {
  if (!ipcRenderer) return () => {};
  const listener = (_event, progress) => callback(progress);
  ipcRenderer.on('update-download-progress', listener);
  return () => ipcRenderer.removeListener('update-download-progress', listener);
}

export async function getQemuStatus() {
  return requireIpc('Checking QEMU').invoke('qemu-status');
}

export async function detectQemu() {
  return requireIpc('Checking QEMU').invoke('qemu-detect');
}

export async function browseQemuBase() {
  return requireIpc('Selecting base images').invoke('qemu-browse-base');
}

export async function setQemuBase(imagePath) {
  return requireIpc('Selecting base images').invoke('qemu-set-base', imagePath);
}

export async function createQemuProvisionDisk({ sizeGB } = {}) {
  return requireIpc('Provisioning base images').invoke('qemu-provision-create', { sizeGB });
}

export async function bootQemuProvision({ isoPath } = {}) {
  return requireIpc('Provisioning base images').invoke('qemu-provision-boot', { isoPath });
}

export async function setGuestExePath(container) {
  return requireIpc('Setting guest paths').invoke('qemu-set-guest-exe', container);
}

export async function openUpdateLink(which) {
  return requireIpc('Opening update links').invoke('open-update-link', which);
}

export async function stopContainer(container) {
  return killContainer(container);
}

export function onContainerStatus(callback) {
  if (!ipcRenderer) return () => {};
  const listener = (_event, record) => callback(record);
  ipcRenderer.on('container:status', listener);
  return () => ipcRenderer.removeListener('container:status', listener);
}

export async function listContainers() {
  if (!ipcRenderer) return [];
  return ipcRenderer.invoke('list-apps');
}