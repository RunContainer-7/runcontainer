const path = require('path');

// Per-app container environment: the app reads/writes its own AppData and Temp folders
// inside RunContainer's managed sandbox directory instead of the user's real profile.
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

function withTrailingSeparator(directory) {
  return directory.endsWith(path.win32.sep) ? directory : `${directory}${path.win32.sep}`;
}

// Lists PIDs of processes whose executable lives inside the given directory.
function buildProcessListArgs(directory) {
  const scope = withTrailingSeparator(directory).replace(/'/g, "''");
  const script = `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('${scope}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Id }`;
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

function parseProcessIds(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
    .filter((pid) => pid > 0);
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
  buildIsolatedEnvironment,
  buildProcessListArgs,
  parseProcessIds,
  buildTaskkillArgs,
};
