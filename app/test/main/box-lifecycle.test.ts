import { execFileSync } from "node:child_process";
import fsx from "node:fs";
import osx from "node:os";
import pathx from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRC } from "@synapse/shared";
import { BoxOpsLock } from "../../src/main/setup/box-ops-lock";
import { BoxLifecycle, OrbBoxOps, bundledImageVersion, type BoxOps, type LifecycleDeps, type LifecycleState } from "../../src/main/box-lifecycle";

function setup(o: { busy?: string[]; backupFails?: boolean; waitHealthyFails?: boolean; restoreSnapshotFails?: boolean; pushFails?: number; lock?: BoxOpsLock } = {}) {
  const log: string[] = [];
  const states: LifecycleState[] = [];
  const ops: BoxOps = {
    restartMachine: async () => { log.push("restart"); }, recreateMachine: async () => { log.push("recreate"); },
    provision: async (p) => { log.push(p?.perBotUid ? `provision:${p.perBotUid}` : "provision"); }, deploy: async () => { log.push("deploy"); },
    perBotUidMode: async () => { log.push("mode"); return "off" as const; },
    waitHealthy: async () => { log.push("healthy"); if (o.waitHealthyFails) throw new Error("box didn't come back healthy"); },
  };
  const call = (async (cmd: string, args: any) => {
    log.push(`${cmd}${args?.parts ? `:${args.parts.join(",")}` : ""}`);
    if (cmd === "prepareBoxRestart") return { ok: args.force || !(o.busy?.length), busyBotIds: o.busy ?? [] };
    if (cmd === "restoreSnapshot" && o.restoreSnapshotFails) throw new Error("restore failed");
    return {};
  }) as never;
  const snap = { id: "snap-abc123", createdAt: 1, bytes: 1, reason: "before_update" as const, parts: ["workspace", "home", "agent-data"] as const, sha256: "x" };
  let pushFails = o.pushFails ?? 0;
  const sink = {
    backupNow: async () => { log.push("backup"); if (o.backupFails) throw new Error("disk full"); return snap as never; },
    push: async (id: string) => {
      if (pushFails > 0) { pushFails -= 1; log.push(`push-fail ${id}`); throw new Error("upload failed (401)"); }
      log.push(`push ${id}`);
    },
    latest: () => snap as never,
  };
  // The retry backoff is injected so the suite never waits on a real timer.
  const lc = new BoxLifecycle({ ops, call, sink, publish: (s) => states.push(s), afterReconnect: async () => { log.push("resync"); }, sleep: async () => {} }, o.lock);
  return { lc, log, states };
}

/**
 * A lifecycle wired to a box whose bearer token changes under it, the way a real Update does:
 * `orb delete -f box` takes /home/box/.host/gateway.json with it, so the recreated host mints a
 * fresh random token (host/gateway/token.ts), and host/gateway/server.ts rejects a stale bearer
 * with 401 *before* it ever routes /health. Every dep here is bound to the token it was built
 * with, exactly like index.ts's startBoxOps closures.
 */
function rotatingToken() {
  const log: string[] = [];
  const snap = { id: "snap-rot", createdAt: 1, bytes: 1, reason: "before_update" as const, parts: ["workspace", "home", "agent-data"] as const, sha256: "x" };
  const box = { token: "token-before" };
  let lc!: BoxLifecycle;
  const depsFor = (token: string): LifecycleDeps => ({
    ops: {
      restartMachine: async () => { log.push("restart"); },
      recreateMachine: async () => { log.push("recreate"); box.token = "token-after"; },
      provision: async () => { log.push("provision"); },
      deploy: async () => { log.push("deploy"); },
      waitHealthy: async () => {
        if (token !== box.token) { log.push(`health-401 ${token}`); throw new Error(STRC.cantReach); }
        log.push("healthy");
      },
    },
    call: (async (cmd: string, args: { parts?: string[]; force?: boolean }) => {
      if (token !== box.token) { log.push(`call-401 ${cmd}`); throw new Error("Unauthorized"); }
      log.push(`${cmd}${args?.parts ? `:${args.parts.join(",")}` : ""}`);
      if (cmd === "prepareBoxRestart") return { ok: true };
      return {};
    }) as never,
    sink: {
      backupNow: async () => { log.push("backup"); return snap as never; },
      push: async (id: string) => {
        if (token !== box.token) { log.push("push-401"); throw new Error("upload failed (401)"); }
        log.push(`push ${id}`);
      },
      latest: () => snap as never,
    },
    publish: () => {},
    // index.ts's connect() → startBoxOps(): re-reads the box's gateway.json and swaps the deps.
    afterReconnect: async () => { log.push("reconnect"); lc.setDeps(depsFor(box.token)); },
    sleep: async () => {},
  });
  lc = new BoxLifecycle(depsFor(box.token));
  return { lc, log, box };
}

describe("BoxLifecycle (CMP-11)", () => {
  // Portable install, fix round 1: Update / Recover / Reset share the ONE box-operations lock with the background
  // re-provision and setup. A second operation is refused with a clear message, and never touches the box.
  it("refuses while another box operation holds the lock, and takes it itself", async () => {
    const lock = new BoxOpsLock();
    const release = lock.tryAcquire("re-provision")!;
    const s = setup({ lock });
    await expect(s.lc.update({ force: false })).rejects.toThrow(/being updated/);
    await expect(s.lc.recover()).rejects.toThrow(/being updated/);
    expect(s.log).toEqual([]);
    release();
    const running = s.lc.recover();
    expect(lock.holder()).toBe("recover");
    await running;
    expect(lock.holder()).toBeNull();
  });


  it("Update: quiesce → backup → recreate → start → restore → reconnect, with the spec's banner steps", async () => {
    const s = setup();
    expect(await s.lc.update({ force: false })).toEqual({ status: "done" });
    // "resync" (afterReconnect → re-read gateway.json) comes BEFORE each "healthy" probe: the
    // recreated box mints a new bearer token, and a probe on the old one can only ever 401.
    // Fix round 1: the rebuilt box takes the per-Bot-account mode of the box the snapshot came from (read first).
    expect(s.log).toEqual(["prepareBoxRestart", "backup", "mode", "recreate", "provision:off", "deploy", "resync", "healthy", "push snap-abc123", "restoreSnapshot:workspace,home,agent-data", "resync", "healthy"]);
    expect(s.states.map((x) => x.step)).toEqual(["getting_ready", "backing_up", "recreating", "starting", "cleaning_up", "reconnecting", null]);
    expect(s.states.at(-1)).toEqual({ phase: "ready", step: null, error: null });
  });

  it("Update while Bots are busy returns busy (the UI then offers 'Update once agents finish' / 'Update anyway')", async () => {
    const s = setup({ busy: ["bot-a"] });
    expect(await s.lc.update({ force: false })).toEqual({ status: "busy", busyBotIds: ["bot-a"] });
    expect(s.log).toEqual(["prepareBoxRestart"]);
    expect(s.lc.state().phase).toBe("ready");
  });

  it("a failed backup stops before anything is destroyed", async () => {
    const s = setup({ backupFails: true });
    await expect(s.lc.update({ force: true })).rejects.toThrow("Backup not ready");
    expect(s.log).not.toContain("recreate");
    expect(s.lc.state()).toMatchObject({ phase: "ready", error: "Backup not ready" });
  });

  it("Reset restores workspace+home by default and adds agent-data when asked", async () => {
    const s = setup();
    await s.lc.reset({ alsoBots: false });
    expect(s.log).toContain("restoreSnapshot:workspace,home");
    expect(s.states.map((x) => x.step)).toEqual(["getting_ready", "wiping", "starting", "reconnecting", null]);
    const t = setup();
    await t.lc.reset({ alsoBots: true });
    expect(t.log).toContain("restoreSnapshot:workspace,home,agent-data");
  });

  it("Recover restarts the machine and reconnects", async () => {
    const s = setup();
    await s.lc.recover();
    expect(s.log).toEqual(["restart", "resync", "healthy"]);
    expect(s.states.map((x) => `${x.phase}:${x.step}`)).toEqual(["recovering:starting", "recovering:reconnecting", "ready:null"]);
  });

  // A marked Synapse machine, as `orb list -f json` and the marker read report it.
  const orbExec = (cmds: string[], o: { marked?: boolean } = {}) => async (cmd: string, args: string[]) => {
    cmds.push([cmd, ...args].join(" "));
    if (args[0] === "list") return { code: 0, stdout: JSON.stringify([{ name: "synapse-box", state: "running", config: { isolated: true } }]), stderr: "" };
    if (args[0] === "-m" && args.at(-1)!.startsWith("cat /etc/bots/image-version")) return { code: 0, stdout: o.marked === false ? "|\n|\n|\n|\n" : "0123456789abcdef\n|\n|\nyes\n|\n|\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  it("OrbBoxOps uses the orb CLI and the repo's box scripts, on the profile's machine", async () => {
    const cmds: string[] = [];
    let forgot = 0;
    const ops = new OrbBoxOps({ exec: orbExec(cmds), boxDir: "/repo/box", health: async () => true, machine: "synapse-box", mac: { cpus: 8, totalMemBytes: 16 * 1024 ** 3 }, onRecreated: () => { forgot++; } });
    await ops.recreateMachine();
    await ops.provision();
    await ops.deploy();
    await ops.restartMachine();
    expect(cmds.map((c) => c.replace(/^\S*orb /, "orb ")).filter((c) => !c.startsWith("orb list") && !c.includes("cat /etc/bots/image-version"))).toEqual([
      "orb delete -f synapse-box",
      "orb create --isolated -a arm64 --cpus 4 --memory 8192 --disk 64G -u synapse-admin debian:bookworm synapse-box",
      "orb -m synapse-box -u root sh -c install -d -m 0755 /etc/bots && date -u +%FT%TZ > /etc/bots/created-by-synapse",
      "bash /repo/box/provision-from-mac.sh", "bash /repo/box/deploy.sh", "orb restart synapse-box",
    ]);
    // A recreated box has a new key: the old pin must not block secret sync forever (blocker c).
    expect(forgot).toBe(1);
  });

  it("OrbBoxOps never deletes a machine Synapse didn't make", async () => {
    const cmds: string[] = [];
    const ops = new OrbBoxOps({ exec: orbExec(cmds, { marked: false }), boxDir: "/repo/box", health: async () => true, machine: "synapse-box" });
    await expect(ops.recreateMachine()).rejects.toThrow(/wasn't made by Synapse/);
    expect(cmds.some((c) => c.includes(" delete "))).toBe(false);
  });

  it("OrbBoxOps hands the machine to the box scripts", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const ops = new OrbBoxOps({ exec: async (_c, _a, opts) => { seen.push(opts?.env); return { code: 0, stdout: "", stderr: "" }; }, boxDir: "/b", health: async () => true, machine: "synapse-box" });
    await ops.provision();
    await ops.deploy();
    expect(seen.map((e) => e?.BOX_MACHINE)).toEqual(["synapse-box", "synapse-box"]);
  });

  it("OrbBoxOps runs the resolved orb and hands the same path to the box scripts as ORB (DMG-symlink ruling)", async () => {
    const seen: { cmd: string; env?: Record<string, string> }[] = [];
    const ops = new OrbBoxOps({
      exec: async (cmd, _args, opts) => { seen.push({ cmd, env: opts?.env }); return { code: 0, stdout: "", stderr: "" }; },
      boxDir: "/b", health: async () => true, orb: () => "/Applications/OrbStack.app/Contents/MacOS/bin/orb",
    });
    await ops.restartMachine();
    await ops.provision();
    await ops.deploy();
    expect(seen[0]!.cmd).toBe("/Applications/OrbStack.app/Contents/MacOS/bin/orb");
    expect(seen.slice(1).map((s) => s.env?.ORB)).toEqual(["/Applications/OrbStack.app/Contents/MacOS/bin/orb", "/Applications/OrbStack.app/Contents/MacOS/bin/orb"]);
  });

  it("recover() resets the banner to ready with an error, instead of getting stuck, when a step throws (T22 fix 2)", async () => {
    const s = setup({ waitHealthyFails: true });
    await expect(s.lc.recover()).rejects.toThrow("box didn't come back healthy");
    expect(s.lc.state()).toMatchObject({ phase: "ready", step: null });
    expect(s.lc.state().error).toBeTruthy();
  });

  it("reset() resets the banner to ready with an error, instead of getting stuck, when a step throws (T22 fix 2)", async () => {
    const s = setup({ restoreSnapshotFails: true });
    await expect(s.lc.reset({ alsoBots: false })).rejects.toThrow("restore failed");
    expect(s.lc.state()).toMatchObject({ phase: "ready", step: null });
    expect(s.lc.state().error).toBeTruthy();
  });

  it("setDeps swaps in fresh ops/call/sink mid-operation, so a reconnect during Update (recreateMachine handing out a new gateway token) doesn't leave the rest of the run using the stale call/sink (T22 fix 1)", async () => {
    const log: string[] = [];
    const states: LifecycleState[] = [];
    const snap = { id: "snap-xyz789", createdAt: 1, bytes: 1, reason: "before_update" as const, parts: ["workspace", "home", "agent-data"] as const, sha256: "x" };
    const oldOps: BoxOps = {
      restartMachine: async () => {}, recreateMachine: async () => { log.push("recreate"); },
      provision: async () => { log.push("provision"); }, deploy: async () => { log.push("deploy"); }, waitHealthy: async () => { log.push("healthy"); },
    };
    const newOps: BoxOps = { ...oldOps };
    const oldCall = (async (cmd: string) => { log.push(`old-call:${cmd}`); return cmd === "prepareBoxRestart" ? { ok: true } : {}; }) as never;
    const newCall = (async (cmd: string) => { log.push(`new-call:${cmd}`); return cmd === "prepareBoxRestart" ? { ok: true } : {}; }) as never;
    const oldSink = { backupNow: async () => { log.push("backup"); return snap as never; }, push: async (id: string) => { log.push(`old-push ${id}`); }, latest: () => snap as never };
    const newSink = { backupNow: async () => { log.push("backup"); return snap as never; }, push: async (id: string) => { log.push(`new-push ${id}`); }, latest: () => snap as never };

    let lc!: BoxLifecycle;
    lc = new BoxLifecycle({
      ops: oldOps, call: oldCall, sink: oldSink, publish: (s) => states.push(s),
      afterReconnect: async () => {
        log.push("reconnect");
        // Simulates index.ts's startBoxOps being invoked again after the box was recreated
        // (a new gateway token), the same way it happens mid-flight inside update().
        lc.setDeps({ ops: newOps, call: newCall, sink: newSink, publish: (s) => states.push(s), afterReconnect: async () => { log.push("reconnect2"); } });
      },
    });

    expect(await lc.update({ force: false })).toEqual({ status: "done" });
    expect(log).toContain("new-push snap-xyz789");
    expect(log).not.toContain("old-push snap-xyz789");
    expect(log.filter((l) => l.startsWith("new-call:restoreSnapshot"))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("old-call:restoreSnapshot"))).toHaveLength(0);
  });

  it("Update re-reads the recreated box's gateway token BEFORE probing /health, so the wait doesn't 401 on the deleted machine's token", async () => {
    const t = rotatingToken();
    expect(await t.lc.update({ force: false })).toEqual({ status: "done" });
    // Nothing may be attempted against the recreated box with the pre-recreate token.
    expect(t.log.filter((l) => l.endsWith("401") || l.includes("-401"))).toEqual([]);
    // And the snapshot actually goes back: the box must not be left wiped.
    expect(t.log).toContain("push snap-rot");
    expect(t.log).toContain("restoreSnapshot:workspace,home,agent-data");
  });

  it("Recover and Reset wait for the box through the same reconnect-first path", async () => {
    const r = rotatingToken();
    await r.lc.recover();
    expect(r.log).toEqual(["restart", "reconnect", "healthy"]);
    const s = rotatingToken();
    await s.lc.reset({ alsoBots: true });
    expect(s.log.filter((l) => l.includes("401"))).toEqual([]);
    expect(s.log).toContain("restoreSnapshot:workspace,home,agent-data");
  });

  it("Update retries the restore rather than leaving the recreated box empty when a push blips", async () => {
    const s = setup({ pushFails: 1 });
    expect(await s.lc.update({ force: true })).toEqual({ status: "done" });
    expect(s.log).toContain("push-fail snap-abc123");
    expect(s.log).toContain("push snap-abc123");
    expect(s.log.filter((l) => l.startsWith("restoreSnapshot"))).toEqual(["restoreSnapshot:workspace,home,agent-data"]);
  });

  it("Reset retries the restore too", async () => {
    const s = setup({ pushFails: 1 });
    await s.lc.reset({ alsoBots: false });
    expect(s.log).toContain("push-fail snap-abc123");
    expect(s.log).toContain("restoreSnapshot:workspace,home");
  });

  it("bundledImageVersion matches provision.sh's recipe", () => {
    const d = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "boxdir-"));
    fsx.mkdirSync(pathx.join(d, "files", "sub"), { recursive: true });
    fsx.writeFileSync(pathx.join(d, "provision.sh"), "p");
    fsx.writeFileSync(pathx.join(d, "desktop.env"), "d");
    fsx.writeFileSync(pathx.join(d, "files", "b"), "b");
    fsx.writeFileSync(pathx.join(d, "files", "sub", "a"), "a");
    const shell = execFileSync("bash", ["-c", `cd ${d} && cat provision.sh desktop.env $(find files -type f | LC_ALL=C sort) | shasum -a 256 | cut -c1-16`]).toString().trim();
    expect(bundledImageVersion(d)).toBe(shell);
  });
});

// Task 30 fuzz (critical): `electron app/` has app.getAppPath() === <repo>/app, so <appPath>/../../box pointed
// outside the repo and box:info threw ENOENT (Settings → Updates crashed; Update would have run no scripts).
describe("defaultBoxDir", () => {
  it("is the box/ folder next to the app folder (the repo's box/ in development)", async () => {
    const { defaultBoxDir } = await import("../../src/main/box-lifecycle");
    const appDir = pathx.resolve(pathx.dirname(fileURLToPath(import.meta.url)), "../..");
    expect(defaultBoxDir(appDir)).toBe(pathx.resolve(appDir, "..", "box"));
    expect(() => bundledImageVersion(defaultBoxDir(appDir))).not.toThrow();
  });
});

// Phase 3 demo finding: macOS tar adds AppleDouble "._*" files to the streamed box/files, so the box's
// /etc/bots/image-version never matched the bundled version and Updates never said "up to date".
describe("image version ignores macOS AppleDouble files", () => {
  it("bundledImageVersion skips ._* files, provision.sh's recipe skips them and the Mac streams without them", () => {
    const d = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "boxv-"));
    fsx.mkdirSync(pathx.join(d, "files"));
    for (const f of ["provision.sh", "desktop.env", "files/a"]) fsx.writeFileSync(pathx.join(d, f), f);
    const clean = bundledImageVersion(d);
    fsx.writeFileSync(pathx.join(d, "files/._a"), "xattr junk");
    expect(bundledImageVersion(d)).toBe(clean);
    const repoBox = pathx.resolve(pathx.dirname(fileURLToPath(import.meta.url)), "../../../box");
    expect(fsx.readFileSync(pathx.join(repoBox, "provision.sh"), "utf8")).toMatch(/find files -type f ! -name '\._\*'/);
    for (const s of ["provision-from-mac.sh", "deploy.sh", "run-box-tests.sh"]) expect(fsx.readFileSync(pathx.join(repoBox, s), "utf8"), s).toMatch(/COPYFILE_DISABLE=1/);
  });
});
