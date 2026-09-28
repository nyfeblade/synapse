import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BOTHOST_UID, BOX_UID, realTool, Sandbox, setprivCalls, type LogEntry } from "./sandbox";

/**
 * Final secfix round 4 (ruling 2): `bot-snapshot restore` never writes as root. Root validates and reads the archive;
 * each tree is extracted and rsynced (-rlptD --no-o --no-g --delete, no -A/-X) by its owner: /workspace and /home/box
 * as box, agent-data as bothost. Real tar/zstd/rsync run inside the sandbox harness, so a box-planted directory link
 * into T/etc is a real attack on a real restore.
 */
const ID = "snap-test01";
const hasTools = !!realTool("zstd") && !!realTool("rsync") && !!realTool("tar");

function archive(sb: Sandbox, members: Record<string, string>): void {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "snapsrc-"));
  for (const [rel, text] of Object.entries(members)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  }
  const tarf = path.join(src, "a.tar");
  execFileSync("/usr/bin/tar", ["-C", src, "-cf", tarf, "workspace", "home"]);
  execFileSync(realTool("zstd")!, ["-q", tarf, "-o", sb.p("home/box/.host/snapshots", `${ID}.tar.zst`)]);
  fs.rmSync(src, { recursive: true, force: true });
}

// (openrsync re-runs itself as "rsync --server" through PATH for the receiving side; that is the same user.)
const syncs = (log: LogEntry[]) => log.filter((e) => e.cmd === "rsync" && !e.args.includes("--server"));
const extracts = (log: LogEntry[]) => log.filter((e) => e.cmd === "tar");

describe.runIf(hasTools)("bot-snapshot restore drops to each tree's owner (secfix round 4, ruling 2)", () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  function plantedBox(): Sandbox {
    sb = new Sandbox({ realTools: ["tar", "zstd", "rsync"] });
    archive(sb, {
      "workspace/hello.txt": "restored hello",
      "workspace/sub/new.txt": "must not reach etc",
      "workspace/.host-out/evil": "host output is never restored",
      "workspace/.bot/terminals/shell-1.txt": "archived transcript",
      "home/box/.bashrc": "restored bashrc",
      "home/box/.host/stolen": "host secrets are never restored",
      "home/box/agent-data/mem.txt": "restored memory",
      "home/box/reference/guide.md": "reference docs from the archive",
    });
    fs.writeFileSync(sb.p("home/box/reference/guide.md"), "host-provisioned reference docs");
    fs.writeFileSync(sb.p("workspace/stale.txt"), "stale");
    fs.symlinkSync(sb.p("etc"), sb.p("workspace/sub")); // box plants /workspace/sub -> /etc
    fs.writeFileSync(sb.p("workspace/.host-out/keep"), "bothost output");
    fs.mkdirSync(sb.p("workspace/.bot/terminals"), { recursive: true });
    fs.writeFileSync(sb.p("workspace/.bot/terminals/shell-1.txt"), "live transcript");
    fs.writeFileSync(sb.p("workspace/.bot/terminals/shell-2.txt"), "live transcript 2");
    fs.writeFileSync(sb.p("home/box/agent-data/old.txt"), "old memory");
    return sb;
  }

  it("a box-planted /workspace/sub -> /etc receives nothing, and box-owned content restores", () => {
    const s = plantedBox();
    const r = s.run("bot-snapshot", ["restore", ID, "workspace,home,agent-data"]);
    expect(r.status, r.stderr).toBe(0);
    expect(s.tree("etc")).toEqual(["shadow"]);
    expect(fs.readFileSync(s.p("etc/shadow"), "utf8")).toBe("root:SECRET-HASH\n");
    expect(fs.readFileSync(s.p("workspace/hello.txt"), "utf8")).toBe("restored hello");
    expect(fs.existsSync(s.p("workspace/stale.txt"))).toBe(false);
    expect(fs.readFileSync(s.p("workspace/.host-out/keep"), "utf8")).toBe("bothost output");
    expect(fs.existsSync(s.p("workspace/.host-out/evil"))).toBe(false);
    expect(fs.readFileSync(s.p("home/box/.bashrc"), "utf8")).toBe("restored bashrc");
    expect(fs.existsSync(s.p("home/box/.host/stolen"))).toBe(false);
    expect(fs.readFileSync(s.p("home/box/agent-data/mem.txt"), "utf8")).toBe("restored memory");
    expect(fs.existsSync(s.p("home/box/agent-data/old.txt"))).toBe(false);
    expect(s.tree("home/box").filter((f) => f.startsWith(".bot-restore"))).toEqual([]);
    // bothost-owned /home/box/reference (provision.sh) is the host's, not box's: box's restore leaves it alone.
    expect(fs.readFileSync(s.p("home/box/reference/guide.md"), "utf8")).toBe("host-provisioned reference docs");
  });

  // Live-box finding: /workspace/.bot/{terminals,screens} holds the host's own Bot-visible output and its files are
  // bothost-owned, so box's rsync -t failed outright ("failed to set times ... Operation not permitted") and the whole
  // restore aborted. That tree is the host's, like .host-out: box's restore neither rewrites nor deletes it.
  it("leaves the host's /workspace/.bot output alone", () => {
    const s = plantedBox();
    const r = s.run("bot-snapshot", ["restore", ID, "workspace,home,agent-data"]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(s.p("workspace/.bot/terminals/shell-1.txt"), "utf8")).toBe("live transcript");
    expect(fs.readFileSync(s.p("workspace/.bot/terminals/shell-2.txt"), "utf8")).toBe("live transcript 2");
  });

  // Live-box finding (2026-09-22 verify): five bothost-owned files in /workspace itself (a host-side debugging run)
  // made box's rsync fail "failed to set times ... Operation not permitted" (exit 23), so every workspace restore
  // reported failure. Nothing leaked (the planted link was still not followed). A file the tree's owner doesn't own
  // is one it can't restore anyway: the stage leaves it exactly as it is, and the rest restores cleanly.
  it("leaves a file the tree's owner doesn't own alone, and the restore still succeeds", () => {
    const s = plantedBox();
    fs.writeFileSync(s.p("workspace/host-made.txt"), "bothost's own");
    fs.writeFileSync(s.p("shim", "find"), `#!/bin/sh
case " $* " in *" -user "*) d=""; prev=""; for a in "$@"; do [ "$prev" = -P ] && d="$a"; prev="$a"; done
  [ "$d" = "${s.p("workspace")}" ] && printf '%s\\0' "$d/host-made.txt"; exit 0 ;; esac
exec /usr/bin/find "$@"
`, { mode: 0o755 });
    const r = s.run("bot-snapshot", ["restore", ID, "workspace"]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(s.p("workspace/host-made.txt"), "utf8")).toBe("bothost's own");
    expect(fs.readFileSync(s.p("workspace/hello.txt"), "utf8")).toBe("restored hello");
    expect(fs.existsSync(s.p("workspace/stale.txt"))).toBe(false);
    expect(s.tree("etc")).toEqual(["shadow"]);
  });

  it("root never extracts or rsyncs; box syncs /workspace and /home/box, bothost syncs agent-data, without -A/-X", () => {
    const s = plantedBox();
    const r = s.run("bot-snapshot", ["restore", ID, "workspace,home,agent-data"]);
    expect(r.status, r.stderr).toBe(0);
    expect(extracts(r.log).filter((e) => e.uid === 0)).toEqual([]);
    expect(syncs(r.log).filter((e) => e.uid === 0)).toEqual([]);
    expect(s.rootMutations(r.log, ["home/box/.host/snapshots"]), JSON.stringify(s.rootMutations(r.log, ["home/box/.host/snapshots"]))).toEqual([]);
    const dest = (e: LogEntry) => e.args.at(-1)!;
    const byDest = Object.fromEntries(syncs(r.log).map((e) => [dest(e), e]));
    expect(Object.keys(byDest).sort()).toEqual([s.p("home/box/"), s.p("home/box/agent-data/"), s.p("workspace/")].sort());
    expect(byDest[s.p("workspace/")]!.uid).toBe(BOX_UID);
    expect(byDest[s.p("home/box/")]!.uid).toBe(BOX_UID);
    expect(byDest[s.p("home/box/agent-data/")]!.uid).toBe(BOTHOST_UID);
    for (const e of syncs(r.log)) {
      expect(e.args).toEqual(expect.arrayContaining(["-rlptD", "--no-o", "--no-g", "--delete"]));
      expect(e.args.some((a) => /^-[a-zA-Z]*[AXH]/.test(a) || a === "-aHAX")).toBe(false);
    }
    expect(setprivCalls(r.log).map((e) => e.args.find((a) => a.startsWith("--reuid="))).sort()).toEqual(["--reuid=bothost", "--reuid=box", "--reuid=box"]);
  });

  it("the per-tree stage refuses root and a mismatched owner", () => {
    const s = plantedBox();
    const asRoot = s.run("bot-snapshot", ["__restore-tree", "workspace"]);
    expect(asRoot.status).not.toBe(0);
    const boxForAgentData = s.run("bot-snapshot", ["__restore-tree", "home/box/agent-data"], { uid: BOX_UID });
    expect(boxForAgentData.status).not.toBe(0);
    const bothostForWorkspace = s.run("bot-snapshot", ["__restore-tree", "workspace"], { uid: BOTHOST_UID });
    expect(bothostForWorkspace.status).not.toBe(0);
    expect(syncs([...asRoot.log, ...boxForAgentData.log, ...bothostForWorkspace.log])).toEqual([]);
  });

  it("restoring only /workspace touches only /workspace", () => {
    const s = plantedBox();
    const r = s.run("bot-snapshot", ["restore", ID, "workspace"]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(s.p("workspace/hello.txt"), "utf8")).toBe("restored hello");
    expect(fs.existsSync(s.p("home/box/.bashrc"))).toBe(false);
    expect(fs.readFileSync(s.p("home/box/agent-data/old.txt"), "utf8")).toBe("old memory");
    expect(s.tree("etc")).toEqual(["shadow"]);
  });
});
