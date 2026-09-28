import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rootValidationPath } from "./sandbox";

// CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): box/files/bot-claude-skill-write
// validation, run locally with plain sh, exactly like host/test/box/delete-session-helper.test.ts does
// for the session helpers. Only the rejection paths that need no filesystem access run here (caller
// check, argument count, skill-id shape); the mkdir/write itself and the symlink-resolution checks
// that need a real /home/box/.claude/skills are checked by box/verify-box.sh in the box.
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../box/files/bot-claude-skill-write");
const run = (args: string[], sudoUser = "bothost", input = "") => spawnSync("dash", [HELPER, ...args], { env: { PATH: rootValidationPath(), SUDO_USER: sudoUser }, input, encoding: "utf8" });

describe("bot-claude-skill-write (root-owned, sudo from bothost only)", () => {
  it("refuses a caller other than bothost", () => {
    const r = run(["weekly-report"], "box");
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(/must be invoked by bothost/);
  });

  it("needs one or two arguments (skill id, optional --no-clobber)", () => {
    expect(run([]).status).toBe(2);
    expect(run(["weekly-report", "x", "y"]).status).toBe(2);
  });

  // Follow-up controller ruling: templates/importer.ts imports several files into a brand-new skill
  // directory and must never silently clobber one (e.g. two source files flattening to the same
  // basename); --no-clobber makes the publish step use `ln` (fails EEXIST) instead of `mv -f`.
  it("rejects an unrecognized second argument", () => {
    const r = run(["weekly-report", "--clobber-please"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/unknown second argument/);
  });

  it.each([
    "..",
    ".",
    "../etc",
    "Weekly-Report",
    "weekly report",
    "-weekly",
    "weekly/report",
    ".hidden",
    "weekly..report",
    "weekly\nreport",
  ])("rejects a malformed skill id %j", (id) => {
    const r = run([id]);
    expect(r.status, r.stderr).toBe(126);
    expect(r.stderr).toMatch(/invalid skill id/);
  });
});
