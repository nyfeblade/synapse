/**
 * 0.1.4 first-run (code audit 3.4): the chat froze for seconds while a Bot searched the Mac. The coordinator carries
 * every chat stream, and its Mac glob and grep walked the folder with sync fs calls, and the Full-auto app check ran
 * codesign with spawnSync, so nothing else in that thread ran until they finished. Now the walks are async and the
 * app check is warmed off the thread before the sync policy check reads its cache.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { _clearAppTrustCache, macAllowedApp, warmAllowedApp, warmAllowedApps } from "../../src/coordinator/local-exec/app-trust";

let dir: string;
let root: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "srch-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "srchroot-"));
  for (let d = 0; d < 60; d++) {
    const sub = path.join(root, `d${d}`, "inner");
    fs.mkdirSync(sub, { recursive: true });
    for (let f = 0; f < 5; f++) fs.writeFileSync(path.join(sub, `f${f}.txt`), `line one\nneedle ${d}-${f}\n`);
  }
  _clearAppTrustCache();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });

/** Counts event-loop turns while `p` runs: a sync walk gives the loop no turn at all until it is done. */
async function turnsDuring<T>(p: () => Promise<T>): Promise<{ turns: number; value: T }> {
  let turns = 0;
  let on = true;
  const spin = () => { if (!on) return; turns++; setImmediate(spin); };
  const started = p();
  setImmediate(spin);
  const value = await started;
  on = false;
  return { turns, value };
}

describe("Mac search never blocks the coordinator's thread", () => {
  it("grep yields to the event loop while it walks, and still finds every match", async () => {
    const ex = new LocalExecutor({ root: () => root, userData: () => dir });
    const { turns, value } = await turnsDuring(() => ex.run({ execId: "g", botId: "b", approvalId: null, op: "grep", path: ".", pattern: "needle" }, { output: () => {} }));
    expect(value.result!.split("\n")).toHaveLength(300);
    expect(turns).toBeGreaterThan(10);
  });

  it("glob yields to the event loop while it walks, newest first as before", async () => {
    const ex = new LocalExecutor({ root: () => root, userData: () => dir });
    const newest = path.join(fs.realpathSync.native(root), "d7", "inner", "f3.txt");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(newest, future, future);
    const { turns, value } = await turnsDuring(() => ex.run({ execId: "l", botId: "b", approvalId: null, op: "glob", path: ".", pattern: "**/*.txt" }, { output: () => {} }));
    const hits = value.result!.split("\n");
    expect(hits).toHaveLength(300);
    expect(hits[0]).toBe(newest);
    expect(turns).toBeGreaterThan(10);
  });

  it("grep of a single file still works", async () => {
    const ex = new LocalExecutor({ root: () => root, userData: () => dir });
    const r = await ex.run({ execId: "s", botId: "b", approvalId: null, op: "grep", path: "d1/inner/f2.txt", pattern: "needle" }, { output: () => {} });
    expect(r.result).toMatch(/f2\.txt:2:needle 1-2$/);
  });
});

describe("the Full-auto app check runs codesign off the thread", () => {
  const home = () => fs.realpathSync.native(dir);
  it("the warm-up finds the apps a hand-off names and caches the answer, so the sync check spawns nothing", async () => {
    const seen: string[] = [];
    const names = await warmAllowedApps(`open -a "Calculator"`, { home: home() }, async (_f, args) => { seen.push(args.join(" ")); return "ok"; });
    expect(names).toEqual(["Calculator"]);
    // Calculator is under /System on a Mac: trusted without codesign; the answer is cached either way.
    if (process.platform === "darwin") expect(macAllowedApp("Calculator", home())).toBe(true);
  });

  it("the daemon warms the app check before its sync policy check", async () => {
    const policy = new LocalPolicyStore(dir, () => 1_000, undefined, { home: () => path.dirname(fs.realpathSync.native(root)) });
    const order: string[] = [];
    const warm = policy.warm.bind(policy);
    const check = policy.check.bind(policy);
    policy.warm = async (r) => { order.push("warm"); await warm(r); };
    policy.check = (r) => { order.push("check"); return check(r); };
    const calls: string[] = [];
    const d = new LocalExecDaemon({ call: async (c) => { calls.push(c); return c === "localExecHeartbeat" ? { pending: [] } : {}; }, policy, executor: new LocalExecutor({ root: () => root, userData: () => dir }), heartbeatMs: 60_000 });
    await d.start();
    d.onEvent({ channel: "local-exec", payload: { execId: "w1", botId: "b", approvalId: null, op: "run-command", command: "open -a Calculator" } });
    await vi.waitFor(() => expect(calls).toContain("localExecDone"));
    d.stop();
    expect(order.slice(0, 2)).toEqual(["warm", "check"]);
  });

  it("a codesign that times out isn't cached as untrusted", async () => {
    if (process.platform !== "darwin") return;
    const apps = fs.readdirSync("/Applications").filter((a) => a.endsWith(".app"));
    const app = apps.map((a) => path.join("/Applications", a)).find((p) => { try { return fs.realpathSync.native(p).startsWith("/Applications/") && fs.statSync(p).uid !== process.getuid!(); } catch { return false; } });
    if (!app) return;
    let calls = 0;
    expect(await warmAllowedApp(app, home(), async () => { calls++; return "timeout"; })).toBeNull();
    expect(await warmAllowedApp(app, home(), async () => { calls++; return "ok"; })).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    // Cached now: the sync check reads it (a fake "ok" was cached, so it is true without a real codesign).
    expect(macAllowedApp(app, home())).toBe(true);
  });
});
