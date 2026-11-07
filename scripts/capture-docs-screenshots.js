// Captures the documentation screenshots from the real, current build.
//
// The screenshots on the documentation site were taken from an older interface and had
// stopped matching the app: the docs described panels that had since been redesigned.
// Hand-made replacements go stale the same way, so this drives the built app over the
// DevTools protocol and saves the renderer's own pixels.
//
//   npm run build && node scripts/capture-docs-screenshots.js
//
// It uses a temporary user-data directory, so a real app list is never touched, and it
// installs nothing permanently: the probe program it needs lives in the temp folder.
//
// Files are written to .docs-site/docs/public/screenshots/, which is what the Markdown
// pages reference. Run the docs build afterwards to publish them.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const repoRoot = path.join(__dirname, '..');
const outDir = path.join(repoRoot, '.docs-site', 'docs', 'public', 'screenshots');
const probeTitle = 'Paint'; // a familiar, real-looking app row in the list

function log(message) {
  process.stdout.write(`${message}\n`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function powershell(args) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
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

// A small real window whose title reads like an everyday app, so the Apps list in the
// screenshots looks like a person's library rather than a test fixture.
function buildProbe(directory) {
  const source = path.join(directory, 'probe.cs');
  const output = path.join(directory, `${probeTitle}.exe`);
  fs.writeFileSync(source, [
    'using System;',
    'using System.Windows.Forms;',
    'public static class DocsProbe {',
    '  [STAThread]',
    '  public static void Main() {',
    '    Application.EnableVisualStyles();',
    '    Form form = new Form();',
    `    form.Text = "${probeTitle}";`,
    '    form.Width = 900;',
    '    form.Height = 600;',
    '    form.StartPosition = FormStartPosition.CenterScreen;',
    '    form.Shown += (sender, args) => {',
    '      Timer timer = new Timer(); timer.Interval = 120000;',
    '      timer.Tick += (s, e) => { timer.Stop(); form.Close(); };',
    '      timer.Start();',
    '    };',
    '    form.Show();',
    '    Application.Run(new ApplicationContext());',
    '  }',
    '}',
  ].join('\n'), 'utf8');
  const script = path.join(directory, 'build-probe.ps1');
  fs.writeFileSync(script, [
    'param([string]$Source, [string]$Out)',
    'Add-Type -Path $Source -ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputAssembly $Out -OutputType WindowsApplication',
    'if (-not (Test-Path $Out)) { exit 1 }',
    'Write-Output "PROBE_BUILT"',
  ].join('\n'), 'utf8');
  const result = powershell(['-File', script, '-Source', source, '-Out', output]);
  if (!String(result).includes('PROBE_BUILT') || !fs.existsSync(output)) {
    throw new Error(`the screenshot probe could not be compiled: ${String(result).slice(0, 300)}`);
  }
  return output;
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
      lastError = targets.map((target) => target.url).join(', ').slice(0, 160);
    } catch (error) {
      lastError = error.message;
    }
    await wait(500);
  }
  throw new Error(`the app never exposed a renderer (${lastError})`);
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`the renderer threw: ${String(result.exceptionDetails.exception?.description || result.exceptionDetails.text).slice(0, 300)}`);
  }
  return result.result.value;
}

function clickTab(label) {
  return `(() => {
    const button = [...document.querySelectorAll('.nav-button, button')]
      .find((element) => [...element.querySelectorAll('span')]
        .some((span) => span.textContent.trim() === ${JSON.stringify(label)}));
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

async function capture(client, name) {
  // A window that Windows considers hidden stops producing frames, which leaves
  // captureScreenshot waiting forever. Bringing it forward keeps the surface live.
  await client.send('Page.bringToFront').catch(() => {});
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  log(`  captured ${name} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  return file;
}

function removeQuietly(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); } catch (error) { /* temp */ }
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
  fs.mkdirSync(outDir, { recursive: true });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-docs-shots-'));
  const userDataDir = path.join(work, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  const port = await freePort();
  let appProcess = null;
  let client = null;
  let installed = null;

  try {
    const probe = buildProbe(work);
    appProcess = spawn(require('electron'), [
      '.',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
    ], { cwd: repoRoot, stdio: 'ignore', windowsHide: false });

    client = await cdpClient(await waitForRenderer(port, 60000));
    // A fixed viewport keeps the images the same size as the ones they replace.
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await wait(2500);

    // The beginner tour opens over the whole interface on a fresh install, so it has to
    // be dismissed or every screenshot would be a picture of the tour.
    const skippedTour = await evaluate(client, `(() => {
      const skip = [...document.querySelectorAll('button')]
        .find((element) => element.textContent.trim() === 'Skip');
      if (!skip) return false;
      skip.click();
      return true;
    })()`);
    if (!skippedTour) log('  ! no beginner tour was showing');
    await wait(1500);

    log('Capturing the empty, first-run state');
    await evaluate(client, clickTab('Apps'));
    await wait(900);
    await capture(client, 'apps-empty.png');

    log('Installing one app so the panels are not empty');
    installed = await evaluate(client, `require('electron').ipcRenderer.invoke('install-exe', ${JSON.stringify(probe)})`);
    if (!installed?.id) throw new Error(`install-exe failed: ${JSON.stringify(installed).slice(0, 200)}`);
    await wait(1200);
    // install-exe writes the app to disk; the list on screen is loaded when the renderer
    // starts, and this script called IPC directly rather than through the interface, so
    // reload it. Otherwise every panel would claim that nothing is installed.
    await client.send('Page.reload', { ignoreCache: false });
    await wait(3500);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await evaluate(client, `(() => {
      const skip = [...document.querySelectorAll('button')]
        .find((element) => element.textContent.trim() === 'Skip');
      if (skip) { skip.click(); return true; }
      return false;
    })()`);
    await wait(1500);
    // Select the row so panels that edit an app show their form rather than a prompt.
    const selected = await evaluate(client, `(() => {
      const label = [...document.querySelectorAll('*')].find((element) => element.children.length === 0
        && element.textContent.trim() === ${JSON.stringify(probeTitle)});
      if (!label) return false;
      const target = label.closest('button, [role="button"], li, .app-card, .app-row, [tabindex]') || label;
      target.click();
      return true;
    })()`);
    if (!selected) log(`  ! could not select the ${probeTitle} row; app-specific panels will show their prompt`);
    await wait(1200);

    log('Capturing the Apps menu');
    // The + control is an icon button, so it has no "+" text node. Fall back to its
    // accessible name, then to the top-right header button that holds an icon.
    const opened = await evaluate(client, `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const byText = buttons.find((element) => element.textContent.trim() === '+');
      const byLabel = buttons.find((element) => /add|install|new/i.test(element.getAttribute('aria-label') || element.title || ''));
      const byPlace = buttons.find((element) => {
        const rect = element.getBoundingClientRect();
        return element.querySelector('svg') && rect.top < 160 && rect.right > 900;
      });
      const plus = byText || byLabel || byPlace;
      if (!plus) return 'no + button: ' + buttons.slice(0, 8).map((b) => b.outerHTML.slice(0, 70)).join(' | ');
      plus.click();
      return 'clicked ' + (plus.getAttribute('aria-label') || plus.title || plus.className || 'button');
    })()`);
    log(`  ${opened}`);
    await wait(900);
    const menuOpen = await evaluate(client, `/Install EXE|Import from URL/i.test(document.body.innerText)`);
    if (!menuOpen) log('  ! the + menu did not open; apps-menu.png will show the list without it');
    await capture(client, 'apps-menu.png');
    await evaluate(client, `document.body.click()`);
    await wait(400);

    log('Capturing the EXE Store');
    const storeOpened = await evaluate(client, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((element) => element.getAttribute('aria-label') === 'EXE Store');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!storeOpened) log('  ! no EXE Store button was found');
    await wait(1200);
    await capture(client, 'exe-store.png');
    await evaluate(client, `(() => {
      // The store panel is rendered last, so its Close is the last match; the app rows
      // behind it also have one and closing those would not dismiss the panel.
      const closes = [...document.querySelectorAll('button')]
        .filter((element) => element.textContent.trim() === 'Close');
      const close = closes[closes.length - 1];
      if (close) { close.click(); return true; }
      return false;
    })()`);
    await wait(700);

    const tabs = [
      ['Sources', 'sources-panel.png'],
      ['Tweaks', 'tweaks-panel.png'],
      ['Profiles', 'profiles-panel.png'],
      ['Settings', 'tab-settings.png'],
      ['Updates', 'updates-panel.png'],
      ['Info', 'info-panel.png'],
    ];
    for (const [label, file] of tabs) {
      log(`Capturing ${label}`);
      const clicked = await evaluate(client, clickTab(label));
      if (!clicked) {
        log(`  ! no tab labelled ${label} was found; keeping the previous screenshot`);
        continue;
      }
      await wait(1100);
      if (label === 'Tweaks') {
        // Choose the app in the panel's own picker, so the form and the Runtime & JIT
        // card show a real app instead of "Select an app".
        await evaluate(client, `(() => {
          const select = [...document.querySelectorAll('select')]
            .find((element) => [...element.options].some((option) => /Select an app/i.test(option.textContent)));
          if (!select) return false;
          const option = [...select.options].find((entry) => ${JSON.stringify(probeTitle)}.includes(entry.textContent.trim()));
          if (!option) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
          setter.call(select, option.value);
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await wait(900);
      }
      await capture(client, file);
    }

    log(`Screenshots written to ${path.relative(repoRoot, outDir)}`);
  } finally {
    if (installed?.id) {
      try { await evaluate(client, `require('electron').ipcRenderer.invoke('kill-exe', ${JSON.stringify({ id: installed.id })})`); } catch (error) { /* quitting */ }
    }
    if (appProcess?.pid) {
      try { execFileSync('taskkill.exe', ['/PID', String(appProcess.pid), '/T', '/F'], { windowsHide: true }); } catch (error) { /* already gone */ }
    }
    try { client?.close(); } catch (error) { /* already closed */ }
    removeQuietly(work);
  }
}

main().catch((error) => {
  log(`FAIL  ${error.message}`);
  process.exit(1);
});
