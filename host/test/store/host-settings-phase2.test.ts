import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostSettingsStore } from "../../store/host-settings";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hs-")), "settings.json");

describe("HostSettingsStore Phase 2 fields (SET-02, SET-05, SET-17, D14)", () => {
  it("defaults theme to system, recall on, advanced off, no tz override", () => {
    const s = new HostSettingsStore(file());
    expect(s.view()).toMatchObject({ themePreference: "system", memoryRecall: true, advancedEnabled: false, userTimeZoneOverride: null });
  });
  it("updates and validates the new fields", () => {
    const s = new HostSettingsStore(file());
    expect(s.update({ themePreference: "dark", memoryRecall: false, advancedEnabled: true, userTimeZone: "Europe/Paris" }))
      .toMatchObject({ themePreference: "dark", memoryRecall: false, advancedEnabled: true, userTimeZone: "Europe/Paris", userTimeZoneOverride: "Europe/Paris" });
    expect(() => s.update({ themePreference: "purple" as never })).toThrow(/theme/i);
    expect(s.update({ userTimeZone: "" }).userTimeZoneOverride).toBeNull();
  });
});

describe("Appearance is theme only (decisions.md, \"the app is neutral\")", () => {
  it("has no Bot-colour setting: the view never carries one, and a stored one is not passed on", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ botColour: "rich" }));
    const v = new HostSettingsStore(f).view();
    expect(v).not.toHaveProperty("botColour");
    // A patch naming it is simply not part of the command's shape and changes nothing on the view.
    expect(new HostSettingsStore(f).update({ botColour: "rich" } as never)).not.toHaveProperty("botColour");
  });
});

describe("Save usage (cost-diet-2 lever 1: model routing)", () => {
  it("is off by default, account-wide, persists, and a Bot's own switch wins over it", async () => {
    const f = file();
    const s = new HostSettingsStore(f);
    expect(s.view().saveUsage).toBe(false);
    expect(s.update({ saveUsage: true }).saveUsage).toBe(true);
    expect(new HostSettingsStore(f).view().saveUsage).toBe(true);
    const { saveUsageOn } = await import("../../brain/model-router");
    expect(saveUsageOn({}, false)).toBe(false);
    expect(saveUsageOn({}, true)).toBe(true);
    expect(saveUsageOn({ saveUsage: false }, true)).toBe(false);
    expect(saveUsageOn({ saveUsage: true }, false)).toBe(true);
  });
});

describe("Savings (saving-settings)", () => {
  it("defaults to today's behaviour, persists, and refuses anything but its own choices", () => {
    const f = file();
    const s = new HostSettingsStore(f);
    expect(s.view()).toMatchObject({ promptCacheTtl: "1h", callReplies: "default", longContext: "on" });
    s.update({ promptCacheTtl: "5m", callReplies: "fast", longContext: "when-needed" });
    expect(new HostSettingsStore(f).view()).toMatchObject({ promptCacheTtl: "5m", callReplies: "fast", longContext: "when-needed" });
    expect(() => s.update({ promptCacheTtl: "10m" as never })).toThrow();
    expect(() => s.update({ callReplies: "slow" as never })).toThrow();
    expect(() => s.update({ longContext: "off" as never })).toThrow();
    expect(new HostSettingsStore(f).view()).toMatchObject({ promptCacheTtl: "5m", callReplies: "fast", longContext: "when-needed" });
  });

  it("a stored value it doesn't know reads as the default", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ promptCacheTtl: "2h", callReplies: 7, longContext: null }));
    expect(new HostSettingsStore(f).view()).toMatchObject({ promptCacheTtl: "1h", callReplies: "default", longContext: "on" });
  });
});
