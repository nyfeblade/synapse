import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ nativeTheme: { themeSource: "system" } }));
import { applyNativeTheme } from "../../src/main/native-theme";

describe("native theme", () => {
  it("maps the preference to nativeTheme.themeSource", () => {
    const nt = { themeSource: "system" };
    applyNativeTheme("dark", nt);
    expect(nt.themeSource).toBe("dark");
    applyNativeTheme("bogus", nt);
    expect(nt.themeSource).toBe("system");
  });
});

describe("new-user walk finding 4: the theme is known on the Mac before the first paint", () => {
  it("the preference is cached on disk and read back at launch; a missing or broken file is system", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { cacheTheme, readCachedTheme } = await import("../../src/main/native-theme");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-"));
    try {
      const f = path.join(dir, "theme.json");
      expect(readCachedTheme(f)).toBe("system");
      cacheTheme(f, "dark");
      expect(readCachedTheme(f)).toBe("dark");
      fs.writeFileSync(f, "{nope");
      expect(readCachedTheme(f)).toBe("system");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("the window's own background matches the theme, so nothing white shows before the page paints", async () => {
    const { windowBackground } = await import("../../src/main/native-theme");
    expect(windowBackground(true)).toBe("#0C0C0C");
    expect(windowBackground(false)).toBe("#FFFFFF");
  });
});
