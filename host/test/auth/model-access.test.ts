import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STR_AUTH, modelLabel } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { ModelAccess } from "../../auth/model-access";
import { sealTo } from "../../secrets/crypto";
import { tmpConfig } from "../helpers";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

/**
 * Review round 2 (P4): which models the saved key can reach, and which have 1M context, from free count_tokens calls
 * made directly by the host (never through the proxy). The picker hides what the key can't use, a Bot on such a model
 * falls back with a plain message, and [1m] is never requested where the key has no 1M context.
 */
const KEY = "sk-ant-api03-" + "M".repeat(80) + "mdls";
let api: FakeAnthropic | null = null;
let app: HostApp | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await app?.close(); app = null;
  await api?.close(); api = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("ModelAccess", () => {
  it("probes each model and 1M context with count_tokens; unreachable = false; a network failure leaves it unchecked", async () => {
    api = await startFakeAnthropic({ apiKey: KEY, script: [], models: { deny: ["claude-fable-5-1"], noLongContext: ["claude-opus-5-5"] } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-access-")); dirs.push(dir);
    const a = new ModelAccess({ dir, key: () => KEY, baseUrl: api.url, now: () => 42 });
    const v = await a.probe();
    expect(v.checkedAt).toBe(42);
    expect(v.models).toMatchObject({ "claude-sonnet-5": true, "claude-opus-5-5": true, "claude-haiku-4-5-20251001": true, "claude-fable-5-1": false });
    expect(v.longContext).toMatchObject({ "claude-sonnet-5": true, "claude-opus-5-5": false });
    expect(v.longContext["claude-haiku-4-5-20251001"]).toBeUndefined(); // no [1m] arm
    const counts = api.requests.filter((r) => r.path.startsWith("/v1/messages/count_tokens"));
    expect(counts.length).toBeGreaterThan(0);
    expect(api.requests.every((r) => r.path.startsWith("/v1/messages/count_tokens"))).toBe(true); // free calls only
    expect(counts.find((r) => r.body.model === "claude-sonnet-5" && (r.beta ?? "").includes("context-1m"))).toBeTruthy();
    // persisted (no secret in it) and read back
    const again = new ModelAccess({ dir, key: () => KEY });
    expect(again.view().models["claude-fable-5-1"]).toBe(false);
    expect(fs.readFileSync(path.join(dir, "model-access.json"), "utf8")).not.toContain(KEY.slice(13, 40));

    const offline = new ModelAccess({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "model-access-")), key: () => KEY, fetchFn: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    dirs.push((offline as unknown as { o: { dir: string } }).o.dir);
    expect((await offline.probe()).models).toEqual({});
  });

  it("resolve: an unreachable model falls back to the first reachable one; 1M only where the key has it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-access-")); dirs.push(dir);
    fs.writeFileSync(path.join(dir, "model-access.json"), JSON.stringify({ checkedAt: 1, models: { "claude-sonnet-5": false, "claude-opus-5-5": true }, longContext: { "claude-opus-5-5": false } }));
    const a = new ModelAccess({ dir, key: () => KEY });
    expect(a.resolve("claude-sonnet-5")).toEqual({ model: "claude-opus-5-5", from: "claude-sonnet-5" });
    expect(a.resolve("claude-opus-5-5")).toEqual({ model: "claude-opus-5-5", from: null });
    expect(a.longContextOk("claude-opus-5-5")).toBe(false);
    expect(a.longContextOk("claude-opus-5")).toBe(true); // unchecked: allowed
  });
});

describe("the host follows the key's model access", () => {
  it("a Bot on a model the key can't use runs on a reachable one with a plain message; no [1m] without 1M access", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    fs.mkdirSync(path.join(cfg.hostPrivate, "anthropic-auth"), { recursive: true });
    fs.writeFileSync(path.join(cfg.hostPrivate, "anthropic-auth", "model-access.json"), JSON.stringify({ checkedAt: 1, models: { "claude-sonnet-5": false, "claude-opus-5-5": true }, longContext: { "claude-opus-5-5": false } }));
    app = await createHostApp(cfg);
    const { id } = await app.handlers.createAgent!({ name: "Picky", isKickstartRequested: false });
    const sc = app.services.spawnConfig(id);
    expect(sc.model).toBe("claude-opus-5-5"); // not [1m]: the key has no 1M context for it
    const tray = app.services.trays.list().find((t) => t.title === STR_AUTH.modelFallbackTitle);
    expect(tray?.detail).toBe(STR_AUTH.modelFallback(modelLabel("claude-sonnet-5"), modelLabel("claude-opus-5-5")));
    const v = await app.handlers.getModelAccess!({});
    expect(v.models["claude-sonnet-5"]).toBe(false);
  });

  it("getModelAccess refresh never probes with a fake brain (no network in tests); saving a key clears stale results", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const before = await app.handlers.getModelAccess!({ refresh: true });
    expect(before).toMatchObject({ checkedAt: null, models: {} });
    const pub = (await app.handlers.getAuth!({})).boxPublicKey;
    await app.handlers.setApiKey!({ sealed: await sealTo(pub, KEY) });
    expect((await app.handlers.getModelAccess!({})).checkedAt).toBeNull();
  });
});
