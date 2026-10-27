// Virtual machines: the developer-mode feature that runs an operating system from an
// ISO on the custom QEMU backend, with the guest console shown inside a RunContainer
// window instead of a separate native window.
//
// This module is pure: it validates a VM's configuration and builds the QEMU command
// line. Creating disks, spawning QEMU and streaming the console live in the main
// process. Everything here is testable without QEMU and without Windows.
const qemu = require('./qemu-runtime');

// A VM is meant to run a whole operating system, so the floors are higher than an
// application environment's. The ceilings keep a typo from asking for a machine this
// PC cannot back with real memory.
const VM_LIMITS = {
  memoryMB: { min: 1024, max: 32768, step: 128 },
  cpuCount: { min: 1, max: 16 },
  diskGB: { min: 8, max: 512 },
};

// QEMU's VNC syntax maps a display number to port 5900 + display. Slots keep two VMs
// from claiming the same console port, and the range stays inside the conventional
// VNC block so it is obvious what is listening.
const VM_CONSOLE_FIRST_DISPLAY = 10;
const VM_CONSOLE_SLOTS = 20;

const VM_STATUSES = ['Stopped', 'Running', 'Failed'];

function consoleDisplayFor(slot) {
  const index = Number(slot);
  if (!Number.isSafeInteger(index) || index < 0 || index >= VM_CONSOLE_SLOTS) {
    throw new Error(`VM console slot ${slot} is outside 0-${VM_CONSOLE_SLOTS - 1}.`);
  }
  return VM_CONSOLE_FIRST_DISPLAY + index;
}

function consolePortFor(slot) {
  return 5900 + consoleDisplayFor(slot);
}

function vncTargetFor(slot) {
  return `127.0.0.1:${consoleDisplayFor(slot)}`;
}

function validateVmName(name) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 2) return 'Give the virtual machine a name of at least 2 characters.';
  if (trimmed.length > 60) return 'Keep the name to 60 characters or fewer.';
  if (/[\\/:*?"<>|]/.test(trimmed)) return 'A VM name cannot contain \\ / : * ? " < > or |.';
  return null;
}

function validateVmConfig({ name, memoryMB, cpuCount, diskGB, isoPath } = {}) {
  const errors = [];
  const nameError = validateVmName(name);
  if (nameError) errors.push(nameError);

  const memory = Number(memoryMB);
  if (!Number.isSafeInteger(memory)) errors.push('Memory must be a whole number of megabytes.');
  else if (memory < VM_LIMITS.memoryMB.min) errors.push(`Give the VM at least ${VM_LIMITS.memoryMB.min} MB of memory.`);
  else if (memory > VM_LIMITS.memoryMB.max) errors.push(`At most ${VM_LIMITS.memoryMB.max} MB of memory can be given to a VM.`);

  const cpus = Number(cpuCount);
  if (!Number.isSafeInteger(cpus)) errors.push('CPU count must be a whole number.');
  else if (cpus < VM_LIMITS.cpuCount.min) errors.push('A VM needs at least one CPU.');
  else if (cpus > VM_LIMITS.cpuCount.max) errors.push(`At most ${VM_LIMITS.cpuCount.max} CPUs can be given to a VM.`);

  const disk = Number(diskGB);
  if (!Number.isSafeInteger(disk)) errors.push('Disk size must be a whole number of gigabytes.');
  else if (disk < VM_LIMITS.diskGB.min) errors.push(`The virtual disk must be at least ${VM_LIMITS.diskGB.min} GB.`);
  else if (disk > VM_LIMITS.diskGB.max) errors.push(`The virtual disk cannot exceed ${VM_LIMITS.diskGB.max} GB.`);

  // The ISO is optional at creation time: a VM whose disk already holds an installed
  // system boots without one, and media can be attached later.
  if (isoPath !== undefined && isoPath !== null && String(isoPath) !== '') {
    const value = String(isoPath);
    if (!/\.(iso|img)$/i.test(value)) errors.push('The installation media must be an .iso or .img file.');
  }

  return { ok: errors.length === 0, errors };
}

// A short, stable id: it names the disk file, so it must never contain a path
// separator or anything a filesystem dislikes.
function newVmId() {
  const random = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `vm-${Date.now().toString(36)}-${random}`;
}

function vmDiskPath(vmDir, id) {
  if (!vmDir || !id) throw new Error('A VM disk needs a directory and an id.');
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`Refusing to build a disk path from "${id}".`);
  return `${vmDir}\\${id}.qcow2`;
}

function defaultVmRecord(overrides = {}) {
  const id = overrides.id || newVmId();
  return {
    id,
    name: String(overrides.name || 'Virtual machine').trim(),
    memoryMB: Number(overrides.memoryMB) || 4096,
    cpuCount: Number(overrides.cpuCount) || 2,
    diskGB: Number(overrides.diskGB) || 40,
    // Media the user owns. Nothing is downloaded or bundled with RunContainer.
    isoPath: overrides.isoPath ? String(overrides.isoPath) : null,
    diskPath: overrides.diskPath ? String(overrides.diskPath) : null,
    consoleSlot: Number.isSafeInteger(overrides.consoleSlot) ? overrides.consoleSlot : null,
    bootFromMedia: overrides.bootFromMedia !== false,
    createdAt: overrides.createdAt || new Date().toISOString(),
    lastBootAt: overrides.lastBootAt || null,
    accel: overrides.accel || null,
  };
}

// The guest console is the point of this feature, so the display is QEMU's VNC server
// bound to loopback and nothing is drawn by QEMU itself (`-display none`). A USB tablet
// is attached because it gives the guest absolute pointer coordinates, which is what
// makes a remote display usable as a mouse instead of a relative one that drifts.
//
// Two things are deliberately NOT here, and both were the reason a machine in this tab
// booted to a blank console:
//
// - No guest-agent channel. It is a `pipe` chardev, and QEMU on Windows stalls machine
//   init until a host process connects to that pipe. This feature has no guest-agent
//   integration, so nothing ever connected: QEMU opened its console port, RunContainer
//   reported the machine running, and the guest never executed its first instruction.
// - No virtio disk. The media the user supplies is a stock installer with no virtio
//   driver, so the guest's own setup could not see its disk. `ide` attaches to q35's
//   AHCI controller, which every installer recognises.
function buildVmBootArgs({
  accel,
  memoryMB,
  cpuCount,
  diskPath,
  vmName,
  consoleSlot,
  qmpPort,
  pidfilePath,
  isoPath,
  bootFromMedia = true,
} = {}) {
  const config = validateVmConfig({ name: vmName, memoryMB, cpuCount, diskGB: VM_LIMITS.diskGB.min, isoPath });
  if (!config.ok) throw new Error(config.errors.join(' '));
  if (!diskPath) throw new Error('A VM needs a disk image to boot.');

  return qemu.buildQemuBootArgs({
    accel,
    memoryMB: Number(memoryMB),
    cpuCount: Number(cpuCount),
    diskPath,
    qmpPort,
    pidfilePath,
    vmName,
    display: 'none',
    diskInterface: 'ide',
    guestAgent: false,
    cdrom: isoPath || undefined,
    // 'd' boots the attached media first, which is what an install needs; a VM whose
    // system is already installed boots from its disk.
    bootOrder: isoPath && bootFromMedia ? 'd' : 'c',
    extraArgs: [
      '-vnc', vncTargetFor(consoleSlot),
      // The tablet gives the guest absolute pointer coordinates, so the drawn console is
      // usable as a mouse. It needs a controller to sit on: q35 has no USB bus of its own,
      // and QEMU does not quietly drop an unparented device — it exits before the guest
      // runs at all ("-device usb-tablet: No 'usb-bus' bus found for device 'usb-tablet'"),
      // which is a machine that starts, reports itself running, and can never draw.
      '-device', 'qemu-xhci',
      '-device', 'usb-tablet',
    ],
  });
}

// What the interface is allowed to know about a VM. Kept apart from the stored record
// so paths and internal ids never leak into the UI by accident.
function summarizeVm(record, { running = false, consoleSlot = null } = {}) {
  if (!record?.id) return null;
  return {
    id: record.id,
    name: record.name,
    memoryMB: record.memoryMB,
    cpuCount: record.cpuCount,
    diskGB: record.diskGB,
    isoPath: record.isoPath || null,
    isoName: record.isoPath ? String(record.isoPath).split(/[\\/]/).pop() : null,
    diskName: record.diskPath ? String(record.diskPath).split(/[\\/]/).pop() : null,
    createdAt: record.createdAt,
    lastBootAt: record.lastBootAt || null,
    accel: record.accel || null,
    status: running ? 'Running' : 'Stopped',
    consolePort: running && Number.isSafeInteger(consoleSlot) ? consolePortFor(consoleSlot) : null,
  };
}

// --- Lifecycle: a machine must not outlive the app invisibly --------------------------
//
// A VM runs in its own process, so a guest keeps running while the interface is busy.
// That process is detached, which means it also survives RunContainer being closed or
// killed — and the record on disk was the only thing that knew nothing about it. A machine
// that was really running, holding its disk and its console port, was therefore drawn as
// "Stopped", and pressing Start would have booted a SECOND QEMU on the same disk, which is
// how a guest's filesystem gets corrupted. The record now carries the QEMU pid, and
// everything that decides whether a machine may be started asks the real world first.

// QEMU is given this path with -pidfile, so the number is written by QEMU itself rather
// than guessed from a process list.
function vmPidFile(vmDir, id) {
  if (!vmDir || !id) throw new Error('A VM pid file needs a directory and an id.');
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`Refusing to build a pid path from "${id}".`);
  return `${vmDir}\\${id}.pid`;
}

// A pid file survives the process that wrote it, so the number in it means nothing on its
// own: only the caller can say whether that process is still alive.
function readVmPid(value) {
  const pid = Number(String(value === undefined || value === null ? '' : value).trim().split(/\s+/)[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

// The status the interface should show for each stored machine, and whether its disk is
// still held by a QEMU process this session did not start.
function reconcileVmRecords(records, { isAlive } = {}) {
  const alive = typeof isAlive === 'function' ? isAlive : () => false;
  return (Array.isArray(records) ? records : []).map((record) => {
    const pid = readVmPid(record?.qemuPid);
    const leftover = Number.isSafeInteger(pid) && alive(pid);
    return {
      id: record?.id,
      name: record?.name || 'Virtual machine',
      qemuPid: Number.isSafeInteger(pid) ? pid : null,
      leftover,
      status: leftover ? 'Running' : 'Stopped',
    };
  });
}

// Why a machine may not be started right now, in the words the interface shows. This
// refuses before QEMU is touched rather than starting and hoping: two machines on one disk
// is the one mistake here that cannot be repaired afterwards.
function vmStartRefusal({ running, leftover, diskPath, diskExists } = {}) {
  if (running) return 'That virtual machine is already running.';
  if (leftover) return 'This machine is still running from a previous session, so its disk is in use. Stop it first — starting it again would boot a second machine on the same disk.';
  if (!diskPath) return 'This VM has no disk image recorded, so there is nothing to boot.';
  if (diskExists === false) return 'This VM\u2019s disk image is missing, so there is nothing to boot.';
  return null;
}

module.exports = {
  VM_LIMITS,
  vmPidFile,
  readVmPid,
  reconcileVmRecords,
  vmStartRefusal,
  VM_CONSOLE_FIRST_DISPLAY,
  VM_CONSOLE_SLOTS,
  VM_STATUSES,
  consoleDisplayFor,
  consolePortFor,
  vncTargetFor,
  validateVmName,
  validateVmConfig,
  newVmId,
  vmDiskPath,
  defaultVmRecord,
  buildVmBootArgs,
  summarizeVm,
};
