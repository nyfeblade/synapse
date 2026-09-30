import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type sodiumType from "libsodium-wrappers";
import { STR_AUTH, validateSecretName } from "@synapse/shared";
import { describe, expect, it } from "vitest";
import { BoxPin } from "../../src/main/box-pin";
import { MacSecretVault } from "../../src/main/secret-vault";
import { SecretSync, sealWith } from "../../src/main/secret-sync";

// libsodium-wrappers@0.7.16's ESM build has a broken relative import ("./libsodium.mjs") not
// shipped in its own package (see host/secrets/crypto.ts for the same, already-documented issue).
// Load the working CJS build via createRequire, same fix, here in the test only.
const sodium: typeof sodiumType = createRequire(import.meta.url)("libsodium-wrappers");

const crypt = { encrypt: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString("base64")}`), decrypt: (b: Buffer) => Buffer.from(b.toString().slice(4), "base64").toString() };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "macvault-"));

async function boxKeys() {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const open = (s: string) => sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(s, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey));
  return { pub, open };
}

describe("MacSecretVault (ORIG-12 §12.1)", () => {
  it("keeps only safeStorage ciphertext on disk (0600) and an HMAC value hash", () => {
    const d = dir();
    const v = new MacSecretVault(path.join(d, "secrets.vault.json"), crypt, () => Buffer.alloc(32, 7), () => 5);
    const { valueHash } = v.upsert("b", "STRIPE_KEY", "Stripe", "sk_test_999999");
    const raw = fs.readFileSync(path.join(d, "secrets.vault.json"), "utf8");
    expect(raw).not.toContain("sk_test_999999");
    expect(fs.statSync(path.join(d, "secrets.vault.json")).mode & 0o777).toBe(0o600);
    expect(valueHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.value("b", "STRIPE_KEY")).toBe("sk_test_999999");
    expect(v.list("b")).toEqual([{ name: "STRIPE_KEY", description: "Stripe", updatedAt: 5 }]);
  });
});

describe("BoxPin (TOFU)", () => {
  it("pins the first key, matches it after, and flags a different key", () => {
    const p = new BoxPin(path.join(dir(), "box-pin.json"));
    expect(p.check("K1")).toBe("pinned");
    expect(p.check("K1")).toBe("match");
    expect(p.check("K2")).toBe("mismatch");
    p.repin("K2");
    expect(p.check("K2")).toBe("match");
  });
});

describe("SecretSync", () => {
  it("sends only sealed values; resync re-pushes needs-sync and mismatched entries and removes strays", async () => {
    const box = await boxKeys();
    const d = dir();
    const vault = new MacSecretVault(path.join(d, "v.json"), crypt, () => Buffer.alloc(32, 1));
    const calls: { cmd: string; args: any }[] = [];
    const boxState: Record<string, { valueHash: string; needsSync: boolean }> = {};
    const call = (async (cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === "getBotSecretsStatus") return { boxPublicKey: box.pub, status: Object.entries(boxState).map(([name, s]) => ({ name, description: "", updatedAt: 1, ...s })) };
      if (cmd === "setBotSecrets") {
        for (const u of args.upserts) { expect(box.open(u.sealed)).toBe(vault.value("b", u.name)); boxState[u.name] = { valueHash: u.valueHash, needsSync: false }; }
        for (const r of args.removes) delete boxState[r];
        return { status: [] };
      }
      return {};
    }) as never;
    const sync = new SecretSync({ vault, pin: new BoxPin(path.join(d, "pin.json")), call, seal: sealWith });
    await sync.save("b", "API_KEY", "Demo", "value-abcdef");
    expect(JSON.stringify(calls)).not.toContain("value-abcdef");
    boxState.API_KEY!.needsSync = true; // box was Reset: vault.key gone
    // Bug 57: a stray is a name THIS profile synced and the user then removed here while the box was
    // unreachable (a name the profile never synced is kept: secret-first-sync.test.ts).
    await sync.save("b", "STRAY", "", "value-stray-1");
    vault.remove("b", "STRAY");
    boxState.STRAY = { valueHash: "x", needsSync: false };
    expect(await sync.resync(["b"])).toBe(2);
    expect(boxState).toEqual({ API_KEY: { valueHash: vault.entries("b")[0]!.valueHash, needsSync: false } });
  });

  it("refuses to seal to a box key that doesn't match the pin", async () => {
    const box = await boxKeys();
    const pin = new BoxPin(path.join(dir(), "pin.json"));
    pin.repin("some-other-key");
    const sync = new SecretSync({ vault: new MacSecretVault(path.join(dir(), "v.json"), crypt, () => Buffer.alloc(32)), pin, seal: sealWith,
      call: (async (cmd: string) => (cmd === "getBotSecretsStatus" ? { boxPublicKey: box.pub, status: [] } : {})) as never });
    await expect(sync.save("b", "K", "", "value-1234")).rejects.toThrow(STR_AUTH.pinMismatch);
  });
});

/**
 * Bug 56: a secret saved under older name rules was listed as saved while the Bot never got it.
 * The box mock below refuses a batch the way host SecretVault.apply() does: one disallowed name
 * throws, and nothing in that batch is stored.
 */
describe("bug 56: a stored secret name the Bot can't use", () => {
  async function rig(seed: (v: MacSecretVault) => void) {
    const box = await boxKeys();
    const d = dir();
    const vault = new MacSecretVault(path.join(d, "v.json"), crypt, () => Buffer.alloc(32, 3), () => 9);
    seed(vault);
    const calls: { cmd: string; args: any }[] = [];
    const boxState: Record<string, { valueHash: string; needsSync: boolean }> = {};
    const call = (async (cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === "getBotSecretsStatus") return { boxPublicKey: box.pub, status: Object.entries(boxState).map(([name, s]) => ({ name, description: "", updatedAt: 1, ...s })) };
      if (cmd === "setBotSecrets") {
        const refused = args.upserts.map((u: any) => validateSecretName(u.name)).find(Boolean);
        if (refused) throw new Error(refused);
        for (const u of args.upserts) boxState[u.name] = { valueHash: u.valueHash, needsSync: false };
        for (const r of args.removes) delete boxState[r];
        return { status: [] };
      }
      return {};
    }) as never;
    const sync = new SecretSync({ vault, pin: new BoxPin(path.join(d, "pin.json")), call, seal: sealWith });
    return { box, vault, calls, boxState, sync };
  }
  // An older build stored whatever name it accepted. upsert() now refuses those names, so seed the
  // vault file directly, the way that older build left it.
  const legacy = (v: MacSecretVault, name: string, value: string) => {
    const file = (v as unknown as { file: string }).file;
    const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, entries: [] };
    cur.entries.push({ botId: "b", name, description: "old", ciphertext: crypt.encrypt(value).toString("base64"), updatedAt: 4, valueHash: v.hash(value) });
    fs.writeFileSync(file, JSON.stringify(cur));
  };

  it("the list names the reason on the secret's own entry, instead of reading as saved", async () => {
    const { vault } = await rig((v) => { legacy(v, "GIT_TOKEN", "legacy-secret-1"); v.upsert("b", "API_KEY", "", "fresh-secret-1"); });
    const rows = Object.fromEntries(vault.list("b").map((r) => [r.name, r as { unusable?: string }]));
    expect(rows.GIT_TOKEN?.unusable).toBe("Names starting with GIT_ are reserved.");
    expect(rows.API_KEY?.unusable).toBeUndefined();
    expect(JSON.stringify(vault.list("b"))).not.toMatch(/legacy-secret|fresh-secret/);
  });

  it("resync still delivers every usable secret when one stored name is refused by the box", async () => {
    const { sync, boxState, calls } = await rig((v) => { legacy(v, "stripe_key", "legacy-secret-2"); v.upsert("b", "API_KEY", "", "fresh-secret-2"); });
    await sync.resync(["b"]);
    expect(Object.keys(boxState)).toEqual(["API_KEY"]);
    expect(JSON.stringify(calls)).not.toMatch(/legacy-secret|fresh-secret/);
  });

  it("save() refuses a disallowed name before storing it on the Mac, so it can't appear as saved", async () => {
    const { sync, vault } = await rig(() => {});
    await expect(sync.save("b", "NODE_OPTIONS", "", "fresh-secret-3")).rejects.toThrow("Names starting with NODE_ are reserved.");
    expect(vault.list("b")).toEqual([]);
  });

  it("rename moves the value to a usable name without it passing through the renderer, and the old name is gone on both sides", async () => {
    const { sync, vault, boxState, calls, box } = await rig((v) => legacy(v, "GIT_TOKEN", "legacy-secret-4"));
    const status = await (sync as any).rename("b", "GIT_TOKEN", "GITHUB_TOKEN");
    expect(Array.isArray(status)).toBe(true);
    expect(vault.list("b").map((r) => r.name)).toEqual(["GITHUB_TOKEN"]);
    expect(vault.value("b", "GITHUB_TOKEN") === "legacy-secret-4").toBe(true);
    expect(Object.keys(boxState)).toEqual(["GITHUB_TOKEN"]);
    const set = calls.find((c) => c.cmd === "setBotSecrets")!;
    expect(set.args.removes).toEqual(["GIT_TOKEN"]);
    expect(box.open(set.args.upserts[0].sealed) === "legacy-secret-4").toBe(true);
    expect(JSON.stringify(calls)).not.toContain("legacy-secret");
  });

  it("rename refuses a new name that is also disallowed, or already taken, and changes nothing", async () => {
    const { sync, vault } = await rig((v) => { legacy(v, "GIT_TOKEN", "legacy-secret-5"); v.upsert("b", "API_KEY", "", "fresh-secret-5"); });
    await expect((sync as any).rename("b", "GIT_TOKEN", "GIT_TOKEN2")).rejects.toThrow("Names starting with GIT_ are reserved.");
    await expect((sync as any).rename("b", "GIT_TOKEN", "API_KEY")).rejects.toThrow("A secret named API_KEY already exists.");
    expect(vault.list("b").map((r) => r.name).sort()).toEqual(["API_KEY", "GIT_TOKEN"]);
  });
});
