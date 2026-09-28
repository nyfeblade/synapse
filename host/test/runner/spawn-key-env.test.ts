import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { envValuesHash, spawnKeyOf } from "../../runner/prompt-collector";
import { sealTo } from "../../secrets/crypto";
import { tmpConfig } from "../helpers";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("spawnKey covers env values, hashed (review fix round 1)", () => {
  it("is stable turn to turn, changes when a secret's VALUE changes under the same name, and never holds the value", async () => {
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const { id } = await app.handlers.createAgent!({ name: "Ledger", isKickstartRequested: false } as never);
    const { boxPublicKey } = await app.handlers.getBotSecretsStatus!({ botId: id });
    const set = async (v: string) => app!.handlers.setBotSecrets!({ botId: id, upserts: [{ name: "STRIPE_KEY", description: "k", sealed: await sealTo(boxPublicKey, v), valueHash: "same" }], removes: [] });
    await set("sk_test_value_one");
    const k1 = app.services.spawnConfig(id).spawnKey;
    expect(app.services.spawnConfig(id).spawnKey).toBe(k1); // nothing changed → a warm process is reused
    await set("sk_test_value_two");
    const k2 = app.services.spawnConfig(id).spawnKey;
    expect(k2).not.toBe(k1);
    expect(k2).not.toContain("sk_test");
  });
  it("a changed env value alone (same names, nothing else) changes the key", () => {
    // Secrets were already covered by the vault version in phase3.spawnKeyPart; the value digest covers every other
    // value (history cap, auth routing, paths) the same way, without relying on each producer to bump a counter.
    const base = { systemAppend: "P", envKeys: ["A", "B"], mcpNames: ["bot"], tokenHash: "t" };
    expect(spawnKeyOf({ ...base, envHash: envValuesHash({ A: "1", B: "x" }) })).not.toBe(spawnKeyOf({ ...base, envHash: envValuesHash({ A: "1", B: "y" }) }));
  });
  it("the digest is one-way and order-independent", () => {
    expect(envValuesHash({ A: "1", B: "2" })).toBe(envValuesHash({ B: "2", A: "1" }));
    expect(envValuesHash({ A: "1" })).not.toBe(envValuesHash({ A: "2" }));
    expect(envValuesHash({ SECRET: "hunter2" })).not.toContain("hunter2");
  });
});
