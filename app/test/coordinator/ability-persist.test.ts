/**
 * settings-persist: the two per-Bot ability switches (Browser, Mac apps) are recorded by the coordinator on this Mac.
 * These pin the round trip through a restart (a NEW policy store and daemon over the same profile, as a relaunch
 * builds them), both directions, per Bot — and the one run in which nothing can be kept: a tampered key file (bug 225).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR5 } from "@synapse/shared";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { createLocalDaemon, disposeScratchPolicy, sweepStaleScratch, SCRATCH_PREFIX } from "../../src/coordinator/local-exec/wiring";
import { POLICY_KEY_FILE } from "../../src/coordinator/local-exec/policy-key";
import { MACAPP_PERMISSION_PREFIX } from "@synapse/shared";

let dir: string;
const key = Buffer.alloc(32, 7);
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ability-persist-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const launch = (o: { key?: Buffer; durable?: boolean } = { key }) => {
  const policy = new LocalPolicyStore(dir, Date.now, o.key ?? key, { home: () => os.tmpdir() });
  return new LocalExecDaemon({ call: async () => ({}), policy, executor: new LocalExecutor({ root: () => os.tmpdir(), fullAccess: () => true }), heartbeatMs: 3_600_000, ...(o.durable === undefined ? {} : { durable: o.durable }) });
};
const read = async (d: LocalExecDaemon, cmd: string, id: string) => ((await d.intercept(cmd, { id })) as { result: { allowed: boolean } }).result.allowed;

const abilities = [
  { name: "Browser", get: "getLocalBrowserAllowed", set: "setLocalBrowserAllowed" },
  { name: "Mac apps", get: "getLocalMacAppAllowed", set: "setLocalMacAppAllowed" },
];

describe.each(abilities)("$name switch survives a restart", ({ get, set }) => {
  it("On stays On and Off stays Off after a relaunch, for that Bot only", async () => {
    const first = launch();
    expect(await first.intercept(set, { id: "cos", allowed: true })).toEqual({ handled: true, result: { allowed: true } });
    const second = launch();
    expect(await read(second, get, "cos")).toBe(true);
    expect(await read(second, get, "other")).toBe(false);
    await second.intercept(set, { id: "cos", allowed: false });
    expect(await read(launch(), get, "cos")).toBe(false);
  });

  it("turning one ability on never turns the other off (both are kept side by side)", async () => {
    const d = launch();
    for (const a of abilities) await d.intercept(a.set, { id: "cos", allowed: true });
    const again = launch();
    for (const a of abilities) expect(await read(again, a.get, "cos")).toBe(true);
    await again.intercept(set, { id: "cos", allowed: false });
    const other = abilities.find((a) => a.set !== set)!;
    expect(await read(launch(), other.get, "cos")).toBe(true);
  });
});

/**
 * Review round 1, bug 225: the fail-closed run through the coordinator's real wiring (createLocalDaemon, as index.ts
 * builds it on every connect) — now only for a key file that can't be trusted: a scratch folder, never the profile;
 * nothing granted for good; taking an ability away always works.
 */
describe("a run whose permission key file can't be trusted (coordinator wiring)", () => {
  let tmpRoot: string;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ability-scratch-")); });
  afterEach(() => { disposeScratchPolicy(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });
  const hostCall = async (cmd: string, args: unknown) => (cmd === "resolveLocalToolPermission" ? { status: (args as { choice: string }).choice } : {});
  const spoilKey = () => fs.writeFileSync(path.join(dir, POLICY_KEY_FILE), Buffer.alloc(32, 1), { mode: 0o644 });
  const wire = (o: { broken?: boolean } = { broken: true }) => {
    if (o.broken) spoilKey();
    return createLocalDaemon({ userData: dir, log: () => {}, call: hostCall, tmpRoot, heartbeatMs: 3_600_000 });
  };
  const card = (action: "browser" | "mac-app", choice: "always" | "once") =>
    ({ id: "cos", askId: `k-${action}-${choice}`, choice, action, target: `${MACAPP_PERMISSION_PREFIX}Calendar` });

  it.each(abilities)("$name: Always on the permission card acts as once — no stored grant, nothing in the profile", async ({ get }) => {
    const w = wire();
    expect(w.durable).toBe(false);
    expect(w.policyDir.startsWith(path.join(tmpRoot, SCRATCH_PREFIX))).toBe(true);
    const action = get === "getLocalBrowserAllowed" ? "browser" : "mac-app";
    const r = await w.daemon.intercept("resolveLocalToolPermission", card(action, "always"));
    expect(r).toEqual({ handled: true, result: { status: "once" } }); // the host is told "once", too
    expect(await read(w.daemon, get, "cos")).toBe(false);
    expect(fs.existsSync(path.join(dir, "local-tool-grants.json"))).toBe(false);
  });

  it.each(abilities)("$name: turning it on refuses with a reason; turning it off always works and never touches the profile", async ({ get, set }) => {
    await launch().intercept(set, { id: "cos", allowed: true }); // a real, signed grant from an earlier run
    const before = fs.readFileSync(path.join(dir, "local-tool-grants.json"), "utf8");
    const w = wire();
    await expect(w.daemon.intercept(set, { id: "cos", allowed: true })).rejects.toThrow(STR5.localPolicyKeyBroken);
    expect(await w.daemon.intercept(set, { id: "cos", allowed: false })).toEqual({ handled: true, result: { allowed: false } });
    expect(await read(w.daemon, get, "cos")).toBe(false);
    expect(fs.readFileSync(path.join(dir, "local-tool-grants.json"), "utf8")).toBe(before);
  });

  it("with a sound key file, the same wiring uses the profile and a card's Always survives a relaunch", async () => {
    const w = wire({});
    expect(w.durable).toBe(true);
    expect(w.policyDir).toBe(dir);
    await w.daemon.intercept("resolveLocalToolPermission", card("mac-app", "always"));
    expect(await read(wire({}).daemon, "getLocalMacAppAllowed", "cos")).toBe(true);
  });

  it("the scratch folder goes on quit, and a stale one from a killed run is swept", () => {
    const w = wire();
    expect(fs.existsSync(w.policyDir)).toBe(true);
    disposeScratchPolicy();
    expect(fs.existsSync(w.policyDir)).toBe(false);
    const stale = fs.mkdtempSync(path.join(tmpRoot, SCRATCH_PREFIX));
    const fresh = fs.mkdtempSync(path.join(tmpRoot, SCRATCH_PREFIX));
    const old = new Date(Date.now() - 2 * 24 * 3_600_000);
    fs.utimesSync(stale, old, old);
    sweepStaleScratch(tmpRoot);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
