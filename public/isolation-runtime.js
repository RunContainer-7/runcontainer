// Built-in Windows isolation engine.
//
// RunContainer cannot ship a native addon, so the engine drives the documented Windows
// AppContainer API (userenv.dll + CreateProcessW with PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES)
// through a generated PowerShell script. When CreateProcessW succeeds with an AppContainer
// SECURITY_CAPABILITIES attribute, the child runs with the container token: it loses access to
// the rest of the user profile, to the registry outside its container keys, and to other
// processes, and its writes are confined to container-accessible locations. The launcher then
// verifies the created process really carries the container SID before RunContainer reports it
// as isolated.
//
// This module only builds and parses text so it can be unit tested off Windows.

const path = require('path');

const ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const SE_GROUP_ENABLED = 0x00000004;

const SUPPORTED_CAPABILITIES = ['internetClient', 'internetClientServer', 'privateNetworkClientServer'];

const RESULT_PREFIX = 'RCAPPCONTAINER ';

function sanitizeContainerNamePart(value) {
  return String(value || 'app').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'app';
}

// AppContainer profile names are limited to 64 characters of [-_. A-Za-z0-9] and are
// per-user, so the container name is derived from the app id.
function appContainerName(appId) {
  const suffix = sanitizeContainerNamePart(appId).slice(0, 40);
  return `RunContainer.App.${suffix}`;
}

function isAppContainerSupported(platform = process.platform) {
  return platform === 'win32';
}

// Grants the container SID access to the app's own folder. `M` (modify) is inherited by
// files and subfolders so the sandboxed app can keep its own data.
function buildAppContainerFolderAclArgs(directory, sid) {
  return [directory, '/grant', `*${sid}:(OI)(CI)M`, '/T', '/C', '/Q'];
}

// Ancestor folders need read/execute only, so the container can traverse to its own
// folder and load the executable.
function buildAppContainerAncestorAclArgs(directory, sid) {
  return [directory, '/grant', `*${sid}:(RX)`, '/C', '/Q'];
}

// Ancestors RunContainer may add an ACE to: only directories inside its own managed root.
// Everything above it (the user profile, C:\Users, the drive root) is left untouched, and
// the container reaches its folder through the normal traverse-checking privilege.
function listAncestorDirectories(directory, managedRoot) {
  // Fail safe: with no managed root there is no directory RunContainer is allowed to
  // touch, so nothing is returned rather than the whole profile chain.
  if (!managedRoot) return [];
  const resolved = path.win32.resolve(directory);
  const managed = path.win32.resolve(managedRoot);
  const scope = `${managed}${path.win32.sep}`.toLowerCase();
  const ancestors = [];
  let current = path.win32.dirname(resolved);
  while (current && path.win32.dirname(current) !== current) {
    const lowered = current.toLowerCase();
    if (lowered === managed.toLowerCase() || lowered.startsWith(scope)) ancestors.push(current);
    current = path.win32.dirname(current);
  }
  // The drive root (C:\) is excluded: it already allows everyone to traverse it and
  // RunContainer must not modify its ACL.
  return ancestors.reverse();
}

function buildAppContainerCapabilities(capabilities = ['internetClient']) {
  const requested = (Array.isArray(capabilities) ? capabilities : [capabilities])
    .filter((name) => SUPPORTED_CAPABILITIES.includes(name));
  const resolved = requested.length > 0 ? requested : ['internetClient'];
  return [...new Set(resolved)];
}

function buildLaunchArguments({ containerName, executablePath, workingDirectory, capabilities }) {
  return {
    containerName,
    executablePath,
    workingDirectory,
    capabilities: buildAppContainerCapabilities(capabilities),
  };
}

// The generated C# mirrors the documented native structures exactly; the P/Invoke surface is
// deliberately small (create/derive profile SID, capability SIDs, one attribute list, one
// CreateProcessW) so there is little room for a marshalling mistake.
function buildAppContainerCSharp() {
  return `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class RunContainerAppContainer
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public uint cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
        public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
        public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags;
        public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeleteAppContainerProfile(string name);

    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out uint groupSidCount, out IntPtr capabilitySids, out uint capabilitySidCount);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr LocalFree(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, uint count, uint flags, ref UIntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, uint informationLength, out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    const int ErrorAlreadyExists = unchecked((int)0x800700B7);
    const int TokenIsAppContainer = 29;
    const int TokenAppContainerSid = 31;
    const uint TokenQuery = 0x0008;

    public static string SidToString(IntPtr sid)
    {
        if (sid == IntPtr.Zero) return null;
        IntPtr text;
        if (!ConvertSidToStringSid(sid, out text)) return null;
        try { return Marshal.PtrToStringUni(text); }
        finally { LocalFree(text); }
    }

    public static IntPtr EnsureAppContainerSid(string name)
    {
        IntPtr sid;
        int hr = CreateAppContainerProfile(name, name, "RunContainer isolated app", IntPtr.Zero, 0, out sid);
        if (hr >= 0) return sid;
        if (hr == ErrorAlreadyExists)
        {
            IntPtr existing;
            int deriveHr = DeriveAppContainerSidFromAppContainerName(name, out existing);
            if (deriveHr >= 0) return existing;
            throw new InvalidOperationException("The existing AppContainer profile could not be opened (HRESULT 0x" + deriveHr.ToString("X8") + ").");
        }
        throw new InvalidOperationException("The AppContainer profile could not be created (HRESULT 0x" + hr.ToString("X8") + ").");
    }

    // Removes the per-user AppContainer profile and the container storage that belongs to
    // it. Windows returns success for a profile that does not exist, and documents that an
    // open handle inside the container can leave storage behind, in which case the caller
    // should retry. Called only after this app's processes have been confirmed stopped.
    public static void DeleteProfile(string name)
    {
        int hr = DeleteAppContainerProfile(name);
        if (hr < 0)
        {
            throw new InvalidOperationException("The AppContainer profile could not be deleted (HRESULT 0x" + hr.ToString("X8") + "). Close anything still running from this app and try Delete again.");
        }
    }

    static IntPtr BuildCapabilityArray(string[] capabilityNames, out uint count)
    {
        count = 0;
        if (capabilityNames == null || capabilityNames.Length == 0) return IntPtr.Zero;

        SID_AND_ATTRIBUTES[] entries = new SID_AND_ATTRIBUTES[capabilityNames.Length];
        int index = 0;
        foreach (string capabilityName in capabilityNames)
        {
            IntPtr groupSids, capabilitySids;
            uint groupSidCount, capabilitySidCount;
            if (!DeriveCapabilitySidsFromName(capabilityName, out groupSids, out groupSidCount, out capabilitySids, out capabilitySidCount))
            {
                throw new InvalidOperationException("The capability '" + capabilityName + "' could not be resolved on this Windows version.");
            }
            if (capabilitySidCount == 0) continue;
            IntPtr firstCapabilitySid = Marshal.ReadIntPtr(capabilitySids);
            entries[index] = new SID_AND_ATTRIBUTES { Sid = firstCapabilitySid, Attributes = 0x4 };
            index += 1;
        }
        if (index == 0) return IntPtr.Zero;

        int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        IntPtr block = Marshal.AllocHGlobal(size * index);
        for (int i = 0; i < index; i += 1)
        {
            Marshal.StructureToPtr(entries[i], IntPtr.Add(block, i * size), false);
        }
        count = (uint)index;
        return block;
    }

    // Launches the executable inside the named AppContainer and returns
    // "<pid>|<containerSid>|<verifiedSidOrEmpty>".
    public static string Launch(string name, string executablePath, string workingDirectory, string[] capabilityNames, string arguments)
    {
        IntPtr containerSid = EnsureAppContainerSid(name);
        string containerSidText = SidToString(containerSid);
        if (containerSidText == null) throw new InvalidOperationException("The AppContainer SID could not be formatted.");

        uint capabilityCount;
        IntPtr capabilityBlock = BuildCapabilityArray(capabilityNames, out capabilityCount);

        SECURITY_CAPABILITIES securityCapabilities = new SECURITY_CAPABILITIES
        {
            AppContainerSid = containerSid,
            Capabilities = capabilityBlock,
            CapabilityCount = capabilityCount,
            Reserved = 0
        };

        int capabilitiesSize = Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));
        IntPtr capabilitiesBuffer = Marshal.AllocHGlobal(capabilitiesSize);
        Marshal.StructureToPtr(securityCapabilities, capabilitiesBuffer, false);

        UIntPtr attributeListSize = UIntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
        if (attributeListSize == UIntPtr.Zero)
        {
            throw new InvalidOperationException("The process attribute list size could not be determined (error " + Marshal.GetLastWin32Error() + ").");
        }

        IntPtr attributeList = Marshal.AllocHGlobal((int)attributeListSize);
        STARTUPINFOEX startupInfo = new STARTUPINFOEX();
        PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
        try
        {
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize))
            {
                throw new InvalidOperationException("The process attribute list could not be initialized (error " + Marshal.GetLastWin32Error() + ").");
            }
            if (!UpdateProcThreadAttribute(attributeList, 0, (UIntPtr)0x00020009, capabilitiesBuffer, (UIntPtr)capabilitiesSize, IntPtr.Zero, IntPtr.Zero))
            {
                throw new InvalidOperationException("The AppContainer token could not be attached to the launch (error " + Marshal.GetLastWin32Error() + ").");
            }

            startupInfo.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startupInfo.lpAttributeList = attributeList;

            StringBuilder commandLine = new StringBuilder("\\"" + executablePath + "\\"" + (string.IsNullOrEmpty(arguments) ? "" : " " + arguments));
            bool created = CreateProcess(
                executablePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                0x00080000 | 0x00000400,
                IntPtr.Zero,
                workingDirectory,
                ref startupInfo,
                out processInformation);

            if (!created)
            {
                int error = Marshal.GetLastWin32Error();
                throw new InvalidOperationException("Windows refused to start the app inside its container (CreateProcessW error " + error + "). Confirm that RunContainer can read the app folder and that the app does not require administrator rights.");
            }

            string verifiedSid = ReadAppContainerSid(processInformation.hProcess);
            return processInformation.dwProcessId + "|" + containerSidText + "|" + (verifiedSid == null ? "" : verifiedSid);
        }
        finally
        {
            if (processInformation.hThread != IntPtr.Zero) CloseHandle(processInformation.hThread);
            if (processInformation.hProcess != IntPtr.Zero) CloseHandle(processInformation.hProcess);
            DeleteProcThreadAttributeList(attributeList);
            Marshal.FreeHGlobal(attributeList);
            Marshal.FreeHGlobal(capabilitiesBuffer);
            if (capabilityBlock != IntPtr.Zero) Marshal.FreeHGlobal(capabilityBlock);
            GC.KeepAlive(securityCapabilities);
        }
    }

    // Reads the AppContainer SID from the new process token. This is what lets RunContainer
    // state that a process really is inside the container instead of assuming it. Both the
    // TokenIsAppContainer flag and the container SID must agree, so an ordinary process can
    // never be reported as isolated.
    public static string ReadAppContainerSid(IntPtr process)
    {
        IntPtr token;
        if (!OpenProcessToken(process, TokenQuery, out token)) return null;
        try
        {
            IntPtr flagBuffer = Marshal.AllocHGlobal(4);
            try
            {
                uint flagLength;
                if (!GetTokenInformation(token, TokenIsAppContainer, flagBuffer, 4, out flagLength)) return null;
                if (Marshal.ReadInt32(flagBuffer) == 0) return null;
            }
            finally { Marshal.FreeHGlobal(flagBuffer); }

            uint length;
            GetTokenInformation(token, TokenAppContainerSid, IntPtr.Zero, 0, out length);
            if (length == 0) return null;
            IntPtr buffer = Marshal.AllocHGlobal((int)length);
            try
            {
                if (!GetTokenInformation(token, TokenAppContainerSid, buffer, length, out length)) return null;
                IntPtr containerSid = Marshal.ReadIntPtr(buffer);
                return SidToString(containerSid);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }
}
`;
}

// Per-app capabilities and launch args travel as script parameters so one shared
// launcher serves every environment. $Caps is a comma list filtered against the
// documented names (empty = locked, no capabilities); $Args is a single argument
// string appended to the sandboxed command line (empty = none).
function buildAppContainerScript() {
  return [
    'param([string]$Mode, [string]$Name, [string]$Exe, [string]$Dir, [string]$Caps = \'internetClient\', [string]$Args = \'\')',
    "$ErrorActionPreference = 'Stop'",
    // The C# has to live in a literal here-string. Raw C# emitted as bare script lines is
    // not valid PowerShell, and the script would fail to parse before Add-Type ever ran.
    "$source = @'",
    buildAppContainerCSharp(),
    "'@",
    'Add-Type -TypeDefinition $source -Language CSharp',
    `$names = @($Caps.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })`,
    `$allowed = @('internetClient', 'internetClientServer', 'privateNetworkClientServer')`,
    `$unknown = @($names | Where-Object { $allowed -notcontains $_ })`,
    'if ($unknown.Count -gt 0) { throw ("Unknown AppContainer capability: " + ($unknown -join ", ")) }',
    '$capabilities = @($names | Where-Object { $allowed -contains $_ })',
    'try {',
    "  if ($Mode -eq 'sid') {",
    '    $sid = [RunContainerAppContainer]::SidToString([RunContainerAppContainer]::EnsureAppContainerSid($Name))',
    `    Write-Output ('${RESULT_PREFIX}' + (@{ sid = $sid } | ConvertTo-Json -Compress))`,
    "  } elseif ($Mode -eq 'delete') {",
    '    [RunContainerAppContainer]::DeleteProfile($Name)',
    `    Write-Output ('${RESULT_PREFIX}' + (@{ deleted = $true } | ConvertTo-Json -Compress))`,
    '  } else {',
    '    $result = [RunContainerAppContainer]::Launch($Name, $Exe, $Dir, $capabilities, $Args)',
    '    $parts = $result.Split("|")',
    '    $output = @{ pid = [int]$parts[0]; containerSid = $parts[1]; processSid = $parts[2]; verified = ($parts[1] -eq $parts[2]) }',
    `    Write-Output ('${RESULT_PREFIX}' + ($output | ConvertTo-Json -Compress))`,
    '  }',
    '} catch {',
    `  Write-Output ('${RESULT_PREFIX}' + (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))`,
    '  exit 1',
    '}',
  ].join('\n');
}

function buildAppContainerScriptArgs(scriptPath, { mode, containerName, executablePath, workingDirectory, capabilities, appArgs }) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', mode, '-Name', containerName];
  // Only a launch needs the executable, working directory, capabilities and args;
  // the sid and delete modes must not receive them, so a delete can never
  // accidentally start the app.
  if (mode === 'launch') {
    args.push('-Exe', executablePath, '-Dir', workingDirectory);
    // An explicit empty list means locked (no capabilities); undefined keeps the script default.
    if (capabilities !== undefined) args.push('-Caps', capabilities.length ? buildAppContainerCapabilities(capabilities).join(',') : '');
    if (appArgs) args.push('-Args', String(appArgs));
  }
  return args;
}

function parseAppContainerOutput(stdout) {
  const text = String(stdout || '');
  // The contained process inherits the launcher's console, so a console app's banner
  // or its prompt can land in front of our marker on the same line, e.g.
  //   C:\Users\me\Temp\run>RCAPPCONTAINER {"pid":123,...}
  // Requiring the marker at the start of a line made that look like "no result"
  // (which is exactly how the AppContainer checks failed on real Windows), so find
  // the last marker anywhere in the output and read JSON up to the end of its line.
  const marker = text.lastIndexOf(RESULT_PREFIX);
  if (marker === -1) throw new Error('The isolation launcher did not return a result.');
  const line = text.slice(marker + RESULT_PREFIX.length).split(/\r?\n/, 1)[0];
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error('The isolation launcher returned an unreadable result.');
  }
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

module.exports = {
  ATTRIBUTE_SECURITY_CAPABILITIES,
  EXTENDED_STARTUPINFO_PRESENT,
  CREATE_UNICODE_ENVIRONMENT,
  SE_GROUP_ENABLED,
  SUPPORTED_CAPABILITIES,
  RESULT_PREFIX,
  appContainerName,
  isAppContainerSupported,
  buildAppContainerFolderAclArgs,
  buildAppContainerAncestorAclArgs,
  listAncestorDirectories,
  buildAppContainerCapabilities,
  buildLaunchArguments,
  buildAppContainerCSharp,
  buildAppContainerScript,
  buildAppContainerScriptArgs,
  parseAppContainerOutput,
};
