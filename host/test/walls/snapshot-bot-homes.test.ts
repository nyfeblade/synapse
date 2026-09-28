import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotService, type SnapshotControl } from "../../computer/snapshots";
import { botUserName } from "../../walls/bot-uid";
import { FakeUsers } from "../box/fake-users";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";

/**
 * Bug #66 follow-up: once each Bot has its own home (/home/bots/<account>), a snapshot's "home" part covers those
 * homes too, restores each one AS its account, and the manifest (SnapshotInfo.trees) says which trees are inside, so
 * the app's backups (another branch) can show and check it.
 */
describe("bug #66: snapshots include the per-Bot homes", () => {
  it("the manifest records the trees the helper archived", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    const control: SnapshotControl = {
      create: async (id) => { fs.writeFileSync(path.join(dir, `${id}.tar.zst`), "x"); return "abc123\ntrees workspace home/box home/bots"; },
      restore: async () => {}, remove: async () => {},
    };
    const svc = new SnapshotService({ dir, control });
    const info = await svc.create("manual", ["workspace", "home"]);
    expect(info.sha256).toBe("abc123");
    expect(info.trees).toEqual(["workspace", "home/box", "home/bots"]);
    expect(svc.list()[0]!.trees).toEqual(["workspace", "home/box", "home/bots"]);
  });

  it("an older helper that prints only the hash leaves trees out (unknown), sha256 unchanged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    const control: SnapshotControl = { create: async (id) => { fs.writeFileSync(path.join(dir, `${id}.tar.zst`), "x"); return "abc123"; }, restore: async () => {}, remove: async () => {} };
    const info = await new SnapshotService({ dir, control }).create("manual");
    expect(info.sha256).toBe("abc123");
    expect(info.trees).toBeUndefined();
  });

  describe("box/files/bot-snapshot", () => {
    let f: FakeUsers;
    beforeEach(() => {
      f = new FakeUsers();
      fs.mkdirSync(f.p("home/box/.host/snapshots"), { recursive: true });
      const w = (n: string, body: string) => { fs.writeFileSync(f.p("shim", n), `#!/bin/bash\n{ printf '%s' "${n}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$SHIM_LOG"\n${body}\n`, { mode: 0o755 }); };
      w("tar", "exit 0");
      w("zstd", 'for a in "$@"; do [ "$prev" = -o ] && : > "$a"; prev="$a"; done; exit 0');
      w("du", "echo 1 x");
      w("df", "printf 'Avail\\n999999999\\n'");
      w("sha256sum", '[ -n "$1" ] && { echo "feedface  $1"; exit 0; }; exec /sbin/sha256sum'); // a file: fake; stdin (bot-user's name): real
      w("sqlite3", "exit 0");
    });
    afterEach(() => f.cleanup());

    it("create: 'home' also archives /home/bots when it exists, and prints the trees", () => {
      expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
      f.clearCalls();
      const r = f.run("bot-snapshot", ["create", "snap-test01", "workspace,home"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual(["feedface", "trees workspace home/box home/bots"]);
      const tar = f.calls().find((c) => c.cmd === "tar")!.args;
      expect(tar.slice(-3)).toEqual(["workspace", "home/box", "home/bots"]);
    });

    it("create without per-Bot homes is unchanged apart from the trees line", () => {
      const r = f.run("bot-snapshot", ["create", "snap-test02", "workspace,home"]);
      expect(r.stdout.trim().split("\n")).toEqual(["feedface", "trees workspace home/box"]);
    });

    it("restore: each Bot home is restored by its own account, never root or box", () => {
      expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
      fs.writeFileSync(f.p("home/box/.host/snapshots/snap-test03.tar.zst"), "x");
      f.clearCalls();
      const r = f.run("bot-snapshot", ["restore", "snap-test03", "home"]);
      expect(r.status, r.stderr).toBe(0);
      const sp = f.calls().filter((c) => c.cmd === "setpriv").map((c) => [c.args[0], c.args.at(-1)]);
      const u = botUserName(A);
      expect(sp, r.stderr).toContainEqual(["--reuid=60200", `home/bots/${u}`]);
      expect(sp).toContainEqual(["--reuid=box", "home/box"]);
    });

    it("the restore stage for a Bot home refuses any other uid", () => {
      expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
      const u = botUserName(A);
      const r = f.run("bot-snapshot", ["__restore-tree", `home/bots/${u}`], { FAKE_UID: "1001", SUDO_USER: "" });
      expect(r.status).toBe(126);
    });
  });
});
