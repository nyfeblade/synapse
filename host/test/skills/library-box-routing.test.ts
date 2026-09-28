import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): SkillLibrary.write()/.remove()
// for user-authored skills in the box-writable ~/.claude/skills (box:bots 2775) must not use the
// host process's own fs operations. In production (cfg.brain === "claude", i.e. the host running in
// the box) they route through the injectable writeSkillFile/deleteSkillDir (host/skills/skill-box-ops.ts),
// which shell out to the root-owned bot-claude-skill-write / bot-claude-skill-delete helpers. The
// local-dev "fake" brain fallback (used by every other SkillLibrary test, which run on the Mac with
// no box) is unaffected -- there is no adversarial Bot process outside the box.
// Follow-up controller ruling: writeHelper() (the non-SKILL.md helper files) carries the same
// race, so it must route through writeSkillHelperFile the same way.
vi.mock("../../skills/skill-box-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skills/skill-box-ops")>();
  return { ...actual, writeSkillFile: vi.fn(), deleteSkillDir: vi.fn(), writeSkillHelperFile: vi.fn() };
});

const { writeSkillFile, deleteSkillDir, writeSkillHelperFile } = await import("../../skills/skill-box-ops");
const { SkillLibrary } = await import("../../skills/library");

describe("SkillLibrary routes write()/remove() through the box helpers when cfg.brain === 'claude'", () => {
  it("write() calls writeSkillFile(id, content), never fs.mkdirSync/fs.writeFileSync directly", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    initLayout(cfg);
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const lib = new SkillLibrary({ cfg });
    const { id } = lib.write({ name: "Weekly report", description: "Use this when…", body: "1. Pull numbers" });
    expect(id).toBe("weekly-report");
    expect(writeSkillFile).toHaveBeenCalledTimes(1);
    const [calledId, calledContent] = vi.mocked(writeSkillFile).mock.calls[0]!;
    expect(calledId).toBe("weekly-report");
    expect(calledContent).toMatch(/^---\nname: Weekly report\n/);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    mkdir.mockRestore();
    writeFile.mockRestore();
  });

  it("remove() calls deleteSkillDir(id), never fs.rmSync directly, after an existing skill is confirmed via read()", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    initLayout(cfg);
    // Seed the skill directly on disk (bypassing write(), which is mocked above) so read() finds it.
    const dir = path.join(cfg.claudeConfigDir, "skills", "weekly-report");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: Weekly report\ndescription: Use this when…\n---\nbody\n");
    const rm = vi.spyOn(fs, "rmSync");
    const lib = new SkillLibrary({ cfg });
    expect(lib.remove("weekly-report")).toBe(true);
    expect(deleteSkillDir).toHaveBeenCalledWith("weekly-report");
    expect(rm).not.toHaveBeenCalled();
    rm.mockRestore();
  });

  it("remove() of a nonexistent skill returns false and never calls deleteSkillDir", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    initLayout(cfg);
    const lib = new SkillLibrary({ cfg });
    vi.mocked(deleteSkillDir).mockClear();
    expect(lib.remove("no-such-skill")).toBe(false);
    expect(deleteSkillDir).not.toHaveBeenCalled();
  });

  it("writeHelper() calls writeSkillHelperFile(id, rel, text), never writeTextAtomic/fs.writeFileSync directly", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    initLayout(cfg);
    const dir = path.join(cfg.claudeConfigDir, "skills", "weekly-report");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: Weekly report\ndescription: Use this when…\n---\nbody\n");
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const lib = new SkillLibrary({ cfg });
    lib.writeHelper("weekly-report", "template.md", "# Template");
    expect(writeSkillHelperFile).toHaveBeenCalledWith("weekly-report", "template.md", "# Template");
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    writeFile.mockRestore();
    mkdir.mockRestore();
  });

  it("writeHelper() still rejects an unsafe relative path before ever calling writeSkillHelperFile", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    initLayout(cfg);
    const lib = new SkillLibrary({ cfg });
    vi.mocked(writeSkillHelperFile).mockClear();
    expect(() => lib.writeHelper("weekly-report", "../escape.md", "x")).toThrow(/Invalid helper file path/);
    expect(() => lib.writeHelper("weekly-report", "SKILL.md", "x")).toThrow(/Invalid helper file path/);
    expect(writeSkillHelperFile).not.toHaveBeenCalled();
  });
});
