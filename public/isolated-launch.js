const path = require('path');
const fs = require('fs');

function buildClearReadOnlyArgs(directory) {
  return ['-R', path.win32.join(directory, '*'), '/S', '/D'];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeDirectoryWithRetries({ directory, existsSync = fs.existsSync, removeSync = fs.rmSync, clearReadOnly = async () => {}, wait = delay, attempts = 60, retryDelayMs = 1000 }) {
  await clearReadOnly().catch(() => {});
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!existsSync(directory)) return;
    try {
      removeSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch (error) {
      lastError = error;
    }
    if (!existsSync(directory)) return;
    if (attempt + 1 < attempts) await wait(retryDelayMs);
  }
  const code = lastError?.code || 'unknown';
  const detail = lastError?.message || 'The directory still exists after all removal attempts.';
  throw new Error(`Could not remove ${directory} after ${attempts} attempts (${code}): ${detail}`);
}

// Redirect conventional per-user write locations into an app-owned profile. This keeps
// app data separable, but is not an OS-enforced security boundary.
function buildIsolatedEnvironment(baseEnv, sandboxRoot, layout) {
  return {
    ...baseEnv,
    APPDATA: layout.appData,
    LOCALAPPDATA: layout.appData,
    TEMP: layout.temp,
    TMP: layout.temp,
    RUNCONTAINER_SANDBOX_ROOT: sandboxRoot,
    RUNCONTAINER_APPDATA_ROOT: layout.appData,
  };
}

// Lists every process with its parent PID and executable path, so an app's whole process
// tree can be found (path match for the app folder, plus descendants of those processes).
function buildProcessTableArgs() {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

function parseProcessTable(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('Windows returned an unreadable process list.');
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      path: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : '',
      commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '',
    }))
    .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
}

function withTrailingSeparator(directory) {
  return directory.endsWith(path.win32.sep) ? directory : `${directory}${path.win32.sep}`;
}

// Returns PIDs of processes executing from `directory`, the seed PIDs still alive,
// and every descendant of those, so a launcher's child processes are stopped too.
function findAppProcessIds(table, directory, seedPids = []) {
  const scope = withTrailingSeparator(directory).toLowerCase();
  const commandLineScope = withTrailingSeparator(directory).toLowerCase();
  const alive = new Set(table.map((row) => row.pid));
  const childrenOf = new Map();
  for (const row of table) {
    if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
    childrenOf.get(row.ppid).push(row.pid);
  }

  const found = new Set();
  const queue = [];
  const matchedPids = new Set();
  for (const row of table) {
    if ((row.path && row.path.toLowerCase().startsWith(scope))
      || (row.commandLine && row.commandLine.toLowerCase().includes(commandLineScope))) {
      matchedPids.add(row.pid);
      queue.push(row.pid);
    }
  }
  for (const pid of seedPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    // A live PID from an old app record may have been reused by another process.
    // Only trust it as the app itself when its path/command line matches; if the PID
    // no longer exists, still traverse descendants that retain it as their parent PID.
    if (matchedPids.has(pid) || !alive.has(pid)) queue.push(pid);
  }
  const visited = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    if (visited.has(pid) || pid === process.pid) continue;
    visited.add(pid);
    if (alive.has(pid)) found.add(pid);
    // Traverse through a seed PID even if its process exited, since Windows retains
    // ParentProcessId on surviving descendants and those children may still hold files.
    for (const child of childrenOf.get(pid) || []) queue.push(child);
  }
  return [...found];
}

function buildTaskkillArgs(pid) {
  return ['/PID', String(pid), '/T', '/F'];
}

// Merges status updates computed from a snapshot into the latest store contents,
// so records added or deleted while the snapshot was being checked are not overwritten.
function mergeStatusUpdates(latestApps, updatesById) {
  return latestApps.map((entry) => (updatesById.has(entry.id) ? { ...entry, ...updatesById.get(entry.id) } : entry));
}

// Resolves a redirect Location header against the current URL and refuses non-HTTPS targets.
function resolveDownloadRedirect(currentUrl, location) {
  const next = new URL(location, currentUrl);
  if (next.protocol !== 'https:') {
    throw new Error('The download redirected to a non-HTTPS address, which RunContainer does not follow.');
  }
  return next.toString();
}

// Clears runtime state so a copy of an app starts from a clean, never-launched record.
function resetLaunchState(record) {
  return {
    ...record,
    status: 'Installed',
    pid: null,
    sandboxPids: [],
    launchMode: null,
    launchCleanupPending: false,
    sandboxieCleanupPending: false,
    sandboxieInitialized: false,
    lastLaunchedAt: null,
    lastExitAt: null,
  };
}

module.exports = {
  buildClearReadOnlyArgs,
  removeDirectoryWithRetries,
  buildIsolatedEnvironment,
  mergeStatusUpdates,
  resolveDownloadRedirect,
  resetLaunchState,
  buildProcessTableArgs,
  parseProcessTable,
  findAppProcessIds,
  buildTaskkillArgs,
};
