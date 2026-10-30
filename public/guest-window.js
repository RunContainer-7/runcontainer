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
const nightly = params.get('channel') === 'nightly';
if (nightly) document.body.classList.add('nightly');
document.title = `${nightly ? 'RunContainer Nightly' : 'RunContainer'} — ${name}`;
document.getElementById('main').textContent = nightly ? 'RunContainer Nightly' : 'RunContainer';

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

// ------------------------------------------------------------------ companion ---
//
// When a paired phone opens this app, it needs to see this window. Windows will not let
// the main process copy another program's window contents on demand, so the capture
// happens here: this page shares its own window, draws each frame onto a small canvas
// and sends the encoded picture to the main process. Nothing is written to disk.

let captureSession = null;

function stopCompanionCapture() {
  if (!captureSession) return;
  const session = captureSession;
  captureSession = null;
  session.stopped = true;
  if (session.timer) clearInterval(session.timer);
  if (session.stream) {
    for (const track of session.stream.getTracks()) {
      try { track.stop(); } catch (error) { /* already ended */ }
    }
  }
  if (session.video?.parentNode) session.video.parentNode.removeChild(session.video);
}

async function startCompanionCapture(options = {}) {
  stopCompanionCapture();
  const appId = String(options.appId || '');
  const preset = options.preset || {};
  const fps = Math.max(1, Math.min(15, Number(preset.fps) || 6));
  const maxWidth = Math.max(320, Math.min(1920, Number(preset.maxWidth) || 1280));
  const jpegQuality = Math.min(0.9, Math.max(0.25, Number(preset.jpeg) || 0.55));
  const session = {
    appId,
    stopped: false,
    timer: null,
    stream: null,
    video: null,
    canvas: document.createElement('canvas'),
    sequence: 0,
    busy: false,
  };
  captureSession = session;

  try {
    // The main process answers this with the source it chose for this window, or with
    // nothing at all, in which case the browser refuses the request.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false });
    if (session.stopped) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    session.stream = stream;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.display = 'none';
    video.srcObject = stream;
    document.body.appendChild(video);
    session.video = video;
    await video.play();

    const captureFrame = () => {
      if (session.stopped || session.busy || video.readyState < 2) return;
      const sourceWidth = video.videoWidth || 0;
      const sourceHeight = video.videoHeight || 0;
      if (!sourceWidth || !sourceHeight) return;
      const scale = Math.min(1, maxWidth / sourceWidth);
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      session.canvas.width = width;
      session.canvas.height = height;
      const context = session.canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      session.busy = true;
      session.canvas.toBlob((blob) => {
        if (!blob || session.stopped) { session.busy = false; return; }
        blob.arrayBuffer().then((buffer) => {
          session.busy = false;
          if (session.stopped) return;
          session.sequence += 1;
          ipcRenderer.send('companion-frame', {
            appId: session.appId,
            width,
            height,
            sequence: session.sequence,
            buffer,
          });
        }).catch(() => { session.busy = false; });
      }, 'image/jpeg', jpegQuality);
    };

    // The first frame is drawn immediately so the phone is not left on a blank stage while
    // it waits for the interval.
    setTimeout(captureFrame, 120);
    session.timer = setInterval(captureFrame, Math.round(1000 / fps));
    // If Windows ends the share (the window closes, or the user stops it), the phone is
    // told rather than left on a still picture.
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (!session.stopped) ipcRenderer.send('companion-capture-ended', { appId: session.appId });
        stopCompanionCapture();
      });
    }
  } catch (error) {
    stopCompanionCapture();
    ipcRenderer.send('companion-capture-failed', {
      appId,
      error: error?.message || 'Windows did not allow this window to be shared.',
    });
  }
}

ipcRenderer.on('companion-capture-start', (_event, options) => {
  startCompanionCapture(options);
});

ipcRenderer.on('companion-capture-stop', () => {
  stopCompanionCapture();
});

// The window is going away; a capture must not keep a stream open.
window.addEventListener('pagehide', stopCompanionCapture);

// Background setup is a Settings choice now, not a button here: an installer that
// supports it is completed unattended on Run. This window is its progress surface, so
// it only ever reports status.
