const {
  buildIsolatedEnvironment,
  buildProcessListArgs,
  parseProcessIds,
  buildTaskkillArgs,
} = require("../../public/isolated-launch");

describe("isolated app container helpers", () => {
  it("redirects app data and temp folders into the app's own container", () => {
    const layout = { appData: "C:\\RC\\app-1\\AppData", temp: "C:\\RC\\app-1\\Temp" };
    const env = buildIsolatedEnvironment({ PATH: "x", APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\RC\\app-1", layout);
    expect(env.APPDATA).toBe(layout.appData);
    expect(env.LOCALAPPDATA).toBe(layout.appData);
    expect(env.TEMP).toBe(layout.temp);
    expect(env.TMP).toBe(layout.temp);
    expect(env.PATH).toBe("x");
    expect(env.RUNCONTAINER_SANDBOX_ROOT).toBe("C:\\RC\\app-1");
  });

  it("scopes process lookup to the container directory with a trailing separator", () => {
    const args = buildProcessListArgs("C:\\RC\\app-1");
    const script = args[args.length - 1];
    expect(script).toContain("StartsWith('C:\\RC\\app-1\\'");
    expect(buildProcessListArgs("C:\\O'Brien\\app")[3]).toBe("-Command");
    expect(buildProcessListArgs("C:\\O'Brien\\app").slice(-1)[0]).toContain("O''Brien");
  });

  it("parses PID output and ignores noise", () => {
    expect(parseProcessIds("")).toEqual([]);
    expect(parseProcessIds("123\r\n456\r\n")).toEqual([123, 456]);
    expect(parseProcessIds("warning\n789\n0\n")).toEqual([789]);
  });

  it("builds forced tree kill arguments", () => {
    expect(buildTaskkillArgs(42)).toEqual(["/PID", "42", "/T", "/F"]);
  });
});
