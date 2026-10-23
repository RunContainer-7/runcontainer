const {
  parsePe,
  classifyPe,
  detectRuntime,
  runtimeEnvironment,
  normalizeStrategy,
  strategyLabel,
  sanitizeEnvironment,
} = require('./runtimeProfile');

// Minimal but structurally valid PE image: enough for the header walk that
// detection performs. `managed` sets the CLR runtime data-directory entry.
function buildPe({ is64 = true, managed = false, machine = 0x8664 } = {}) {
  const peOffset = 0x80;
  const optionalSize = is64 ? 240 : 224;
  const buffer = Buffer.alloc(peOffset + 24 + optionalSize + 16);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write('PE\u0000\u0000', peOffset, 'ascii');
  buffer.writeUInt16LE(machine, peOffset + 4);
  buffer.writeUInt16LE(1, peOffset + 6); // number of sections
  buffer.writeUInt16LE(optionalSize, peOffset + 20);
  const optionalStart = peOffset + 24;
  buffer.writeUInt16LE(is64 ? 0x20b : 0x10b, optionalStart);
  buffer.writeUInt16LE(3, optionalStart + 68); // console subsystem
  const dirCountOffset = optionalStart + (is64 ? 108 : 92);
  const dirStart = optionalStart + (is64 ? 112 : 96);
  buffer.writeUInt32LE(16, dirCountOffset);
  if (managed) {
    buffer.writeUInt32LE(0x2000, dirStart + 14 * 8); // COM descriptor RVA
    buffer.writeUInt32LE(0x48, dirStart + 14 * 8 + 4);
  }
  return buffer;
}

describe('runtime detection', () => {
  it('reads a native 64-bit console image as native code', () => {
    const pe = parsePe(buildPe({ managed: false }));
    expect(pe).toMatchObject({ machine: 'x64', subsystem: 'Windows console', is64: true, managed: false });
    expect(classifyPe(pe).kind).toBe('native');
    expect(classifyPe(pe).jit).toContain('Already compiled machine code');
  });

  it('reads a managed image as .NET, not as native', () => {
    const runtime = detectRuntime(buildPe({ managed: true }));
    expect(runtime.kind).toBe('dotnet');
    expect(runtime.label).toBe('Managed .NET');
  });

  it('handles 32-bit optional headers too', () => {
    const pe = parsePe(buildPe({ is64: false, machine: 0x014c, managed: true }));
    expect(pe).toMatchObject({ machine: 'x86', is64: false, managed: true });
  });

  it('refuses to guess for files it cannot read', () => {
    expect(parsePe(null)).toBeNull();
    expect(parsePe(Buffer.from('not an executable'))).toBeNull();
    // A truncated header must not throw or report a runtime.
    const truncated = buildPe().subarray(0, 0x90);
    expect(detectRuntime(truncated).kind).toBe('unknown');
    expect(detectRuntime(Buffer.alloc(0)).kind).toBe('unknown');
  });
});

describe('JIT strategy', () => {
  it('only sets documented .NET switches, and only for managed apps', () => {
    expect(runtimeEnvironment('fast-start', 'native')).toEqual({});
    expect(runtimeEnvironment('auto', 'dotnet')).toEqual({});
    expect(runtimeEnvironment('fast-start', 'dotnet')).toEqual({
      DOTNET_TieredCompilation: '0',
      DOTNET_TC_QuickJitForLoops: '0',
    });
    expect(runtimeEnvironment('throughput', 'dotnet')).toMatchObject({
      DOTNET_TieredCompilation: '1',
      DOTNET_TieredPGO: '1',
    });
  });

  it('treats unknown strategies as automatic', () => {
    expect(normalizeStrategy('turbo')).toBe('auto');
    expect(normalizeStrategy(undefined)).toBe('auto');
    expect(strategyLabel('fast-start')).toBe('Fast start');
    expect(strategyLabel('auto')).toContain('runtime default');
  });

  it('drops anything outside the allowed environment variables', () => {
    expect(sanitizeEnvironment({
      DOTNET_TieredPGO: '1',
      PATH: 'C:\\evil',
      DOTNET_TieredCompilation: '1; Remove-Item C:\\',
    })).toEqual({ DOTNET_TieredPGO: '1' });
  });
});
