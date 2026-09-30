import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STR_PROVIDER_UI } from "@synapse/shared";
import { settingEntries } from "../../src/renderer/components/settings/search-index";

/**
 * 0.1.6 readiness: the Safety reviewer block is registered in Settings → Auto-review, but its search entry opened
 * Account, where it isn't. The search entry goes to the section the block is registered in.
 */
describe("Settings search: Safety reviewer", () => {
  it("opens the section the block is registered in", () => {
    const modal = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/components/SettingsModal.tsx"), "utf8");
    const registered = /registerSectionBlock\("([\w-]+)", "safety-reviewer"/.exec(modal)?.[1];
    expect(registered).toBe("auto-review");
    const entry = settingEntries().find((e) => e.label === STR_PROVIDER_UI.safetyTitle);
    expect(entry?.section).toBe(registered);
  });
});
