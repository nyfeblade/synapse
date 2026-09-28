import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoxOpsLock } from "../../src/main/setup/box-ops-lock";
import { registerSetup } from "../../src/main/setup/wire";

// Portable install, fix round 1: setup (first run, or reopened from Settings) shares the ONE box-operations lock
// with the background re-provision and Settings → Update. While another holds it, setup is refused with a clear
// message and runs nothing; it takes the lock for its own run and gives it back.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function world(lock: BoxOpsLock) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "setup-wire-"));
  dirs.push(ud);
  const handlers = new Map<string, (a: never) => unknown>();
  const execs: string[][] = [];
  registerSetup({
    reg: ((n: string, fn: (a: never) => unknown) => handlers.set(n, fn)) as never,
    emit: () => {}, userData: ud, appDir: ud, runtime: { isPackaged: false, resourcesPath: ud }, home: ud,
    exec: async (cmd, args) => { execs.push([cmd, ...args]); return { code: 1, stdout: "", stderr: "not running" }; },
    orb: () => "/nope/orb", machine: () => "synapse-box", boxDir: () => ud,
    imageVersion: () => null, hostBuild: () => null, reconnect: async () => {}, connected: () => false,
    openExternal: async () => {}, skip: false, log: () => {}, lock, forgetPin: () => {},
    run: async () => {},
  });
  return { call: (n: string, a: unknown = {}) => (handlers.get(n)! as (x: unknown) => unknown)(a), execs };
}

describe("setup and the box-operations lock", () => {
  it("is refused, and runs nothing, while a re-provision holds the box", async () => {
    const lock = new BoxOpsLock();
    const release = lock.tryAcquire("re-provision")!;
    const w = world(lock);
    expect(await w.call("setup.box.start")).toEqual({ started: false, busy: "The Bots' computer is being updated." });
    expect(w.execs).toEqual([]);
    release();
  });

  it("holds the lock while it runs and gives it back when it stops", async () => {
    const lock = new BoxOpsLock();
    const w = world(lock);
    expect(await w.call("setup.box.start")).toEqual({ started: true });
    expect(lock.holder()).toBe("setup");
    await new Promise((r) => setTimeout(r, 50));
    expect(lock.holder()).toBeNull(); // this fake run fails at once (OrbStack "not running"): released
  });
});
