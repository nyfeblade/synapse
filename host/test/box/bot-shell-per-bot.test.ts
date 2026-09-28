import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { botUserName } from "../../walls/bot-uid";
import { FakeUsers } from "./fake-users";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
const B = "7a7a7a7a-1111-4222-8333-444455556666";

/** Bug #66: a Bot's background Shell runs as the Bot's own account, not box. */
describe("bug #66: bot-shell runs a Bot's Shell as its own account", () => {
  let f: FakeUsers;
  const id = "shell-abc123";
  const stage = () => {
    fs.writeFileSync(f.p("home/box/.host/run", `${id}.sh`), "echo hi\n", { mode: 0o600 });
    fs.writeFileSync(f.p("home/box/.host/run", `${id}.env`), 'BOT_ID="x"\n', { mode: 0o600 });
  };
  beforeEach(() => {
    f = new FakeUsers();
    fs.mkdirSync(f.p("home/box/.host/run"), { recursive: true });
    expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
    expect(f.run("bot-user", ["ensure", B]).status).toBe(0);
    stage();
    f.clearCalls();
  });
  afterEach(() => f.cleanup());
  const unit = () => f.calls().find((c) => c.cmd === "systemd-run")?.args ?? [];

  const term = (bot: string) => f.p("workspace/.host-out/terminals", bot, `${id}.txt`);
  const plantTerm = (bot: string) => { fs.writeFileSync(term(bot), "---\n", { mode: 0o640 }); };

  it("with an account: that uid, its private group, bots as a supplementary group, umask 002", () => {
    const u = botUserName(A);
    plantTerm(A);
    const r = f.run("bot-shell", ["start", id, f.p("workspace"), u, A]);
    expect(r.status, r.stderr).toBe(0);
    expect(unit()).toEqual(expect.arrayContaining([`--uid=${u}`, `--gid=${u}`, "SupplementaryGroups=bots", "UMask=0002"]));
    expect(unit()).not.toContain("--uid=box");
  });

  it("follow-up: the transcript is the Bot's private file, appended by systemd, never by name", () => {
    const u = botUserName(A);
    plantTerm(A);
    expect(f.run("bot-shell", ["start", id, f.p("workspace"), u, A]).status).toBe(0);
    expect(unit()).toEqual(expect.arrayContaining([`StandardOutput=append:${term(A)}`, `StandardError=append:${term(A)}`]));
    // Live finding: PrivateTmp is inert on OrbStack's systemd, so nothing may depend on it.
    expect(unit()).not.toContain("PrivateTmp=yes");
    expect(unit().at(-1)).toBe("--stdout");
  });

  it("follow-up: refuses a Bot id the account doesn't belong to, a missing terminal file, or a planted link", () => {
    const u = botUserName(A);
    expect(f.run("bot-shell", ["start", id, f.p("workspace"), u, B]).status).toBe(2);
    expect(f.run("bot-shell", ["start", id, f.p("workspace"), u, A]).status).toBe(2); // no terminal file yet
    fs.symlinkSync("/etc/passwd", term(A));
    expect(f.run("bot-shell", ["start", id, f.p("workspace"), u, A]).status).toBe(2);
    expect(unit()).toEqual([]);
  });

  it("may start in its own home, never another Bot's (falls back to /workspace)", () => {
    const u = botUserName(A);
    fs.mkdirSync(f.p("home/bots", u, "proj"), { recursive: true });
    plantTerm(A);
    f.run("bot-shell", ["start", id, f.p("home/bots", u, "proj"), u, A]);
    expect(unit()).toContain(`WorkingDirectory=-${f.p("home/bots", u, "proj")}`);
    f.clearCalls();
    f.run("bot-shell", ["start", id, f.p("home/bots", botUserName(B)), u, A]);
    expect(unit()).toContain(`WorkingDirectory=-${f.p("workspace")}`);
  });

  it("refuses an account that isn't a Bot account", () => {
    for (const acct of ["box", "root", "bot-0123456789ab", "bot-x"]) expect(f.run("bot-shell", ["start", id, f.p("workspace"), acct, A]).status, acct).toBe(2);
    expect(unit()).toEqual([]);
  });

  it("legacy: no account still runs as box", () => {
    expect(f.run("bot-shell", ["start", id, f.p("workspace")]).status).toBe(0);
    expect(unit()).toEqual(expect.arrayContaining(["--uid=box", "--gid=bots"]));
  });
});
