// Drives the real built app and checks what Settings actually shows.
//
// The companion existed in the code and in the tests while a person could not find it
// on screen, so this check reads the rendered panel rather than the source: does the
// Settings tab contain the iPhone companion card, does turning it on produce an address
// and a six-digit code, and does turning it off close the port again.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const repoRoot = path.join(__dirname, '..');
const notes = [];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch (error) { return; }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    socket.on('error', reject);
    socket.on('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = (nextId += 1);
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { socket.close(); } catch (error) { /* already closed */ } },
      });
    });
  });
}

async function waitForRenderer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no debugging endpoint';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && /index\.html/.test(target.url));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      lastError = targets.map((target) => target.url).join(', ').slice(0, 200);
    } catch (error) {
      lastError = error.message;
    }
    await wait(500);
  }
  throw new Error(`the app never exposed a renderer to drive (${lastError})`);
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`the renderer threw: ${String(result.exceptionDetails.exception?.description || result.exceptionDetails.text).slice(0, 400)}`);
  }
  return result.result.value;
}

// Clicks a tab by its label. Each tab shows a glyph and a word inside one button, so
// the label is matched on its own span rather than on the button's whole text.
function clickTabExpression(label) {
  return `(() => {
    const button = [...document.querySelectorAll('.nav-button, button')]
      .find((element) => [...element.querySelectorAll('span')]
        .some((span) => span.textContent.trim() === ${JSON.stringify(label)}));
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

async function main() {
  if (process.platform !== 'win32') {
    log('This check needs Windows.');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(repoRoot, 'build', 'index.html'))) {
    log('No production build found. Run `npm run build` first.');
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-companion-ui-'));
  const userDataDir = path.join(work, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  // The beginner introduction is a once-ever overlay; this check is not about it.
  fs.writeFileSync(path.join(userDataDir, 'runcontainer-preferences.json'), JSON.stringify({
    beginnerSetupSeen: true,
    beginnerSetupSeenVersion: require('../package.json').version,
    theme: 'dark',
  }, null, 2), 'utf8');

  const port = await freePort();
  let appProcess = null;
  let client = null;
  let passed = false;

  try {
    appProcess = spawn(require('electron'), [
      '.',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    appProcess.stdout.on('data', () => {});
    appProcess.stderr.on('data', () => {});

    client = await cdpClient(await waitForRenderer(port, 60000));
    await wait(1500);

    if (!(await evaluate(client, clickTabExpression('Settings')))) {
      throw new Error('no Settings tab could be found in the rendered app');
    }
    await wait(1200);

    const settingsText = await evaluate(client, 'document.body.innerText');
    if (!/iPhone companion/i.test(settingsText)) {
      throw new Error(`Settings does not mention the iPhone companion. It shows: ${settingsText.slice(0, 400)}`);
    }
    notes.push('Settings contains the iPhone companion card');

    // The card must be the first thing in Settings and on screen without scrolling:
    // it existed before but sat below another card, which is how it was missed.
    const placement = await evaluate(client, `(() => {
      const text = document.body.innerText;
      const heading = [...document.querySelectorAll('.companion-card strong')]
        .find((element) => /iPhone companion/i.test(element.textContent));
      if (!heading) return { found: false };
      const rect = heading.getBoundingClientRect();
      return {
        found: true,
        companion: text.search(/iPhone companion/i),
        appearance: text.indexOf('Appearance'),
        top: Math.round(rect.top),
        onScreen: rect.top >= 0 && rect.top < window.innerHeight * 0.6,
      };
    })()`);
    if (!placement.found) throw new Error('the iPhone companion card is not in the rendered Settings panel');
    if (!(placement.companion < placement.appearance)) {
      throw new Error(`the companion card is not the first card in Settings (companion=${placement.companion}, appearance=${placement.appearance})`);
    }
    if (!placement.onScreen) {
      throw new Error(`the companion card is below the first screenful (top=${placement.top}px)`);
    }
    notes.push(`the card is the first setting and on screen (top ${placement.top}px)`);

    const enabled = await evaluate(client, `(async () => {
      const button = [...document.querySelectorAll('button')]
        .find((element) => /^Turn on$/i.test(element.textContent.trim()));
      if (!button) return { clicked: false };
      button.click();
      return { clicked: true };
    })()`);
    if (!enabled.clicked) throw new Error('the companion card has no Turn on button');

    let card = '';
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      card = await evaluate(client, 'document.body.innerText');
      if (/http:\/\/\d+\.\d+\.\d+\.\d+:\d+/i.test(card) && /\b\d{3}\s\d{3}\b/.test(card)) break;
      await wait(700);
    }
    if (!/http:\/\/\d+\.\d+\.\d+\.\d+:\d+/i.test(card)) {
      throw new Error('turning the companion on showed no address');
    }
    if (!/\b\d{3}\s\d{3}\b/.test(card)) {
      throw new Error('turning the companion on showed no six-digit code');
    }
    notes.push('turning it on shows an address and a six-digit pairing code');

    if (!/Add to Home Screen/i.test(card)) {
      throw new Error('the card does not tell the person to add the page to the Home Screen');
    }
    if (!/Copy address/i.test(card)) {
      throw new Error('the card has no way to copy the address');
    }
    notes.push('the card gives the address, a copy button, Home Screen steps and the code');

    await evaluate(client, `(async () => {
      const button = [...document.querySelectorAll('button')]
        .find((element) => /^Turn off$/i.test(element.textContent.trim()));
      if (button) button.click();
    })()`);
    await wait(1200);
    passed = true;
  } catch (error) {
    log(`FAIL  ${error.message}`);
  } finally {
    if (client) client.close();
    if (appProcess?.pid) {
      try { execFileSync('taskkill.exe', ['/PID', String(appProcess.pid), '/T', '/F'], { windowsHide: true }); } catch (error) { /* already gone */ }
    }
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (error) { /* temp */ }
  }

  for (const note of notes) log(`  · ${note}`);
  if (passed) {
    log('\nPASS  the iPhone companion is visible and usable from Settings');
    process.exit(0);
  }
  log('\nFAIL  the iPhone companion is not reachable from Settings');
  process.exit(1);
}

main().catch((error) => {
  log(`FAIL  ${error.message}`);
  process.exit(1);
});
