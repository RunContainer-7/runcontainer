// Remote input for the iPhone companion.
//
// The phone sends a pointer position and a key, not a Windows message. Turning that into
// a click or a keystroke is a native operation: Windows only accepts synthesised input
// from a process, and a browser on the phone has no way to reach one.
//
// This module builds a small resident helper (C# compiled once with the .NET Framework
// that ships with Windows, the same way the window host is built) that reads one command
// per line and performs it. It is fed only normalised values that the main process has
// already checked and clamped: a malformed line is ignored, never guessed at.
//
// Only the strings are built here, so the command format and the mapping can be tested
// on any platform; the helper itself only runs on Windows.

const COMMAND_PREFIX = 'RCINPUT';

// The native program. Commands arrive tab-separated:
//
//   focus <parent>
//   move  <parent> <x> <y>
//   down  <parent> <x> <y>
//   up    <parent> <x> <y>
//   click <parent> <x> <y> <count>
//   wheel <parent> <x> <y> <delta>
//   key   <vk> <extended> <down|up>
//   text  <base64 utf-8>
//   quit
//
// Coordinates are pixels in the parent window's client area (the app area under the
// hosted window's header). Windows' own hit testing decides which child receives the
// click, so the helper never needs to know which control it is over.
function buildCompanionInputProgram() {
  return `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class RunContainerRemoteInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extraInfo);

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    static long Fingerprint()
    {
        return GetForegroundWindow().ToInt64();
    }

    static bool ToScreen(long parent, int x, int y, out int screenX, out int screenY)
    {
        POINT point = new POINT();
        point.X = x;
        point.Y = y;
        screenX = x;
        screenY = y;
        if (parent == 0) return false;
        if (!ClientToScreen(new IntPtr(parent), ref point)) return false;
        screenX = point.X;
        screenY = point.Y;
        return true;
    }

    static void Move(long parent, int x, int y)
    {
        int screenX;
        int screenY;
        if (!ToScreen(parent, x, y, out screenX, out screenY)) return;
        SetCursorPos(screenX, screenY);
    }

    static void Button(uint downFlag)
    {
        mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
    }

    static void Wheel(int delta)
    {
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
    }

    // A key press and its release are sent together, so a lost phone connection cannot
    // leave a modifier held down on the PC.
    static void Key(int virtualKey, bool extended)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = 1;
        inputs[0].ki.wVk = (ushort)virtualKey;
        inputs[0].ki.wScan = 0;
        inputs[0].ki.dwFlags = extended ? KEYEVENTF_EXTENDEDKEY : 0;
        inputs[1].type = 1;
        inputs[1].ki.wVk = (ushort)virtualKey;
        inputs[1].ki.wScan = 0;
        inputs[1].ki.dwFlags = (extended ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static void KeyDown(int virtualKey, bool extended)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = 1;
        inputs[0].ki.wVk = (ushort)virtualKey;
        inputs[0].ki.dwFlags = extended ? KEYEVENTF_EXTENDEDKEY : 0;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static void KeyUp(int virtualKey, bool extended)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = 1;
        inputs[0].ki.wVk = (ushort)virtualKey;
        inputs[0].ki.dwFlags = (extended ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    // Unicode input carries the character itself, so the PC's keyboard layout is
    // irrelevant: a phone keyboard can send what it shows.
    static void Text(string value)
    {
        foreach (char character in value)
        {
            INPUT[] pair = new INPUT[2];
            pair[0].type = 1;
            pair[0].ki.wScan = (ushort)character;
            pair[0].ki.dwFlags = KEYEVENTF_UNICODE;
            pair[1].type = 1;
            pair[1].ki.wScan = (ushort)character;
            pair[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static int Main(string[] args)
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            string[] parts = line.Split((char)9);
            try
            {
                switch (parts[0])
                {
                    case "quit":
                        return 0;
                    case "move":
                    case "down":
                    case "up":
                    {
                        long parent = long.Parse(parts[1]);
                        int x = int.Parse(parts[2]);
                        int y = int.Parse(parts[3]);
                        Move(parent, x, y);
                        if (parts[0] == "down") Button(MOUSEEVENTF_LEFTDOWN);
                        if (parts[0] == "up") Button(MOUSEEVENTF_LEFTUP);
                        break;
                    }
                    case "click":
                    {
                        long parent = long.Parse(parts[1]);
                        int x = int.Parse(parts[2]);
                        int y = int.Parse(parts[3]);
                        int count = parts.Length > 4 ? int.Parse(parts[4]) : 1;
                        Move(parent, x, y);
                        for (int index = 0; index < Math.Max(1, count); index += 1)
                        {
                            Button(MOUSEEVENTF_LEFTDOWN);
                            System.Threading.Thread.Sleep(40);
                            Button(MOUSEEVENTF_LEFTUP);
                            System.Threading.Thread.Sleep(40);
                        }
                        break;
                    }
                    case "wheel":
                    {
                        long parent = long.Parse(parts[1]);
                        int x = int.Parse(parts[2]);
                        int y = int.Parse(parts[3]);
                        int delta = int.Parse(parts[4]);
                        Move(parent, x, y);
                        Wheel(delta);
                        break;
                    }
                    case "key":
                    {
                        int virtualKey = int.Parse(parts[1]);
                        bool extended = parts.Length > 2 && parts[2] == "1";
                        string action = parts.Length > 3 ? parts[3] : "tap";
                        if (action == "down") KeyDown(virtualKey, extended);
                        else if (action == "up") KeyUp(virtualKey, extended);
                        else Key(virtualKey, extended);
                        break;
                    }
                    case "text":
                    {
                        if (parts.Length > 1) Text(Encoding.UTF8.GetString(Convert.FromBase64String(parts[1])));
                        break;
                    }
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("${COMMAND_PREFIX} " + error.Message);
            }
            Console.Out.WriteLine("${COMMAND_PREFIX} ok");
            Console.Out.Flush();
        }
        return 0;
    }
}
`;
}

// Keyboard: the phone only names a key, never a scan code. Virtual-key codes are the
// stable Windows names for them. `extended` marks the keys Windows distinguishes from
// their numeric-pad twins (arrows, Insert/Delete/Home/End/PageUp/PageDown, Win, Menu).
const KEYS = {
  Enter: { vk: 0x0d },
  Tab: { vk: 0x09 },
  Escape: { vk: 0x1b },
  Backspace: { vk: 0x08 },
  Delete: { vk: 0x2e, extended: true },
  ArrowLeft: { vk: 0x25, extended: true },
  ArrowUp: { vk: 0x26, extended: true },
  ArrowRight: { vk: 0x27, extended: true },
  ArrowDown: { vk: 0x28, extended: true },
  Home: { vk: 0x24, extended: true },
  End: { vk: 0x23, extended: true },
  PageUp: { vk: 0x21, extended: true },
  PageDown: { vk: 0x22, extended: true },
  Space: { vk: 0x20 },
  F5: { vk: 0x74 },
};

function resolveKey(name) {
  return KEYS[name] || null;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

// A pointer event from the page, as pixels in the parent window's client area.
//
// The phone shows the whole hosted window, header included, and sends a position as a
// fraction of that picture. Converting it back is a scale, not a layout guess: the same
// fraction of the same window is the point the person touched. The header strip is part
// of the picture but belongs to RunContainer, so a click there is refused below.
function pointerToClient(pointer, viewport) {
  const width = Math.max(1, Math.round(viewport?.width || 0));
  const height = Math.max(1, Math.round(viewport?.height || 0));
  return {
    x: Math.round(clamp(pointer?.x, 0, 1) * (width - 1)),
    y: Math.round(clamp(pointer?.y, 0, 1) * (height - 1)),
  };
}

// What one page message means to the helper. Returns null for anything that is not a
// command this build understands, or a value that is out of range.
function commandFor(payload, { parentHandle, viewport, headerPx = 56 } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const parent = Number(parentHandle);
  if (!Number.isSafeInteger(parent) || parent <= 0) return null;
  const action = payload.action;

  if (action === 'pointer.down' || action === 'pointer.up' || action === 'pointer.move') {
    if (payload.button && payload.button !== 'left') return null;
    const point = pointerToClient(payload, viewport);
    const verb = action === 'pointer.down' ? 'down' : action === 'pointer.up' ? 'up' : 'move';
    // A release after a drag that ended over the header must still be delivered, or the
    // button would stay down on the PC. Only a press (and a wheel) in the header is refused.
    if (verb !== 'up' && point.y < headerPx) return null;
    return `${verb}\t${parent}\t${point.x}\t${point.y}`;
  }
  if (action === 'pointer.click') {
    const point = pointerToClient(payload, viewport);
    if (point.y < headerPx) return null;
    const count = clamp(payload.count || 1, 1, 2);
    return `click\t${parent}\t${point.x}\t${point.y}\t${count}`;
  }
  if (action === 'wheel') {
    const point = pointerToClient(payload, viewport);
    if (point.y < headerPx) return null;
    const delta = Math.round(clamp(payload.delta, -1200, 1200));
    if (delta === 0) return null;
    return `wheel\t${parent}\t${point.x}\t${point.y}\t${delta}`;
  }
  if (action === 'key') {
    const key = resolveKey(payload.key);
    if (!key) return null;
    const phase = payload.phase === 'down' || payload.phase === 'up' ? payload.phase : 'tap';
    return `key\t${key.vk}\t${key.extended ? 1 : 0}\t${phase}`;
  }
  if (action === 'text') {
    const text = String(payload.text || '');
    if (!text || text.length > 500) return null;
    return `text\t${Buffer.from(text, 'utf8').toString('base64')}`;
  }
  return null;
}

module.exports = {
  COMMAND_PREFIX,
  KEYS,
  buildCompanionInputProgram,
  resolveKey,
  clamp,
  pointerToClient,
  commandFor,
};
