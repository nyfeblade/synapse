import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { botUserName } from "../../walls/bot-uid";
import { FakeUsers } from "./fake-users";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";

/**
 * Bug #66: a Bot's screen (X session, Chromium and its profile, the X cookie, its accessibility bus) belongs to the
 * Bot's own account, so another Bot can't read its cookies or connect to its display.
 */
describe("bug #66: displays run as the owning Bot's account", () => {
  let f: FakeUsers;
  let u: string;
  beforeEach(() => {
    f = new FakeUsers();
    expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
    u = botUserName(A);
    f.clearCalls();
  });
  afterEach(() => f.cleanup());
  const dropIn = (unit: string, n: number) => f.p("run/systemd/system", `${unit}@${n}.service.d`, "50-bot-user.conf");

  it("bot-display start with an account: drop-ins make the X session and Chrome that account, HOME its home", () => {
    const r = f.run("bot-display", ["start", "3", "tok", u]);
    expect(r.status, r.stderr).toBe(0);
    for (const unit of ["bot-display", "bot-chrome"]) {
      expect(fs.readFileSync(dropIn(unit, 3), "utf8")).toBe(`[Service]\nUser=${u}\nGroup=${u}\nSupplementaryGroups=bots\nEnvironment=HOME=/home/bots/${u}\nProtectProc=invisible\n`.replace("/home/bots", f.p("home/bots")));
    }
    expect(fs.readFileSync(f.p("run/bot-x/3.user"), "utf8")).toBe(u);
    const sc = f.calls().filter((c) => c.cmd === "systemctl").map((c) => c.args[0]);
    expect(sc.indexOf("daemon-reload")).toBeLessThan(sc.indexOf("start"));
    // Unchanged drop-ins: no second daemon-reload.
    f.clearCalls();
    f.run("bot-display", ["start", "3", "tok", u]);
    expect(f.calls().some((c) => c.cmd === "systemctl" && c.args[0] === "daemon-reload")).toBe(false);
  });

  it("without an account the drop-ins go (the screen is box's again)", () => {
    f.run("bot-display", ["start", "3", "tok", u]);
    expect(f.run("bot-display", ["start", "3", "tok"]).status).toBe(0);
    expect(fs.existsSync(dropIn("bot-chrome", 3))).toBe(false);
    expect(fs.existsSync(f.p("run/bot-x/3.user"))).toBe(false);
  });

  it("refuses an account that isn't a Bot account, before touching anything", () => {
    for (const a of ["box", "root", "bot-0123456789ab"]) expect(f.run("bot-display", ["start", "3", "tok", a]).status, a).toBe(2);
    expect(fs.existsSync(f.p("run/bot-x/3.owner"))).toBe(false);
    expect(f.calls().filter((c) => c.cmd === "systemctl")).toEqual([]);
  });

  it("display-cookie gives the cookie to the account with group bothost (not the bots group every Bot is in)", () => {
    f.run("bot-display", ["start", "3", "tok", u]);
    f.clearCalls();
    expect(f.run("display-cookie", ["3"]).status).toBe(0);
    expect(f.calls().find((c) => c.cmd === "chown")?.args).toEqual([`${u}:bothost`, f.p("run/bot-x/3.xauth")]);
    fs.rmSync(f.p("run/bot-x/3.user"));
    f.clearCalls();
    f.run("display-cookie", ["3"]);
    expect(f.calls().find((c) => c.cmd === "chown")?.args).toEqual(["box:bots", f.p("run/bot-x/3.xauth")]);
  });

  it("bot-display open-app starts the dock app as the display's owner, so it joins that display's accessibility bus (bug 78)", () => {
    f.run("bot-display", ["start", "3", "tok", u]);
    fs.writeFileSync(f.p("run/bot-x/3.xauth"), "c");
    f.clearCalls();
    const r = f.run("bot-display", ["open-app", "3", "terminal"]);
    expect(r.status, r.stderr).toBe(0);
    const sr = f.calls().find((c) => c.cmd === "systemd-run")!.args;
    expect(sr).toContain(`--uid=${u}`);
    expect(sr).toContain(`--gid=${u}`);
    expect(sr).toContain("--setenv=DISPLAY=:3");
    expect(sr).toContain(`--setenv=XAUTHORITY=${f.p("run/bot-x/3.xauth")}`);
    expect(sr).toContain(`--setenv=HOME=${f.p("home/bots", u)}`);
    expect(sr).toContain("ProtectProc=invisible");
    expect(sr.slice(sr.indexOf("--") + 1)).toEqual(["/usr/bin/xfce4-terminal", `--working-directory=${f.p("workspace")}`]);
    // Without a Bot account the display is box's, and so is the app.
    f.run("bot-display", ["start", "3", "tok"]);
    f.clearCalls();
    expect(f.run("bot-display", ["open-app", "3", "files"]).status).toBe(0);
    const box = f.calls().find((c) => c.cmd === "systemd-run")!.args;
    expect(box).toContain("--uid=box");
    expect(box.slice(box.indexOf("--") + 1)).toEqual(["/usr/bin/thunar", f.p("workspace")]);
  });

  it("bot-display open-app runs only the three dock apps, on a running display", () => {
    fs.mkdirSync(f.p("run/bot-x"), { recursive: true });
    fs.writeFileSync(f.p("run/bot-x/3.xauth"), "c");
    for (const app of ["xterm", "sh", "", "../terminal", "terminal;id"]) expect(f.run("bot-display", ["open-app", "3", app]).status, app).toBe(2);
    fs.rmSync(f.p("run/bot-x/3.xauth"));
    expect(f.run("bot-display", ["open-app", "3", "terminal"]).status).toBe(3);
    expect(f.calls().filter((c) => c.cmd === "systemd-run")).toEqual([]);
  });

  it("bot-display open-app re-checks the owner account exactly as start does (security review)", () => {
    fs.mkdirSync(f.p("run/bot-x"), { recursive: true });
    fs.writeFileSync(f.p("run/bot-x/3.xauth"), "c");
    // A Bot-shaped name whose account is outside the reserved uid range, or has another home: refused, never box.
    f.addPasswd("bot-0123456789ab:x:1500:1500:synapse-bot x:/home/bots/bot-0123456789ab:/bin/sh");
    fs.writeFileSync(f.p("run/bot-x/3.user"), "bot-0123456789ab");
    expect(f.run("bot-display", ["open-app", "3", "terminal"]).status).toBe(2);
    f.addPasswd("bot-0123456789ac:x:60300:60300:synapse-bot y:/tmp/elsewhere:/bin/sh");
    fs.writeFileSync(f.p("run/bot-x/3.user"), "bot-0123456789ac");
    expect(f.run("bot-display", ["open-app", "3", "terminal"]).status).toBe(2);
    fs.writeFileSync(f.p("run/bot-x/3.user"), "root");
    expect(f.run("bot-display", ["open-app", "3", "terminal"]).status).toBe(2);
    expect(f.calls().filter((c) => c.cmd === "systemd-run")).toEqual([]);
  });

  it("bot-atspi reads the accessibility tree as the display's owner", () => {
    f.run("bot-display", ["start", "3", "tok", u]);
    fs.writeFileSync(f.p("run/bot-x/3.xauth"), "c");
    f.clearCalls();
    expect(f.run("bot-atspi", ["3"]).status).toBe(0);
    const ru = f.calls().find((c) => c.cmd === "runuser")!.args;
    expect(ru.slice(0, 2)).toEqual(["-u", u]);
    expect(ru).toContain(`HOME=${f.p("home/bots", u)}`);
  });
});
