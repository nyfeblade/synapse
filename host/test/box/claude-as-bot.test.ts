import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOT_UID_MIN, botUserName } from "../../walls/bot-uid";
import { FakeUsers } from "./fake-users";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
const B = "7a7a7a7a-1111-4222-8333-444455556666";

/** Bug #66: bot-claude-as-box runs a Bot's CLI as that Bot's own account once the host names it (BOT_UNIX_USER). */
describe("bug #66: bot-claude-as-box, per-Bot uid", () => {
  let f: FakeUsers;
  beforeEach(() => { f = new FakeUsers(); expect(f.run("bot-user", ["ensure", A]).status).toBe(0); expect(f.run("bot-user", ["ensure", B]).status).toBe(0); f.clearCalls(); });
  afterEach(() => f.cleanup());

  const run = (env: Record<string, string>) => f.run("bot-claude-as-box", ["--version"], env);
  const setpriv = () => f.calls().find((c) => c.cmd === "setpriv")?.args ?? [];

  it("legacy: no BOT_UNIX_USER runs as box, unchanged", () => {
    const r = run({ BOT_ID: A });
    expect(r.status, r.stderr).toBe(0);
    expect(setpriv().slice(0, 2)).toEqual(["--reuid=box", "--regid=box"]);
  });

  it("per-Bot: runs as the Bot's own uid with its own HOME and CLAUDE_CONFIG_DIR, whatever the caller's env said", () => {
    const u = botUserName(A);
    const r = run({ BOT_ACCOUNT_OF: A, BOT_UNIX_USER: u, HOME: "/home/box", CLAUDE_CONFIG_DIR: "/home/box/.claude" });
    expect(r.status, r.stderr).toBe(0);
    expect(setpriv().slice(0, 4)).toEqual([`--reuid=${BOT_UID_MIN}`, `--regid=${BOT_UID_MIN}`, "--init-groups", "--pdeathsig=KILL"]);
    const home = f.p("home/bots", u);
    expect(r.stdout.trim()).toBe(`HOME=${home} USER=${u} CLAUDE_CONFIG_DIR=${home}/.claude umask=0002`);
  });

  it("bug 231: enters BOT_CWD (a folder in the Bot's own home) only after dropping to the Bot's uid", () => {
    const u = botUserName(A);
    const home = f.p("home/bots", u);
    fs.mkdirSync(path.join(home, "code", "r"), { recursive: true });
    const r = run({ BOT_ACCOUNT_OF: A, BOT_UNIX_USER: u, BOT_CWD: path.join(home, "code", "r") });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`cwd=${fs.realpathSync(path.join(home, "code", "r"))}`);
    expect(setpriv().slice(0, 2)).toEqual([`--reuid=${BOT_UID_MIN}`, `--regid=${BOT_UID_MIN}`]);
  });

  it("bug 231: refuses a BOT_CWD outside the Bot's home, in another Bot's home, or with ..", () => {
    const u = botUserName(A);
    for (const cwd of [f.p("workspace"), f.p("home/bots", botUserName(B), "code"), `${f.p("home/bots", u)}/../${botUserName(B)}`, f.p("home/bots", u)]) {
      f.clearCalls();
      expect(run({ BOT_ACCOUNT_OF: A, BOT_UNIX_USER: u, BOT_CWD: cwd }).status, cwd).toBe(126);
      expect(setpriv(), cwd).toEqual([]);
    }
  });

  it("refuses to run a Bot as another Bot's account (GECOS names the owner)", () => {
    expect(run({ BOT_ACCOUNT_OF: A, BOT_UNIX_USER: botUserName(B) }).status).toBe(126);
    expect(run({ BOT_UNIX_USER: botUserName(A) }).status).toBe(126);
    expect(setpriv()).toEqual([]);
  });

  it("refuses any account outside the reserved range, or a name that isn't a Bot account", () => {
    for (const u of ["box", "root", "bothost", "bot-../../x", "bot-ABC", `${botUserName(A)}x`]) {
      expect(run({ BOT_ACCOUNT_OF: A, BOT_UNIX_USER: u }).status, u).toBe(126);
    }
    f.addPasswd(`bot-000000000000:x:0:0:synapse-bot ${A}:${f.p("home/bots/bot-000000000000")}:/bin/sh`);
    expect(run({ BOT_ACCOUNT_OF: A, BOT_UNIX_USER: "bot-000000000000" }).status).toBe(126);
    expect(setpriv()).toEqual([]);
  });

  it("only bothost via sudo may invoke it", () => {
    expect(run({ SUDO_USER: "box", BOT_ACCOUNT_OF: A, BOT_UNIX_USER: botUserName(A) }).status).toBe(126);
  });

  it("performance: the per-Bot branch adds only a passwd lookup (dry, shimmed; printed for the record)", () => {
    const time = (env: Record<string, string>, n = 20) => {
      const file = f.install("bot-claude-as-box");
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) {
        spawnSync(file, ["--version"], { env: { PATH: `${f.p("shim")}:/usr/bin:/bin`, SHIM_LOG: f.p("calls.log"), FAKE_ETC: f.p("etc"), FAKE_UID: "0", SUDO_USER: "bothost", ...env } });
      }
      return Number(process.hrtime.bigint() - t0) / 1e6 / n;
    };
    const legacy = time({ BOT_ID: A });
    const perBot = time({ BOT_ACCOUNT_OF: A, BOT_UNIX_USER: botUserName(A) });
    console.log(`[bug #66 spawn latency, shimmed] legacy ${legacy.toFixed(1)} ms, per-Bot ${perBot.toFixed(1)} ms (+${(perBot - legacy).toFixed(1)} ms)`);
    expect(perBot - legacy).toBeLessThan(100);
  });
});
