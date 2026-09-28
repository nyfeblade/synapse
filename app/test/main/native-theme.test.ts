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
