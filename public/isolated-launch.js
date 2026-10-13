const path = require('path');

// Lists every process with its parent PID and executable path, so an app's whole process
// tree can be found (path match for the app folder, plus descendants of those processes).
function buildProcessTableArgs() {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress";
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
  const alive = new Set(table.map((row) => row.pid));
  const childrenOf = new Map();
  for (const row of table) {
    if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
    childrenOf.get(row.ppid).push(row.pid);
  }

  const found = new Set();
  const queue = [];
  for (const row of table) {
    if (row.path && row.path.toLowerCase().startsWith(scope)) queue.push(row.pid);
  }
  for (const pid of seedPids) {
    if (alive.has(pid)) queue.push(pid);
  }
  while (queue.length > 0) {
    const pid = queue.shift();
    if (found.has(pid) || pid === process.pid) continue;
    found.add(pid);
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
  return { ...record, status: 'Installed', pid: null, sandboxPids: [], launchMode: null, lastLaunchedAt: null, lastExitAt: null };
}

module.exports = {
  mergeStatusUpdates,
  resolveDownloadRedirect,
  resetLaunchState,
  buildProcessTableArgs,
  parseProcessTable,
  findAppProcessIds,
  buildTaskkillArgs,
};
