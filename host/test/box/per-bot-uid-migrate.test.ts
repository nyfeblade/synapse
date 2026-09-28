import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOT_UID_MIN, botUserName } from "../../walls/bot-uid";
import { buildMigrationPlan, planToTsv } from "../../walls/migration-plan";
import { FakeUsers } from "./fake-users";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
const S1 = "11111111-2222-4333-8444-555555555555";
const S2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";

/**
 * Bug #66: box/files/per-bot-uid-migrate, the root script behind box/migrate-per-bot-uid.sh and
 * box/rollback-per-bot-uid.sh, run for real against a fake box tree (fake-users.ts).
 */
describe("bug #66: the per-Bot-uid migration and its rollback", () => {
  let f: FakeUsers;
  let u: string;
  let L: string;
  let mine: string;
  let planFile: string;
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const migrate = (...args: string[]) => {
    for (const h of ["bot-user", "bot-claude-as-box"]) f.install(h);
    fs.writeFileSync(f.p("libexec/proc-hidepid"), `#!/bin/sh\nprintf 'proc-hidepid\\t%s\\n' "$1" >> "$SHIM_LOG"\n`, { mode: 0o755 });
    return f.run("per-bot-uid-migrate", [...args, "--plan", planFile]);
  };
  const journal = () => (fs.existsSync(f.p("var/lib/bots/per-bot-uid/journal.tsv")) ? read(f.p("var/lib/bots/per-bot-uid/journal.tsv")).split("\n").filter(Boolean) : []);
  const dropIn = () => f.p("etc/systemd/system/bothost.service.d/50-per-bot-uid.conf");

  beforeEach(() => {
    f = new FakeUsers();
    u = botUserName(A);
    L = f.p("home/box/.claude/projects/-workspace");
    mine = f.p("home/bots", u, ".claude/projects/-workspace");
    fs.writeFileSync(`${L}/${S1}.jsonl`, "one\n");
    fs.mkdirSync(`${L}/${S1}/subagents`, { recursive: true });
    fs.writeFileSync(`${L}/${S1}/subagents/x.jsonl`, "child\n");
    fs.writeFileSync(`${L}/${S2}.jsonl`, "two\n");
    fs.writeFileSync(`${L}/99999999-0000-4000-8000-000000000000.jsonl`, "nobody's\n");
    fs.mkdirSync(f.p("home/box/.chrome-screens/3"), { recursive: true });
    fs.writeFileSync(f.p("home/box/.chrome-screens/3/Cookies"), "cookies");
    fs.mkdirSync(f.p("workspace/.host-out/uploads", A), { recursive: true });
    const steps = buildMigrationPlan({ claudeConfigDir: f.p("home/box/.claude"), boxHome: f.p("home/box"), botHomes: f.p("home/bots") },
      [{ id: A, group: false, sessionFiles: [`${L}/${S1}.jsonl`, `${L}/${S2}.jsonl`], display: 3 }]);
    planFile = f.p("plan.tsv");
    fs.writeFileSync(planFile, planToTsv(steps));
  });
  afterEach(() => f.cleanup());

  it("dry run (the default) changes nothing and says what it would do", () => {
    const r = migrate();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`move session ${L}/${S1}.jsonl -> ${mine}/${S1}.jsonl`);
    expect(r.stdout).toContain("(dry-run)");
    expect(fs.existsSync(`${L}/${S1}.jsonl`)).toBe(true);
    expect(f.passwd(u)).toBeNull();
    expect(journal()).toEqual([]);
    expect(fs.existsSync(dropIn())).toBe(false);
    expect(f.calls().filter((c) => c.cmd === "systemctl" || c.cmd === "useradd")).toEqual([]);
  });

  it("apply: stops the host, makes the account, moves the Bot's sessions and screen profile into its home, journals, switches the host", () => {
    const r = migrate("--apply");
    expect(r.status, r.stderr).toBe(0);
    expect(f.passwd(u)![2]).toBe(String(BOT_UID_MIN));
    expect(read(`${mine}/${S1}.jsonl`)).toBe("one\n");
    expect(read(`${mine}/${S1}/subagents/x.jsonl`)).toBe("child\n");
    expect(read(`${mine}/${S2}.jsonl`)).toBe("two\n");
    expect(read(f.p("home/bots", u, "chrome-profile/Cookies"))).toBe("cookies");
    expect(fs.existsSync(`${L}/${S1}.jsonl`)).toBe(false);
    expect(read(`${L}/99999999-0000-4000-8000-000000000000.jsonl`)).toBe("nobody's\n"); // not this Bot's: stays box's
    expect(journal().length).toBe(4);
    const calls = f.calls();
    expect(calls).toContainEqual({ cmd: "chown", args: ["-R", "-P", `${BOT_UID_MIN}:${BOT_UID_MIN}`, "--", `${mine}/${S1}.jsonl`] });
    const sc = calls.filter((c) => c.cmd === "systemctl").map((c) => c.args.join(" "));
    expect(sc[0]).toBe("stop bothost");
    expect(sc.slice(-2)).toEqual(["daemon-reload", "start bothost"]);
    const firstMove = calls.findIndex((c) => c.cmd === "chown" && c.args[0] === "-R");
    expect(calls.findIndex((c) => c.cmd === "systemctl" && c.args[0] === "stop")).toBeLessThan(firstMove);
    // Bug 284: the old name too, so a host an app downgrade redeploys still runs every Bot as its own account.
    expect(read(dropIn())).toBe("[Service]\nEnvironment=SYNAPSE_PER_BOT_UID=1\nEnvironment=BOTS_PER_BOT_UID=1\n");
    // Follow-up: other uids' processes are hidden before the host starts again, and at every boot from then on.
    const hide = calls.findIndex((c) => c.cmd === "proc-hidepid" && c.args[0] === "on");
    expect(hide).toBeGreaterThan(-1);
    expect(hide).toBeLessThan(calls.findIndex((c) => c.cmd === "systemctl" && c.args.join(" ") === "start bothost"));
    expect(sc).toContain("enable bots-hidepid.service");
  });

  it("is idempotent, and resumes an interrupted run", () => {
    // Interrupted after moving S2 by hand-equivalent: S2 is already in the Bot's home.
    expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
    fs.mkdirSync(mine, { recursive: true });
    fs.renameSync(`${L}/${S2}.jsonl`, `${mine}/${S2}.jsonl`);
    const r1 = migrate("--apply");
    expect(r1.status, r1.stderr).toBe(0);
    expect(r1.stdout).toMatch(/moved 3, already done 1, skipped 0/);
    const r2 = migrate("--apply");
    expect(r2.stdout).toMatch(/moved 0, already done 4, skipped 0/);
    expect(journal().length).toBe(3);
  });

  it("refuses plan lines outside the known roots, into another account's home, or for a mismatched account", () => {
    const other = botUserName("7a7a7a7a-1111-4222-8333-444455556666");
    fs.writeFileSync(planFile, [
      ["account", A, u],
      ["move", "session", A, u, "/etc/passwd", `${mine}/x.jsonl`],
      ["move", "session", A, u, `${L}/${S1}.jsonl`, f.p("home/bots", other, "x.jsonl")],
      ["move", "session", A, u, `${L}/../../../../../etc/${S1}.jsonl`, `${mine}/${S1}.jsonl`],
      ["account", A, other],
    ].map((c) => c.join("\t")).join("\n") + "\n");
    const r = migrate("--apply");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/moved 0, already done 0, skipped 4/);
    expect(read(`${L}/${S1}.jsonl`)).toBe("one\n");
  });

  it("rollback puts everything back (and sessions made since), regroups staging to bots, drops the host flag; twice is a no-op", () => {
    expect(migrate("--apply").status).toBe(0);
    fs.writeFileSync(`${mine}/${"abcdefab-0000-4000-8000-000000000000"}.jsonl`, "new since\n");
    const dry = migrate("--rollback");
    expect(dry.status, dry.stderr).toBe(0);
    expect(fs.existsSync(`${mine}/${S1}.jsonl`)).toBe(true); // a dry run moves nothing back
    f.clearCalls();
    const r = migrate("--rollback", "--apply");
    expect(r.status, r.stderr).toBe(0);
    expect(read(`${L}/${S1}.jsonl`)).toBe("one\n");
    expect(read(`${L}/${S1}/subagents/x.jsonl`)).toBe("child\n");
    expect(read(`${L}/${S2}.jsonl`)).toBe("two\n");
    expect(read(`${L}/abcdefab-0000-4000-8000-000000000000.jsonl`)).toBe("new since\n");
    expect(read(f.p("home/box/.chrome-screens/3/Cookies"))).toBe("cookies");
    expect(fs.existsSync(dropIn())).toBe(false);
    const calls = f.calls();
    expect(calls.some((c) => c.cmd === "chgrp" && c.args.includes("bots") && c.args.includes(path.join(f.p("workspace/.host-out/uploads"), A)))).toBe(true);
    expect(calls.filter((c) => c.cmd === "systemctl").map((c) => c.args.join(" ")).slice(-2)).toEqual(["daemon-reload", "start bothost"]);
    expect(calls.some((c) => c.cmd === "systemctl" && c.args.join(" ") === "disable bots-hidepid.service")).toBe(true);
    expect(calls.some((c) => c.cmd === "proc-hidepid" && c.args[0] === "off")).toBe(true);
    f.clearCalls();
    const again = migrate("--rollback", "--apply");
    expect(again.stdout).not.toMatch(/move back/);
  });

  it("the Mac wrappers stream this script and default to a dry run", () => {
    const box = path.resolve(__dirname, "../../../box");
    for (const w of ["migrate-per-bot-uid.sh", "rollback-per-bot-uid.sh"]) {
      const s = read(path.join(box, w));
      expect(s, w).toContain('< "$HERE/files/per-bot-uid-migrate"');
      expect(s, w).toMatch(/case "\$\{1:-\}" in ''\|--dry-run\|--apply\)/);
      expect(fs.statSync(path.join(box, w)).mode & 0o111, w).not.toBe(0);
    }
  });
});
