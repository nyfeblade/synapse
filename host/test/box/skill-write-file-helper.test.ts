import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rootValidationPath } from "./sandbox";

// Follow-up controller ruling: box/files/bot-claude-skill-write-file validation, run locally with
// plain sh, exactly like the other box/files/bot-claude-skill-* tests. Only the rejection paths
// that need no filesystem access run here (caller check, argument count, skill-id shape, relative-
// path shape); the mkdir/write itself and the symlink-resolution checks that need a real
// /home/box/.claude/skills are checked by box/verify-box.sh in the box.
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../box/files/bot-claude-skill-write-file");
const run = (args: string[], sudoUser = "bothost") => spawnSync("dash", [HELPER, ...args], { env: { PATH: rootValidationPath(), SUDO_USER: sudoUser }, input: "", encoding: "utf8" });

describe("bot-claude-skill-write-file (root-owned, sudo from bothost only)", () => {
  it("refuses a caller other than bothost", () => {
    const r = run(["weekly-report", "template.md"], "box");
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(/must be invoked by bothost/);
  });

  it("needs two or three arguments (skill id, relative path, optional --no-clobber)", () => {
    expect(run([]).status).toBe(2);
    expect(run(["weekly-report"]).status).toBe(2);
    expect(run(["weekly-report", "template.md", "extra", "more"]).status).toBe(2);
  });

  // Follow-up controller ruling: templates/importer.ts imports several files into a brand-new skill
  // directory and must never silently clobber one; --no-clobber makes the publish step use `ln`
  // (fails EEXIST) instead of `mv -f`.
  it("rejects an unrecognized third argument", () => {
    const r = run(["weekly-report", "template.md", "--clobber-please"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/unknown third argument/);
  });

  it.each(["..", ".", "../etc", "Weekly-Report", "weekly report", "-weekly", "weekly/report", ".hidden"])("rejects a malformed skill id %j", (id) => {
    const r = run([id, "template.md"]);
    expect(r.status, r.stderr).toBe(126);
    expect(r.stderr).toMatch(/invalid skill id/);
  });

  it.each([
    "SKILL.md",
    "",
    "/etc/passwd",
    "../escape",
    "a/../b",
    "..",
    "a/..",
    "bad*char",
    "a//b",
    "a/",
    "trailing/",
    "weekly\nreport.md",
  ])("rejects a malformed relative path %j", (rel) => {
    const r = run(["weekly-report", rel]);
    expect(r.status, r.stderr).toBe(126);
    expect(r.stderr).toMatch(/invalid|empty|must go through/);
  });
});
