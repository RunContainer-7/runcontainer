const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sandboxBoxName(appId) {
  // Sandboxie box names are restricted to alphanumeric characters and 32 chars.
  return `RunContainer${crypto.createHash('sha256').update(String(appId)).digest('hex').slice(0, 20)}`;
}

function findSandboxieTools(env = process.env, existsSync = fs.existsSync) {
  const roots = [
    env.RUNCONTAINER_SANDBOXIE_DIR,
    env.ProgramW6432 && path.win32.join(env.ProgramW6432, 'Sandboxie-Plus'),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Sandboxie-Plus'),
    env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Sandboxie-Plus'),
    env.ProgramW6432 && path.win32.join(env.ProgramW6432, 'Sandboxie'),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Sandboxie'),
    env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Sandboxie'),
  ].filter(Boolean);

  for (const root of [...new Set(roots)]) {
    const startExe = path.win32.join(root, 'Start.exe');
    const sbieIniExe = path.win32.join(root, 'SbieIni.exe');
    if (existsSync(startExe) && existsSync(sbieIniExe)) {
      return { root, startExe, sbieIniExe };
    }
  }

  return null;
}

function buildLaunchArgs(boxName, executablePath) {
  return [`/box:${boxName}`, executablePath];
}

function buildListPidsArgs(boxName) {
  return [`/box:${boxName}`, '/listpids'];
}

function buildTerminateArgs(boxName) {
  return [`/box:${boxName}`, '/terminate'];
}

function buildDeleteSandboxArgs(boxName) {
  return [`/box:${boxName}`, 'delete_sandbox_silent'];
}

function buildConfigureBoxArgs(boxName, setting, value) {
  return ['set', boxName, setting, value];
}

function buildRemoveBoxArgs(boxName) {
  return ['set', boxName, '*', ''];
}

function parseSandboxPids(output) {
  const lines = String(output || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || !/^\d+$/.test(lines[0])) return null;

  const expectedCount = Number(lines[0]);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) return null;
  if (expectedCount === 0) return [];

  const pids = lines.slice(1).map((line) => Number(line)).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  return pids.length === expectedCount ? pids : null;
}

function isWithinDirectory(parent, candidate) {
  const pathApi = /^[A-Za-z]:[\\/]/.test(parent) || /^[A-Za-z]:[\\/]/.test(candidate)
    ? path.win32
    : path;
  const resolvedParent = pathApi.resolve(parent);
  const resolvedCandidate = pathApi.resolve(candidate);
  const relative = pathApi.relative(resolvedParent, resolvedCandidate);
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSandboxPids(tools, boxName, execute) {
  const result = await execute(tools.startExe, buildListPidsArgs(boxName));
  return parseSandboxPids(result?.stdout);
}

async function configureSandboxieBox({ tools, boxName, fileRootPath, execute }) {
  await execute(tools.sbieIniExe, buildConfigureBoxArgs(boxName, 'Enabled', 'y'));
  await execute(tools.sbieIniExe, buildConfigureBoxArgs(boxName, 'FileRootPath', fileRootPath));
  await execute(tools.startExe, ['/reload']);
  const { stdout } = await execute(tools.sbieIniExe, ['query', boxName, 'FileRootPath']);
  const configuredRoot = String(stdout || '').trim().replace(/^FileRootPath\s*=\s*/i, '').replace(/^['"]|['"]$/g, '');
  const normalizedRoot = configuredRoot.replace(/[\\/]+$/, '').toLowerCase();
  const expectedRoot = String(fileRootPath).replace(/[\\/]+$/, '').toLowerCase();
  if (normalizedRoot !== expectedRoot) {
    throw new Error(`Sandboxie did not confirm the requested FileRootPath (reported: ${configuredRoot || 'empty'}).`);
  }
}

async function launchInSandboxie({ tools, boxName, executablePath, fileRootPath, execute, onConfigured, wait = delay, pollAttempts = 12, pollIntervalMs = 500 }) {
  await configureSandboxieBox({ tools, boxName, fileRootPath, execute });
  if (onConfigured) await onConfigured();
  await execute(tools.startExe, buildLaunchArgs(boxName, executablePath));

  let lastReadError = null;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    try {
      const pids = await readSandboxPids(tools, boxName, execute);
      if (pids === null) {
        lastReadError = 'Sandboxie returned an unreadable process list.';
      } else if (pids.length > 0) {
        return { pids, boxName };
      }
    } catch (error) {
      lastReadError = error.message;
    }
    if (attempt + 1 < pollAttempts) await wait(pollIntervalMs);
  }

  throw new Error(`Sandboxie did not confirm a running process in box ${boxName}.${lastReadError ? ` ${lastReadError}` : ''}`);
}

async function terminateSandboxieBox({ tools, boxName, execute, wait = delay, pollAttempts = 12, pollIntervalMs = 500 }) {
  await execute(tools.startExe, buildTerminateArgs(boxName));

  let lastReadError = null;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    try {
      const pids = await readSandboxPids(tools, boxName, execute);
      if (pids && pids.length === 0) return;
      if (pids === null) lastReadError = 'Sandboxie returned an unreadable process list.';
    } catch (error) {
      lastReadError = error.message;
    }
    if (attempt + 1 < pollAttempts) await wait(pollIntervalMs);
  }

  throw new Error(`Sandboxie could not confirm that box ${boxName} is empty.${lastReadError ? ` ${lastReadError}` : ''}`);
}

async function deleteSandboxieBox({ tools, boxName, execute, wait = delay }) {
  await terminateSandboxieBox({ tools, boxName, execute, wait });
  await execute(tools.startExe, buildDeleteSandboxArgs(boxName));
  await execute(tools.sbieIniExe, buildRemoveBoxArgs(boxName));
  await execute(tools.startExe, ['/reload']);
}

module.exports = {
  sandboxBoxName,
  findSandboxieTools,
  buildLaunchArgs,
  buildListPidsArgs,
  buildTerminateArgs,
  buildDeleteSandboxArgs,
  buildConfigureBoxArgs,
  buildRemoveBoxArgs,
  parseSandboxPids,
  isWithinDirectory,
  configureSandboxieBox,
  launchInSandboxie,
  terminateSandboxieBox,
  deleteSandboxieBox,
};
