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

// A JIT run: the app is started immediately, with the chosen runtime strategy applied
// on the way in (see the jitRun handling in public/main.js runApp).
export async function runContainerWithJit(container) {
  return requireIpc('Running apps with JIT').invoke('run-exe', { ...container, jitRun: true });
}

// One-time, app-wide state for this installation (for example whether the beginner
// introduction has already been shown).
export async function getPreferences() {
  if (!ipcRenderer) return {};
  try {
    return await ipcRenderer.invoke('get-preferences');
  } catch (error) {
    return {};
  }
}

export async function setPreference(patch = {}) {
  if (!ipcRenderer) return {};
  try {
    return await ipcRenderer.invoke('set-preference', patch);
  } catch (error) {
    return {};
  }
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

export async function checkForUpdate() {
  if (!ipcRenderer) return null;
  try {
    return await ipcRenderer.invoke('check-for-update');
  } catch (_error) {
    return null;
  }
}

export async function getPerformance() {
  if (!ipcRenderer) return null;
  try {
    return await ipcRenderer.invoke('get-performance');
  } catch (error) {
    return null;
  }
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

// Opens a documented project link (docs site, Discord) in the default browser.
// Outside Electron the click falls back to a normal browser navigation.
export async function openExternalUrl(url) {
  if (!ipcRenderer) {
    if (typeof window !== 'undefined' && /^https:\/\//.test(url)) window.open(url, '_blank', 'noopener');
    return { opened: false };
  }
  return ipcRenderer.invoke('open-external-url', url);
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

// RC-Brain: the model in the main process makes the diagnosis and chooses the
// action; the renderer shows the evidence and asks the executor to run it.
export async function getAiStatus() {
  if (!ipcRenderer) return null;
  try {
    return await ipcRenderer.invoke('ai-status');
  } catch (error) {
    return null;
  }
}

export async function getAiHistory() {
  if (!ipcRenderer) return [];
  try {
    return await ipcRenderer.invoke('ai-history');
  } catch (error) {
    return [];
  }
}

export async function setAiMonitoring(enabled) {
  return requireIpc('Changing monitoring').invoke('ai-set-monitoring', { enabled: Boolean(enabled) });
}

export async function getAiExperiences(limit = 20) {
  if (!ipcRenderer) return [];
  try {
    return await ipcRenderer.invoke('ai-experiences', { limit });
  } catch (error) {
    return [];
  }
}

export async function promoteAiExperiences(ids, consent = false) {
  return requireIpc('Promoting verified experiences').invoke('ai-promote-experiences', { ids, consent: Boolean(consent) });
}

export async function correctAiExperience(id, diagnosis, action, note = '') {
  return requireIpc('Correcting a diagnosis').invoke('ai-correct-experience', { id, diagnosis, action, note });
}

export async function rollbackAiModel() {
  return requireIpc('Rolling back the model').invoke('ai-rollback-model');
}

export async function repairAppEnvironment(appId, decision, approved = false) {
  return requireIpc('Repairing apps').invoke('repair-app-behaviour', { appId, decision, approved });
}

function onAiEvent(channel, callback) {
  if (!ipcRenderer) return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export function onAiDiagnosis(callback) {
  return onAiEvent('ai:diagnosis', callback);
}

export function onAiRepairResult(callback) {
  return onAiEvent('ai:repair-result', callback);
}

export function onAiRecovered(callback) {
  return onAiEvent('ai:recovered', callback);
}

export function onAiUnavailable(callback) {
  return onAiEvent('ai:unavailable', callback);
}

export function onAiStatus(callback) {
  return onAiEvent('ai:status', callback);
}

export function onAiHistory(callback) {
  return onAiEvent('ai:history', callback);
}

// Setup progress for an app that is really its own setup program: either it is being
// set up in the background, or its wizard is waiting in a RunContainer window.
export function onSetupProgress(callback) {
  return onAiEvent('app:setup', callback);
}

export function onSetupComplete(callback) {
  return onAiEvent('app:setup-complete', callback);
}

export async function setUpInBackground(container) {
  return requireIpc('Setting up apps').invoke('setup-in-background', container);
}

export function onAiVerified(callback) {
  return onAiEvent('ai:verified', callback);
}

// --- Virtual machines (developer mode) ---------------------------------------
// A VM is a whole operating system on the custom QEMU backend, with its screen drawn
// inside a RunContainer window. The guest is served over loopback VNC and the socket
// lives in the main process; these calls carry bytes, never a URL.
export async function listVms() {
  if (!ipcRenderer) return { vms: [] };
  try {
    return await ipcRenderer.invoke('vm-list');
  } catch (error) {
    return { vms: [], error: error?.message };
  }
}

export async function browseVmIso() {
  return requireIpc('Choosing installation media').invoke('vm-browse-iso');
}

export async function createVm(config) {
  return requireIpc('Creating virtual machines').invoke('vm-create', config);
}

export async function startVm(vm) {
  return requireIpc('Starting virtual machines').invoke('vm-start', { id: vm?.id });
}

export async function stopVm(vm) {
  return requireIpc('Stopping virtual machines').invoke('vm-stop', { id: vm?.id });
}

export async function deleteVm(vm) {
  return requireIpc('Deleting virtual machines').invoke('vm-delete', { id: vm?.id });
}

export async function connectVmConsole(vm) {
  return requireIpc('Opening the VM console').invoke('vm-console-connect', { id: vm?.id });
}

export async function writeVmConsole(id, bytes) {
  if (!ipcRenderer) return { written: false };
  return ipcRenderer.invoke('vm-console-write', { id, bytes });
}

export async function disconnectVmConsole(id) {
  if (!ipcRenderer) return { disconnected: false };
  return ipcRenderer.invoke('vm-console-disconnect', { id });
}

// Guest screen updates and console state, one event stream per VM.
export function onVmConsoleData(callback) {
  return onAiEvent('vm-console-data', callback);
}

export function onVmConsoleStatus(callback) {
  return onAiEvent('vm-console-status', callback);
}

export function onVmsChanged(callback) {
  return onAiEvent('vm-status', callback);
}