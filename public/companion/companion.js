// The RunContainer companion page.
//
// This page is a screen and a keyboard for an app on the PC. It draws the frames the PC
// sends and turns touches into pointer and key messages; it never decides what a command
// means, and it cannot start an app by itself.

(function companion() {
  'use strict';

  const TOKEN_KEY = 'rc-companion-token';
  const DEVICE_KEY = 'rc-companion-device';
  const THEME_KEY = 'rc-companion-theme';

  const screens = {
    pair: document.getElementById('screen-pair'),
    apps: document.getElementById('screen-apps'),
    view: document.getElementById('screen-view'),
  };
  const pairCode = document.getElementById('pair-code');
  const pairDevice = document.getElementById('pair-device');
  const pairButton = document.getElementById('pair-button');
  const pairError = document.getElementById('pair-error');
  const connection = document.getElementById('connection');
  const appList = document.getElementById('app-list');
  const appsHint = document.getElementById('apps-hint');
  const refreshButton = document.getElementById('refresh');
  const viewName = document.getElementById('view-name');
  const viewState = document.getElementById('view-state');
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('screen');
  const stageNote = document.getElementById('stage-note');
  const keysRow = document.getElementById('keys');
  const typeForm = document.getElementById('type-form');
  const typeField = document.getElementById('type-field');
  const qualityButton = document.getElementById('quality');

  const state = {
    token: '',
    device: '',
    socket: null,
    connected: false,
    apps: [],
    viewing: null,
    frameSize: { width: 0, height: 0 },
    quality: 'auto',
    retry: 0,
    retryTimer: null,
    retry: 0,
  };

  function show(name) {
    for (const [key, element] of Object.entries(screens)) {
      element.hidden = key !== name;
    }
  }

  // The interface follows the phone until it is told otherwise, then it remembers. The
  // button shows the theme it switches to, not the one in use.
  // Stable and Nightly are told apart by the icon on the phone as well as the colour:
  // iOS takes the apple-touch-icon, Android the manifest, and both change together.
  function applyChannel(channel) {
    const nightly = channel === 'nightly';
    document.body.classList.toggle('nightly', nightly);
    const base = nightly ? '/icons/nightly' : '/icons';
    const icon = document.getElementById('app-icon');
    const favicon = document.getElementById('app-favicon');
    const manifest = document.getElementById('app-manifest');
    if (icon) icon.href = `${base}/icon-180.png`;
    if (favicon) favicon.href = `${base}/icon-192.png`;
    if (manifest) manifest.href = nightly ? '/manifest-nightly.webmanifest' : '/manifest.webmanifest';
  }

  function applyTheme(theme) {
    const chosen = theme === 'light' ? 'light' : 'dark';
    document.body.dataset.theme = chosen;
    for (const button of document.querySelectorAll('.theme-toggle')) {
      button.textContent = chosen === 'dark' ? '☀' : '☾';
      button.setAttribute('aria-label', chosen === 'dark' ? 'Switch to the light interface' : 'Switch to the dark interface');
    }
  }

  function preferredTheme() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (error) { /* private mode */ }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (error) { /* older browser */ }
    return 'dark';
  }

  function toggleTheme() {
    const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* private mode */ }
  }

  function setPill(element, text, tone) {
    element.textContent = text;
    element.classList.toggle('live', tone === 'live');
    element.classList.toggle('bad', tone === 'bad');
  }

  function message(text) {
    pairError.textContent = text;
    pairError.hidden = !text;
  }

  function deviceName() {
    try {
      const stored = localStorage.getItem(DEVICE_KEY);
      if (stored) return stored;
    } catch (error) { /* private mode */ }
    return 'iPhone';
  }

  function saveToken(token) {
    state.token = token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (error) { /* private mode */ }
  }

  function clearToken() {
    state.token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch (error) { /* private mode */ }
  }

  function currentToken() {
    if (state.token) return state.token;
    try { state.token = localStorage.getItem(TOKEN_KEY) || ''; } catch (error) { state.token = ''; }
    return state.token;
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      cache: 'no-store',
    });
    let body = null;
    try { body = await response.json(); } catch (error) { body = null; }
    return { ok: response.ok, status: response.status, body };
  }

  // ------------------------------------------------------------------ pairing ---

  async function pair() {
    const code = pairCode.value.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) {
      message('Enter the six digits shown on the PC.');
      pairCode.focus();
      return;
    }
    pairButton.disabled = true;
    message('');
    try {
      const result = await api('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, device: (pairDevice.value || deviceName()).trim() }),
      });
      if (!result.ok || !result.body?.token) {
        message(result.body?.error || 'The PC did not accept that code.');
        return;
      }
      saveToken(result.body.token);
      try { localStorage.setItem(DEVICE_KEY, result.body.device || deviceName()); } catch (error) { /* private */ }
      applyChannel(result.body.channel);
      await open();
    } catch (error) {
      message('Could not reach the PC. Check that both devices are on the same network, then try again.');
    } finally {
      pairButton.disabled = false;
    }
  }

  // ------------------------------------------------------------------ session ---

  function socketUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`;
  }

  function scheduleReconnect() {
    if (state.retryTimer) return;
    state.retry = Math.min(state.retry + 1, 6);
    const delay = Math.min(1000 * state.retry, 6000);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      connectSocket();
    }, delay);
  }

  function connectSocket() {
    if (!currentToken()) {
      show('pair');
      return;
    }
    if (state.socket) {
      try { state.socket.close(); } catch (error) { /* closing */ }
      state.socket = null;
    }
    setPill(connection, 'Connecting…');
    let socket;
    try {
      socket = new WebSocket(socketUrl());
    } catch (error) {
      setPill(connection, 'Not connected', 'bad');
      scheduleReconnect();
      return;
    }
    socket.binaryType = 'blob';
    state.socket = socket;

    socket.addEventListener('open', () => {
      state.connected = true;
      state.retry = 0;
      setPill(connection, 'Connected', 'live');
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        let payload;
        try { payload = JSON.parse(event.data); } catch (error) { return; }
        handleMessage(payload);
        return;
      }
      drawFrame(event.data);
    });

    socket.addEventListener('close', () => {
      state.connected = false;
      if (state.socket === socket) state.socket = null;
      setPill(connection, 'Reconnecting…', 'bad');
      if (screens.pair.hidden && !screens.apps.hidden) scheduleReconnect();
      else if (screens.view.hidden) scheduleReconnect();
      else setPill(viewState, 'Connection lost', 'bad');
    });

    socket.addEventListener('error', () => {
      // The close event follows; one visible state is enough.
    });
  }

  function send(payload) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
    try {
      state.socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      return false;
    }
  }

  function handleMessage(payload) {
    if (payload.type === 'hello' || payload.type === 'apps') {
      state.apps = Array.isArray(payload.apps) ? payload.apps : [];
      renderApps();
      return;
    }
    if (payload.type === 'view.meta') {
      state.frameSize = {
        width: Number(payload.width) || state.frameSize.width,
        height: Number(payload.height) || state.frameSize.height,
      };
      if (payload.sequence === 0) setPill(viewState, 'Live', 'live');
      return;
    }
    if (payload.type === 'view.state') {
      if (payload.stage === 'capturing') {
        setPill(viewState, 'Live', 'live');
        stageNote.hidden = true;
      } else if (payload.stage === 'unavailable') {
        setPill(viewState, 'Not available', 'bad');
        stageNote.textContent = payload.reason || 'The PC could not share this window.';
        stageNote.hidden = false;
      }
      return;
    }
    if (payload.type === 'error') {
      setPill(viewState, payload.message || 'Something went wrong', 'bad');
    }
  }

  // -------------------------------------------------------------------- frame ---

  const context = canvas.getContext('2d');
  let drawing = false;

  async function drawFrame(blob) {
    if (drawing) return;
    drawing = true;
    try {
      const bitmap = await createImageBitmap(blob);
      const stageRect = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(stageRect.width * dpr));
      canvas.height = Math.max(1, Math.round(stageRect.height * dpr));
      // Keep the picture's aspect ratio and centre it, so the phone and the PC agree on
      // where a touch lands.
      const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      if (bitmap.close) bitmap.close();
      stageNote.hidden = true;
    } catch (error) {
      // A half-received frame is dropped rather than drawn as a broken picture.
    } finally {
      drawing = false;
    }
  }

  // The canvas shows the whole app window, letterboxed. A touch is turned into a
  // position inside the picture, so the PC receives the same point the person touched.
  function pointerInFrame(event) {
    const rect = canvas.getBoundingClientRect();
    const frameWidth = state.frameSize.width || rect.width;
    const frameHeight = state.frameSize.height || rect.height;
    const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight);
    const drawWidth = frameWidth * scale;
    const drawHeight = frameHeight * scale;
    const originX = rect.left + (rect.width - drawWidth) / 2;
    const originY = rect.top + (rect.height - drawHeight) / 2;
    const x = (event.clientX - originX) / drawWidth;
    const y = (event.clientY - originY) / drawHeight;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  function sendPointer(action, event) {
    if (!state.viewing) return;
    const point = pointerInFrame(event);
    send({ type: 'input', action, x: point.x, y: point.y });
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    sendPointer('pointer.down', event);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
      sendPointer('pointer.move', event);
      return;
    }
    if (!canvas.hasPointerCapture(event.pointerId)) return;
    sendPointer('pointer.move', event);
  });

  canvas.addEventListener('pointerup', (event) => {
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    sendPointer('pointer.up', event);
  });

  canvas.addEventListener('pointercancel', (event) => {
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    sendPointer('pointer.up', event);
  });

  canvas.addEventListener('wheel', (event) => {
    if (!state.viewing) return;
    event.preventDefault();
    const point = pointerInFrame(event);
    send({
      type: 'input',
      action: 'wheel',
      x: point.x,
      y: point.y,
      delta: Math.max(-1200, Math.min(1200, -event.deltaY)),
    });
  }, { passive: false });

  // --------------------------------------------------------------------- apps ---

  function initial(name) {
    return (name || '?').trim().charAt(0).toUpperCase() || '?';
  }

  function renderApps() {
    appList.textContent = '';
    const apps = state.apps.filter((app) => app && app.id);
    if (apps.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No apps yet. Add one on the PC, then start it there.';
      appList.appendChild(empty);
      appsHint.hidden = true;
      return;
    }
    appsHint.hidden = false;
    appsHint.textContent = 'Apps that are running can be opened here.';
    for (const app of apps) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-card';
      button.disabled = !app.running;

      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.textContent = initial(app.name);
      const meta = document.createElement('span');
      meta.className = 'meta';
      const title = document.createElement('strong');
      title.textContent = app.name;
      const status = document.createElement('span');
      status.textContent = app.running ? 'Running — tap to open' : `${app.status} — start it on the PC`;
      meta.append(title, status);
      const chevron = document.createElement('span');
      chevron.className = 'chev';
      chevron.textContent = app.running ? '›' : '';

      button.append(glyph, meta, chevron);
      button.addEventListener('click', () => openApp(app));
      item.appendChild(button);
      appList.appendChild(item);
    }
  }

  function openApp(app) {
    if (!app.running) return;
    state.viewing = app;
    viewName.textContent = app.name;
    setPill(viewState, 'Connecting to the window…');
    stageNote.textContent = 'Waiting for the PC to send the first frame…';
    stageNote.hidden = false;
    state.frameSize = { width: 0, height: 0 };
    show('view');
    send({ type: 'view.start', appId: app.id, quality: state.quality });
  }

  function leaveView() {
    if (state.viewing) send({ type: 'view.stop' });
    state.viewing = null;
    show('apps');
    refresh();
  }

  // ------------------------------------------------------------------ actions ---

  refreshButton.addEventListener('click', () => {
    refresh();
  });

  async function refresh() {
    if (!currentToken()) {
      show('pair');
      return;
    }
    try {
      const result = await api('/api/state', { token: state.token });
      if (result.status === 401) {
        clearToken();
        show('pair');
        message('This phone is no longer paired with that PC. Pair again with the code on the PC.');
        return;
      }
      if (result.ok && result.body) {
        applyChannel(result.body.channel);
        state.apps = result.body.apps || [];
        renderApps();
      }
    } catch (error) {
      setPill(connection, 'PC not reachable', 'bad');
    }
  }

  async function open() {
    show('apps');
    await refresh();
    connectSocket();
  }

  document.getElementById('back').addEventListener('click', leaveView);

  for (const button of keysRow.querySelectorAll('button[data-key]')) {
    button.addEventListener('click', () => {
      send({ type: 'input', action: 'key', key: button.dataset.key, phase: 'tap' });
    });
  }

  document.getElementById('more-keys').addEventListener('click', () => {
    keysRow.hidden = !keysRow.hidden;
  });

  // Text is sent as a single message, so autocorrect and emoji are sent as typed rather
  // than as a sequence of key codes the PC would have to guess at.
  typeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = typeField.value;
    if (!text) {
      send({ type: 'input', action: 'key', key: 'Enter', phase: 'tap' });
      return;
    }
    send({ type: 'input', action: 'text', text });
    typeField.value = '';
  });

  qualityButton.addEventListener('click', () => {
    const order = ['auto', 'sharp', 'small'];
    const next = order[(order.indexOf(state.quality) + 1) % order.length];
    state.quality = next;
    qualityButton.textContent = next === 'auto' ? 'Auto' : next === 'sharp' ? 'Sharp' : 'Data saver';
    if (state.viewing) send({ type: 'view.quality', quality: next, appId: state.viewing.id });
  });

  pairButton.addEventListener('click', pair);
  pairCode.addEventListener('input', () => {
    pairCode.value = pairCode.value.replace(/\D/g, '').slice(0, 6);
    if (pairCode.value.length === 6) pairCode.blur();
  });
  pairCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') pair();
  });

  window.addEventListener('resize', () => {
    // The next frame redraws at the new size.
    stageNote.hidden = state.viewing ? false : stageNote.hidden;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Phone unlocked or Safari returned: the socket may have been suspended.
    if (currentToken() && (!state.socket || state.socket.readyState !== WebSocket.OPEN)) {
      if (!screens.pair.hidden) return;
      connectSocket();
    }
  });

  // ------------------------------------------------------------------- start ---

  applyTheme(preferredTheme());
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.addEventListener('click', toggleTheme);
  }

  pairDevice.value = deviceName();
  if (currentToken()) {
    open();
  } else {
    show('pair');
    pairCode.focus();
  }
}());
