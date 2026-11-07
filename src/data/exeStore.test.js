const { EXE_STORE, isDirectInstall, storeEntryById, storeCategories } = require("./exeStore");

describe("EXE Store catalogue", () => {
  it("has a unique, stable id and a name for every entry", () => {
    const ids = EXE_STORE.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of EXE_STORE) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/);
      expect(String(entry.name || "").trim().length).toBeGreaterThan(1);
      expect(String(entry.publisher || "").trim().length).toBeGreaterThan(1);
      expect(String(entry.summary || "").trim().length).toBeGreaterThan(10);
      expect(String(entry.category || "").trim().length).toBeGreaterThan(1);
      expect(Number(entry.approxSizeMb)).toBeGreaterThan(0);
      expect(String(entry.installNote || "").trim().length).toBeGreaterThan(10);
    }
  });

  it("only links to https pages, and only calls a link an installer when it is one", () => {
    for (const entry of EXE_STORE) {
      expect(entry.downloadPage).toMatch(/^https:\/\//);
      if (entry.installerUrl === null || entry.installerUrl === undefined) {
        expect(isDirectInstall(entry)).toBe(false);
        continue;
      }
      expect(entry.installerUrl).toMatch(/^https:\/\//);
      expect(entry.directInstall).toBe(true);
      expect(isDirectInstall(entry)).toBe(true);
    }
  });

  it("offers at least one one-press install, so the feature is not page-only", () => {
    expect(EXE_STORE.filter((entry) => isDirectInstall(entry)).length).toBeGreaterThan(0);
  });

  it("never treats a missing entry as installable", () => {
    expect(storeEntryById("does-not-exist")).toBeNull();
    expect(isDirectInstall(null)).toBe(false);
    expect(isDirectInstall({ installerUrl: "http://example.com/app.exe", directInstall: true })).toBe(false);
    expect(isDirectInstall({ installerUrl: "https://example.com/app.exe" })).toBe(false);
    expect(isDirectInstall({ installerUrl: "https://example.com/app.exe", directInstall: true })).toBe(true);
  });

  it("builds the filter list from the entries themselves", () => {
    const categories = storeCategories();
    expect(categories[0]).toBe("All");
    expect(new Set(categories).size).toBe(categories.length);
    for (const entry of EXE_STORE) expect(categories).toContain(entry.category);
  });
});
