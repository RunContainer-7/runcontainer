const {
  parseVersion,
  compareVersions,
  interpretLatestRelease,
  checkForUpdate,
  RELEASES_PAGE,
} = require("../../public/update-check");

describe("version comparison", () => {
  it("orders dotted numeric versions", () => {
    expect(compareVersions("0.5.0", "0.5.1")).toBe(-1);
    expect(compareVersions("0.5.1", "0.5.1")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("accepts a v prefix on tags", () => {
    expect(parseVersion("v0.5.1")).toEqual([0, 5, 1]);
    expect(compareVersions("v0.5.1", "0.5.0")).toBe(1);
  });

  it("returns null for anything that is not plain numbers", () => {
    expect(parseVersion("0.5.1-beta")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(compareVersions("latest", "0.5.0")).toBeNull();
  });
});

describe("interpreting the latest release", () => {
  const stable = { tag_name: "v0.5.1", html_url: "https://github.com/RunContainer-7/runcontainer/releases/tag/v0.5.1", prerelease: false, draft: false };

  it("reports a newer Stable release", () => {
    expect(interpretLatestRelease(stable, "0.5.0")).toEqual({
      available: true,
      current: "0.5.0",
      latest: "0.5.1",
      url: stable.html_url,
    });
  });

  it("reports nothing when already up to date", () => {
    expect(interpretLatestRelease(stable, "0.5.1").available).toBe(false);
    expect(interpretLatestRelease(stable, "0.6.0").available).toBe(false);
  });

  it("ignores pre-releases and drafts", () => {
    expect(interpretLatestRelease({ ...stable, prerelease: true }, "0.5.0").available).toBe(false);
    expect(interpretLatestRelease({ ...stable, draft: true }, "0.5.0").available).toBe(false);
  });

  it("falls back to the releases page for a link outside GitHub", () => {
    const result = interpretLatestRelease({ ...stable, html_url: "https://example.com/x" }, "0.5.0");
    expect(result.url).toBe(RELEASES_PAGE);
  });

  it("treats malformed responses as no update", () => {
    expect(interpretLatestRelease(null, "0.5.0").available).toBe(false);
    expect(interpretLatestRelease({ tag_name: "nightly" }, "0.5.0").available).toBe(false);
  });
});

describe("checkForUpdate", () => {
  function fakeGet(statusCode, body) {
    return (url, options, callback) => {
      const handlers = {};
      const response = {
        statusCode,
        setEncoding() {},
        resume() {},
        on(event, fn) { handlers[event] = fn; return response; },
      };
      const request = { on() { return request; }, destroy() {} };
      setImmediate(() => {
        callback(response);
        if (handlers.data) handlers.data(body);
        if (handlers.end) handlers.end();
      });
      return request;
    };
  }

  it("resolves with the notice when GitHub returns a newer release", async () => {
    const body = JSON.stringify({ tag_name: "v0.5.1", html_url: "https://github.com/RunContainer-7/runcontainer/releases/tag/v0.5.1" });
    const result = await checkForUpdate("0.5.0", { get: fakeGet(200, body) });
    expect(result.available).toBe(true);
    expect(result.latest).toBe("0.5.1");
  });

  it("resolves quietly with no notice when GitHub is unavailable", async () => {
    const result = await checkForUpdate("0.5.0", { get: fakeGet(503, "") });
    expect(result.available).toBe(false);
  });

  it("resolves quietly when the request throws", async () => {
    const result = await checkForUpdate("0.5.0", { get: () => { throw new Error("offline"); } });
    expect(result.available).toBe(false);
  });
});
