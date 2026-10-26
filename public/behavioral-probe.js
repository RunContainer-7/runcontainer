// Win32 probe for the behavioural monitor.
//
// One PowerShell call per tick answers all three vectors for an app's PIDs:
//   - window handles: is a visible top-level window owned by the process?
//   - hard hang: CPU time and cumulative IO bytes, so the supervisor can tell a
//     busy process from one that spins with no file activity; Windows' own
//     IsHungAppWindow is reported too, as a second opinion.
//   - liveness: whether the probe itself answered (an engine that traps the
//     process also stops this from returning).
//
// Only text is built and parsed here, so it can be unit tested off Windows.

const RESULT_PREFIX = 'RCBEHAVE ';

function buildProbeCSharp() {
  return `
using System;
using System.Runtime.InteropServices;

public static class RunContainerBehaviorProbe
{
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr hwnd);

    // Walks the whole window tree, not just top-level windows. A window hosted inside
    // RunContainer is a child of RunContainer's host window, so an EnumWindows-only
    // probe reported "no window" for an app whose window was visibly right there, and
    // RunContainer restarted the app. Both top-level windows and hosted children count.
    //
    // Foreign counts windows that exist but cannot be attributed through the host: a
    // child of a process that is neither the app nor the host we were given (an
    // elevated launcher host, or a window owned elsewhere). That is the one case where
    // "no window" is a measurement error rather than a fact, so it is reported
    // separately instead of being folded into the visible count.
    sealed class Tally
    {
        public uint ProcessId;
        public uint HostProcessId;
        public int Count;
        public int Foreign;
        public bool Hung;
    }

    static void Visit(IntPtr hwnd, Tally tally)
    {
        uint owner;
        GetWindowThreadProcessId(hwnd, out owner);
        if (owner == tally.ProcessId && IsWindowVisible(hwnd))
        {
            IntPtr windowParent = GetParent(hwnd);
            if (windowParent == IntPtr.Zero)
            {
                if (GetWindow(hwnd, 4u) == IntPtr.Zero) tally.Count += 1;
            }
            else
            {
                uint parentOwner;
                GetWindowThreadProcessId(windowParent, out parentOwner);
                // A window hosted by RunContainer's host window still counts, and so does
                // the app's own child window (an in-process dialog or control).
                if (parentOwner == tally.ProcessId || (tally.HostProcessId != 0 && parentOwner == tally.HostProcessId))
                {
                    tally.Count += 1;
                }
                else
                {
                    tally.Foreign += 1;
                }
            }
            if (IsHungAppWindow(hwnd)) tally.Hung = true;
        }
        EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr param)
        {
            Visit(child, tally);
            return true;
        }, IntPtr.Zero);
    }

    static Tally Inspect(uint processId, uint hostProcessId)
    {
        Tally tally = new Tally();
        tally.ProcessId = processId;
        tally.HostProcessId = hostProcessId;
        EnumWindows(delegate(IntPtr hwnd, IntPtr param)
        {
            Visit(hwnd, tally);
            return true;
        }, IntPtr.Zero);
        return tally;
    }

    public static int VisibleWindowCount(uint processId, uint hostProcessId)
    {
        return Inspect(processId, hostProcessId).Count;
    }

    public static bool IsHung(uint processId, uint hostProcessId)
    {
        return Inspect(processId, hostProcessId).Hung;
    }

    public static int ForeignWindowCount(uint processId, uint hostProcessId)
    {
        return Inspect(processId, hostProcessId).Foreign;
    }
}
`;
}

function buildBehaviorProbeScript() {
  return [
    'param([string]$Pids, [string]$HostPid = \'0\')',
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$source = @'",
    buildProbeCSharp(),
    "'@",
    'Add-Type -TypeDefinition $source -Language CSharp',
    '$ids = @($Pids -split \',\' | Where-Object { $_ -match \'^\\d+$\' } | ForEach-Object { [uint32]$_ })',
    '$hostId = 0',
    '$parsedHost = 0',
    'if ([int]::TryParse($HostPid, [ref]$parsedHost) -and $parsedHost -gt 0) { $hostId = [uint32]$parsedHost }',
    '$windows = @()',
    '$perf = @()',
    'foreach ($procId in $ids) {',
    '  $count = [RunContainerBehaviorProbe]::VisibleWindowCount($procId, $hostId)',
    '  $foreign = [RunContainerBehaviorProbe]::ForeignWindowCount($procId, $hostId)',
    '  $hung = [RunContainerBehaviorProbe]::IsHung($procId, $hostId)',
    '  $windows += [pscustomobject]@{ pid = [int]$procId; visible = ($count -gt 0); windows = [int]$count; foreign = [int]$foreign; hung = [bool]$hung }',
    '  $row = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter "IDProcess=$procId" | Select-Object -First 1',
    '  if ($row) {',
    '    $io = [double]$row.IOReadBytesPerSec + [double]$row.IOWriteBytesPerSec + [double]$row.IOOtherBytesPerSec',
    '    $perf += [pscustomobject]@{ pid = [int]$procId; cpu = [double]$row.PercentProcessorTime; io = $io }',
    '  } else {',
    '    $proc = Get-Process -Id ([int]$procId)',
    '    if ($proc) { $perf += [pscustomobject]@{ pid = [int]$procId; cpu = ([double]$proc.TotalProcessorTime.TotalMilliseconds * 10000); io = 0 } }',
    '  }',
    '}',
    "$result = [pscustomobject]@{ responsive = $true; probedAt = [DateTime]::UtcNow.ToString('o'); windows = @($windows); perf = @($perf) }",
    `Write-Output ('${RESULT_PREFIX}' + ($result | ConvertTo-Json -Depth 5 -Compress))`,
  ].join('\n');
}

function buildBehaviorProbeArgs(scriptPath, pids, hostPid = 0) {
  const list = (Array.isArray(pids) ? pids : [])
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
    .join(',');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Pids', list];
  // RunContainer's own PID, so a window hosted inside it still counts as the app's window.
  if (Number.isSafeInteger(hostPid) && hostPid > 0) args.push('-HostPid', String(hostPid));
  return args;
}

function parseBehaviorProbeOutput(stdout) {
  const text = String(stdout || '');
  const line = text.split(/\r?\n/).reverse().find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) throw new Error('The behavioural probe did not return a result.');
  let parsed;
  try {
    parsed = JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch (error) {
    throw new Error('The behavioural probe returned an unreadable result.');
  }
  const windows = (Array.isArray(parsed?.windows) ? parsed.windows : [parsed?.windows].filter(Boolean))
    .map((entry) => ({
      pid: Number(entry?.pid),
      visible: Boolean(entry?.visible),
      windows: Number(entry?.windows) || 0,
      foreign: Number(entry?.foreign) || 0,
      hung: Boolean(entry?.hung),
    }))
    .filter((entry) => Number.isSafeInteger(entry.pid) && entry.pid > 0);
  const perf = (Array.isArray(parsed?.perf) ? parsed.perf : [parsed?.perf].filter(Boolean))
    .map((entry) => ({
      pid: Number(entry?.pid),
      cpu: Number(entry?.cpu) || 0,
      io: Number(entry?.io) || 0,
    }))
    .filter((entry) => Number.isSafeInteger(entry.pid) && entry.pid > 0);
  return { responsive: parsed?.responsive !== false, windows, perf };
}

// Sums the whole process tree so a launcher's helper process is included. CPU is
// kept in the raw 100 ns units Windows reports; the supervisor compares deltas.
function summarizeProbe(probe) {
  const windows = probe?.windows || [];
  const perf = probe?.perf || [];
  return {
    windowVisible: windows.some((entry) => entry.visible),
    // Visible windows that belong to a process other than the app and the host we
    // were given. Reported so the window agent can tell "no window" apart from
    // "a window we could not attribute".
    windowForeign: windows.reduce((sum, entry) => sum + entry.foreign, 0),
    windowCount: windows.reduce((sum, entry) => sum + entry.windows, 0),
    windowHung: windows.some((entry) => entry.hung),
    cpuMs: perf.length > 0 ? perf.reduce((sum, entry) => sum + entry.cpu, 0) / 10000 : null,
    ioBytes: perf.length > 0 ? perf.reduce((sum, entry) => sum + entry.io, 0) : null,
  };
}

module.exports = {
  RESULT_PREFIX,
  buildProbeCSharp,
  buildBehaviorProbeScript,
  buildBehaviorProbeArgs,
  parseBehaviorProbeOutput,
  summarizeProbe,
};
