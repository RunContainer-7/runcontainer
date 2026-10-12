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

module.exports = {
  buildIsolatedEnvironment,
  buildProcessListArgs,
  parseProcessIds,
  buildTaskkillArgs,
};
