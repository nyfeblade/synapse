import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeUsers } from "./fake-users";

/**
 * Bug #66 follow-up: /proc is mounted hidepid=invisible, so a Bot's uid sees only its own processes. The exception
 * group `procview` (bothost for the supervisor's RSS walk, bot-reap and the screens; polkitd, which breaks without
 * it) sees everything. Turned on by the migration, off by its rollback.
 */
describe("bug #66: box/files/proc-hidepid", () => {
  let f: FakeUsers;
  beforeEach(() => { f = new FakeUsers(); fs.appendFileSync(f.p("etc/passwd"), "polkitd:x:995:995::/nonexistent:/usr/sbin/nologin\n"); });
  afterEach(() => f.cleanup());
  const mounts = () => f.calls().filter((c) => c.cmd === "mount").map((c) => c.args);

  it("on: makes procview (bothost, polkitd), remounts /proc hidepid=invisible with that gid", () => {
    const r = f.run("proc-hidepid", ["on"], { SUDO_USER: "" });
    expect(r.status, r.stderr).toBe(0);
    const g = f.groupOf("procview")!;
    expect(g[3]!.split(",").sort()).toEqual(["bothost", "polkitd"]);
    expect(mounts()).toEqual([["-o", `remount,hidepid=invisible,gid=${g[2]}`, "/proc"]]);
    // Idempotent: no second group, same mount.
    f.clearCalls();
    expect(f.run("proc-hidepid", ["on"], { SUDO_USER: "" }).status).toBe(0);
    expect(f.calls().some((c) => c.cmd === "groupadd")).toBe(false);
    expect(mounts()).toEqual([["-o", `remount,hidepid=invisible,gid=${g[2]}`, "/proc"]]);
  });

  it("off: remounts /proc visible again", () => {
    expect(f.run("proc-hidepid", ["off"], { SUDO_USER: "" }).status).toBe(0);
    expect(mounts()).toEqual([["-o", "remount,hidepid=off", "/proc"]]);
  });

  it("root only (never through bothost's sudo: it is not in the sudoers rule)", () => {
    expect(f.run("proc-hidepid", ["on"], { SUDO_USER: "bothost" }).status).toBe(126);
    expect(fs.readFileSync(path.resolve(__dirname, "../../../box/files/sudoers-bothost"), "utf8")).not.toContain("proc-hidepid");
  });

  it("the boot unit re-applies it, and provision installs both (the migration enables the unit on an existing box)", () => {
    const box = path.resolve(__dirname, "../../../box");
    const unit = fs.readFileSync(path.join(box, "files/bots-hidepid.service"), "utf8");
    expect(unit).toMatch(/ExecStart=\/usr\/local\/lib\/bots\/proc-hidepid on/);
    expect(unit).toMatch(/Before=bothost\.service/);
    const prov = fs.readFileSync(path.join(box, "provision.sh"), "utf8");
    expect(prov).toMatch(/proc-hidepid/);
    expect(prov).toMatch(/bots-hidepid\.service/);
    // Portable install (per-Bot accounts on by default for NEW installs): provision enables it only on a box
    // provisioned for the first time; a box that already existed keeps what it had until it is migrated.
    const block = /if per_bot_uid_wanted; then([\s\S]*?)\nfi/.exec(prov);
    expect(block?.[1]).toMatch(/enable bots-hidepid\.service/);
    expect(block?.[1]).toMatch(/50-per-bot-uid\.conf/);
    expect(prov.replace(block?.[0] ?? "", "")).not.toMatch(/enable[^\n]*bots-hidepid/);
    expect(prov).toMatch(/\[ -f \/etc\/bots\/image-version \] \|\| FRESH=1/);
  });

  // Fix round 1: a box recreated to receive a snapshot takes the per-Bot-account mode of the box that snapshot came
  // from (the Mac passes PER_BOT_UID=on|off): an unmigrated snapshot restored onto a per-Bot box would be unreadable
  // to every Bot. Without a snapshot (auto) a first provision turns it on; after that provision leaves it alone.
  it("per-Bot accounts follow the snapshot's mode, and default on only for a first provision", () => {
    const prov = fs.readFileSync(path.resolve(__dirname, "../../../box/provision.sh"), "utf8");
    const fn = /^per_bot_uid_wanted\(\) \{[\s\S]*?^\}/m.exec(prov)?.[0];
    expect(fn).toBeTruthy();
    const wanted = (mode: string | null, fresh: 0 | 1) => spawnSync("bash", ["-c", `${fn}\nFRESH=${fresh}\n${mode === null ? "unset PER_BOT_UID" : `PER_BOT_UID=${mode}`}\nper_bot_uid_wanted && echo yes || echo no`], { encoding: "utf8" }).stdout.trim();
    expect(wanted(null, 1)).toBe("yes");
    expect(wanted("auto", 1)).toBe("yes");
    expect(wanted("auto", 0)).toBe("no");
    expect(wanted("off", 1)).toBe("no"); // an unmigrated snapshot is on its way
    expect(wanted("on", 0)).toBe("yes"); // a migrated snapshot onto a rebuilt box
    // A value that isn't one of the three stops provisioning instead of guessing.
    expect(prov).toMatch(/case "\$\{PER_BOT_UID:-auto\}" in on\|off\|auto\) ;; \*\)/);
  });
});
