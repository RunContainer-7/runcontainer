// Is this app actually its own setup program, and can it be set up unattended?
//
// Why this exists: when someone adds an installer as an app, pressing Run starts
// setup — not the app they wanted. That is correct (setup must run inside the
// environment), but until now RunContainer said nothing about it, so the app
// looked stuck for as long as the wizard waited for a click. Two honest answers
// are possible, and both are decided here:
//
//   * the installer supports a documented unattended mode, so setup can be
//     completed in the background before the app is shown;
//   * it does not, so the wizard is shown inside a RunContainer window and the
//     user is told that this window IS the app's setup.
//
// Everything here is a pure decision over the file's own bytes and its version
// metadata. Nothing is executed here; the caller runs the plan.

const fs = require('fs');

// Detection by the bytes an installer carries. These strings are part of each
// installer's own format, so they are evidence, not guesses.
const FAMILIES = [
  {
    id: 'inno',
    name: 'Inno Setup',
    args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'],
    detect: (buffer) => buffer.includes('Inno Setup') || buffer.includes('InnoSetupVersion'),
  },
  {
    id: 'nsis',
    name: 'NSIS',
    args: ['/S'],
    detect: (buffer) => buffer.includes('Nullsoft') || buffer.includes('NSIS Error'),
  },
  {
    id: 'installshield',
    name: 'InstallShield',
    args: ['/s', '/v"/qn"'],
    detect: (buffer) => buffer.includes('InstallShield') || buffer.includes('setup.inx'),
  },
  {
    id: 'burn',
    name: 'WiX Burn bundle',
    args: ['/quiet', '/norestart'],
    detect: (buffer) => buffer.includes('wixburn') || buffer.includes('WixBundle') || buffer.includes('.NET Framework') === false && buffer.includes('burn.exe'),
  },
  {
    id: 'msi',
    name: 'Windows Installer package',
    args: ['/qn', '/norestart'],
    detect: (buffer) => buffer.includes('msi.dll') && buffer.includes('MsiExec'),
  },
  {
    id: 'squirrel',
    name: 'Squirrel installer',
    args: ['--silent'],
    detect: (buffer) => buffer.includes('Squirrel') || buffer.includes('Update.exe'),
  },
];

// Names that, together with a setup signature or on their own, make an executable
// a setup program rather than an application.
const SETUP_NAME = /(^|[^a-z])(setup|install(er)?|instal|unpack|sfx|updater|patch|update)([^a-z]|$)/i;

function readSignatureBuffer(exePath, { bytes = 8 * 1024 * 1024, fsModule = fs } = {}) {
  try {
    const handle = fsModule.openSync(exePath, 'r');
    try {
      const stats = fsModule.fstatSync(handle);
      const length = Math.min(Number(stats.size) || 0, bytes);
      const buffer = Buffer.alloc(length);
      const read = fsModule.readSync(handle, buffer, 0, length, 0);
      return buffer.subarray(0, read).toString('latin1');
    } finally {
      fsModule.closeSync(handle);
    }
  } catch (error) {
    return '';
  }
}

function detectInstallerFamily(exePath, options = {}) {
  const text = readSignatureBuffer(exePath, options);
  if (!text) return null;
  for (const family of FAMILIES) {
    try {
      if (family.detect(text)) return { id: family.id, name: family.name, args: family.args };
    } catch (error) {
      // A detector that fails simply does not match.
    }
  }
  return null;
}

// A name-only match is weaker evidence, so it is reported as such: the caller can
// still host the wizard, but it should not claim to know the installer's language.
function looksLikeSetupByName({ name = '', metadata = {} } = {}) {
  const candidates = [name, metadata.originalName, metadata.title, metadata.company]
    .filter((value) => typeof value === 'string' && value.trim());
  return candidates.some((value) => SETUP_NAME.test(value));
}

/**
 * Decides what RunContainer should do when an app is pressed Run on.
 * Returns a plan, never an action: the caller performs it.
 */
function planSetupRun({
  source,
  name = '',
  metadata = {},
  installedExePath = null,
  setupMode = 'auto',
  detectFamily = detectInstallerFamily,
  existsSync = fs.existsSync,
} = {}) {
  const missing = !source || !existsSync(source);
  if (missing) {
    return {
      isSetup: false,
      family: null,
      mode: 'none',
      args: [],
      summary: 'The installed executable is missing, so setup cannot be planned.',
    };
  }
  const family = detectFamily(source) || null;
  const nameSaysSetup = looksLikeSetupByName({ name, metadata });
  const isSetup = Boolean(family) || nameSaysSetup;
  if (!isSetup) {
    return {
      isSetup: false,
      family: null,
      mode: 'none',
      args: [],
      summary: 'This executable is not a setup program; it is launched as the app.',
    };
  }

  const alreadyInstalled = Boolean(installedExePath) && existsSync(installedExePath);
  if (alreadyInstalled) {
    return {
      isSetup: true,
      family,
      mode: 'installed',
      args: [],
      installedExePath,
      summary: `Setup already produced ${installedExePath}, so that executable is the app to run.`,
    };
  }

  // The user asked for the wizard, or the installer has no documented unattended
  // mode. Either way the wizard is shown inside RunContainer and we say so.
  if (setupMode === 'wizard' || !family) {
    return {
      isSetup: true,
      family,
      mode: 'wizard',
      args: [],
      summary: family
        ? `${family.name} setup is shown in a RunContainer window: complete the wizard there and RunContainer will look for the app it installs.`
        : 'This looks like a setup program, but its installer type is not recognised, so its wizard is shown in a RunContainer window instead of being run unattended.',
    };
  }

  return {
    isSetup: true,
    family,
    mode: 'silent',
    args: family.args,
    summary: `${family.name} setup supports unattended mode (${family.args.join(' ')}), so setup runs in the background inside this environment and the app is started when it finishes.`,
  };
}

// Which executables did setup produce? Used to answer "what should Run start now
// that setup has finished?", without assuming where the installer put its files.
function findInstalledCandidates(root, {
  since = 0,
  exclude = [],
  maxDepth = 6,
  maxEntries = 4000,
  fsModule = fs,
  pathModule = require('path'),
} = {}) {
  const found = [];
  const skip = new Set(exclude.filter(Boolean).map((entry) => String(entry).toLowerCase()));
  let visited = 0;
  const walk = (directory, depth) => {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries = [];
    try {
      entries = fsModule.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) return;
      visited += 1;
      const child = pathModule.join(directory, entry.name);
      if (skip.has(child.toLowerCase())) continue;
      if (entry.isDirectory()) {
        walk(child, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.exe')) continue;
      try {
        const stats = fsModule.statSync(child);
        if (!since || stats.mtimeMs >= since) {
          found.push({ path: child, sizeBytes: Number(stats.size) || 0, modifiedMs: stats.mtimeMs });
        }
      } catch (error) {
        // A file that vanished mid-scan is not a candidate.
      }
    }
  };
  walk(root, 0);
  // A bigger executable is more likely to be the application than a helper stub.
  return found.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

module.exports = {
  FAMILIES,
  SETUP_NAME,
  readSignatureBuffer,
  detectInstallerFamily,
  looksLikeSetupByName,
  planSetupRun,
  findInstalledCandidates,
};
