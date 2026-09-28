/**
 * policy-key-file (bug 225): the Mac's permission files are signed with a random key kept in the profile as
 * `local-policy.key` — never the keychain, never the build identity — so a switch stays on across launches,
 * reinstalls and re-signing. A key-derived-from-the-keychain from an older build is used once, to carry its
 * still-valid files over. Only a key file that is unreadable or tampered with fails closed, and then Settings
 * offers "Reset permissions".
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MACAPP_PERMISSION_PREFIX, STR5 } from "@synapse/shared";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { loadPolicyKey, POLICY_KEY_FILE } from "../../src/coordinator/local-exec/policy-key";
import { createLocalDaemon, disposeScratchPolicy } from "../../src/coordinator/local-exec/wiring";

let dir: string;
let tmpRoot: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-key-"));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "policy-key-scratch-"));
});
afterEach(() => {
  disposeScratchPolicy();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const hostCall = async (cmd: string, args: unknown) => (cmd === "resolveLocalToolPermission" ? { status: (args as { choice: string }).choice } : {});
const wire = (o: { legacyKey?: Buffer; log?: (s: string) => void } = {}) =>
  createLocalDaemon({ userData: dir, legacyKey: o.legacyKey, log: o.log ?? (() => {}), call: hostCall, tmpRoot, heartbeatMs: 3_600_000 });
const allowed = async (w: ReturnType<typeof wire>, cmd: string, id = "cos") =>
  ((await w.daemon.intercept(cmd, { id })) as { result: { allowed: boolean } }).result.allowed;
const keyPath = () => path.join(dir, POLICY_KEY_FILE);

describe("the key file", () => {
  it("is created once (32 random bytes, 0600, owned by the user) and reused across restarts", () => {
    const a = loadPolicyKey(dir);
    expect(a.ok).toBe(true);
    const st = fs.lstatSync(keyPath());
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe(process.getuid!());
    expect(st.size).toBe(32);
    const b = loadPolicyKey(dir);
    expect(b.ok && a.ok && b.key.equals(a.key)).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("grants persist across a daemon restart with no keychain at all", async () => {
    const first = wire();
    expect(first.durable).toBe(true);
    expect(first.policyDir).toBe(dir);
    expect(await first.daemon.intercept("setLocalMacAppAllowed", { id: "cos", allowed: true })).toEqual({ handled: true, result: { allowed: true } });
    await first.daemon.intercept("setAgentPermMode", { id: "cos", mode: "full-auto" });
    const second = wire();
    expect(await allowed(second, "getLocalMacAppAllowed")).toBe(true);
    expect(await allowed(second, "getLocalMacAppAllowed", "other")).toBe(false);
    expect(((await second.daemon.intercept("getLocalBotMode", { id: "cos" })) as { result: { mode: string } }).result.mode).toBe("full-auto");
  });

  it("a toggle round-trips both ways across a daemon restart, and a card's Always is kept", async () => {
    await wire().daemon.intercept("setLocalBrowserAllowed", { id: "cos", allowed: true });
    expect(await allowed(wire(), "getLocalBrowserAllowed")).toBe(true);
    await wire().daemon.intercept("setLocalBrowserAllowed", { id: "cos", allowed: false });
    expect(await allowed(wire(), "getLocalBrowserAllowed")).toBe(false);
    await wire().daemon.intercept("resolveLocalToolPermission", { id: "cos", askId: "k1", choice: "always", action: "mac-app", target: `${MACAPP_PERMISSION_PREFIX}Calendar` });
    expect(await allowed(wire(), "getLocalMacAppAllowed")).toBe(true);
  });

  it("reports ok through getLocalPolicyStatus", async () => {
    expect((await wire().daemon.intercept("getLocalPolicyStatus", {}))).toEqual({ handled: true, result: { ok: true } });
  });
});

describe("migration from the keychain-derived key", () => {
  const legacy = Buffer.alloc(32, 9);
  const signed = (key: Buffer, name: string, data: unknown) =>
    ({ data, mac: createHmac("sha256", key).update(`${name}\0${JSON.stringify(data)}`).digest("hex") });

  it("files that verify with the old key are re-signed with the new key file: grants survive", async () => {
    const old = new LocalPolicyStore(dir, Date.now, legacy, { home: () => os.tmpdir() });
    old.grant("cos", "mac-app");
    old.grant("cos", "browser");
    old.setBotMode("cos", "full-auto");
    const log = vi.fn();
    const w = wire({ legacyKey: legacy, log });
    expect(w.durable).toBe(true);
    expect(fs.existsSync(keyPath())).toBe(true);
    expect(await allowed(w, "getLocalMacAppAllowed")).toBe(true);
    expect(await allowed(w, "getLocalBrowserAllowed")).toBe(true);
    // and again with no legacy key at all (the keychain is never asked again)
    const again = wire();
    expect(await allowed(again, "getLocalMacAppAllowed")).toBe(true);
    expect(((await again.daemon.intercept("getLocalBotMode", { id: "cos" })) as { result: { mode: string } }).result.mode).toBe("full-auto");
    expect(log).not.toHaveBeenCalled();
  });

  it("an unverifiable old file: one log line, a fresh start, no crash; valid siblings still migrate", async () => {
    fs.writeFileSync(path.join(dir, "local-tool-grants.json"), JSON.stringify(signed(Buffer.alloc(32, 1), "local-tool-grants.json", { grants: [{ botId: "cos", action: "mac-app" }] })));
    fs.writeFileSync(path.join(dir, "local-bot-modes.json"), JSON.stringify(signed(legacy, "local-bot-modes.json", { cos: "full-auto" })));
    const log = vi.fn();
    const w = wire({ legacyKey: legacy, log });
    expect(w.durable).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/local-tool-grants\.json/);
    expect(await allowed(w, "getLocalMacAppAllowed")).toBe(false);
    expect(((await w.daemon.intercept("getLocalBotMode", { id: "cos" })) as { result: { mode: string } }).result.mode).toBe("full-auto");
    // the user re-toggles once, and it sticks
    await w.daemon.intercept("setLocalMacAppAllowed", { id: "cos", allowed: true });
    expect(await allowed(wire(), "getLocalMacAppAllowed")).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("no legacy key at all (the keychain is relocked): unverifiable files are logged once, and switches work", async () => {
    fs.writeFileSync(path.join(dir, "local-tool-grants.json"), JSON.stringify(signed(Buffer.alloc(32, 1), "local-tool-grants.json", { grants: [] })));
    const log = vi.fn();
    const w = wire({ log });
    expect(w.durable).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(await w.daemon.intercept("setLocalBrowserAllowed", { id: "cos", allowed: true })).toEqual({ handled: true, result: { allowed: true } });
    wire({ log });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("a key file that can't be trusted fails closed and offers Reset permissions", () => {
  const tamper: Array<[string, () => void]> = [
    ["group/other-readable perms", () => fs.chmodSync(keyPath(), 0o644)],
    ["a symlink", () => { const real = path.join(tmpRoot, "k"); fs.copyFileSync(keyPath(), real); fs.chmodSync(real, 0o600); fs.rmSync(keyPath()); fs.symlinkSync(real, keyPath()); }],
    ["the wrong size", () => fs.appendFileSync(keyPath(), "x")],
    ["a directory", () => { fs.rmSync(keyPath()); fs.mkdirSync(keyPath()); }],
  ];

  it.each(tamper)("%s", async (_name, spoil) => {
    await wire().daemon.intercept("setLocalMacAppAllowed", { id: "cos", allowed: true });
    const grantsBefore = fs.readFileSync(path.join(dir, "local-tool-grants.json"), "utf8");
    spoil();
    const w = wire();
    expect(w.durable).toBe(false);
    const st = (await w.daemon.intercept("getLocalPolicyStatus", {})) as { result: { ok: boolean; reason?: string } };
    expect(st.result.ok).toBe(false);
    expect(st.result.reason).toBe(STR5.localPolicyKeyBroken);
    await expect(w.daemon.intercept("setLocalMacAppAllowed", { id: "cos", allowed: true })).rejects.toThrow(STR5.localPolicyKeyBroken);
    expect(fs.readFileSync(path.join(dir, "local-tool-grants.json"), "utf8")).toBe(grantsBefore); // never overwritten
    // Reset permissions: a new key and fresh files, then switches work again and stick
    expect(await w.daemon.intercept("resetLocalPolicy", {})).toEqual({ handled: true, result: { ok: true } });
    const after = wire();
    expect(after.durable).toBe(true);
    expect(fs.lstatSync(keyPath()).isFile()).toBe(true);
    expect(await allowed(after, "getLocalMacAppAllowed")).toBe(false);
    await after.daemon.intercept("setLocalMacAppAllowed", { id: "cos", allowed: true });
    expect(await allowed(wire(), "getLocalMacAppAllowed")).toBe(true);
  });

  it("the wrong owner", () => {
    loadPolicyKey(dir);
    const r = loadPolicyKey(dir, { uid: process.getuid!() + 1 });
    expect(r.ok).toBe(false);
  });

  it("a reset never follows a symlinked key file to its target", async () => {
    const real = path.join(tmpRoot, "precious");
    fs.writeFileSync(real, Buffer.alloc(32, 3), { mode: 0o600 });
    fs.symlinkSync(real, keyPath());
    const w = wire();
    expect(w.durable).toBe(false);
    await w.daemon.intercept("resetLocalPolicy", {});
    expect(fs.readFileSync(real)).toEqual(Buffer.alloc(32, 3));
    expect(fs.lstatSync(keyPath()).isSymbolicLink()).toBe(false);
  });
});
