// The console, drawn for real.
//
// Everything else about Virtualise is tested with pure builders, which is exactly how a
// machine could be "created" and "started" while the console stayed black: nothing ever
// proved that a guest's screen arrives and turns into pixels. This test boots genuine QEMU
// with the same arguments the app builds, speaks RFB to it with the same client the window
// uses, and checks that frames arrive and are not blank.
//
// It skips (never silently passes) when QEMU is not installed, which is the case on a
// typical CI runner.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const vm = require('../../public/vm-runtime');
const qemu = require('../../public/qemu-runtime');
const { RfbSession } = require('./rfbClient');

const BOOT_TIMEOUT_MS = 120000;

function findQemu() {
  const dirs = qemu.candidateQemuDirs({
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env['ProgramFiles(x86)'],
  });
  for (const dir of dirs) {
    const system = path.join(dir, qemu.QEMU_SYSTEM_BINARY);
    const image = path.join(dir, qemu.QEMU_IMG_BINARY);
    if (fs.existsSync(system) && fs.existsSync(image)) return { system, image };
  }
  return null;
}

function run(exePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${exePath} exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

// A console port is only usable if nothing else holds it, so a slot is tried until one is
// free rather than assuming the first.
function freeSlot() {
  return new Promise((resolve, reject) => {
    let slot = 0;
    const attempt = () => {
      if (slot >= vm.VM_CONSOLE_SLOTS) {
        reject(new Error('Every VM console port is in use.'));
        return;
      }
      const port = vm.consolePortFor(slot);
      const probe = net.createServer();
      probe.once('error', () => { slot += 1; attempt(); });
      probe.once('listening', () => probe.close(() => resolve({ slot, port })));
      probe.listen(port, '127.0.0.1');
    };
    attempt();
  });
}

function connect(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', (error) => {
        socket.destroy();
        if (Date.now() > deadline) reject(error);
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

const qemuBinary = findQemu();
const describeLive = qemuBinary ? describe : describe.skip;

describeLive('the guest console draws a real machine', () => {
  it('receives frames from a genuine QEMU guest and paints something other than black', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-vm-console-'));
    const diskPath = path.join(dir, 'disk.qcow2');
    const pidfilePath = path.join(dir, 'vm.pid');
    let child = null;
    let socket = null;
    try {
      await run(qemuBinary.image, qemu.buildImgCreateArgs({ diskPath, sizeGB: 8 }));
      const { slot, port } = await freeSlot();
      const args = vm.buildVmBootArgs({
        accel: 'tcg',
        memoryMB: 1024,
        cpuCount: 2,
        diskPath,
        vmName: 'RunContainer-console-check',
        consoleSlot: slot,
        qmpPort: 44800 + slot,
        pidfilePath,
        isoPath: null,
        bootFromMedia: false,
      });

      child = spawn(qemuBinary.system, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let qemuOutput = '';
      child.stderr.on('data', (chunk) => { qemuOutput += chunk; });
      child.once('error', (error) => { qemuOutput += String(error.message || error); });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });

      socket = await connect(port, 30000).catch((error) => {
        throw new Error(`QEMU never opened its console on port ${port}: ${error.message}. QEMU said: ${qemuOutput.trim().slice(0, 300)}`);
      });

      const frames = [];
      const size = { width: 0, height: 0 };
      let handshook = false;
      let failure = null;
      let arrived = null;
      const arrived$ = new Promise((resolve) => { arrived = resolve; });
      const session = new RfbSession({
        onReady: (info) => {
          handshook = true;
          size.width = info.width;
          size.height = info.height;
        },
        // A guest that has not set a video mode yet is announced at 0x0 and resized later,
        // so the size the canvas ends up with is the one to assert on.
        onResize: (width, height) => { size.width = width; size.height = height; },
        onRect: (rect) => { frames.push(rect); if (arrived) arrived(); },
        onError: (message) => { failure = message; if (arrived) arrived(); },
      });
      socket.on('data', (chunk) => {
        if (process.env.RC_VNC_DUMP) {
          try { fs.appendFileSync(process.env.RC_VNC_DUMP, chunk); } catch (error) { /* diagnostic only */ }
        }
        session.receive(chunk);
        for (const message of session.takeOutbox()) socket.write(Buffer.from(message));
      });

      // A drawn frame, a refusal, or a timeout: whichever happens first is the answer.
      await Promise.race([
        arrived$,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`The console drew nothing in ${BOOT_TIMEOUT_MS} ms. QEMU said: ${qemuOutput.trim().slice(0, 300)}`)), BOOT_TIMEOUT_MS)),
      ]);
      if (failure) throw new Error(`The console refused a real guest: ${failure}`);
      expect(handshook).toBe(true);

      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      while (frames.filter((rect) => rect.encoding === 'raw').length === 0 && !failure && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(failure).toBeNull();
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);

      const raw = frames.filter((rect) => rect.encoding === 'raw');
      expect(raw.length).toBeGreaterThan(0);
      let litPixels = 0;
      for (const rect of raw) {
        for (let index = 0; index < rect.rgba.length; index += 4) {
          if (rect.rgba[index] > 32 || rect.rgba[index + 1] > 32 || rect.rgba[index + 2] > 32) litPixels += 1;
        }
      }
      // The measurement is reported, not just asserted: a console that drew a black screen
      // would satisfy "a frame arrived" while being exactly the failure this test exists for.
      console.log(`[vm console] guest screen ${size.width}x${size.height}, ${raw.length} raw frame(s), ${litPixels} lit pixel(s)`);
      expect(litPixels).toBeGreaterThan(200);
    } finally {
      if (socket) { try { socket.destroy(); } catch (error) { /* closed */ } }
      if (child && child.pid) {
        try { spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (error) { /* gone */ }
        try { child.kill(); } catch (error) { /* gone */ }
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { /* best effort */ }
    }
  }, BOOT_TIMEOUT_MS + 60000);
});
