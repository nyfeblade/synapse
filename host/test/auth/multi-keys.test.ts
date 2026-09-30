import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROVIDER_CONSENT_VERSION, type BotSummary, type KeyedProvider } from "@synapse/shared";
import { AuthStore } from "../../auth/auth-store";
import { KeyRing } from "../../auth/key-ring";
import { createKeyServices, type KeyServicesDeps } from "../../auth/keys-module";
import { ProviderConsentStore } from "../../auth/provider-consent";
import { MIGRATED_KEY_ID, ProviderKeyStore } from "../../auth/provider-keys";
import { ProviderProxy } from "../../auth/provider-proxy";
import { AuthProxy } from "../../auth/proxy";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { createHealthServices } from "../../health/module";
import { loadOrCreateBoxKeyPair, sealTo } from "../../secrets/crypto";
import { HostSettingsStore } from "../../store/host-settings";
import { UsageStore } from "../../usage/usage-store";
import { startFakeChatServer } from "../brain/provider/fake-chat-server";

/** Several keys per provider (0.1.7): sealing, routing per Bot, metering, health, default and fallback, migration. */
const PERSONAL = "sk-proj-PERSONALabcdefghij0123456789";
const WORK = "sk-proj-WORKWORKabcdefghij0123456789";
// Made up and built in pieces, so the tree never carries a real-format key (public-tree.test.ts).
const ANT_A = ["sk", "ant", "api03", "A".repeat(28)].join("-");
const ANT_B = ["sk", "ant", "api03", "B".repeat(28)].join("-");

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const closers: (() => Promise<void> | void)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const mk = (p: string) => { const d = tmp(p); dirs.push(d); return d; };

/** A tiny Bot roster with profiles, as keys-module sees it. */
function fakeBots(init: Record<string, { name: string; model?: string; modelKeys?: Partial<Record<KeyedProvider, string>> }>) {
  const bots = new Map(Object.entries(init).map(([id, b]) => [id, { ...b }]));
  const summary = (id: string) => { const b = bots.get(id)!; return { id, profile: { name: b.name, model: b.model, ...(b.modelKeys ? { modelKeys: b.modelKeys } : {}) } } as unknown as BotSummary; };
  return {
    bots,
    has: (id: string) => bots.has(id), ids: () => [...bots.keys()], summary,
    setModelKey: (id: string, p: KeyedProvider, k: string | null) => { const b = bots.get(id)!; const m = { ...(b.modelKeys ?? {}) }; if (k === null) delete m[p]; else m[p] = k; b.modelKeys = m; return summary(id); },
    update: (id: string, patch: { model?: string }) => { const b = bots.get(id)!; if (patch.model) b.model = patch.model; return summary(id); },
  };
}

function services(o: { hostPrivate?: string; bots?: ReturnType<typeof fakeBots>; spend?: Record<string, number> } = {}) {
  const hp = o.hostPrivate ?? mk("keys-");
  const vault = randomBytes(32);
  const auth = new AuthStore({ dir: path.join(hp, "anthropic-auth"), key: vault });
  const providers = new ProviderKeyStore({ dir: path.join(hp, "provider-auth"), vaultKey: vault });
  const consent = new ProviderConsentStore({ dir: path.join(hp, "provider-auth") });
  consent.consent("openai", PROVIDER_CONSENT_VERSION);
  const bots = o.bots ?? fakeBots({});
  const notices: { botId: string; title: string; detail: string }[] = [];
  const health: { p: string; id: string; status: number | null }[] = [];
  const deps: KeyServicesDeps = {
    auth, providers, consent, bots: bots as never, keyPair: () => loadOrCreateBoxKeyPair(hp), now: () => 1_000, monthStart: () => 0,
    usage: () => ({ keySpend: (ref) => ({ usd: o.spend?.[ref] ?? 0, runs: o.spend?.[ref] ? 3 : 0 }), recentModels: () => [] }),
    healthState: () => null, keyHealth: (p, id, status) => health.push({ p, id, status }),
    notice: (botId, title, detail) => notices.push({ botId, title, detail }), nameOf: (b) => bots.bots.get(b)?.name ?? b,
    onKeyChange: () => {}, testProvider: async () => ({ ok: true, kind: "ok", title: "Key works", detail: "" }), fake: true,
  };
  const svc = createKeyServices(deps);
  const seal = async (v: string) => sealTo((await loadOrCreateBoxKeyPair(hp)).publicKey, v);
  return { hp, vault, auth, providers, consent, bots, svc, notices, health, seal };
}

describe("KeyRing sealing", () => {
  it("seals every key with a fresh IV under the provider's subkey; nothing in the clear but ids, labels and times", () => {
    const sub = randomBytes(32);
    const r = new KeyRing(sub);
    const a = r.add(PERSONAL, "Personal", 5);
    const b = r.add(WORK, "Work", 6);
    const disk = JSON.stringify(r.toDisk());
    expect(disk).not.toContain("PERSONAL");
    expect(disk).not.toContain("WORKWORK");
    const again = new KeyRing(sub, JSON.parse(disk));
    expect(again.key(a)).toBe(PERSONAL);
    expect(again.key(b)).toBe(WORK);
    expect(again.defaultId()).toBe(a); // the first key added
    expect(new KeyRing(randomBytes(32), JSON.parse(disk)).size).toBe(0); // another vault key opens nothing
    expect(() => r.add(PERSONAL, "Again", 7)).toThrow(/already saved/);
  });
});

describe("ProviderKeyStore: several named keys", () => {
  it("keeps two OpenAI keys, sealed on disk (0600), with a default the owner can move; removing the default moves it", () => {
    const dir = mk("pk-");
    const vault = randomBytes(32);
    const s = new ProviderKeyStore({ dir, vaultKey: vault, now: () => 9 });
    const personal = s.add("openai", PERSONAL, "Personal");
    const work = s.add("openai", WORK, "Work");
    const raw = fs.readFileSync(path.join(dir, "keys.json"), "utf8");
    expect(raw).not.toContain("PERSONALabc");
    expect(raw).not.toContain("WORKWORKabc");
    expect(fs.statSync(path.join(dir, "keys.json")).mode & 0o777).toBe(0o600);
    expect(s.list("openai").map((k) => [k.label, k.isDefault])).toEqual([["Personal", true], ["Work", false]]);
    s.setDefault("openai", work);
    const re = new ProviderKeyStore({ dir, vaultKey: vault });
    expect(re.defaultId("openai")).toBe(work);
    expect(re.key("openai")).toBe(WORK);
    expect(re.key("openai", personal)).toBe(PERSONAL);
    expect(re.resolve("openai", "kgone")).toBe(work); // a key that isn't saved falls back to the default
    re.remove("openai", work);
    expect(re.defaultId("openai")).toBe(personal);
    re.rename("openai", personal, "  Home\nkey ");
    expect(re.entry("openai", personal)?.label).toBe("Home key");
  });

  it("migration: a single key from before becomes the provider's default key, named after it, silently", () => {
    const dir = mk("pk-");
    const vault = randomBytes(32);
    // write the old shape with the old store's sealing (a ring's sealing is the same, per provider)
    const legacy = new KeyRing((new ProviderKeyStore({ dir: mk("x-"), vaultKey: vault }) as unknown as { subkey(p: string): Uint8Array }).subkey("openai"));
    const id = legacy.add(PERSONAL, "x", 42);
    fs.writeFileSync(path.join(dir, "keys.json"), JSON.stringify({ keys: { openai: { key: legacy.toDisk().entries.find((e) => e.id === id)!.key, savedAt: 42 } } }));
    const s = new ProviderKeyStore({ dir, vaultKey: vault });
    expect(s.list("openai")).toEqual([{ id: MIGRATED_KEY_ID, label: "OpenAI", savedAt: 42, isDefault: true, capUsd: null }]);
    expect(s.key("openai")).toBe(PERSONAL);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "keys.json"), "utf8")).v).toBe(2); // written back in the new shape
  });
});

describe("AuthStore: several Anthropic keys", () => {
  it("migration: the one key from before becomes the default named Anthropic; more keys can be added", () => {
    const dir = mk("auth-");
    const key = randomBytes(32);
    const old = new KeyRing(key);
    const id = old.add(ANT_A, "x", 7);
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ key: old.toDisk().entries.find((e) => e.id === id)!.key, savedAt: 7, mode: "api-key" }));
    const s = new AuthStore({ dir, key });
    expect(s.apiKey()).toBe(ANT_A);
    expect(s.list().map((k) => [k.label, k.isDefault])).toEqual([["Anthropic", true]]);
    const b = s.add(ANT_B, "Work");
    expect(new AuthStore({ dir, key }).key(b)).toBe(ANT_B);
    expect(fs.readFileSync(path.join(dir, "auth.json"), "utf8")).not.toContain("BBBBBBBB");
    s.clearApiKey(); // the default goes; the other one takes over
    expect(s.apiKey()).toBe(ANT_B);
  });
});

describe("routing: the right key per Bot, never the Bot's", () => {
  it("the provider proxy uses each Bot's chosen OpenAI key and the default otherwise; the Bot only ever holds a token", async () => {
    const bots = fakeBots({ a: { name: "Scout", model: "openai:gpt-6.1-sol" }, b: { name: "Planner", model: "openai:gpt-6.1-sol" } });
    const k = services({ bots });
    const personal = k.providers.add("openai", PERSONAL, "Personal");
    const work = k.providers.add("openai", WORK, "Work");
    bots.setModelKey("b", "openai", work);
    const statuses: [string, string | null, number][] = [];
    const up = await startFakeChatServer(() => ({ status: 200, body: "{\"ok\":true}" }));
    const proxy = new ProviderProxy({ credential: (p, b) => k.svc.providerCredential(p, b), upstream: () => up.url, onStatus: (p, b, s) => statuses.push([p, b, s]) });
    await proxy.start();
    closers.push(async () => { await proxy.stop(); await up.close(); });
    for (const botId of ["a", "b", null]) {
      const t = proxy.issue({ botId, provider: "openai" });
      expect(t).not.toContain("PERSONAL");
      expect(t).not.toContain("WORK");
      await fetch(`${proxy.url}/p/openai/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" });
    }
    expect(up.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${PERSONAL}`, `Bearer ${WORK}`, `Bearer ${PERSONAL}`]);
    expect(statuses).toEqual([["openai", "a", 200], ["openai", "b", 200], ["openai", null, 200]]);
    expect(k.svc.keyIdFor("a", "openai")).toBe(personal);
    expect(k.svc.keyIdFor("b", "openai")).toBe(work);
  });

  it("the Anthropic key proxy (both engines go through it) uses each Bot's chosen key", async () => {
    const bots = fakeBots({ a: { name: "Scout", model: "claude-sonnet-5" }, b: { name: "Planner", model: "claude-opus-5" } });
    const k = services({ bots });
    k.auth.setApiKey(ANT_A);
    const b = k.auth.add(ANT_B, "Work");
    bots.setModelKey("b", "anthropic", b);
    const seen: string[] = [];
    const up = http.createServer((req, res) => { seen.push(String(req.headers["x-api-key"])); req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}")); });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
    const proxy = new AuthProxy({ upstream: `http://127.0.0.1:${(up.address() as AddressInfo).port}`, port: 0, credential: (bot) => k.svc.anthropicCredential(bot) });
    await proxy.start();
    closers.push(async () => { await proxy.stop(); await new Promise<void>((r) => up.close(() => r())); });
    for (const botId of ["a", "b"]) {
      const t = proxy.issue({ botId });
      expect(t).not.toContain("AAAA");
      await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "x-api-key": t, "content-type": "application/json" }, body: "{}" });
    }
    expect(seen).toEqual([ANT_A, ANT_B]);
  });
});

describe("per-key metering and caps", () => {
  it("usage.db records which key paid for each run, and sums a key's month", () => {
    const dir = mk("usage-");
    const settings = new HostSettingsStore(path.join(dir, "settings.json"));
    const bots = { has: () => true, summary: (id: string) => ({ id, profile: { name: id } }) } as never;
    const store = new UsageStore({ file: path.join(dir, "usage.db"), metricsFile: path.join(dir, "m.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => 5_000 });
    closers.push(() => store.close());
    store.setKeyResolver((b, m) => (m.startsWith("openai:") ? (b === "b" ? "openai/kwork" : "openai/k1") : null));
    store.recordHelper("a", "memory", "openai:gpt-6-luna", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 });
    store.recordHelper("b", "memory", "openai:gpt-6-luna", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5 });
    store.recordHelper("b", "memory", "openai:gpt-6-luna", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 });
    store.recordHelper("a", "memory", "ollama:qwen3:4b", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
    expect(store.keySpend("openai/k1", 0)).toEqual({ usd: 0.25, runs: 1 });
    expect(store.keySpend("openai/kwork", 0)).toEqual({ usd: 2, runs: 2 });
  });

  it("a key over its monthly cap refuses the Bot that pays with it, not the others; Settings shows spend per key", async () => {
    const bots = fakeBots({ a: { name: "Scout", model: "openai:gpt-6.1-sol" }, b: { name: "Planner", model: "openai:gpt-6.1-sol" } });
    const k = services({ bots, spend: { "openai/kwork0001": 12 } });
    k.providers.add("openai", PERSONAL, "Personal");
    const ring = (k.providers as unknown as { rings: Map<string, KeyRing> }).rings.get("openai")!;
    const work = ring.add(WORK, "Work", 1, "kwork0001");
    k.providers.setCap("openai", work, 10);
    bots.setModelKey("b", "openai", work);
    expect(k.svc.allowKey("a", "openai")).toEqual({ ok: true, message: null });
    expect(k.svc.allowKey("b", "openai")).toEqual({ ok: false, message: "This key's monthly cap is reached (Work)." });
    expect(k.svc.usageKeyRef("b", "openai:gpt-6.1-sol")).toBe(`openai/${work}`);
    expect(k.svc.usageKeyRef("b", "ollama:qwen3:4b")).toBeNull();
    const v = await k.svc.handlers.getKeys!({} as never);
    const openai = v.rings.find((r) => r.provider === "openai")!;
    expect(openai.keys.map((x) => [x.label, x.masked, x.isDefault, x.monthUsd, x.capUsd])).toEqual([["Personal", "sk-…6789", true, 0, null], ["Work", "sk-…6789", false, 12, 10]]);
    expect(JSON.stringify(v)).not.toContain("PERSONALabc");
  });
});

describe("per-key health", () => {
  it("each key has its own row, named with its label once a provider has more than one", () => {
    const k = services();
    const personal = k.providers.add("openai", PERSONAL, "Personal");
    const hub = { subscribe: () => () => {}, publish: () => {} };
    const h = createHealthServices({ cfg: { hostPrivate: k.hp } as never, hub: hub as never, trays: { add: () => ({}) } as never, bots: { has: () => false, ids: () => [] } as never, now: () => 1 }, { google: null, mcp: null, composio: null, file: null, setTimer: () => 0, clearTimer: () => {}, keyRow: (p, id) => k.svc.keyRow(p, id) });
    h.providerKey("openai", 200, personal);
    expect(h.health.get(`provider:openai:${personal}`)).toMatchObject({ state: "ok", name: "OpenAI API key" });
    const work = k.providers.add("openai", WORK, "Work");
    h.providerKey("openai", 401, work);
    expect(h.health.get(`provider:openai:${work}`)).toMatchObject({ state: "needs-sign-in", name: "OpenAI API key · Work" });
    expect(h.health.get(`provider:openai:${personal}`)?.state).toBe("ok"); // one key's trouble isn't the other's
    h.providerKey("openai", null, work);
    expect(h.health.get(`provider:openai:${work}`)).toBeFalsy();
  });
});

describe("default and fallback on removal", () => {
  it("Bots paying with a removed key fall back to the default with a quiet notice; with no key left they say so", async () => {
    const bots = fakeBots({ a: { name: "Scout", model: "openai:gpt-6.1-sol" }, b: { name: "Planner", model: "openai:gpt-6.1-sol" }, c: { name: "Writer", model: "claude-sonnet-5" } });
    const k = services({ bots });
    await k.svc.handlers.addKey!({ provider: "openai", sealed: await k.seal(PERSONAL), label: "Personal" });
    const v = await k.svc.handlers.addKey!({ provider: "openai", sealed: await k.seal(WORK), label: "Work" });
    const [personal, work] = v.rings.find((r) => r.provider === "openai")!.keys.map((x) => x.id) as [string, string];
    await k.svc.handlers.pickAgentModel!({ id: "b", model: "openai:gpt-6.1-sol", keyId: work });
    expect(bots.bots.get("b")!.modelKeys).toEqual({ openai: work });
    await k.svc.handlers.removeKey!({ provider: "openai", keyId: work });
    expect(bots.bots.get("b")!.modelKeys).toEqual({});
    expect(k.svc.keyIdFor("b", "openai")).toBe(personal);
    expect(k.notices).toEqual([{ botId: "b", title: "Key removed", detail: "Planner now uses Personal." }]);
    k.notices.length = 0;
    await k.svc.handlers.removeKey!({ provider: "openai", keyId: personal });
    expect(k.notices.map((n) => [n.botId, n.title])).toEqual([["a", "No key for this model"], ["b", "No key for this model"]]);
    expect(k.svc.providerCredential("openai", "a")).toBeNull();
  });

  it("the owner makes another key the default; Bots without a choice follow it", async () => {
    const bots = fakeBots({ a: { name: "Scout", model: "openai:gpt-6.1-sol" } });
    const k = services({ bots });
    k.providers.add("openai", PERSONAL, "Personal");
    const work = k.providers.add("openai", WORK, "Work");
    expect(k.svc.providerCredential("openai", "a")).toBe(PERSONAL);
    await k.svc.handlers.setDefaultKey!({ provider: "openai", keyId: work });
    expect(k.svc.providerCredential("openai", "a")).toBe(WORK);
  });

  it("a key for a provider not yet allowed is refused; consent stays per provider", async () => {
    const k = services();
    await expect(k.svc.handlers.addKey!({ provider: "gemini", sealed: await k.seal("AIzaSyD-0123456789abcdefghijklmnopqrst") })).rejects.toThrow(/allowed/);
  });
});

describe("the picker's data", () => {
  it("lists keys by provider, recent models (this Bot's first) and models in use", async () => {
    const bots = fakeBots({ a: { name: "Scout", model: "openai:gpt-6.1-sol" }, b: { name: "Planner", model: "claude-sonnet-5" } });
    const k = services({ bots });
    k.auth.setApiKey(ANT_A);
    const personal = k.providers.add("openai", PERSONAL, "Personal");
    const work = k.providers.add("openai", WORK, "Work");
    bots.setModelKey("a", "openai", work);
    const deps = { recent: [
      { botId: "b", model: "claude-sonnet-5", keyRef: "anthropic/k1", at: 30 },
      { botId: "a", model: "openai:gpt-6.1-sol", keyRef: `openai/${work}`, at: 20 },
      { botId: "a", model: "openai:gpt-6-luna", keyRef: `openai/${personal}`, at: 10 },
      { botId: "a", model: "openai:gpt-6-astra", keyRef: "openai/kgone", at: 5 },
    ] };
    const svc = createKeyServices({
      auth: k.auth, providers: k.providers, consent: k.consent, bots: bots as never, keyPair: () => loadOrCreateBoxKeyPair(k.hp), now: () => 100, monthStart: () => 0,
      usage: () => ({ keySpend: () => ({ usd: 0, runs: 0 }), recentModels: () => deps.recent }), healthState: () => null, keyHealth: () => {}, notice: () => {}, nameOf: (b) => b, onKeyChange: () => {},
      testProvider: async () => ({ ok: true, kind: "ok", title: "", detail: "" }),
    });
    const v = await svc.handlers.getModelPicks!({ botId: "a" });
    expect(v.keys.openai).toEqual([{ id: personal, label: "Personal", isDefault: true }, { id: work, label: "Work", isDefault: false }]);
    expect(v.keys.anthropic?.map((x) => x.label)).toEqual(["Anthropic"]);
    expect(v.recent.map((r) => [r.ref, r.keyId, r.mine])).toEqual([
      ["openai:gpt-6.1-sol", work, true], ["openai:gpt-6-luna", personal, true], ["openai:gpt-6-astra", null, true], ["claude-sonnet-5", "k1", false],
    ]);
    expect(v.inUse).toEqual([{ ref: "openai:gpt-6.1-sol", keyId: work }, { ref: "claude-sonnet-5", keyId: null }]);
  });
});

beforeEach(() => { closers.length = 0; });

describe("Bot-made Bots never pick a key", () => {
  it("a Bot that makes a Bot gets the provider's default key, whatever its maker or the owner's other Bots pay with", async () => {
    const { createHostApp } = await import("../../app");
    const { tmpConfig } = await import("../helpers");
    const app = await createHostApp(tmpConfig());
    closers.push(() => app.close());
    const h = app.handlers as Record<string, (a: unknown) => Promise<unknown>>;
    const pk = ((await h.getKeys!({})) as { boxPublicKey: string }).boxPublicKey;
    await h.consentProvider!({ provider: "openai", textVersion: 1 });
    await h.addKey!({ provider: "openai", sealed: await sealTo(pk, PERSONAL), label: "Personal" });
    const v = (await h.addKey!({ provider: "openai", sealed: await sealTo(pk, WORK), label: "Work" })) as { rings: { provider: string; keys: { id: string; label: string }[] }[] };
    const work = v.rings.find((r) => r.provider === "openai")!.keys.find((k) => k.label === "Work")!.id;
    const { id: maker } = (await h.createAgent!({ name: "Maker", isKickstartRequested: false })) as { id: string };
    await h.pickAgentModel!({ id: maker, model: "openai:gpt-6.1-sol", keyId: work });
    // What the CreateBot tool does (control-plane-tools.ts): origin "bot"; a stray key field never reaches the profile.
    const made = app.services.bots.create({ name: "Made", model: "openai:gpt-6.1-sol", origin: "bot", kickstart: false, ...({ modelKeys: { openai: work } } as object) } as never);
    expect(app.services.bots.summary(made).profile.modelKeys).toBeUndefined();
    const picks = (await h.getModelPicks!({ botId: made })) as { inUse: { ref: string; keyId: string | null }[] };
    expect(picks.inUse).toContainEqual({ ref: "openai:gpt-6.1-sol", keyId: work }); // the maker's own choice
    expect(picks.inUse.filter((u) => u.keyId === null && u.ref === "openai:gpt-6.1-sol")).toHaveLength(1); // the made Bot: default
  }, 30_000);
});
