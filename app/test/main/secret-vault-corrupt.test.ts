import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MacSecretVault } from "../../src/main/secret-vault";
import { SecretSync } from "../../src/main/secret-sync";
import { BoxPin } from "../../src/main/box-pin";

const crypt = {
  encrypt: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString("base64")}`),
  decrypt: (b: Buffer) => Buffer.from(b.toString().slice(4), "base64").toString(),
};
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vault-corrupt-"));
const vaultAt = (d: string) => new MacSecretVault(path.join(d, "secrets.vault.json"), crypt, () => Buffer.alloc(32, 7), () => 5);

// ORIG-12 §12.1: the Mac is the only copy of a secret's value. Treating an unreadable vault as
// "no secrets" made SecretSync.resync() compute `removes` = every name the box has, wiping every
// secret on both sides from one corrupt read. Only ENOENT may mean "empty".
describe("MacSecretVault refuses to read a damaged vault as empty", () => {
  it("returns the empty shape for a missing file", () => {
    expect(vaultAt(dir()).entries("b")).toEqual([]);
  });

  it("throws on an unparsable vault instead of reporting no secrets", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "secrets.vault.json"), '{"version":1,"entries":[{"botId":"b"');
    expect(() => vaultAt(d).entries("b")).toThrow(/secrets\.vault\.json/);
    expect(() => vaultAt(d).list("b")).toThrow(/secrets\.vault\.json/);
  });

  it("throws on a zero-length vault", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "secrets.vault.json"), "");
    expect(() => vaultAt(d).entries("b")).toThrow(/secrets\.vault\.json/);
  });

  it("throws on valid JSON of the wrong shape", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "secrets.vault.json"), "{}");
    expect(() => vaultAt(d).entries("b")).toThrow(/secrets\.vault\.json/);
  });

  it("refuses to overwrite a damaged vault with a fresh one on upsert", () => {
    const d = dir();
    const file = path.join(d, "secrets.vault.json");
    fs.writeFileSync(file, "{ broken");
    expect(() => vaultAt(d).upsert("b", "K", "d", "v")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
  });

  it("fsyncs the vault before renaming it into place", () => {
    const d = dir();
    const seen: unknown[] = [];
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => { seen.push(fd); }) as typeof fs.fsyncSync);
    try {
      vaultAt(d).upsert("b", "K", "Desc", "v");
    } finally {
      spy.mockRestore();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(vaultAt(d).list("b")).toEqual([{ name: "K", description: "Desc", updatedAt: 5 }]);
  });
});

describe("SecretSync.resync never deletes box secrets because the Mac vault failed to load", () => {
  it("propagates the read failure instead of sending removes", async () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "secrets.vault.json"), "not json at all");
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const call = (async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "getBotSecretsStatus") {
        return { boxPublicKey: "PUB", status: [{ name: "STRIPE_KEY", description: "s", valueHash: "h", needsSync: false, updatedAt: 1 }] };
      }
      return { status: [] };
    }) as never;
    const sync = new SecretSync({ vault: vaultAt(d), pin: new BoxPin(path.join(d, "box-pin.json")), call, seal: async () => "sealed" });
    await expect(sync.resync(["bot-a"])).rejects.toThrow();
    expect(calls.filter((c) => c.cmd === "setBotSecrets")).toEqual([]);
  });
});
