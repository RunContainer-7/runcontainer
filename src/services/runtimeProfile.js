// What an .exe actually runs on, and what a "JIT" setting can honestly do.
//
// A native Windows executable is already machine code: there is no intermediate
// language for a just-in-time compiler to translate, so no switch can make it
// "use JIT". A managed .NET executable *is* IL until the .NET runtime compiles
// it, and that runtime already JITs it by default. What a user can choose is how
// the .NET runtime balances startup work against steady-state speed; that is the
// only honest meaning of the toggle in Tweaks.
//
// Detection reads the PE headers in the process's own file (no launching, no
// scanning of the whole disk): the CLR runtime header (data directory 14) marks
// a managed image, its absence marks native code.

const PE_MACHINES = {
  0x014c: 'x86',
  0x8664: 'x64',
  0xaa64: 'arm64',
  0x01c4: 'arm',
};

const SUB_SYSTEMS = {
  2: 'Windows GUI',
  3: 'Windows console',
};

const STRATEGIES = ['auto', 'fast-start', 'throughput'];

function parsePe(buffer) {
  if (!buffer || buffer.length < 0x40) return null;
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null; // "MZ"
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > buffer.length) return null;
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') return null;

  const machine = buffer.readUInt16LE(peOffset + 4);
  const optionalStart = peOffset + 24;
  if (optionalStart + 2 > buffer.length) return null;
  const magic = buffer.readUInt16LE(optionalStart);
  const is64 = magic === 0x20b;
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  if (optionalStart + optionalSize > buffer.length) return null;

  const subsystemOffset = optionalStart + 68;
  const subsystem = subsystemOffset + 2 <= buffer.length ? buffer.readUInt16LE(subsystemOffset) : 0;

  const dirCountOffset = optionalStart + (is64 ? 108 : 92);
  const dirStart = optionalStart + (is64 ? 112 : 96);
  let managed = false;
  let clrRuntimeVersion = null;
  if (dirCountOffset + 4 <= buffer.length) {
    const dirCount = buffer.readUInt32LE(dirCountOffset);
    const clrEntry = dirStart + 14 * 8; // IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR
    if (dirCount > 14 && clrEntry + 8 <= buffer.length) {
      const clrRva = buffer.readUInt32LE(clrEntry);
      const clrSize = buffer.readUInt32LE(clrEntry + 4);
      managed = clrRva !== 0 && clrSize !== 0;
    }
  }
  // The CLR metadata has the target runtime version, but it needs section
  // mapping to reach; the header alone is enough to say "managed", and saying
  // less is better than guessing.
  return {
    machine: PE_MACHINES[machine] || `0x${machine.toString(16)}`,
    subsystem: SUB_SYSTEMS[subsystem] || 'unknown',
    is64,
    managed,
    clrRuntimeVersion,
  };
}

// Human-facing classification. `kind` decides what the UI may offer.
function classifyPe(pe) {
  if (!pe) {
    return {
      kind: 'unknown',
      label: 'Not recognised',
      jit: 'RunContainer could not read a Windows executable header, so it makes no claim about JIT here.',
    };
  }
  if (pe.managed) {
    return {
      kind: 'dotnet',
      label: 'Managed .NET',
      jit: 'This app ships IL, and the .NET runtime already JIT-compiles it. The strategy below changes how much work it defers, not whether JIT is used.',
    };
  }
  return {
    kind: 'native',
    label: 'Native code',
    jit: 'Already compiled machine code. There is nothing for a JIT to translate, so no JIT setting can speed this app up.',
  };
}

function detectRuntime(buffer) {
  return classifyPe(parsePe(buffer));
}

// The .NET switches are documented runtime settings, not flags RunContainer
// invents. They are only ever set for managed apps.
function runtimeEnvironment(strategy, kind) {
  if (kind !== 'dotnet') return {};
  if (strategy === 'fast-start') {
    return {
      // Compile each method to optimized code on first use and stop tiering:
      // less background compilation, so startup work stays small.
      DOTNET_TieredCompilation: '0',
      DOTNET_TC_QuickJitForLoops: '0',
    };
  }
  if (strategy === 'throughput') {
    return {
      // The modern default, stated explicitly so the choice is visible.
      DOTNET_TieredCompilation: '1',
      DOTNET_TC_QuickJitForLoops: '1',
      DOTNET_TieredPGO: '1',
    };
  }
  return {};
}

function normalizeStrategy(value) {
  return STRATEGIES.includes(value) ? value : 'auto';
}

function strategyLabel(strategy) {
  if (strategy === 'fast-start') return 'Fast start';
  if (strategy === 'throughput') return 'Maximum speed';
  return 'Automatic (runtime default)';
}

// Only the variables above may reach the launcher environment.
function sanitizeEnvironment(environment) {
  const allowed = new Set([
    'DOTNET_TieredCompilation',
    'DOTNET_TC_QuickJitForLoops',
    'DOTNET_TieredPGO',
  ]);
  const clean = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (!allowed.has(key)) continue;
    if (!/^[0-9A-Za-z._-]{1,32}$/.test(String(value))) continue;
    clean[key] = String(value);
  }
  return clean;
}

module.exports = {
  STRATEGIES,
  parsePe,
  classifyPe,
  detectRuntime,
  runtimeEnvironment,
  normalizeStrategy,
  strategyLabel,
  sanitizeEnvironment,
};
