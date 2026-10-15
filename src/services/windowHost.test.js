const {
  buildWindowHostCSharp,
  buildWindowHostScript,
  buildWindowHostScriptArgs,
  parseWindowHostOutput,
  nativeHandleToInt,
  RESULT_PREFIX,
} = require("../../public/window-host");

describe("window host launcher", () => {
  it("embeds the C# in a here-string so the script parses as PowerShell", () => {
    const script = buildWindowHostScript();
    expect(script).toContain("$source = @'");
    expect(script).toContain("'@");
    expect(script).toContain("Add-Type -TypeDefinition $source -Language CSharp");
    // Bare C# outside the here-string is what broke the isolation launcher once.
    const outside = script.split("$source = @'")[1].split("'@")[1];
    expect(outside).not.toContain("DllImport");
    expect(outside).not.toContain("using System");
  });

  it("uses only documented window APIs", () => {
    const csharp = buildWindowHostCSharp();
    for (const api of ["EnumWindows", "GetWindowThreadProcessId", "IsWindowVisible", "SetParent", "MoveWindow", "GetClientRect", "SetWindowPos", "ShowWindow"]) {
      expect(csharp).toContain(api);
    }
    expect(csharp).toContain("WsChild");
    expect(csharp).toContain("WsPopup");
  });

  it("never claims hosting adds isolation and only re-parents visible top-level windows", () => {
    const csharp = buildWindowHostCSharp();
    expect(csharp).toContain("GetParent(hwnd) != IntPtr.Zero");
    expect(csharp).toContain("GetWindow(hwnd, GwOwner) != IntPtr.Zero");
  });

  it("passes the process, the parent handle and a timeout", () => {
    expect(buildWindowHostScriptArgs("C:\\w.ps1", { mode: "embed", processId: 42, parentHandle: 1234 })).toEqual([
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\w.ps1",
      "-Mode", "embed", "-ProcessId", "42", "-Parent", "1234", "-TimeoutMs", "12000",
    ]);
    expect(buildWindowHostScriptArgs("C:\\w.ps1", { mode: "release", processId: 42, parentHandle: 1, timeoutMs: 500 })).toContain("release");
  });

  it("reads the result, including a refusal that must not be treated as success", () => {
    expect(parseWindowHostOutput(`${RESULT_PREFIX}{"embedded":true,"child":99}`)).toMatchObject({ embedded: true });
    expect(parseWindowHostOutput(`${RESULT_PREFIX}{"embedded":false,"reason":"refused"}`)).toMatchObject({ embedded: false });
    expect(() => parseWindowHostOutput("no result")).toThrow("did not return a result");
  });

  it("converts Electron's native window handle", () => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(0x00123456n, 0);
    expect(nativeHandleToInt(buffer)).toBe(0x00123456);
    expect(nativeHandleToInt(null)).toBe(0);
    expect(nativeHandleToInt(77)).toBe(77);
  });
});
