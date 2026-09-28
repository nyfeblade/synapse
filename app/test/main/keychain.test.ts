import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// safeStorage only exists inside a real Electron main process; keychain.ts binds it at module load
// for the app, and every test here drives an explicit store instead (same pattern as native-theme).
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" } }));

import { safeStorage } from "electron";
import {
  PROBE_ENV,
  PROBE_MARK,
  PROBE_TIMEOUT_MS,
  codeIdentity,
  inProcessProbe,
  LEGACY_KEYCHAIN_APP_NAME,
  legacySafeStorageName,
  migrationItemName,
  openLegacyKeychain,
  parseCdhash,
  parseCodeIdentity,
  probeKeychain,
  runProbeMode,
  safeStorageName,
  type SafeStore,
} from "../../src/main/keychain";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bots-keychain-"));

/** A store that records every call, so a test can prove the gate did NOT touch the keychain. */
function fakeStore(over: Partial<SafeStore> = {}): SafeStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable: () => { calls.push("isEncryptionAvailable"); return true; },
    encryptString: (s: string) => { calls.push("encryptString"); return Buffer.from(s, "utf8"); },
    decryptString: (b: Buffer) => { calls.push("decryptString"); return b.toString("utf8"); },
    ...over,
  };
}

describe("parseCdhash", () => {
  it("reads the cdhash out of `codesign -d -r-` output", () => {
    expect(parseCdhash('Executable=/x/Synapse\n# designated => cdhash H"b9a7914a230316754c6ac3ac984e86efd1c121e7"\n'))
      .toBe("b9a7914a230316754c6ac3ac984e86efd1c121e7");
  });

  it("returns null for a designated requirement that is not a bare cdhash, and for junk", () => {
    expect(parseCdhash('# designated => identifier "com.example.app" and anchor apple generic')).toBeNull();
    expect(parseCdhash("")).toBeNull();
  });
});

describe("parseCodeIdentity (bug 99: stable local signing identity)", () => {
  it("an ad-hoc build is still its cdhash", () => {
    expect(parseCodeIdentity('# designated => cdhash H"b9a7914a230316754c6ac3ac984e86efd1c121e7"\n')).toBe("b9a7914a230316754c6ac3ac984e86efd1c121e7");
  });

  it("a build signed with the local certificate is that certificate's leaf hash — the same for every build", () => {
    expect(parseCodeIdentity('designated => identifier "com.nyfeblade.synapse" and certificate leaf = H"4F1C0A9E77B2D35E8C6A1F0B9D2E3C4A5B6C7D8E"\n'))
      .toBe("4f1c0a9e77b2d35e8c6a1f0b9d2e3c4a5b6c7d8e");
  });

  it("anything else has no identity (the shared item, bounded by the probe)", () => {
    expect(parseCodeIdentity('# designated => identifier "com.example.app" and anchor apple generic')).toBeNull();
    expect(parseCodeIdentity("")).toBeNull();
  });
});

describe("safeStorageName (the identity decision)", () => {
  // An ad-hoc signature's designated requirement is a bare cdhash, which changes on every rebuild
  // and every self-update. A keychain item created by the previous build is therefore guarded by an
  // ACL this build does not satisfy, and macOS answers that with a SecurityAgent prompt that a
  // headless launch can never answer — the app hangs forever inside SecItemCopyMatching.
  // So the item is namespaced per code identity: every build owns the item it created.
  it("namespaces the safe-storage item by code identity", () => {
    expect(safeStorageName("Bots", "b9a7914a230316754c6ac3ac984e86efd1c121e7")).toBe("Bots b9a7914a2303");
  });

  it("is stable for the same identity and different for a different one", () => {
    expect(safeStorageName("Bots", "a".repeat(40))).toBe(safeStorageName("Bots", "a".repeat(40)));
    expect(safeStorageName("Bots", "a".repeat(40))).not.toBe(safeStorageName("Bots", "b".repeat(40)));
  });

  it("falls back to the plain app name when the identity is unknown", () => {
    expect(safeStorageName("Bots", null)).toBe("Bots");
  });
});

describe("codeIdentity", () => {
  it("shells out to codesign once and caches the answer per binary", () => {
    const d = dir();
    const exe = path.join(d, "Synapse");
    fs.writeFileSync(exe, "binary");
    const runs: string[][] = [];
    const run = (cmd: string, args: string[]) => { runs.push([cmd, ...args]); return '# designated => cdhash H"deadbeef00112233445566778899aabbccddeeff"'; };
    const cacheFile = path.join(d, "code-identity.json");
    expect(codeIdentity({ exe, cacheFile, run })).toBe("deadbeef00112233445566778899aabbccddeeff");
    expect(codeIdentity({ exe, cacheFile, run })).toBe("deadbeef00112233445566778899aabbccddeeff");
    expect(runs).toHaveLength(1);
    expect(runs[0]![0]).toBe("/usr/bin/codesign");
  });

  it("re-reads when the binary changes (a rebuild or a self-update)", () => {
    const d = dir();
    const exe = path.join(d, "Synapse");
    fs.writeFileSync(exe, "binary-v1");
    const cacheFile = path.join(d, "code-identity.json");
    let hash = "a".repeat(40);
    const run = () => `# designated => cdhash H"${hash}"`;
    expect(codeIdentity({ exe, cacheFile, run })).toBe("a".repeat(40));
    fs.writeFileSync(exe, "binary-v2-which-is-longer");
    hash = "b".repeat(40);
    expect(codeIdentity({ exe, cacheFile, run })).toBe("b".repeat(40));
  });

  it("returns null (never throws) when codesign fails or the binary is unsigned", () => {
    const d = dir();
    const exe = path.join(d, "Synapse");
    fs.writeFileSync(exe, "binary");
    expect(codeIdentity({ exe, cacheFile: path.join(d, "c.json"), run: () => { throw new Error("code object is not signed at all"); } })).toBeNull();
    expect(codeIdentity({ exe, cacheFile: path.join(d, "c2.json"), run: () => "# designated => anchor apple" })).toBeNull();
  });
});

describe("legacySafeStorageName (review M2: read the item that SEALED the secrets)", () => {
  it("takes the namespace an earlier build stamped in keychain-namespace.json", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "keychain-namespace.json"), JSON.stringify({ namespace: "Bots 0123456789ab" }));
    expect(legacySafeStorageName(d, "Bots", () => "ffffffffffffffff")).toBe("Bots 0123456789ab");
  });

  it("doesn't even compute this build's identity when the stamp is there", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "keychain-namespace.json"), JSON.stringify({ namespace: "Bots 0123456789ab" }));
    let asked = 0;
    legacySafeStorageName(d, "Bots", () => { asked++; return "ffff"; });
    expect(asked).toBe(0);
  });

  it("falls back to this build's identity with no stamp, or a stamp that isn't one of ours", () => {
    const d = dir();
    expect(legacySafeStorageName(d, "Bots", () => "ffffffffffffffff")).toBe("Bots ffffffffffff");
    fs.writeFileSync(path.join(d, "keychain-namespace.json"), JSON.stringify({ namespace: "Chrome" }));
    expect(legacySafeStorageName(d, "Bots", () => "ffffffffffffffff")).toBe("Bots ffffffffffff");
    fs.writeFileSync(path.join(d, "keychain-namespace.json"), "not json");
    expect(legacySafeStorageName(d, "Bots", () => null)).toBe("Bots");
  });
});

describe("bug 285: the app is Synapse, but the keychain item it migrates from is still named Bots", () => {
  it("the migration names the old \"Bots <identity>\" item, whatever the app is called now", () => {
    expect(LEGACY_KEYCHAIN_APP_NAME).toBe("Bots");
    const d = dir();
    expect(migrationItemName(d, () => "ffffffffffffffff")).toBe("Bots ffffffffffff");
    expect(migrationItemName(d, () => null)).toBe("Bots");
  });

  it("a profile moved to …/Synapse before its keychain migration still reads the item its stamp names", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "keychain-namespace.json"), JSON.stringify({ namespace: "Bots 0123456789ab" }));
    expect(migrationItemName(d, () => "ffffffffffffffff")).toBe("Bots 0123456789ab");
  });
});

describe("openLegacyKeychain (bug-log 279: the migration's one keychain read)", () => {
  const exec = (out: string, err: Error | null = null) =>
    vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => { cb(err, out, ""); });

  it("re-review 4: even the named item is asked through the time-limited probe; an unanswered prompt is BLOCKED, not a pending gate", async () => {
    const touched = vi.spyOn(safeStorage, "isEncryptionAvailable");
    const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" });
    const e = exec("", killed);
    const k = await openLegacyKeychain({ exe: "/nonexistent/never-run", env: {}, exec: e as never });
    expect(k.verdict).toBe("blocked");
    expect(e).toHaveBeenCalledTimes(1);
    expect((e.mock.calls[0]![2] as { timeout: number }).timeout).toBe(PROBE_TIMEOUT_MS);
    // The main process never made a synchronous keychain call it couldn't bound.
    expect(touched).not.toHaveBeenCalled();
    touched.mockRestore();
  });

  it("a probe that answers ok hands safeStorage to the migration", async () => {
    const k = await openLegacyKeychain({ exe: "/nonexistent/never-run", env: {}, exec: exec(`${PROBE_MARK} {"verdict":"ok"}\n`) as never });
    expect(k.verdict).toBe("ok");
    expect(typeof k.store.decryptString).toBe("function");
  });
});

describe("inProcessProbe", () => {
  it("is ok when the store round-trips", () => {
    expect(inProcessProbe(fakeStore())).toBe("ok");
  });

  it("is unavailable when encryption is not available", () => {
    expect(inProcessProbe(fakeStore({ isEncryptionAvailable: () => false }))).toBe("unavailable");
  });

  it("is blocked when the round trip does not come back intact, and when it throws", () => {
    expect(inProcessProbe(fakeStore({ decryptString: () => "something else" }))).toBe("blocked");
    expect(inProcessProbe(fakeStore({ encryptString: () => { throw new Error("nope"); } }))).toBe("blocked");
  });
});

describe("probeKeychain (the out-of-process, same-identity canary)", () => {
  const exec = (out: string, err: Error | null = null) =>
    vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => { cb(err, out, ""); });

  it("spawns this very binary with the probe env set, so the verdict has THIS code identity", async () => {
    const e = exec(`${PROBE_MARK} {"verdict":"ok"}\n`);
    expect(await probeKeychain({ exe: "/Applications/Synapse.app/Contents/MacOS/Synapse", env: { A: "1" }, timeoutMs: 5000, exec: e as never })).toBe("ok");
    const [cmd, args, opts] = e.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; timeout: number; killSignal: string }];
    expect(cmd).toBe("/Applications/Synapse.app/Contents/MacOS/Synapse");
    expect(args).toEqual([]);
    expect(opts.env[PROBE_ENV]).toBe("1");
    expect(opts.timeout).toBe(5000);
    expect(opts.killSignal).toBe("SIGKILL");
  });

  it("a probe that never answers is BLOCKED, not a hang — the timeout kill is the whole point", async () => {
    const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" });
    expect(await probeKeychain({ exe: "/x", env: {}, timeoutMs: 10, exec: exec("", killed) as never })).toBe("blocked");
  });

  it("garbage or missing output is blocked, never ok", async () => {
    expect(await probeKeychain({ exe: "/x", env: {}, timeoutMs: 10, exec: exec("hello\n") as never })).toBe("blocked");
    expect(await probeKeychain({ exe: "/x", env: {}, timeoutMs: 10, exec: exec(`${PROBE_MARK} {"verdict":"nonsense"}`) as never })).toBe("blocked");
  });

  it("passes an unavailable verdict through", async () => {
    expect(await probeKeychain({ exe: "/x", env: {}, timeoutMs: 10, exec: exec(`${PROBE_MARK} {"verdict":"unavailable"}`) as never })).toBe("unavailable");
  });

  it("refuses to spawn from inside a probe process, so a probe can never fork probes forever", async () => {
    const e = exec(`${PROBE_MARK} {"verdict":"ok"}`);
    expect(await probeKeychain({ exe: "/x", env: { [PROBE_ENV]: "1" }, timeoutMs: 10, exec: e as never })).toBe("blocked");
    expect(e).not.toHaveBeenCalled();
  });
});

describe("runProbeMode", () => {
  it("prints the verdict on one marked line and exits 0", () => {
    const out: string[] = [];
    const codes: number[] = [];
    runProbeMode({ store: fakeStore(), write: (s) => out.push(s), exit: (c) => codes.push(c) });
    expect(out.join("")).toBe(`${PROBE_MARK} {"verdict":"ok"}\n`);
    expect(codes).toEqual([0]);
  });

  it("never throws out of probe mode", () => {
    const out: string[] = [];
    runProbeMode({ store: fakeStore({ isEncryptionAvailable: () => { throw new Error("boom"); } }), write: (s) => out.push(s), exit: () => {} });
    expect(out.join("")).toContain('"verdict":"blocked"');
  });
});
