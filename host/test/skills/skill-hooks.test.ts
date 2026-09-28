import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillLibrary } from "../../skills/library";
import { createSkillHooks, expansionText, skillCatalog } from "../../skills/skill-hooks";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const B = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  fs.mkdirSync(path.join(cfg.dataRoot, "agents", B), { recursive: true });
  const lib = new SkillLibrary({ cfg });
  lib.write({ name: "Weekly report", description: "Use this when the user asks for the weekly report.", body: "1. Pull numbers" });
  lib.writeHelper("weekly-report", "template.md", "# Template");
  lib.write({ name: "Inbox sweep", description: "Use this when the inbox needs sorting.", body: "…" });
  return { cfg, lib };
}

describe("/ invocation (SKL-03)", () => {
  it("expands the skill before the message text", () => {
    const { cfg, lib } = setup();
    const dir = path.join(cfg.claudeConfigDir, "skills", "weekly-report");
    expect(expansionText(lib, "weekly-report")).toBe(
      `The user invoked the "Weekly report" workflow (skill weekly-report). Run it now.\nWhat it does: Use this when the user asks for the weekly report.\nRecipe to follow:\n1. Pull numbers\n\nThis workflow's helper files are in ${dir}: template.md\nCarry out the recipe now, using the user's message below as its input.`,
    );
    const h = createSkillHooks({ library: lib });
    const d = h.decorateUserMessage!(B, { kind: "message", id: "t1u", role: "user", content: "for this week", createdAt: 1, skillIds: ["weekly-report"] });
    expect(d.before).toHaveLength(1);
    expect(d.after).toEqual([]);
  });
  it("caps the injected body at 8,000 chars", () => {
    const { lib } = setup();
    lib.write({ name: "Long", description: "Use this when…", body: "y".repeat(9000) });
    const t = expansionText(lib, "long")!;
    expect(t).toContain("…(truncated; read the rest in SKILL.md)");
    expect(t.length).toBeLessThan(8600);
  });
});

describe("catalog in the prompt (SKL-04)", () => {
  it("lists enabled skills with their SKILL.md paths and omits opted-out ones", () => {
    const { lib } = setup();
    lib.setEnabled(B, "inbox-sweep", false);
    const c = skillCatalog(lib, B);
    expect(c).toMatch(/^# Skills\n/);
    expect(c).toContain("- Weekly report — Use this when the user asks for the weekly report. (");
    expect(c).not.toContain("Inbox sweep");
    expect(createSkillHooks({ library: lib }).promptSections!(B)).toEqual({ memory: "", skills: c });
  });
});
