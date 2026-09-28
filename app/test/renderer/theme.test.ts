// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, cycleTheme, nextTheme, startThemeSync } from "../../src/renderer/theme";
import { useUi } from "../../src/renderer/store";
import { installFakeBridge, settingsFixture } from "./fake-bridge";

describe("theme (SET-02, PAL-04)", () => {
  beforeEach(() => { installFakeBridge({ setHostSettings: (a: { themePreference: string }) => ({ ...settingsFixture(), themePreference: a.themePreference }) }); });

  it("cycles Follow System → Light → Dark", () => {
    expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual(["light", "dark", "system"]);
  });
  it("sets data-theme and tells main", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect((window.synapse.setNativeTheme as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0])).toEqual(["dark", "system"]);
  });
  it("cycleTheme saves the next value and the sync applies it", async () => {
    useUi.setState({ settings: { ...settingsFixture(), themePreference: "light" } } as never);
    const stop = startThemeSync();
    expect(await cycleTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    stop();
  });
});
