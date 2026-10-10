const electronModule = typeof window !== 'undefined' && window.require
  ? window.require('electron')
  : typeof require === 'function'
    ? require('electron')
    : null;

const ipcRenderer = electronModule?.ipcRenderer || null;

if (ipcRenderer && !window.electron) {
  window.electron = {
    openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
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

export async function installContainer(exePathOrFile) {
  if (!ipcRenderer) {
    return Promise.resolve(createContainerRecord(exePathOrFile, 'Installed'));
  }

  const exePath = typeof exePathOrFile === 'string' ? exePathOrFile : exePathOrFile?.path || exePathOrFile?.name;
  const record = await ipcRenderer.invoke('install-exe', exePath);
  return record;
}

export async function importFromUrl(url) {
  if (!ipcRenderer) {
    return Promise.resolve({ id: 'mock-url', name: 'Imported app', status: 'Installed' });
  }

  return ipcRenderer.invoke('import-url', url);
}

export async function updatePermissions(container, permissions) {
  if (!ipcRenderer) {
    return { ...container, permissions };
  }

  return ipcRenderer.invoke('update-permissions', container, permissions);
}

export async function resetContainer(container) {
  if (!ipcRenderer) {
    return { ...container, status: 'Reset' };
  }

  return ipcRenderer.invoke('reset-container', container);
}

export async function duplicateContainer(container) {
  if (!ipcRenderer) {
    return { ...container, id: `${container.id}-copy`, name: `${container.name} Copy` };
  }

  return ipcRenderer.invoke('duplicate-container', container);
}

export async function exportContainer(container) {
  if (!ipcRenderer) {
    return { ...container, exported: true };
  }

  return ipcRenderer.invoke('export-container', container);
}

export async function getAppLogs(container) {
  if (!ipcRenderer) {
    return [];
  }

  return ipcRenderer.invoke('get-app-logs', container);
}

export async function runContainer(container) {
  if (!ipcRenderer) {
    return { id: container?.id, status: 'Running', embedded: false };
  }

  return ipcRenderer.invoke('run-exe', container);
}

export async function killContainer(container) {
  if (!ipcRenderer) {
    return { id: container?.id, status: 'Stopped' };
  }

  return ipcRenderer.invoke('kill-exe', container);
}

export async function launchDesktopContainer(container) {
  if (!ipcRenderer) {
    return { id: container?.id, status: 'Running', embedded: false };
  }

  return ipcRenderer.invoke('launch-desktop', container);
}

export async function stopContainer(containerId) {
  return killContainer(containerId);
}

export async function listContainers() {
  if (!ipcRenderer) {
    return [];
  }

  return ipcRenderer.invoke('list-apps');
}