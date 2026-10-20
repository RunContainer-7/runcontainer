const qemu = require('../../public/qemu-runtime');

describe('QEMU genuine-VM backend builders', () => {
  it('parses and gates QEMU versions', () => {
    expect(qemu.parseQemuVersion('QEMU emulator version 11.0.50 (v11.0.0-12631-g54e84cdc7a)')).toBe('11.0.50');
    expect(qemu.parseQemuVersion('qemu-img version 8.2.1')).toBe('8.2.1');
    expect(qemu.parseQemuVersion('garbage')).toBeNull();
    expect(qemu.isSupportedQemuVersion('11.0.50')).toBe(true);
    expect(qemu.isSupportedQemuVersion('8.0.0')).toBe(true);
    expect(qemu.isSupportedQemuVersion('7.2.0')).toBe(false);
    expect(qemu.isSupportedQemuVersion(null)).toBe(false);
  });

  it('validates VM configs server-side', () => {
    expect(qemu.validateQemuVmConfig({ memoryMB: 4096, cpuCount: 2, diskGB: 40 }).ok).toBe(true);
    expect(qemu.validateQemuVmConfig({}).ok).toBe(true);
    expect(qemu.validateQemuVmConfig({ memoryMB: 64 }).ok).toBe(false);
    expect(qemu.validateQemuVmConfig({ cpuCount: 99 }).ok).toBe(false);
    expect(qemu.validateQemuVmConfig({ diskGB: 2 }).ok).toBe(false);
  });

  it('refuses unsafe disk-deletion targets', () => {
    const envDir = 'C:\\data\\env';
    const good = qemu.validateQemuDiskTarget({
      candidate: 'C:\\data\\env\\qemu\\disk.qcow2',
      envDir,
      baseImagePath: 'C:\\vm\\base.qcow2',
    });
    expect(good.ok).toBe(true);
    expect(qemu.validateQemuDiskTarget({ candidate: 'C:\\vm\\base.qcow2', envDir, baseImagePath: 'C:\\vm\\base.qcow2' }).ok).toBe(false);
    expect(qemu.validateQemuDiskTarget({ candidate: 'C:\\data\\other\\disk.qcow2', envDir }).ok).toBe(false);
    expect(qemu.validateQemuDiskTarget({ candidate: 'C:\\data\\env\\evil.exe', envDir }).ok).toBe(false);
  });

  it('builds overlay creation on the read-only base (safe sharing)', () => {
    const args = qemu.buildImgCreateOverlayArgs({ overlayPath: 'e\\disk.qcow2', basePath: 'b\\base.qcow2' });
    expect(args).toContain('-b');
    expect(args).toContain('b\\base.qcow2');
    expect(qemu.buildImgCreateArgs({ diskPath: 'd.qcow2', sizeGB: 40 })).toEqual(
      ['create', '-f', 'qcow2', 'd.qcow2', '40G'],
    );
  });

  it('builds boot args with no virtual network and management channels', () => {
    const args = qemu.buildQemuBootArgs({
      accel: 'whpx', memoryMB: 4096, cpuCount: 2,
      diskPath: 'e\\disk.qcow2', qmpPort: 43001,
      agentPipe: '\\\\.\\pipe\\rc-x', pidfilePath: 'e\\vm.pid', vmName: 'RunContainer-x',
    });
    expect(args).toContain('whpx');
    expect(args).toContain('none'); // -nic none AND -display default check below
    expect(args.join(' ')).toContain('if=virtio');
    expect(args.join(' ')).toContain('org.qemu.guest_agent.0');
    expect(args).toContain('tcp:127.0.0.1:43001,server=on,wait=off');
    expect(args).not.toContain('user'); // no user-mode networking by default
    expect(() => qemu.buildQemuBootArgs({ accel: 'kvm' })).toThrow();
  });

  it('parses accel probes: timeout-hold means usable, fast errors mean not', () => {
    // Real WHPX output seen on Windows 10 Pro: benign warning only.
    expect(qemu.parseAccelProbe({
      accel: 'whpx', timedOut: true,
      stderr: 'qemu: -accel whpx: warning: WHPX: Failed to get performance monitoring features, hr=80370300',
    }).supported).toBe(true);
    expect(qemu.parseAccelProbe({ accel: 'whpx', timedOut: false, exitCode: 1, stderr: 'WHPX: Failed to initialize' }).supported).toBe(false);
    expect(qemu.parseAccelProbe({ accel: 'tcg', timedOut: true, stderr: '' }).supported).toBe(true);
  });

  it('frames QMP and parses streams', () => {
    const frame = qemu.QMP.guestExec({ path: 'C:\\a.exe', args: ['--x'] }, 7);
    expect(frame.endsWith('\n')).toBe(true);
    expect(JSON.parse(frame)).toMatchObject({ execute: 'guest-exec', id: 7 });
    const { messages, rest } = qemu.parseQmpStream('{"QMP":{}}\n{"return":{},"id":7}\npartial');
    expect(messages).toHaveLength(2);
    expect(rest).toBe('partial');
    expect(qemu.qmpStatusOf({ return: { status: 'running' } })).toBe('running');
  });

  it('derives stable per-env ports, pipes, and names', () => {
    expect(qemu.qmpPortFor('abc')).toBe(qemu.qmpPortFor('abc'));
    expect(qemu.qmpPortFor('abc')).toBeGreaterThanOrEqual(43000);
    expect(qemu.qmpPortFor('abc')).toBeLessThan(44000);
    expect(qemu.agentPipeFor('abc')).toMatch(/^rc-qemu-agent-[0-9a-f]{12}$/);
    expect(qemu.agentPipePath(qemu.agentPipeFor('abc')).startsWith('\\\\.\\pipe\\rc-qemu-agent-')).toBe(true);
    expect(qemu.shortVmName('abc')).toMatch(/^RunContainer-[0-9a-f]{8}$/);
  });
});
