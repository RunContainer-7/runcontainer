const vm = require('../../public/vm-runtime');
const qemu = require('../../public/qemu-runtime');

// A VM here runs a whole operating system, so these are the rules that decide whether a
// configuration is allowed to touch this PC's memory, disk and console ports at all.
describe('virtual machine configuration', () => {
  it('accepts a sane machine and rejects the numbers that would hurt this PC', () => {
    expect(vm.validateVmConfig({
      name: 'Ubuntu test',
      memoryMB: 4096,
      cpuCount: 2,
      diskGB: 40,
      isoPath: 'C:\\isos\\ubuntu.iso',
    }).ok).toBe(true);

    const tooSmall = vm.validateVmConfig({ name: 'Tiny', memoryMB: 100, cpuCount: 0, diskGB: 2 });
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.errors.join(' ')).toContain('at least 1024 MB');
    expect(tooSmall.errors.join(' ')).toContain('at least one CPU');
    expect(tooSmall.errors.join(' ')).toContain('at least 8 GB');

    expect(vm.validateVmConfig({ name: 'Huge', memoryMB: 999999, cpuCount: 99, diskGB: 9999 }).ok).toBe(false);
  });

  it('keeps a VM name safe to use as a file name', () => {
    expect(vm.validateVmName('Windows 11 test')).toBeNull();
    expect(vm.validateVmName('x')).toContain('at least 2');
    expect(vm.validateVmName('a/b')).toContain('cannot contain');
    expect(vm.validateVmName('a'.repeat(61))).toContain('60 characters');
  });

  it('only accepts real installation media', () => {
    expect(vm.validateVmConfig({ name: 'Media', memoryMB: 2048, cpuCount: 2, diskGB: 20, isoPath: 'C:\\a\\setup.exe' }).ok).toBe(false);
    expect(vm.validateVmConfig({ name: 'Media', memoryMB: 2048, cpuCount: 2, diskGB: 20, isoPath: 'C:\\a\\disk.img' }).ok).toBe(true);
    // Media is optional: an installed VM boots from its own disk.
    expect(vm.validateVmConfig({ name: 'Installed', memoryMB: 2048, cpuCount: 2, diskGB: 20, isoPath: null }).ok).toBe(true);
  });

  it('refuses to build a disk path from an id containing a separator', () => {
    expect(vm.vmDiskPath('C:\\vms', 'vm-abc-123')).toBe('C:\\vms\\vm-abc-123.qcow2');
    expect(() => vm.vmDiskPath('C:\\vms', '..\\..\\etc\\passwd')).toThrow();
    expect(() => vm.vmDiskPath('C:\\vms', 'vm/a')).toThrow();
  });
});

describe('virtual machine console', () => {
  it('gives each slot a distinct loopback console port', () => {
    expect(vm.consolePortFor(0)).toBe(5910);
    expect(vm.consolePortFor(1)).toBe(5911);
    expect(vm.vncTargetFor(0)).toBe('127.0.0.1:10');
    expect(() => vm.consolePortFor(vm.VM_CONSOLE_SLOTS)).toThrow();
    expect(() => vm.consolePortFor(-1)).toThrow();
  });
});

describe('QEMU command line for a VM', () => {
  const base = {
    accel: 'tcg',
    memoryMB: 4096,
    cpuCount: 2,
    diskPath: 'C:\\vms\\disk.qcow2',
    vmName: 'Test VM',
    consoleSlot: 0,
    qmpPort: 44800,
    pidfilePath: 'C:\\vms\\vm.pid',
  };

  it('draws no window of its own and serves the guest over loopback VNC', () => {
    const args = vm.buildVmBootArgs({ ...base, isoPath: 'C:\\isos\\ubuntu.iso', bootFromMedia: true });
    expect(args).toEqual(expect.arrayContaining(['-display', 'none', '-vnc', '127.0.0.1:10']));
    // Absolute pointer input is what makes a drawn console usable as a mouse — and the
    // tablet needs a USB controller to attach to, or QEMU exits instead of booting.
    expect(args).toEqual(expect.arrayContaining(['-device', 'usb-tablet']));
    expect(args.indexOf('qemu-xhci')).toBeGreaterThan(-1);
    expect(args.indexOf('qemu-xhci')).toBeLessThan(args.indexOf('usb-tablet'));
    expect(args.join(' ')).not.toContain('sdl');
  });

  it('opens no guest-agent channel, which would stall the boot before any guest runs', () => {
    // A `pipe` chardev waits for a host process to connect. Nothing in this feature ever
    // connects, and a machine started that way serves a console that never draws anything,
    // so the channel is absent rather than merely unused.
    const args = vm.buildVmBootArgs({ ...base, isoPath: 'C:\\isos\\ubuntu.iso', bootFromMedia: true });
    const line = args.join(' ');
    expect(line).not.toContain('chardev');
    expect(line).not.toContain('virtserialport');
    expect(line).not.toContain('guest_agent');
    expect(() => qemu.buildQemuBootArgs({
      accel: 'tcg', memoryMB: 4096, cpuCount: 2, diskPath: 'd.qcow2',
      qmpPort: 44800, pidfilePath: 'f', vmName: 'n', guestAgent: true,
    })).toThrow();
  });

  it('attaches the disk in a way an unmodified installer can see', () => {
    const args = vm.buildVmBootArgs({ ...base, isoPath: null, bootFromMedia: false });
    expect(args.join(' ')).toContain('if=ide');
    expect(args.join(' ')).not.toContain('if=virtio');
  });

  it('boots attached media first for an install, and the disk otherwise', () => {
    const installing = vm.buildVmBootArgs({ ...base, isoPath: 'C:\\isos\\windows.iso', bootFromMedia: true });
    expect(installing.join(' ')).toContain('-boot order=d');
    expect(installing).toEqual(expect.arrayContaining(['-cdrom', 'C:\\isos\\windows.iso']));

    const installed = vm.buildVmBootArgs({ ...base, isoPath: null, bootFromMedia: true });
    expect(installed.join(' ')).toContain('-boot order=c');
    expect(installed).not.toContain('-cdrom');

    // Media stays attached but is not booted, which is how a second install is avoided.
    const attachedOnly = vm.buildVmBootArgs({ ...base, isoPath: 'C:\\isos\\windows.iso', bootFromMedia: false });
    expect(attachedOnly.join(' ')).toContain('-boot order=c');
    expect(attachedOnly).toEqual(expect.arrayContaining(['-cdrom', 'C:\\isos\\windows.iso']));
  });

  it('refuses to build a boot command for an invalid configuration', () => {
    expect(() => vm.buildVmBootArgs({ ...base, memoryMB: 32 })).toThrow();
    expect(() => vm.buildVmBootArgs({ ...base, consoleSlot: 999 })).toThrow();
    expect(() => vm.buildVmBootArgs({ ...base, diskPath: '' })).toThrow();
    // The accelerator is validated by the QEMU builder, so a typo fails closed.
    expect(() => vm.buildVmBootArgs({ ...base, accel: 'turbo' })).toThrow();
  });

  it('reuses the engine VM args, so a VM and an environment boot the same way', () => {
    const args = vm.buildVmBootArgs({ ...base, isoPath: null });
    const engineArgs = qemu.buildQemuBootArgs({
      accel: 'tcg', memoryMB: 4096, cpuCount: 2, diskPath: 'C:\\vms\\disk.qcow2',
      qmpPort: 44800, agentPipe: 'p', pidfilePath: 'f', vmName: 'Test VM', display: 'none',
    });
    for (const token of ['-rtc', 'base=localtime', '-nic', 'none', '-machine', 'q35']) {
      expect(args).toEqual(expect.arrayContaining([token]));
      expect(engineArgs).toEqual(expect.arrayContaining([token]));
    }
  });
});

describe('what the interface is told about a VM', () => {
  it('reports state and names without leaking full paths', () => {
    const record = vm.defaultVmRecord({
      name: 'Windows 11',
      memoryMB: 8192,
      cpuCount: 4,
      diskGB: 80,
      diskPath: 'C:\\Users\\someone\\AppData\\Roaming\\RunContainer\\vms\\vm-1.qcow2',
      isoPath: 'D:\\media\\Win11.iso',
      accel: 'whpx',
    });
    const summary = vm.summarizeVm(record, { running: true, consoleSlot: 2 });
    expect(summary).toMatchObject({
      name: 'Windows 11',
      memoryMB: 8192,
      cpuCount: 4,
      diskGB: 80,
      status: 'Running',
      consolePort: 5912,
      isoName: 'Win11.iso',
      diskName: 'vm-1.qcow2',
      accel: 'whpx',
    });
    expect(summary.diskPath).toBeUndefined();
    expect(vm.summarizeVm(null)).toBeNull();
    expect(vm.summarizeVm(record, { running: false }).consolePort).toBeNull();
  });

  it('shows a machine whose QEMU process outlived the app as running, not stopped', () => {
    // The bug this covers: the process is detached, so it survives RunContainer closing.
    // The record then said "Stopped" while QEMU still held the disk and the console port,
    // and Start would have booted a second machine on that same disk.
    const records = [
      { id: 'a', name: 'Left over', qemuPid: 4242 },
      { id: 'b', name: 'Really stopped', qemuPid: 1111 },
      { id: 'c', name: 'Never started' },
    ];
    const seen = vm.reconcileVmRecords(records, { isAlive: (pid) => pid === 4242 });
    expect(seen[0]).toMatchObject({ status: 'Running', leftover: true, qemuPid: 4242 });
    expect(seen[1]).toMatchObject({ status: 'Stopped', leftover: false, qemuPid: 1111 });
    expect(seen[2]).toMatchObject({ status: 'Stopped', leftover: false, qemuPid: null });
    // With nothing to ask, nothing may be claimed as running.
    expect(vm.reconcileVmRecords(records)[0].status).toBe('Stopped');
    expect(vm.reconcileVmRecords(null)).toEqual([]);
  });

  it('reads a pid out of a pid file, and reads nothing out of nonsense', () => {
    expect(vm.readVmPid('4242')).toBe(4242);
    expect(vm.readVmPid('4242\n')).toBe(4242);
    expect(vm.readVmPid('')).toBeNull();
    expect(vm.readVmPid('not a pid')).toBeNull();
    expect(vm.readVmPid('-5')).toBeNull();
    expect(vm.readVmPid(undefined)).toBeNull();
  });

  it('refuses to start a machine whose disk is still in use, and says why', () => {
    expect(vm.vmStartRefusal({ running: true, diskPath: 'C:\\vms\\d.qcow2', diskExists: true }))
      .toContain('already running');
    expect(vm.vmStartRefusal({ leftover: true, diskPath: 'C:\\vms\\d.qcow2', diskExists: true }))
      .toContain('previous session');
    expect(vm.vmStartRefusal({ diskPath: '', diskExists: false })).toContain('no disk image');
    expect(vm.vmStartRefusal({ diskPath: 'C:\\vms\\gone.qcow2', diskExists: false })).toContain('missing');
    expect(vm.vmStartRefusal({ diskPath: 'C:\\vms\\d.qcow2', diskExists: true })).toBeNull();
  });

  it('keeps a pid file path inside the VM directory, or refuses', () => {
    expect(vm.vmPidFile('C:\\vms', 'vm-abc-123')).toBe('C:\\vms\\vm-abc-123.pid');
    expect(() => vm.vmPidFile('C:\\vms', '../escape')).toThrow();
    expect(() => vm.vmPidFile('', 'vm-1')).toThrow();
  });
});
