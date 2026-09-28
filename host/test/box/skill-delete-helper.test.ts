import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rootValidationPath } from "./sandbox";

// CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): box/files/bot-claude-skill-delete
// validation, run locally with plain sh, exactly like host/test/box/delete-session-helper.test.ts does
// for the session helpers. Only the rejection paths that need no filesystem access run here; the
// symlink-resolution checks that need a real /home/box/.claude/skills are checked by box/verify-box.sh
// in the box.
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../box/files/bot-claude-skill-delete");
const run = (args: string[], sudoUser = "bothost") => spawnSync("dash", [HELPER, ...args], { env: { PATH: rootValidationPath(), SUDO_USER: sudoUser }, encoding: "utf8" });

describe("bot-claude-skill-delete (root-owned, sudo from bothost only)", () => {
  it("refuses a caller other than bothost", () => {
    const r = run(["weekly-report"], "box");
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(/must be invoked by bothost/);
  });

  it("needs exactly one argument", () => {
    expect(run([]).status).toBe(2);
    expect(run(["weekly-report", "x"]).status).toBe(2);
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
  ])("rejects a malformed skill id %j", (id) => {
    const r = run([id]);
    expect(r.status, r.stderr).toBe(126);
    expect(r.stderr).toMatch(/invalid skill id/);
  });
});
