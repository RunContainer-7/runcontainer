export function openFileExplorer(callback) {
  const { dialog } = window.require('electron').remote;
  dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Executables', extensions: ['exe'] }
    ]
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      callback(result.filePaths[0]);
    }
  }).catch(err => {
    console.error('Failed to open file explorer:', err);
  });
}

export function installContainer(exePath) {
  // Logic to install the container using the provided exePath
  console.log('Installing container from:', exePath);
  // Implement installation logic here
}

export function runContainer(containerId) {
  // Logic to run the container in a sandboxed environment
  console.log('Running container with ID:', containerId);
  // Implement sandbox execution logic here
}

export function killContainer(containerId) {
  // Logic to kill the running container
  console.log('Killing container with ID:', containerId);
  // Implement container termination logic here
}