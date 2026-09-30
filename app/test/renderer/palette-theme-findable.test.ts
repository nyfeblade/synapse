// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { STR } from "@synapse/shared";
import { settingsSections } from "../../src/renderer/components/settings/sections";
import { defaultRows, typedRows, type PaletteCtx } from "../../src/renderer/palette-rows";

const ctx = (theme: "system" | "light" | "dark"): PaletteCtx => ({
  bots: {}, pinned: [], currentBotId: null, theme,
  actions: {
    openBot: () => {}, openChatSettings: () => {}, openSettings: () => {}, cycleTheme: async () => {},
    newBot: () => {}, showHidden: () => {}, jumpTo: () => {}, startCall: () => {}, exportBot: () => {}, importBot: () => {},
  },
});

describe("the palette's theme row is findable (PAL-04)", () => {
  it("its subtitle names a Settings section that exists", () => {
    expect(settingsSections().some((s) => STR.themeSubtitle.includes(s.label))).toBe(true);
  });

  it("matches the words a user would type for it", () => {
    for (const q of ["light", "dark", "appearance", "theme", "follow system"]) {
      const keys = typedRows(ctx("system"), q, [], []).map((r) => r.key);
      expect(keys, `searching "${q}" should reach the theme row`).toContain("theme");
    }
  });

  it("still offers the cycle row by default", () => {
    expect(defaultRows(ctx("light")).find((r) => r.key === "theme")?.title).toBe(STR.themeRow(STR.themeLabels.light!));
  });
});
