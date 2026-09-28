import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config";
import { BOT_UID_MIN, botLayoutPlan, botUserName, gecosFor } from "../../walls/bot-uid";
import { BOTHOST_GID, FakeUsers } from "./fake-users";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
const B = "7a7a7a7a-1111-4222-8333-444455556666";
const C = "c0ffee00-0000-4000-8000-000000000001";

describe("bug #66: box/files/bot-user (one OS account per Bot)", () => {
  let f: FakeUsers;
  beforeEach(() => { f = new FakeUsers(); });
  afterEach(() => f.cleanup());

  const ensure = (id: string, env: Record<string, string> = {}) => f.run("bot-user", ["ensure", id], env);

  it("names the account exactly as walls/bot-uid.ts does", () => {
    for (const id of [A, B, "b1", "x_y-Z"]) expect(f.run("bot-user", ["name", id]).stdout.trim()).toBe(botUserName(id));
  });

  it("only bothost via sudo, or root itself, may run it; a bad Bot id is refused", () => {
    expect(ensure(A, { SUDO_USER: "box" }).status).toBe(126);
    expect(ensure(A, { FAKE_UID: "1001", SUDO_USER: "" }).status).toBe(126);
    for (const bad of ["../x", "a b", "", "x".repeat(65), "a/b"]) expect(ensure(bad).status, bad).toBe(2);
    expect(f.passwd(botUserName(A))).toBeNull();
    expect(ensure(A, { SUDO_USER: "" }).status).toBe(0); // root, not through sudo (the migration)
  });

  it("allocates from the bottom of the reserved range, a private group of the same number, supplementary bots, no login", () => {
    const r = ensure(A);
    expect(r.status, r.stderr).toBe(0);
    const u = botUserName(A);
    const pw = f.passwd(u)!;
    expect(pw[2]).toBe(String(BOT_UID_MIN));
    expect(pw[3]).toBe(String(BOT_UID_MIN));
    expect(pw[4]).toBe(gecosFor(A));
    expect(pw[5]).toBe(f.p("home/bots", u));
    expect(pw[6]).toBe("/usr/sbin/nologin");
    expect(f.groupOf(u)![2]).toBe(String(BOT_UID_MIN));
    expect(f.groupOf("bots")![3]!.split(",")).toContain(u);
    expect(r.stdout.trim()).toBe(`${u} ${BOT_UID_MIN} ${f.p("home/bots", u)}`);
    expect(f.run("bot-user", ["ensure", B]).stdout.split(" ")[1]).toBe(String(BOT_UID_MIN + 1));
  });

  it("is idempotent: a second ensure keeps the uid and adds no account", () => {
    ensure(A);
    f.clearCalls();
    const r = ensure(A);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split(" ")[1]).toBe(String(BOT_UID_MIN));
    expect(f.calls().filter((c) => c.cmd === "useradd" || c.cmd === "groupadd")).toEqual([]);
  });

  it("skips a uid or gid already taken, and never reuses a removed Bot's uid while there is room above", () => {
    f.addPasswd(`someone:x:${BOT_UID_MIN}:100::/nonexistent:/usr/sbin/nologin`);
    ensure(A);
    expect(f.passwd(botUserName(A))![2]).toBe(String(BOT_UID_MIN + 1));
    ensure(B);
    expect(f.run("bot-user", ["remove", A]).status).toBe(0);
    ensure(C);
    expect(f.passwd(botUserName(C))![2]).toBe(String(BOT_UID_MIN + 3));
  });

  it("refuses an existing account that is not this Bot's (wrong GECOS, out of range, or homed elsewhere)", () => {
    const u = botUserName(A);
    f.addPasswd(`${u}:x:${BOT_UID_MIN}:${BOT_UID_MIN}:someone else:${f.p("home/bots", u)}:/usr/sbin/nologin`);
    expect(ensure(A).status).toBe(3);
    expect(f.run("bot-user", ["remove", A]).status).toBe(3);
  });

  it("lays out exactly botLayoutPlan: the home by root, everything inside it as the Bot, staging via O_NOFOLLOW fds", () => {
    const r = ensure(A);
    expect(r.status, r.stderr).toBe(0);
    const u = botUserName(A);
    const uid = String(BOT_UID_MIN);
    const calls = f.calls();
    const cfg = loadConfig({ BOX_HOME: f.p("home/box"), WORKSPACE: f.p("workspace"), SYNAPSE_PER_BOT_UID: "1" });
    const plan = botLayoutPlan(cfg, A).map((e) => ({ ...e, path: e.path.replace(/^\/home\/bots/, f.p("home/bots")) }));
    for (const e of plan) {
      const st = fs.lstatSync(e.path);
      if (e.type === "link") { expect(st.isSymbolicLink(), e.path).toBe(true); expect(fs.readlinkSync(e.path)).toBe(e.target); continue; }
      expect(st.isDirectory(), e.path).toBe(true);
      expect((st.mode & 0o7777).toString(8), e.path).toBe(e.mode.toString(8));
      if (e.owner === "bothost") expect(calls.some((c) => c.cmd === "fchown" && c.args[0] === e.path && c.args[2] === uid), e.path).toBe(true);
    }
    // The home's owner is set by root on the home itself (chown -h, never following a link) ...
    expect(calls).toContainEqual({ cmd: "chown", args: ["-h", "--", `${uid}:${uid}`, f.p("home/bots", u)] });
    // ... and the inside is made by the Bot's own uid, with no supplementary groups and a clean env.
    const sp = calls.find((c) => c.cmd === "setpriv")!;
    expect(sp.args.slice(0, 4)).toEqual([`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--reset-env"]);
    // Root never chowns anything below the home (a link the Bot planted there can't redirect root).
    expect(calls.filter((c) => c.cmd === "chown").every((c) => c.args.at(-1) === f.p("home/bots", u))).toBe(true);
  });

  it("does not follow a link planted at a staging path, and leaves a dir bothost doesn't own alone", () => {
    fs.symlinkSync("/etc", f.p("workspace/.host-out/uploads", A));
    const r = ensure(A);
    expect(r.status).not.toBe(0);
    expect(f.calls().some((c) => c.cmd === "fchown" && c.args[0].startsWith("/etc"))).toBe(false);
  });

  it("an existing home that is a symlink is refused", () => {
    fs.mkdirSync(f.p("home/bots"), { recursive: true });
    fs.symlinkSync(f.p("home/box"), f.p("home/bots", botUserName(A)));
    expect(ensure(A).status).toBe(126);
  });

  it("remove: kills the Bot's processes, hands staging back to bothost only before freeing the gid, deletes account and home", () => {
    ensure(A);
    const u = botUserName(A);
    fs.writeFileSync(f.p("home/bots", u, ".claude/projects/x.jsonl"), "secret");
    f.clearCalls();
    const r = f.run("bot-user", ["remove", A]);
    expect(r.status, r.stderr).toBe(0);
    const calls = f.calls();
    expect(calls).toContainEqual({ cmd: "pkill", args: ["-KILL", "-u", String(BOT_UID_MIN)] });
    const stage = calls.findIndex((c) => c.cmd === "fchown" && c.args[0] === f.p("workspace/.host-out/uploads", A) && c.args[2] === String(BOTHOST_GID));
    const del = calls.findIndex((c) => c.cmd === "groupdel");
    expect(stage).toBeGreaterThanOrEqual(0);
    expect(stage).toBeLessThan(del);
    expect((fs.statSync(f.p("workspace/.host-out/uploads", A)).mode & 0o7777).toString(8)).toBe("700");
    expect(f.passwd(u)).toBeNull();
    expect(f.groupOf(u)).toBeNull();
    expect(fs.existsSync(f.p("home/bots", u))).toBe(false);
    expect(f.run("bot-user", ["remove", A]).status).toBe(0); // idempotent
  });

  it("the sudoers rule names bot-user, and provision installs it root-owned", () => {
    const box = path.resolve(__dirname, "../../../box");
    expect(fs.readFileSync(path.join(box, "files/sudoers-bothost"), "utf8")).toMatch(/NOPASSWD: .*\/usr\/local\/libexec\/bot-user \*/);
    expect(fs.readFileSync(path.join(box, "provision.sh"), "utf8")).toMatch(/install -m 0755 -o root -g root "\$HERE\/files\/bot-user" \/usr\/local\/libexec\/bot-user/);
  });
});
