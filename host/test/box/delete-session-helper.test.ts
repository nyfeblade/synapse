import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rootValidationPath } from "./sandbox";

// Gate M-2: box/files/bot-claude-delete-session validation, run locally with plain sh. Only the rejection
// paths run here (they exit before touching the file system); the delete itself is checked by box/verify-box.sh.
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../box/files/bot-claude-delete-session");
const run = (args: string[], sudoUser = "bothost") => spawnSync("dash", [HELPER, ...args], { env: { PATH: rootValidationPath(), SUDO_USER: sudoUser }, encoding: "utf8" });
const DIR = "/home/box/.claude/projects/-workspace/";
const UUID = "0393b532-c3c8-448c-b375-f9851dc52ed9";

describe("bot-claude-delete-session (root-owned, sudo from bothost only)", () => {
  it("refuses a caller other than bothost", () => {
    const r = run([`${DIR}${UUID}.jsonl`], "box");
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(/must be invoked by bothost/);
  });

  it("needs exactly one argument", () => {
    expect(run([]).status).toBe(2);
    expect(run([`${DIR}${UUID}.jsonl`, "x"]).status).toBe(2);
  });

  it.each([
    ["/etc/passwd", /directory must be/],
    [`/home/box/.claude/projects/-verify/${UUID}.jsonl`, /directory must be/],
    [`${DIR}../../../../etc/${UUID}.jsonl`, /directory must be|traversal/],
    [`${DIR}sub/${UUID}.jsonl`, /directory must be/],
    [`${DIR}not-a-uuid.jsonl`, /not a session file name/],
    [`${DIR}${UUID}.json`, /not a session file name/],
    [`${DIR}${UUID.toUpperCase()}.jsonl`, /not a session file name/],
    [`${DIR}${UUID}x.jsonl`, /not a session file name/],
    [`${DIR}${UUID}.jsonl\n/etc/passwd`, /not a session file name|directory must be/],
    [`${DIR}*.jsonl`, /not a session file name/],
    [`${DIR}.jsonl`, /not a session file name/],
  ])("rejects %j", (p, msg) => {
    const r = run([p]);
    expect(r.status, r.stderr).toBe(126);
    expect(r.stderr).toMatch(msg);
  });
});
