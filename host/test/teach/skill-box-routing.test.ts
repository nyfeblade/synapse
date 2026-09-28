import { describe, expect, it, vi } from "vitest";
import { tmpConfig } from "../helpers";

// Follow-up controller ruling: installManagedSkill's default writer must route through the
// root-owned bot-claude-skill-write helper (writeSkillFile) when cfg.brain === "claude", the same
// way SkillLibrary.write() does -- ~/.claude/skills is the exact same box:bots 2775 tree.
vi.mock("../../skills/skill-box-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skills/skill-box-ops")>();
  return { ...actual, writeSkillFile: vi.fn() };
});

const { writeSkillFile } = await import("../../skills/skill-box-ops");
const { installManagedSkill } = await import("../../teach/skill");

describe("installManagedSkill routes through the box helper when cfg.brain === 'claude'", () => {
  it("calls writeSkillFile(\"learn-from-demonstration\", text) instead of writing fs directly", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    expect(installManagedSkill(cfg)).toBe(true);
    expect(writeSkillFile).toHaveBeenCalledTimes(1);
    const [id, text] = vi.mocked(writeSkillFile).mock.calls[0]!;
    expect(id).toBe("learn-from-demonstration");
    expect(text).toContain("<<LEARN_FROM_DEMO_V1>>");
  });
});
