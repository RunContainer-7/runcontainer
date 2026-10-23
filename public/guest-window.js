// Runs inside the second RunContainer window.
//
// The window's only job is to be the parent of an app's (or a VM console's) native
// window. The child window is positioned below the 56px header by the main process,
// so this page draws the header and a plain background; it never pretends to render
// the app itself.
const { ipcRenderer } = require('electron');

const params = new URLSearchParams(window.location.search);
const appId = params.get('appId') || '';
const name = params.get('name') || 'App window';
const note = params.get('note') || 'This window belongs to RunContainer.';

document.getElementById('app-name').textContent = name;
document.getElementById('app-note').textContent = note;
document.title = `RunContainer — ${name}`;

const status = document.getElementById('status');

function setStatus(text) {
  status.textContent = text;
}

function ask(action) {
  return ipcRenderer.invoke('guest-window-action', { appId, action }).catch((error) => ({
    ok: false,
    error: error?.message || 'The action could not be completed.',
  }));
}

ipcRenderer.on('guest-window-status', (_event, payload) => {
  if (payload?.text) setStatus(payload.text);
});

document.getElementById('stop').addEventListener('click', () => {
  setStatus('Stopping the app…');
  ipcRenderer.invoke('kill-exe', { id: appId })
    .then((result) => {
      setStatus(result?.status === 'Stopped'
        ? 'The app is stopped.'
        : (result?.error || 'The app did not confirm that it stopped.'));
    })
    .catch((error) => setStatus(error?.message || 'The app could not be stopped.'));
});

document.getElementById('release').addEventListener('click', () => {
  ask('release').then((result) => {
    setStatus(result?.released > 0
      ? 'The app window is back on your desktop.'
      : 'No hosted window was left to release.');
  });
});

document.getElementById('main').addEventListener('click', () => {
  ask('focus-main');
});
