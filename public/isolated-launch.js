const path = require('path');
const fs = require('fs');
const os = require('os');

function buildClearReadOnlyArgs(directory) {
  return ['-R', path.win32.join(directory, '*'), '/S', '/D'];
}

// Take ownership of a tree so a sandbox created by an installer with restrictive ACLs
// can be removed. Applied to the app's own managed folder only.
function buildTakeOwnershipArgs(directory) {
  return ['/F', directory, '/R', '/D', 'Y'];
}

// Reset explicit (possibly DENY) ACEs so the tree reports the inherited ACLs again.
function buildResetAclArgs(directory) {
  return ['/reset', '/T', '/C', '/Q', directory];
}

function buildGrantFullControlArgs(directory, user = os.userInfo().username) {
  return ['/grant:r', `${user}:(OI)(CI)F`, '/T', '/C', '/Q', directory];
}

// The order matters on Windows. An explicit DENY ACE also denies traverse, so the root has to
// be reset first or the recursive tools cannot even walk the tree. Ownership comes next (the
// owner can always rewrite the DACL), then the inherited ACLs are restored and the current
// user is re-granted full control. Shared by the app and by scripts/windows-verify.js so both
// run the same sequence.
function buildAclRepairPlan(directory, user = os.userInfo().username) {
  return [
    { command: 'icacls.exe', args: ['/reset', directory] },
    { command: 'takeown.exe', args: buildTakeOwnershipArgs(directory) },
    { command: 'icacls.exe', args: buildResetAclArgs(directory) },
    { command: 'icacls.exe', args: buildGrantFullControlArgs(directory, user) },
  ];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Node's fs layer and the Windows API both stop at MAX_PATH (260) unless the path is
// extended. Sandbox trees created by installers get deep, so removal uses the \\?\ form.
function toExtendedLengthPath(directory, platform = process.platform) {
  if (platform !== 'win32') return directory;
  const resolved = path.win32.resolve(directory);
  if (resolved.startsWith('\\\\?\\')) return resolved;
  if (resolved.startsWith('\\\\')) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  if (/^[a-zA-Z]:\\/.test(resolved)) return `\\\\?\\${resolved}`;
  return resolved;
}

class CleanupCancelledError extends Error {
  constructor(directory) {
    // Files already unlinked stay unlinked: rmSync is not transactional, so the message
    // must not promise that nothing was removed.
    super(`Deletion of ${directory} was cancelled before it finished. Files already removed stay removed; the app is still listed, so run Delete again to finish.`);
    this.name = 'CleanupCancelledError';
    this.cancelled = true;
  }
}

async function removeDirectoryWithRetries({
  directory,
  existsSync = fs.existsSync,
  removeSync = fs.rmSync,
  clearReadOnly = async () => {},
  prepareForRemoval = async () => {},
  wait = delay,
  attempts = 60,
  retryDelayMs = 1000,
  shouldAbort = () => false,
  onAttempt = () => {},
}) {
  const extended = toExtendedLengthPath(directory);
  await clearReadOnly().catch(() => {});
  let lastError = null;
  let repaired = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (shouldAbort()) throw new CleanupCancelledError(directory);
    if (!existsSync(directory)) return;
    try {
      removeSync(extended, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch (error) {
      lastError = error;
    }
    if (!existsSync(directory)) return;
    // A denial that survives the first attempts is usually an explicit ACL rather than a
    // transient lock, so take ownership and reset permissions once, then keep retrying.
    if (!repaired && lastError && attempt >= 1) {
      repaired = true;
      onAttempt({ phase: 'repair', attempt, error: lastError });
      await prepareForRemoval({ extended, directory, error: lastError }).catch((repairError) => {
        onAttempt({ phase: 'repair-failed', attempt, error: repairError });
      });
    }
    onAttempt({ phase: 'retry', attempt, error: lastError });
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
      name: typeof row.Name === 'string' ? row.Name : '',
    }))
    .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
}

function withTrailingSeparator(directory) {
  return directory.endsWith(path.win32.sep) ? directory : `${directory}${path.win32.sep}`;
}

function isWithinDirectory(parent, candidate) {
  if (!parent || !candidate) return false;
  const parentScope = withTrailingSeparator(path.win32.resolve(parent)).toLowerCase();
  const candidatePath = path.win32.resolve(candidate).toLowerCase();
  return candidatePath === parentScope.slice(0, -1) || candidatePath.startsWith(parentScope);
}

// The executable a Windows command line names: the first quoted token, or everything up to
// the first space. Arguments are ignored on purpose, so a helper that merely mentions the
// sandbox path (Explorer with the folder open, an editor, RunContainer's own tooling) is
// never mistaken for the app and can never be terminated.
function commandLineExecutable(commandLine) {
  const text = String(commandLine || '').trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end > 1 ? text.slice(1, end) : '';
  }
  const match = text.match(/^\S+/);
  return match ? match[0] : '';
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
  const matchedPids = new Set();
  for (const row of table) {
    const commandLineImage = commandLineExecutable(row.commandLine).toLowerCase();
    if ((row.path && row.path.toLowerCase().startsWith(scope))
      || (commandLineImage && commandLineImage.startsWith(scope))
      || (row.name && row.path && isWithinDirectory(directory, row.path))) {
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
  return [...found].sort((a, b) => a - b);
}

function buildTaskkillArgs(pid) {
  return ['/PID', String(pid), '/T', '/F'];
}

// Ask an app's window to close cleanly before forcing it. `/T` still covers children,
// but no `/F`, so a document-based app can flush and exit on its own.
function buildGracefulTaskkillArgs(pid) {
  return ['/PID', String(pid), '/T'];
}

// Reports which processes still reference the folder: image paths inside the tree and
// modules (EXE/DLL) loaded from it. A memory-mapped image blocks deletion even when it
// holds no ordinary file handle. This is read-only; RunContainer never force-closes
// processes it has not confirmed belong to the app being deleted.
function buildBlockingProcessArgs(directory) {
  const escaped = String(directory).replace(/'/g, "''");
  const script = [
    `$root = '${escaped}'`,
    'Get-Process -ErrorAction SilentlyContinue | ForEach-Object {',
    '  $proc = $_; $paths = @();',
    '  if ($proc.Path -and $proc.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { $paths += $proc.Path }',
    '  try { $paths += ($proc.Modules | Where-Object { $_.FileName -and $_.FileName.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.FileName }) } catch {}',
    '  if ($paths.Count -gt 0) { [pscustomobject]@{ ProcessId = $proc.Id; ProcessName = $proc.ProcessName; ImagePath = $proc.Path; LoadedFrom = ($paths | Select-Object -Unique) } }',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

function parseBlockingProcesses(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      pid: Number(row.ProcessId),
      name: typeof row.ProcessName === 'string' ? row.ProcessName : '',
      imagePath: typeof row.ImagePath === 'string' ? row.ImagePath : '',
      loadedFrom: Array.isArray(row.LoadedFrom) ? row.LoadedFrom : (row.LoadedFrom ? [row.LoadedFrom] : []),
    }))
    .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
}

// Builds the human-facing reason a sandbox could not be removed, naming any process that
// still references it so the user can act instead of seeing a bare EPERM.
function describeCleanupFailure({ directory, error, blockers = [], remainingPids = [] }) {
  const parts = [];
  if (remainingPids.length > 0) {
    parts.push(`RunContainer could not stop this app's processes (PIDs ${remainingPids.join(', ')}). They may be running elevated; close them in Task Manager or restart RunContainer as administrator and try Delete again.`);
  }
  if (blockers.length > 0) {
    const named = blockers.slice(0, 5).map((entry) => `${entry.name || 'process'} (PID ${entry.pid})`);
    parts.push(`Windows still has files open from ${directory}: ${named.join(', ')}. Close ${blockers.length === 1 ? 'that program' : 'those programs'} and try Delete again.`);
  }
  if (parts.length === 0) {
    parts.push(`Windows refused to remove ${directory}: ${error?.message || 'unknown error'}. Another program or your antivirus may be holding a file open; retry in a moment.`);
  }
  return parts.join(' ');
}

// Stops only the processes RunContainer has confirmed belong to this app: anything
// executing from the app folder, the recorded launch PIDs, and every descendant of them.
// Nothing else is ever terminated. Returns the PIDs that could not be stopped.
async function stopAppProcesses({
  directory,
  seedPids = [],
  listProcesses,
  terminate,
  wait = delay,
  attempts = 4,
  forceAfterGracefulMs = 0,
  verifyAfterMs = 800,
}) {
  let remaining = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pids = findAppProcessIds(await listProcesses(), directory, seedPids);
    if (pids.length === 0) return [];
    if (attempt === 0 && forceAfterGracefulMs > 0) {
      for (const pid of pids) await terminate(pid, { force: false }).catch(() => {});
      await wait(forceAfterGracefulMs);
      const stillRunning = findAppProcessIds(await listProcesses(), directory, seedPids);
      if (stillRunning.length === 0) return [];
      for (const pid of stillRunning) await terminate(pid, { force: true }).catch(() => {});
    } else {
      for (const pid of pids) await terminate(pid, { force: true }).catch(() => {});
    }
    await wait(verifyAfterMs);
    remaining = findAppProcessIds(await listProcesses(), directory, seedPids);
    if (remaining.length === 0) return [];
  }
  return remaining;
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
    knownPids: [],
    launchMode: null,
    activeEngine: null,
    isolated: false,
    launchCleanupPending: false,
    sandboxieCleanupPending: false,
    sandboxieInitialized: false,
    lastLaunchedAt: null,
    lastExitAt: null,
  };
}

module.exports = {
  commandLineExecutable,
  buildAclRepairPlan,
  buildClearReadOnlyArgs,
  buildTakeOwnershipArgs,
  buildResetAclArgs,
  buildGrantFullControlArgs,
  toExtendedLengthPath,
  CleanupCancelledError,
  removeDirectoryWithRetries,
  buildIsolatedEnvironment,
  mergeStatusUpdates,
  resolveDownloadRedirect,
  resetLaunchState,
  buildProcessTableArgs,
  parseProcessTable,
  findAppProcessIds,
  buildTaskkillArgs,
  buildGracefulTaskkillArgs,
  buildBlockingProcessArgs,
  parseBlockingProcesses,
  describeCleanupFailure,
  stopAppProcesses,
  isWithinDirectory,
  withTrailingSeparator,
};
