import { describe, expect, it } from "vitest";
import { sectionOf, settingsSections } from "../../src/renderer/components/settings/sections";
describe("six settings sections", () => {
  it("lists General, Auto-review, Account, Usage, Voice, Computer, Schedules, System (new-user walk findings 15, 22)", () => {
    expect(settingsSections().map((s) => s.label)).toEqual(["General", "Auto-review", "Account", "Usage", "Voice", "Computer", "Schedules", "System"]);
  });
  it("keeps old deep links working", () => {
    expect(sectionOf("usage")).toBe("usage");
    expect(sectionOf("updates")).toBe("system");
    expect(sectionOf("backups/now")).toBe("system");
    expect(sectionOf("diagnostics")).toBe("system");
    expect(sectionOf("auto-review")).toBe("auto-review");
  });
  it("an inherited Object key in a deep link is not a section (own keys only)", () => {
    // `head in SECTION_OF_BLOCK` also matched Object.prototype: "constructor" returned a function.
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(sectionOf(k)).toBe("general");
  });
});
