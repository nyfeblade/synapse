import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SkillLibrary } from "../../skills/library";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): a Bot in the box could swap
// ~/.claude/skills itself (or one skill's own directory) for a symlink pointing at the host's
// hostPrivate (~/.host, holding the OAuth token etc.) and try to trick the host into writing,
// deleting or reading through it. write()/remove() must delegate every mutation to the injected
// box writer and never touch fs themselves; reads (ids/read, which "can stay as they are" per the
// ruling) must still never follow a symlink out of the skills dir.
function hostPrivateWithCanaries(): string {
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "bots-hostprivate-"));
  fs.writeFileSync(path.join(hp, "vault.key"), "SECRET-KEY");
  fs.writeFileSync(path.join(hp, "claude-oauth-token"), "SECRET-TOKEN");
  return hp;
}
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) out[name] = fs.readFileSync(path.join(dir, name), "utf8");
  return out;
}

describe("SkillLibrary never writes or deletes through a symlinked ~/.claude/skills", () => {
  it("write()/remove(), with cfg.brain === 'claude' and a fully injected writer, never touch fs and leave hostPrivate untouched when skills is symlinked to it", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    initLayout(cfg);
    const hp = hostPrivateWithCanaries();
    const before = snapshot(hp);
    fs.mkdirSync(cfg.claudeConfigDir, { recursive: true });
    fs.rmSync(path.join(cfg.claudeConfigDir, "skills"), { recursive: true, force: true });
    fs.symlinkSync(hp, path.join(cfg.claudeConfigDir, "skills"));

    const writeSkillFile = vi.fn();
    const deleteSkillDir = vi.fn();
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const rm = vi.spyOn(fs, "rmSync");
    const lib = new SkillLibrary({ cfg, writeSkillFile, deleteSkillDir });

    lib.write({ name: "Weekly report", description: "Use this when…", body: "1." });
    expect(writeSkillFile).toHaveBeenCalledWith("weekly-report", expect.any(String));
    // remove() first calls read(), which must report nothing usable through the symlinked root.
    expect(lib.remove("vault")).toBe(false);
    expect(deleteSkillDir).not.toHaveBeenCalled();

    expect(mkdir).not.toHaveBeenCalledWith(expect.stringContaining(hp), expect.anything());
    expect(writeFile).not.toHaveBeenCalledWith(expect.stringContaining(hp), expect.anything(), expect.anything());
    expect(rm).not.toHaveBeenCalledWith(expect.stringContaining(hp), expect.anything());
    expect(snapshot(hp)).toEqual(before);

    mkdir.mockRestore();
    writeFile.mockRestore();
    rm.mockRestore();
    fs.rmSync(hp, { recursive: true, force: true });
  });

  it("ids()/read() return nothing through a skills root swapped to a symlink (hostPrivate)", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const hp = hostPrivateWithCanaries();
    fs.writeFileSync(path.join(hp, "vault.key"), "SECRET-KEY"); // not a valid skill dir, but prove ids() doesn't even list it
    fs.mkdirSync(cfg.claudeConfigDir, { recursive: true });
    fs.rmSync(path.join(cfg.claudeConfigDir, "skills"), { recursive: true, force: true });
    fs.symlinkSync(hp, path.join(cfg.claudeConfigDir, "skills"));

    const lib = new SkillLibrary({ cfg });
    expect(lib.ids()).toEqual([]);
    expect(lib.read("vault")).toBeNull();

    fs.rmSync(hp, { recursive: true, force: true });
  });

  it("read()/ids() skip a skill whose own directory is a symlink out of the skills dir", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const lib = new SkillLibrary({ cfg });
    lib.write({ name: "Real skill", description: "Use this when…", body: "kept" });

    const hp = hostPrivateWithCanaries();
    fs.mkdirSync(path.join(hp, "leaked"), { recursive: true });
    fs.writeFileSync(path.join(hp, "leaked", "SKILL.md"), "---\nname: Leaked\ndescription: Use this when…\n---\nleaked body\n");
    const evilLink = path.join(cfg.claudeConfigDir, "skills", "leaked");
    fs.symlinkSync(path.join(hp, "leaked"), evilLink);

    expect(lib.ids()).toEqual(["real-skill"]);
    expect(lib.read("leaked")).toBeNull();

    fs.rmSync(hp, { recursive: true, force: true });
  });
});
