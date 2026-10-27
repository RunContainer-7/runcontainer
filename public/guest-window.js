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

// Offered only when this app is a setup program whose installer has a documented
// unattended mode: completing it in the background is then a real option, not a guess.
if (params.get('autosetup') === '1') {
  const button = document.getElementById('background-setup');
  button.hidden = false;
  button.addEventListener('click', () => {
    button.disabled = true;
    setStatus('Completing this setup in the background, inside its environment…');
    ask('background-setup').then((result) => {
      if (result?.ok) {
        setStatus(result.result?.detail || 'Setup finished. The app starts in its own RunContainer window.');
        return;
      }
      setStatus(result?.result?.error || result?.error || 'Setup could not be completed in the background.');
      button.disabled = false;
    });
  });
}
