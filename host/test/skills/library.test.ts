import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillLibrary } from "../../skills/library";
import { createSkillOptOutHooks } from "../../skills/optout-hooks";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const B = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  fs.mkdirSync(path.join(cfg.dataRoot, "agents", B), { recursive: true });
  let changes = 0;
  const lib = new SkillLibrary({ cfg, onChange: () => changes++ });
  return { cfg, lib, changes: () => changes };
}

describe("SkillLibrary (SKL-01)", () => {
  it("writes SKILL.md under ~/.claude/skills/<slug>, group-writable, and overwrites by id", () => {
    const { cfg, lib, changes } = setup();
    expect(lib.write({ name: "Weekly report", description: "Use this when asked for the weekly report.", body: "1. Pull numbers" })).toEqual({ id: "weekly-report", created: true });
    const f = path.join(cfg.claudeConfigDir, "skills", "weekly-report", "SKILL.md");
    expect(fs.readFileSync(f, "utf8")).toMatch(/^---\nname: Weekly report\n/);
    expect(fs.statSync(f).mode & 0o777).toBe(0o664);
    expect(lib.write({ name: "Weekly report", description: "Use this when…", body: "2. v2" }).created).toBe(false);
    expect(lib.read("weekly-report")!.file.body).toBe("2. v2\n");
    expect(changes()).toBe(2);
  });

  it("tracks per-Bot opt-outs in enabled-workflows.json and reports them in views", () => {
    const { cfg, lib } = setup();
    lib.write({ name: "Inbox sweep", description: "Use this when…", body: "…" });
    expect(lib.setEnabled(B, "inbox-sweep", false)).toEqual(["inbox-sweep"]);
    expect(JSON.parse(fs.readFileSync(path.join(cfg.dataRoot, "agents", B, "enabled-workflows.json"), "utf8"))).toEqual({ disabled: ["inbox-sweep"] });
    expect(lib.views([B])[0]).toMatchObject({ id: "inbox-sweep", disabledFor: [B], source: null, managed: false });
  });

  it("denies the Skill tool for a disabled skill (PreToolUse)", () => {
    const { lib } = setup();
    lib.write({ name: "Inbox sweep", description: "Use this when…", body: "…" });
    lib.setEnabled(B, "inbox-sweep", false);
    const h = createSkillOptOutHooks({ library: lib });
    expect(h.preToolUse!(B, { toolName: "Skill", input: { skill: "inbox-sweep" }, toolUseId: "t" }, null)).toEqual({ decision: "deny", reason: 'The user turned off the skill "Inbox sweep" for you.' });
    expect(h.preToolUse!(B, { toolName: "Skill", input: { command: "Inbox sweep" }, toolUseId: "t" }, null)).toMatchObject({ decision: "deny" });
    expect(h.preToolUse!(B, { toolName: "Bash", input: {}, toolUseId: "t" }, null)).toBeNull();
  });
});
