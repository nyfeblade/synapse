import { describe, expect, it, vi } from "vitest";
import { deleteSkillDir, SKILL_DELETE_HELPER, SKILL_WRITE_FILE_HELPER, SKILL_WRITE_HELPER, writeSkillFile, writeSkillFileNoClobber, writeSkillHelperFile, writeSkillHelperFileNoClobber } from "../../skills/skill-box-ops";

// CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): ~/.claude/skills is box:bots
// 2775 -- box-writable by design, since Bot processes (running as box) edit skills too. That same
// group-write bit is the danger: a Bot could swap the skills directory, or one skill's own
// directory, for a symlink and redirect the host's own mkdir/write/rm. So writeSkillFile and
// deleteSkillDir never touch ~/.claude/skills with the host process's own fs calls; they shell out,
// via `sudo -n`, to narrow root-owned helpers that run the actual mutation as user box and refuse
// any symlink in the chain (box/files/bot-claude-skill-write, box/files/bot-claude-skill-delete).
describe("writeSkillFile (root-owned bot-claude-skill-write helper)", () => {
  it("shells out to sudo -n bot-claude-skill-write with exactly the skill id, piping SKILL.md content on stdin", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    writeSkillFile("weekly-report", "---\nname: Weekly report\n---\nbody\n", exec as never);
    expect(SKILL_WRITE_HELPER).toBe("/usr/local/libexec/bot-claude-skill-write");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SKILL_WRITE_HELPER, "weekly-report"], expect.objectContaining({ input: "---\nname: Weekly report\n---\nbody\n" }));
  });

  it("propagates the helper's failure rather than swallowing it", () => {
    const exec = vi.fn().mockImplementation(() => { throw new Error("bot-claude-skill-write: skills directory is a symlink"); });
    expect(() => writeSkillFile("weekly-report", "x", exec as never)).toThrow(/skills directory is a symlink/);
  });

  it.each(["..", ".", "../etc", "Weekly-Report", "weekly report", "-weekly", "", "weekly/report", ".hidden"])("refuses a malformed skill id %j before ever shelling out", (id) => {
    const exec = vi.fn();
    expect(() => writeSkillFile(id, "x", exec as never)).toThrow(/invalid skill id/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("accepts ids with dots and underscores, matching the box helper's own regex", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    writeSkillFile("weekly_report.v2", "x", exec as never);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SKILL_WRITE_HELPER, "weekly_report.v2"], expect.any(Object));
  });
});

// Follow-up controller ruling: writeHelper() (the non-SKILL.md helper files a skill carries, e.g.
// a template or a script) carries the same race -- ~/.claude/skills/<id> is box:bots 2775 -- so it
// must route through the same kind of root-owned helper too, confined to that skill's own dir.
describe("writeSkillHelperFile (root-owned bot-claude-skill-write-file helper)", () => {
  it("shells out to sudo -n bot-claude-skill-write-file with the skill id and relative path, piping content on stdin", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    writeSkillHelperFile("weekly-report", "template.md", "# Template", exec as never);
    expect(SKILL_WRITE_FILE_HELPER).toBe("/usr/local/libexec/bot-claude-skill-write-file");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SKILL_WRITE_FILE_HELPER, "weekly-report", "template.md"], expect.objectContaining({ input: "# Template" }));
  });

  it("accepts a nested relative path", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    writeSkillHelperFile("weekly-report", "scripts/run.sh", "#!/bin/sh", exec as never);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SKILL_WRITE_FILE_HELPER, "weekly-report", "scripts/run.sh"], expect.any(Object));
  });

  it("propagates the helper's failure rather than swallowing it", () => {
    const exec = vi.fn().mockImplementation(() => { throw new Error("bot-claude-skill-write-file: path component is a symlink"); });
    expect(() => writeSkillHelperFile("weekly-report", "template.md", "x", exec as never)).toThrow(/path component is a symlink/);
  });

  it.each(["..", ".", "../etc", "Weekly-Report", ""])("refuses a malformed skill id %j before ever shelling out", (id) => {
    const exec = vi.fn();
    expect(() => writeSkillHelperFile(id, "template.md", "x", exec as never)).toThrow(/invalid skill id/);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["SKILL.md", "", "/etc/passwd", "../escape", "a/../b", "..", "a/..", "bad*char", "a//b", "a/", "trailing/"])("refuses a malformed relative path %j before ever shelling out", (rel) => {
    const exec = vi.fn();
    expect(() => writeSkillHelperFile("weekly-report", rel, "x", exec as never)).toThrow(/invalid skill helper file path/);
    expect(exec).not.toHaveBeenCalled();
  });
});

// Follow-up controller ruling: templates/importer.ts imports several files into a brand-new skill
// directory and must never silently clobber one, so it uses the no-clobber variants, which pass
// --no-clobber through to the same root-owned helpers (ln instead of mv -f at the publish step).
describe("writeSkillFileNoClobber / writeSkillHelperFileNoClobber", () => {
  it("writeSkillFileNoClobber appends --no-clobber to the sudo invocation", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    writeSkillFileNoClobber("trip-desk--book-flights", "content", exec as never);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SKILL_WRITE_HELPER, "trip-desk--book-flights", "--no-clobber"], expect.objectContaining({ input: "content" }));
  });

  it("writeSkillFileNoClobber still validates the id and never shells out on a bad one", () => {
    const exec = vi.fn();
    expect(() => writeSkillFileNoClobber("../etc", "x", exec as never)).toThrow(/invalid skill id/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("writeSkillFileNoClobber propagates a refused overwrite", () => {
    const exec = vi.fn().mockImplementation(() => { throw new Error("bot-claude-skill-write: refusing to overwrite an existing file"); });
    expect(() => writeSkillFileNoClobber("trip-desk--book-flights", "x", exec as never)).toThrow(/refusing to overwrite/);
  });

  it("writeSkillHelperFileNoClobber appends --no-clobber to the sudo invocation", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    writeSkillHelperFileNoClobber("trip-desk--book-flights", "run.sh", "#!/bin/sh", exec as never);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SKILL_WRITE_FILE_HELPER, "trip-desk--book-flights", "run.sh", "--no-clobber"], expect.objectContaining({ input: "#!/bin/sh" }));
  });

  it("writeSkillHelperFileNoClobber still validates the id and relative path and never shells out on a bad one", () => {
    const exec = vi.fn();
    expect(() => writeSkillHelperFileNoClobber("../etc", "run.sh", "x", exec as never)).toThrow(/invalid skill id/);
    expect(() => writeSkillHelperFileNoClobber("trip-desk--book-flights", "../escape", "x", exec as never)).toThrow(/invalid skill helper file path/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("deleteSkillDir (root-owned bot-claude-skill-delete helper)", () => {
  it("shells out to sudo -n bot-claude-skill-delete with exactly the skill id", () => {
    const exec = vi.fn().mockReturnValue(Buffer.from(""));
    deleteSkillDir("weekly-report", exec as never);
    expect(SKILL_DELETE_HELPER).toBe("/usr/local/libexec/bot-claude-skill-delete");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", SKILL_DELETE_HELPER, "weekly-report"], expect.any(Object));
  });

  it.each(["..", ".", "../etc", "Weekly-Report", ""])("refuses a malformed skill id %j before ever shelling out", (id) => {
    const exec = vi.fn();
    expect(() => deleteSkillDir(id, exec as never)).toThrow(/invalid skill id/);
    expect(exec).not.toHaveBeenCalled();
  });
});
