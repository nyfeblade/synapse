import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileKeyStore, isFileSealed, type SafeStore } from "../../src/main/file-key-store";
import {
  KEYCHAIN_ARCHIVE_DIR, KEYCHAIN_RETIRED_FILE, MAX_KEYCHAIN_ATTEMPTS, MOCK_KEYCHAIN_SWITCH, SealGate, hasSealedMaterial,
  keychainRetired, openSealing, prepareSealing, retireKeychain, type LegacyKeychain,
} from "../../src/main/sealing";

/**
 * Keychain retired (2026-09-26). The one launch that finds keychain-sealed material and no marker opens the keychain
 * once, re-seals everything with the profile's key file and writes the marker; after that nothing touches the keychain.
 * Temp dirs and a fake safeStorage only — the real keychain, ~/Library and the network are never reached.
 */
/** A store allowed to make its key (openSealing installs sealing.ts's own guard over it). */
const keys = (d: string) => new FileKeyStore(d, { mayCreate: () => true });
const made: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "bots-retire-")); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A stand-in for safeStorage: "v10" + a reversible scramble, and a log of every call. */
function fakeSafeStorage(over: Partial<SafeStore> = {}): SafeStore & { calls: string[] } {
  const calls: string[] = [];
  const scramble = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  return {
    calls,
    isEncryptionAvailable: () => { calls.push("isEncryptionAvailable"); return true; },
    encryptString: (s: string) => { calls.push("encryptString"); return Buffer.concat([Buffer.from("v10"), scramble(Buffer.from(s, "utf8"))]); },
    decryptString: (b: Buffer) => {
      calls.push("decryptString");
      if (b.subarray(0, 3).toString() !== "v10") throw new Error("not ours");
      return scramble(b.subarray(3)).toString("utf8");
    },
    ...over,
  };
}

const PLAIN = {
  hashkey: Buffer.alloc(32, 9).toString("base64"),
  backupKey: Buffer.alloc(32, 3).toString("base64"),
  updateToken: "ghp_legacy_token",
  vaultA: "sk-alpha",
  vaultB: "sk-beta",
  vapid: "vapid-private-scalar",
};

/** A profile an older build sealed with the keychain: every kind of sealed store the app has. */
function legacyProfile(ss: SafeStore = fakeSafeStorage()): string {
  const d = tmp();
  fs.writeFileSync(path.join(d, "secrets.hashkey.bin"), ss.encryptString(PLAIN.hashkey), { mode: 0o600 });
  fs.mkdirSync(path.join(d, "secrets"), { mode: 0o700 });
  fs.writeFileSync(path.join(d, "secrets", "backupKey.bin"), ss.encryptString(PLAIN.backupKey), { mode: 0o600 });
  fs.writeFileSync(path.join(d, "secrets", "updateToken.bin"), ss.encryptString(PLAIN.updateToken), { mode: 0o600 });
  const entry = (name: string, v: string) => ({ botId: "b1", name, description: "", ciphertext: ss.encryptString(v).toString("base64"), updatedAt: 1, valueHash: `h-${name}` });
  fs.writeFileSync(path.join(d, "secrets.vault.json"), JSON.stringify({ version: 1, entries: [entry("A", PLAIN.vaultA), entry("B", PLAIN.vaultB)], synced: { b1: ["A", "B"] } }), { mode: 0o600 });
  fs.writeFileSync(path.join(d, "phone-access.json"), JSON.stringify({
    enabled: true, offPending: false, devices: [{ id: "p1", tokenHash: "t", name: "Phone", createdAt: 1, lastSeenAt: 1 }],
    vapid: { publicKey: "PUB", sealed: ss.encryptString(PLAIN.vapid).toString("base64") },
    subs: [{ deviceId: "p1", endpoint: "https://push.example/x", p256dh: "k", auth: "a", createdAt: 1 }], mapped: null,
  }), { mode: 0o600 });
  return d;
}

/** Every sealed file of the profile, name → bytes, to prove nothing was lost. */
function snapshot(d: string): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  for (const f of ["secrets.hashkey.bin", "secrets/backupKey.bin", "secrets/updateToken.bin", "secrets.vault.json", "phone-access.json"]) {
    m.set(f, fs.readFileSync(path.join(d, f)));
  }
  return m;
}

const legacyFrom = (store: SafeStore, verdict: LegacyKeychain["verdict"] = "ok") => {
  const opens = { n: 0 };
  const fn = async (): Promise<LegacyKeychain> => { opens.n++; return { verdict, store }; };
  return Object.assign(fn, { opens });
};

describe("migration from the keychain (one launch, once)", () => {
  it("moves every sealed store to the file key; each is still readable after, and the marker is written last", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    const files = keys(d);
    const legacy = legacyFrom(ss);
    const r = await retireKeychain({ profileDir: d, files, legacy, log: () => {} });
    expect(r.outcome).toBe("migrated");
    expect(r.unreadable).toEqual([]);
    expect(legacy.opens.n).toBe(1);
    expect(keychainRetired(d)).toBe(true);

    const hk = fs.readFileSync(path.join(d, "secrets.hashkey.bin"));
    expect(isFileSealed(hk)).toBe(true);
    expect(files.decryptString(hk)).toBe(PLAIN.hashkey);
    for (const [n, v] of [["backupKey", PLAIN.backupKey], ["updateToken", PLAIN.updateToken]] as const) {
      const b = fs.readFileSync(path.join(d, "secrets", `${n}.bin`));
      expect(isFileSealed(b)).toBe(true);
      expect(files.decryptString(b)).toBe(v);
      expect(fs.statSync(path.join(d, "secrets", `${n}.bin`)).mode & 0o777).toBe(0o600);
    }
    const vault = JSON.parse(fs.readFileSync(path.join(d, "secrets.vault.json"), "utf8")) as { entries: { name: string; ciphertext: string; valueHash: string }[]; synced: unknown };
    expect(vault.entries.map((e) => files.decryptString(Buffer.from(e.ciphertext, "base64")))).toEqual([PLAIN.vaultA, PLAIN.vaultB]);
    expect(vault.entries.map((e) => e.valueHash)).toEqual(["h-A", "h-B"]); // the ledger and hashes are untouched
    expect(vault.synced).toEqual({ b1: ["A", "B"] });
    const phone = JSON.parse(fs.readFileSync(path.join(d, "phone-access.json"), "utf8")) as { vapid: { publicKey: string; sealed: string }; subs: unknown[]; devices: unknown[] };
    expect(phone.vapid.publicKey).toBe("PUB");
    expect(files.decryptString(Buffer.from(phone.vapid.sealed, "base64"))).toBe(PLAIN.vapid);
    expect(phone.subs).toHaveLength(1);
    expect(phone.devices).toHaveLength(1);
  });

  it("a second run is a no-op that never opens the keychain", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    await retireKeychain({ profileDir: d, files: keys(d), legacy: legacyFrom(ss), log: () => {} });
    const again = legacyFrom(ss);
    ss.calls.length = 0;
    expect((await retireKeychain({ profileDir: d, files: keys(d), legacy: again, log: () => {} })).outcome).toBe("already");
    expect(again.opens.n).toBe(0);
    expect(ss.calls).toEqual([]);
  });

  it("resumes after a crash mid-way: items already re-sealed are kept, the rest are moved", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    const files = keys(d);
    // As if an earlier migration run died after re-sealing only the hash key.
    fs.writeFileSync(path.join(d, "secrets.hashkey.bin"), files.encryptString(PLAIN.hashkey), { mode: 0o600 });
    const r = await retireKeychain({ profileDir: d, files, legacy: legacyFrom(ss), log: () => {} });
    expect(r.outcome).toBe("migrated");
    expect(files.decryptString(fs.readFileSync(path.join(d, "secrets.hashkey.bin")))).toBe(PLAIN.hashkey);
    expect(files.decryptString(fs.readFileSync(path.join(d, "secrets", "updateToken.bin")))).toBe(PLAIN.updateToken);
  });
});

describe("a keychain that doesn't answer is asked again on the next launches (review M3)", () => {
  it("one blocked launch leaves no marker and changes nothing; the next launch retries and migrates", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    const before = snapshot(d);
    const first = legacyFrom(ss, "blocked");
    const r1 = await retireKeychain({ profileDir: d, files: keys(d), legacy: first, log: () => {} });
    expect(r1.outcome).toBe("deferred");
    expect(keychainRetired(d)).toBe(false);
    for (const [rel, bytes] of before) expect(fs.readFileSync(path.join(d, rel)).equals(bytes), rel).toBe(true);
    // The migration launch still keeps the real keychain for the next try.
    const switches: string[] = [];
    expect(prepareSealing(d, { appendSwitch: (x) => switches.push(x) })).toBe("migrate");
    expect(switches).toEqual([]);
    const second = legacyFrom(ss, "ok");
    const r2 = await retireKeychain({ profileDir: d, files: keys(d), legacy: second, log: () => {} });
    expect(second.opens.n).toBe(1);
    expect(r2.outcome).toBe("migrated");
    expect(keys(d).decryptString(fs.readFileSync(path.join(d, "secrets", "updateToken.bin")))).toBe(PLAIN.updateToken);
  });

  it("a deferred launch keeps the gate closed with its own reason, so nothing is sealed over the old values", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    const gate = new SealGate();
    const st = await openSealing({ gate, mode: "migrate", profileDir: d, files: keys(d), legacy: legacyFrom(ss, "blocked"), log: () => {} });
    expect(st.status).toBe("blocked");
    expect(st.message).toMatch(/next time|again/i);
    expect(gate.read((k) => k.encryptString("x"), null)).toBeNull();
  });

  it(`retires as unreadable only after ${3} launches that couldn't read it`, async () => {
    expect(MAX_KEYCHAIN_ATTEMPTS).toBe(3);
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    for (let i = 1; i < MAX_KEYCHAIN_ATTEMPTS; i++) {
      expect((await retireKeychain({ profileDir: d, files: keys(d), legacy: legacyFrom(ss, "blocked"), log: () => {} })).outcome).toBe("deferred");
      expect(keychainRetired(d)).toBe(false);
    }
    expect((await retireKeychain({ profileDir: d, files: keys(d), legacy: legacyFrom(ss, "blocked"), log: () => {} })).outcome).toBe("unreadable");
    expect(keychainRetired(d)).toBe(true);
  });
});

describe("an attempts count that can't be kept (re-review 3)", () => {
  it("is treated as the last attempt: retires as unreadable with the re-enter state, instead of asking forever", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    // A folder where the count's file should go: writing it fails.
    fs.mkdirSync(path.join(d, "keychain-retire-attempts.json"));
    const gate = new SealGate();
    const st = await openSealing({ gate, mode: "migrate", profileDir: d, files: keys(d), legacy: legacyFrom(ss, "blocked"), log: () => {} });
    expect(keychainRetired(d)).toBe(true);
    expect(st.status).toBe("ready");
    expect(st.relocked).toBe(true);
    expect(st.message).toMatch(/re-enter/i);
    expect(fs.readFileSync(path.join(d, KEYCHAIN_ARCHIVE_DIR, "secrets", "updateToken.bin")).length).toBeGreaterThan(0);
  });
});

/** Runs the migration until it stops deferring (the last attempt retires as unreadable). */
async function retireAfterAttempts(d: string, files: FileKeyStore, legacy: () => Promise<LegacyKeychain>) {
  let r = await retireKeychain({ profileDir: d, files, legacy, log: () => {} });
  for (let i = 1; i < MAX_KEYCHAIN_ATTEMPTS && r.outcome === "deferred"; i++) r = await retireKeychain({ profileDir: d, files, legacy, log: () => {} });
  return r;
}

describe("a keychain that can't be read keeps every old file and loses nothing", () => {
  for (const [label, legacy] of [
    ["blocked", (ss: SafeStore) => legacyFrom(ss, "blocked")],
    ["unavailable", (ss: SafeStore) => legacyFrom(ss, "unavailable")],
    ["throws", (_ss: SafeStore) => Object.assign(async (): Promise<LegacyKeychain> => { throw new Error("denied"); }, { opens: { n: 0 } })],
  ] as const) {
    it(`keychain ${label}`, async () => {
      const ss = fakeSafeStorage();
      const d = legacyProfile(ss);
      const before = snapshot(d);
      ss.calls.length = 0;
      const files = keys(d);
      const r = await retireAfterAttempts(d, files, legacy(ss));
      expect(r.outcome).toBe("unreadable");
      expect(ss.calls.filter((c) => c === "decryptString")).toEqual([]);
      // Every original sealed file is kept, byte for byte, in the archive…
      for (const [rel, bytes] of before) expect(fs.readFileSync(path.join(d, KEYCHAIN_ARCHIVE_DIR, rel)).equals(bytes), rel).toBe(true);
      // …and the ones that don't block re-entering stay where they were.
      for (const rel of ["secrets/backupKey.bin", "secrets/updateToken.bin", "secrets.vault.json"]) {
        expect(fs.readFileSync(path.join(d, rel)).equals(before.get(rel)!), rel).toBe(true);
      }
      // The old hash key is moved aside (kept in the archive) so re-entered secrets get a working one.
      expect(fs.existsSync(path.join(d, "secrets.hashkey.bin"))).toBe(false);
      // The push key it can't open is set aside too; the phone pairing stays.
      const phone = JSON.parse(fs.readFileSync(path.join(d, "phone-access.json"), "utf8")) as { vapid: unknown; devices: unknown[] };
      expect(phone.vapid).toBeNull();
      expect(phone.devices).toHaveLength(1);
      // The app still switches to the file key.
      expect(keychainRetired(d)).toBe(true);
      expect(files.decryptString(files.encryptString("works"))).toBe("works");
      // And the archived originals still open with the old keychain, so nothing is lost.
      expect(fakeSafeStorage().decryptString(fs.readFileSync(path.join(d, KEYCHAIN_ARCHIVE_DIR, "secrets", "updateToken.bin")))).toBe(PLAIN.updateToken);
    });
  }

  it("one item the keychain can't open is kept; the others still move", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    fs.writeFileSync(path.join(d, "secrets", "updateToken.bin"), Buffer.from("v11-sealed-by-another-build"), { mode: 0o600 });
    const files = keys(d);
    const r = await retireKeychain({ profileDir: d, files, legacy: legacyFrom(ss), log: () => {} });
    expect(r.outcome).toBe("migrated");
    expect(r.unreadable).toEqual(["secrets/updateToken.bin"]);
    expect(fs.readFileSync(path.join(d, "secrets", "updateToken.bin")).toString()).toBe("v11-sealed-by-another-build");
    expect(fs.readFileSync(path.join(d, KEYCHAIN_ARCHIVE_DIR, "secrets", "updateToken.bin")).toString()).toBe("v11-sealed-by-another-build");
    expect(files.decryptString(fs.readFileSync(path.join(d, "secrets", "backupKey.bin")))).toBe(PLAIN.backupKey);
  });

  it("openSealing reports the re-enter state after the last failed read, and the gate still opens on the file key", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    for (let i = 1; i < MAX_KEYCHAIN_ATTEMPTS; i++) await openSealing({ gate: new SealGate(), mode: "migrate", profileDir: d, files: keys(d), legacy: legacyFrom(ss, "blocked"), log: () => {} });
    const gate = new SealGate();
    const st = await openSealing({ gate, mode: "migrate", profileDir: d, files: keys(d), legacy: legacyFrom(ss, "blocked"), log: () => {} });
    expect(st.status).toBe("ready");
    expect(st.relocked).toBe(true);
    expect(st.message).toMatch(/re-enter/i);
    expect(gate.require((s) => s.decryptString(s.encryptString("ok")))).toBe("ok");
  });
});

describe("a move that stops half-way", () => {
  it("writes no marker, keeps the gate closed with its own reason, and the next launch picks up", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    class Flaky extends FileKeyStore { override encryptString(s: string): Buffer { if (s === PLAIN.vaultA) throw new Error("disk full"); return super.encryptString(s); } }
    const gate = new SealGate();
    const st = await openSealing({ gate, mode: "migrate", profileDir: d, files: new Flaky(d), legacy: legacyFrom(ss), log: () => {} });
    expect(st.status).toBe("blocked");
    expect(st.message).toMatch(/didn't finish/);
    expect(keychainRetired(d)).toBe(false);
    const r = await retireKeychain({ profileDir: d, files: keys(d), legacy: legacyFrom(ss), log: () => {} });
    expect(r.outcome).toBe("migrated");
    const vault = JSON.parse(fs.readFileSync(path.join(d, "secrets.vault.json"), "utf8")) as { entries: { ciphertext: string }[] };
    expect(vault.entries.map((e) => keys(d).decryptString(Buffer.from(e.ciphertext, "base64")))).toEqual([PLAIN.vaultA, PLAIN.vaultB]);
  });
});

describe("a fresh install never touches the keychain", () => {
  it("writes the marker at once and appends the mock-keychain switch", () => {
    const d = tmp();
    const switches: string[] = [];
    expect(hasSealedMaterial(d)).toBe(false);
    expect(prepareSealing(d, { appendSwitch: (s) => switches.push(s) })).toBe("retired");
    expect(keychainRetired(d)).toBe(true);
    expect(switches).toEqual([MOCK_KEYCHAIN_SWITCH]);
  });

  it("never calls safeStorage: the legacy opener isn't asked and the fake records nothing", async () => {
    const d = tmp();
    const ss = fakeSafeStorage();
    const legacy = legacyFrom(ss);
    const mode = prepareSealing(d, { appendSwitch: () => {} });
    const gate = new SealGate();
    const st = await openSealing({ gate, mode, profileDir: d, files: keys(d), legacy, log: () => {} });
    expect(st.status).toBe("ready");
    expect(legacy.opens.n).toBe(0);
    expect(ss.calls).toEqual([]);
    // Even retireKeychain on its own answers "fresh" without opening anything.
    const d2 = tmp();
    expect((await retireKeychain({ profileDir: d2, files: keys(d2), legacy, log: () => {} })).outcome).toBe("fresh");
    expect(legacy.opens.n).toBe(0);
  });
});

describe("with the marker set, nothing touches the keychain", () => {
  it("no safeStorage call at all, even with keychain-sealed files still on disk", async () => {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    fs.writeFileSync(path.join(d, KEYCHAIN_RETIRED_FILE), JSON.stringify({ at: 1, outcome: "migrated" }), { mode: 0o600 });
    ss.calls.length = 0;
    const legacy = legacyFrom(ss);
    const mode = prepareSealing(d, { appendSwitch: () => {} });
    expect(mode).toBe("retired");
    const gate = new SealGate();
    await openSealing({ gate, mode, profileDir: d, files: keys(d), legacy, log: () => {} });
    gate.read((s) => s.encryptString("x"), null);
    expect(legacy.opens.n).toBe(0);
    expect(ss.calls).toEqual([]);
  });
});

describe("the mock-keychain switch is set only with the marker", () => {
  it("marker present: appended", () => {
    const d = legacyProfile();
    fs.writeFileSync(path.join(d, KEYCHAIN_RETIRED_FILE), "{}", { mode: 0o600 });
    const switches: string[] = [];
    prepareSealing(d, { appendSwitch: (s) => switches.push(s) });
    expect(switches).toEqual(["use-mock-keychain"]);
  });

  it("sealed material and no marker (the migration launch): not appended, no marker written, so the real item can be read", () => {
    const d = legacyProfile();
    const switches: string[] = [];
    expect(prepareSealing(d, { appendSwitch: (s) => switches.push(s) })).toBe("migrate");
    expect(switches).toEqual([]);
    expect(keychainRetired(d)).toBe(false);
  });

  it("the bounded keychain probe child never appends it and never writes the marker", () => {
    const d = tmp();
    const switches: string[] = [];
    expect(prepareSealing(d, { appendSwitch: (s) => switches.push(s) }, { probeChild: true })).toBe("migrate");
    expect(switches).toEqual([]);
    expect(keychainRetired(d)).toBe(false);
  });

  it("a marker that is a symlink doesn't count", () => {
    const d = legacyProfile();
    const elsewhere = path.join(tmp(), "m.json");
    fs.writeFileSync(elsewhere, "{}");
    fs.symlinkSync(elsewhere, path.join(d, KEYCHAIN_RETIRED_FILE));
    expect(keychainRetired(d)).toBe(false);
  });
});

describe("a missing key file is never silently replaced while sealed data exists (review B1)", () => {
  async function migrated(): Promise<string> {
    const ss = fakeSafeStorage();
    const d = legacyProfile(ss);
    await openSealing({ gate: new SealGate(), mode: "migrate", profileDir: d, files: keys(d), legacy: legacyFrom(ss), log: () => {} });
    expect(keychainRetired(d)).toBe(true);
    return d;
  }

  it("marker + sealed items, keys/ deleted: no new key, the gate is blocked, nothing new is sealed", async () => {
    const d = await migrated();
    fs.rmSync(path.join(d, "keys"), { recursive: true, force: true });
    const before = snapshot(d);
    const gate = new SealGate();
    const files = keys(d);
    const st = await openSealing({ gate, mode: prepareSealing(d, { appendSwitch: () => {} }), profileDir: d, files, legacy: legacyFrom(fakeSafeStorage()), log: () => {} });
    expect(st.status).toBe("blocked");
    expect(st.message).toMatch(/missing/i);
    expect(files.problem()).toBe("missing");
    expect(gate.read((k) => k.encryptString("x"), null)).toBeNull();
    expect(() => gate.require((k) => k.encryptString("x"))).toThrow(/missing/i);
    expect(() => files.encryptString("x")).toThrow();
    expect(fs.existsSync(path.join(d, "keys", "seal.key"))).toBe(false);
    for (const [rel, bytes] of before) expect(fs.readFileSync(path.join(d, rel)).equals(bytes), rel).toBe(true);
  });

  it("the marker alone doesn't veto a key (re-review 2): with nothing sealed left, a lost key is simply made again", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, KEYCHAIN_RETIRED_FILE), JSON.stringify({ at: 1, outcome: "migrated" }), { mode: 0o600 });
    const gate = new SealGate();
    const st = await openSealing({ gate, mode: "retired", profileDir: d, files: keys(d), legacy: legacyFrom(fakeSafeStorage()), log: () => {} });
    expect(st.status).toBe("ready");
    expect(fs.existsSync(path.join(d, "keys", "seal.key"))).toBe(true);
  });

  it("a fresh profile still gets its key", async () => {
    const d = tmp();
    const gate = new SealGate();
    const st = await openSealing({ gate, mode: prepareSealing(d, { appendSwitch: () => {} }), profileDir: d, files: keys(d), legacy: legacyFrom(fakeSafeStorage()), log: () => {} });
    expect(st.status).toBe("ready");
    expect(fs.existsSync(path.join(d, "keys", "seal.key"))).toBe(true);
  });
});

describe("SealGate", () => {
  it("never touches the store before open() resolves", () => {
    const ss = fakeSafeStorage();
    const gate = new SealGate({ store: ss });
    expect(gate.read((s) => s.encryptString("x"), null)).toBeNull();
    expect(() => gate.require((s) => s.encryptString("x"))).toThrow(/open yet/i);
    expect(ss.calls).toEqual([]);
  });

  it("a key file it can't use fails loudly and never falls back to the keychain", async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "keys"), { mode: 0o700 });
    fs.writeFileSync(path.join(d, "keys", "seal.key"), Buffer.alloc(32), { mode: 0o644 });
    fs.chmodSync(path.join(d, "keys", "seal.key"), 0o644);
    const ss = fakeSafeStorage();
    const gate = new SealGate();
    const st = await openSealing({ gate, mode: "retired", profileDir: d, files: keys(d), legacy: legacyFrom(ss), log: () => {} });
    expect(st.status).toBe("blocked");
    expect(() => gate.require((s) => s.encryptString("x"))).toThrow(st.message!);
    expect(ss.calls).toEqual([]);
  });
});
