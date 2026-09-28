import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOT_UID_MIN, botUserName } from "../../walls/bot-uid";
import { FakeUsers } from "./fake-users";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
const B = "7a7a7a7a-1111-4222-8333-444455556666";
const SID = "0f0e0d0c-0b0a-4908-8706-050403020100";

/**
 * Bug #66: the host reads, writes and deletes a Bot's CLI session only through the root helpers, which now act AS the
 * account that owns the session's tree (legacy /home/box/.claude stays box). The legacy behaviour is covered by
 * secfix3-session-skill-helpers.test.ts and delete-session-helper.test.ts, unchanged.
 */
describe("bug #66: session helpers act as the owning Bot account", () => {
  let f: FakeUsers;
  let dirA: string;
  beforeEach(() => {
    f = new FakeUsers();
    expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
    expect(f.run("bot-user", ["ensure", B]).status).toBe(0);
    dirA = f.p("home/bots", botUserName(A), ".claude/projects/-workspace");
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(`${dirA}/${SID}.jsonl`, '{"a":1}\n');
    f.clearCalls();
  });
  afterEach(() => f.cleanup());
  const asUid = () => f.calls().filter((c) => c.cmd === "setpriv").map((c) => c.args.slice(0, 2));

  it("read: re-execs as the Bot's own uid and gid, then reads", () => {
    const r = f.run("bot-claude-read-session", [`${dirA}/${SID}.jsonl`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('{"a":1}\n');
    expect(asUid()).toEqual([[`--reuid=${BOT_UID_MIN}`, `--regid=${BOT_UID_MIN}`]]);
  });

  it("write: creates the new session as the Bot, never clobbering", () => {
    const target = `${dirA}/11111111-2222-4333-8444-555555555555.jsonl`;
    const r = f.run("bot-claude-write-session", [target], {}, '{"b":2}\n');
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe('{"b":2}\n');
    expect(asUid()).toEqual([[`--reuid=${BOT_UID_MIN}`, `--regid=${BOT_UID_MIN}`]]);
    expect(f.run("bot-claude-write-session", [target], {}, "x").status).toBe(126);
  });

  it("delete: only <account>/.claude/projects/-workspace/<uuid>.jsonl, as the Bot", () => {
    const r = f.run("bot-claude-delete-session", [`${dirA}/${SID}.jsonl`]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(`${dirA}/${SID}.jsonl`)).toBe(false);
    expect(asUid()).toEqual([[`--reuid=${BOT_UID_MIN}`, `--regid=${BOT_UID_MIN}`]]);
    expect(f.run("bot-claude-delete-session", [`${f.p("home/bots", botUserName(A), ".claude/projects/other")}/${SID}.jsonl`]).status).toBe(126);
  });

  it("refuses a path under /home/bots that isn't a Bot account's tree", () => {
    for (const p of [f.p("home/bots/box/.claude/projects/x.jsonl"), f.p("home/bots/bot-zzzzzzzzzzzz/.claude/projects/x.jsonl"), f.p("home/bots/bot-0123456789ab/.claude/projects/x.jsonl")]) {
      expect(f.run("bot-claude-read-session", [p]).status, p).toBe(126);
    }
    expect(asUid()).toEqual([]);
  });

  it("a link in Bot B's tree pointing at Bot A's session is read as B, so the kernel decides (never as root or A)", () => {
    const dirB = f.p("home/bots", botUserName(B), ".claude/projects/-workspace");
    fs.mkdirSync(dirB, { recursive: true });
    fs.symlinkSync(`${dirA}/${SID}.jsonl`, `${dirB}/${SID}.jsonl`);
    const r = f.run("bot-claude-read-session", [`${dirB}/${SID}.jsonl`]);
    expect(r.status).toBe(126); // the resolved path escapes B's root
    expect(asUid()).toEqual([[`--reuid=${BOT_UID_MIN + 1}`, `--regid=${BOT_UID_MIN + 1}`]]);
  });
});
