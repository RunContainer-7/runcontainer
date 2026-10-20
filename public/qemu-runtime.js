// RCVM genuine virtual-machine backend, powered by QEMU.
//
// This module builds everything RunContainer needs to manage a REAL virtual
// machine per environment: QEMU discovery, acceleration probing (WHPX with TCG
// fallback), qcow2 disk creation (per-env overlays on a read-only base image),
// boot arguments, and the QMP management protocol (status, shutdown, quit,
// guest-agent exec/file/shutdown). All builders are pure and unit tested.
//
// What QEMU does NOT supply (honest boundaries, enforced in main.js, not here):
// - No guest OS or Windows licence comes with QEMU. The base image must be
//   provisioned from media the user owns (first-run provisioning workflow).
// - No network cut-off is claimed from disk isolation alone; env VMs boot with
//   `-nic none` (no virtual network at all) by default.
// - QEMU is NOT bundled (GPLv2 source-offer burden, ~200MB experimental Windows
//   builds). RunContainer detects an installed QEMU and guides setup instead.
//   See THIRD_PARTY_NOTICES.md.
//
// Verified 2026-10-20 against real QEMU 11.0.50 on Windows 10 Pro:
// qemu-img create works; `-accel whpx` AND `-accel tcg` both reach QMP
// `prelaunch` via TCP; query-status/quit round-trip works (see lifecycle probe).

const crypto = require('crypto');
const path = require('path');

const QEMU_SYSTEM_BINARY = 'qemu-system-x86_64.exe';
const QEMU_IMG_BINARY = 'qemu-img.exe';
// Minimum QEMU with the WHPX/TCG behaviour this backend relies on.
const QEMU_MIN_VERSION = '8.0.0';
const QEMU_ACCELS = ['whpx', 'tcg'];
const QEMU_UPDATE_STATE_VERSION = 1;

// 'QEMU emulator version 11.0.50 (v11.0.0-12631-g54e84cdc7a)' -> '11.0.50'.
function parseQemuVersion(text) {
  const match = String(text || '').match(/version\s+(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function compareDotted(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function isSupportedQemuVersion(version) {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  return compareDotted(version, QEMU_MIN_VERSION) >= 0;
}

// Ordered search locations for an installed QEMU. Pure: main.js stats each.
function candidateQemuDirs({ bundledDir, programFiles, programFilesX86 } = {}) {
  const dirs = [];
  if (bundledDir) dirs.push(bundledDir);
  if (process.env.QEMU_HOME) dirs.push(process.env.QEMU_HOME);
  for (const base of [programFiles, programFilesX86]) {
    if (base) dirs.push(path.join(base, 'qemu'));
  }
  return dirs;
}

function validateQemuVmConfig({ memoryMB, cpuCount, diskGB } = {}) {
  const memory = memoryMB === undefined || memoryMB === null || memoryMB === ''
    ? 4096 : Number(memoryMB);
  const cpu = cpuCount === undefined || cpuCount === null || cpuCount === ''
    ? 2 : Number(cpuCount);
  const disk = diskGB === undefined || diskGB === null || diskGB === ''
    ? 40 : Number(diskGB);
  if (!Number.isSafeInteger(memory) || memory < 512 || memory > 32768) {
    return { ok: false, reason: 'VM memory must be 512–32768 MB.' };
  }
  if (!Number.isSafeInteger(cpu) || cpu < 1 || cpu > 16) {
    return { ok: false, reason: 'VM CPUs must be 1–16.' };
  }
  if (!Number.isSafeInteger(disk) || disk < 8 || disk > 500) {
    return { ok: false, reason: 'VM disk must be 8–500 GB.' };
  }
  return { ok: true, config: { memoryMB: memory, cpuCount: cpu, diskGB: disk } };
}

// Disk-deletion safety: only this environment's disk.qcow2, inside its qemu/
// dir, never the shared base image.
function validateQemuDiskTarget({ candidate, envDir, baseImagePath } = {}) {
  if (!candidate || !envDir) return { ok: false, reason: 'Missing disk path.' };
  const qemuDir = path.join(envDir, 'qemu');
  const resolved = path.resolve(candidate);
  if (path.basename(resolved) !== 'disk.qcow2' && path.basename(resolved) !== 'transfer.qcow2') {
    return { ok: false, reason: `Refusing to delete ${resolved}: not this environment's VM disk.` };
  }
  const rel = path.relative(path.resolve(qemuDir), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: `Refusing to delete ${resolved}: outside this environment.` };
  }
  if (baseImagePath && resolved.toLowerCase() === path.resolve(baseImagePath).toLowerCase()) {
    return { ok: false, reason: 'Refusing to delete the shared base image.' };
  }
  return { ok: true, disk: resolved };
}

function qemuEnvPaths(sandboxRoot) {
  const qemuDir = path.join(sandboxRoot, 'qemu');
  return {
    qemuDir,
    diskPath: path.join(qemuDir, 'disk.qcow2'),
    vmConfigPath: path.join(qemuDir, 'vm.json'),
    pidfilePath: path.join(qemuDir, 'vm.pid'),
  };
}

// Deterministic per-env QMP port in 43000–43999, stored on the app record.
function qmpPortFor(appId) {
  const hash = crypto.createHash('sha256').update(`qmp:${String(appId)}`).digest();
  return 43000 + (hash.readUInt16BE(0) % 1000);
}

// Guest-agent channel: virtio-serial device inside the guest, Windows named pipe
// on the host. The QEMU `pipe` backend takes a BARE pipe name (it creates
// \\.\pipe\<name> itself); Node connects to agentPipePath(name). Verified:
// the host must connect promptly after spawn or machine init stalls.
function agentPipeFor(appId) {
  const hash = crypto.createHash('sha256').update(`agent:${String(appId)}`).digest('hex').slice(0, 12);
  return `rc-qemu-agent-${hash}`;
}

function agentPipePath(pipeName) {
  return `\\\\.\\pipe\\${pipeName}`;
}

function shortVmName(appId) {
  const hash = crypto.createHash('sha256').update(String(appId)).digest('hex').slice(0, 8);
  return `RunContainer-${hash}`;
}

function buildImgCreateArgs({ diskPath, sizeGB, format = 'qcow2' }) {
  if (!diskPath) throw new Error('qemu-img needs a disk path.');
  if (!Number.isSafeInteger(sizeGB) || sizeGB < 1 || sizeGB > 1000) {
    throw new Error('Disk size must be 1–1000 GB.');
  }
  return ['create', '-f', format, diskPath, `${sizeGB}G`];
}

// Per-env overlay on the read-only base image: the deliberate safe-sharing
// mechanism. Env writes go to the overlay; the base is never modified.
function buildImgCreateOverlayArgs({ overlayPath, basePath, format = 'qcow2' }) {
  if (!overlayPath || !basePath) throw new Error('Overlay needs both paths.');
  return ['create', '-f', format, '-b', basePath, '-F', format, overlayPath];
}

function buildImgInfoArgs({ diskPath }) {
  if (!diskPath) throw new Error('qemu-img info needs a disk path.');
  return ['info', '--output=json', diskPath];
}

// Full boot arguments for an environment VM. No virtual network by default
// (-nic none): the management channel is QMP on localhost, file transfer and
// commands go through the guest agent, and networking stays off unless the
// user explicitly enables it later.
function buildQemuBootArgs({
  machine = 'q35',
  accel = 'whpx',
  memoryMB,
  cpuCount,
  diskPath,
  qmpPort,
  agentPipe,
  pidfilePath,
  vmName,
  display = 'sdl',
  cdrom,
  bootOrder,
  extraArgs = [],
} = {}) {
  if (!QEMU_ACCELS.includes(accel)) throw new Error(`Unknown accelerator "${accel}".`);
  if (!diskPath || !qmpPort || !agentPipe || !pidfilePath || !vmName) {
    throw new Error('QEMU boot needs disk, QMP port, agent pipe, pidfile, and VM name.');
  }
  if (!Number.isSafeInteger(memoryMB) || !Number.isSafeInteger(cpuCount)) {
    throw new Error('QEMU boot needs numeric memory/CPU (validate first).');
  }
  const args = [
    '-name', vmName,
    '-machine', machine,
    '-accel', accel,
    '-m', String(memoryMB),
    '-smp', String(cpuCount),
    '-rtc', 'base=localtime',
    '-display', display,
    '-nic', 'none',
    '-drive', `file=${diskPath},format=qcow2,if=virtio`,
    '-device', 'virtio-serial-pci',
    '-chardev', `pipe,path=${agentPipe},id=rcagent`,
    '-device', 'virtserialport,chardev=rcagent,name=org.qemu.guest_agent.0',
    '-qmp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
    '-pidfile', pidfilePath,
  ];
  if (cdrom) args.push('-cdrom', cdrom);
  if (bootOrder) args.push('-boot', `order=${bootOrder}`);
  return args.concat(extraArgs);
}

// Acceleration probe: `-machine none -S` sits still when the accelerator
// initializes (killed by timeout = supported); a fast failed exit = unsupported.
function buildAccelProbeArgs({ accel }) {
  if (!QEMU_ACCELS.includes(accel)) throw new Error(`Unknown accelerator "${accel}".`);
  return ['-accel', accel, '-machine', 'none', '-display', 'none', '-S'];
}

function parseAccelProbe({ accel, timedOut, exitCode, stderr }) {
  // WHPX prints a perf-monitoring warning on machines where it still works,
  // so scrub that known-benign line before looking for real failures.
  const output = String(stderr || '').replace(/warning: WHPX: Failed to get performance monitoring features[^\r\n]*/g, '');
  const failed = /failed to initialize|not available|could not|error:|failed to get/i.test(output);
  if (timedOut) {
    return failed
      ? { supported: false, reason: `${accel} printed errors before the probe timeout.` }
      : { supported: true, reason: `${accel} initialized and held (probe timeout reached).` };
  }
  if (exitCode === 0 && !failed) return { supported: true, reason: `${accel} exited cleanly.` };
  return { supported: false, reason: `${accel} is not usable here: ${(output.trim().split('\n')[0] || `exit ${exitCode}`).slice(0, 200)}` };
}

// --- QMP framing ------------------------------------------------------------
// One JSON object per line. Responses carry the request's `id` when provided.
function qmpFrame(command, args, id) {
  const frame = { execute: command };
  if (args && Object.keys(args).length > 0) frame.arguments = args;
  if (id !== undefined) frame.id = id;
  return `${JSON.stringify(frame)}\n`;
}

function parseQmpStream(buffer) {
  const messages = [];
  const parts = String(buffer || '').split('\n');
  const rest = parts.pop();
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch (error) {
      // Partial/corrupt line: ignore, the next chunk completes it.
    }
  }
  return { messages, rest };
}

const QMP = {
  handshake: () => qmpFrame('qmp_capabilities'),
  queryStatus: (id) => qmpFrame('query-status', undefined, id),
  systemPowerdown: (id) => qmpFrame('system_powerdown', undefined, id),
  quit: (id) => qmpFrame('quit', undefined, id),
  guestPing: (id) => qmpFrame('guest-ping', undefined, id),
  guestExec: ({ path: exePath, args = [], captureOutput = false }, id) => {
    if (!exePath) throw new Error('guest-exec needs a guest path.');
    return qmpFrame('guest-exec', { path: exePath, arg: args, 'capture-output': captureOutput }, id);
  },
  guestExecStatus: (pid, id) => qmpFrame('guest-exec-status', { pid }, id),
  guestShutdown: (mode = 'powerdown', id) => qmpFrame('guest-shutdown', { mode }, id),
  guestFileOpen: (guestPath, id) => qmpFrame('guest-file-open', { path: guestPath, mode: 'wb' }, id),
  guestFileWrite: (handle, base64Chunk, id) => qmpFrame('guest-file-write', { handle, 'buf-b64': base64Chunk }, id),
  guestFileClose: (handle, id) => qmpFrame('guest-file-close', { handle }, id),
};

function qmpStatusOf(response) {
  return response?.return?.status || null;
}

module.exports = {
  QEMU_SYSTEM_BINARY,
  QEMU_IMG_BINARY,
  QEMU_MIN_VERSION,
  QEMU_ACCELS,
  QEMU_UPDATE_STATE_VERSION,
  parseQemuVersion,
  isSupportedQemuVersion,
  candidateQemuDirs,
  validateQemuVmConfig,
  validateQemuDiskTarget,
  qemuEnvPaths,
  qmpPortFor,
  agentPipeFor,
  agentPipePath,
  shortVmName,
  buildImgCreateArgs,
  buildImgCreateOverlayArgs,
  buildImgInfoArgs,
  buildQemuBootArgs,
  buildAccelProbeArgs,
  parseAccelProbe,
  qmpFrame,
  parseQmpStream,
  QMP,
  qmpStatusOf,
};
