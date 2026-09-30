import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_CONSENT_VERSION } from "@synapse/shared";
import { ProviderConsentStore } from "../../auth/provider-consent";
import { ProviderKeyStore } from "../../auth/provider-keys";
import { ProviderProxy, redactSecret } from "../../auth/provider-proxy";
import { BUDGET_HEADER } from "../../auth/proxy";
import { startFakeChatServer, type FakeReply } from "../brain/provider/fake-chat-server";

const KEY = "sk-proj-SECRETabcdefghij0123456789XYZ";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

describe("ProviderKeyStore", () => {
  it("seals each key under its own subkey (0600, no plaintext on disk), masks it, and survives a reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
    const vault = randomBytes(32);
    const s = new ProviderKeyStore({ dir, vaultKey: vault, now: () => 5 });
    s.set("openai", `  ${KEY}\n`);
    s.set("gemini", "AIzaSyD-0123456789abcdefghijklmnopqrst");
    const raw = fs.readFileSync(path.join(dir, "keys.json"), "utf8");
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("AIzaSy");
    expect(fs.statSync(path.join(dir, "keys.json")).mode & 0o777).toBe(0o600);
    expect(s.masked("openai")).toEqual({ masked: "sk-…9XYZ", savedAt: 5 });
    const again = new ProviderKeyStore({ dir, vaultKey: vault });
    expect(again.key("openai")).toBe(KEY);
    expect(again.has("gemini")).toBe(true);
    // the openai entry can't be opened as gemini's (per-provider subkeys): swap them on disk and both fail
    const j = JSON.parse(raw) as { keys: Record<string, unknown> };
    fs.writeFileSync(path.join(dir, "keys.json"), JSON.stringify({ keys: { openai: j.keys.gemini, gemini: j.keys.openai } }));
    const swapped = new ProviderKeyStore({ dir, vaultKey: vault });
    expect(swapped.has("openai") || swapped.has("gemini")).toBe(false);
    expect(new ProviderKeyStore({ dir, vaultKey: randomBytes(32) }).has("openai")).toBe(false); // another vault key
  });

  it("refuses what isn't a key, and clears", () => {
    const s = new ProviderKeyStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "pk-")), vaultKey: randomBytes(32) });
    expect(() => s.set("openai", "short")).toThrow();
    expect(() => s.set("openai", "has spaces in it 0123456789")).toThrow();
    s.set("openai", KEY);
    s.clear("openai");
    expect(s.key("openai")).toBeNull();
  });
});

describe("ProviderConsentStore", () => {
  it("a provider is refused until consented with the current text; Anthropic counts as consented", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
    const c = new ProviderConsentStore({ dir });
    expect(c.consented("anthropic")).toBe(true);
    expect(c.consented("openai")).toBe(false);
    expect(() => c.consent("openai", PROVIDER_CONSENT_VERSION - 1)).toThrow();
    c.consent("openai", PROVIDER_CONSENT_VERSION);
    expect(new ProviderConsentStore({ dir }).consented("openai")).toBe(true);
    expect(fs.statSync(path.join(dir, "consent.json")).mode & 0o777).toBe(0o600);
    c.withdraw("openai");
    expect(c.consented("openai")).toBe(false);
  });
});

describe("redactSecret", () => {
  it("removes the whole key and any 12+ character slice of it", () => {
    expect(redactSecret(`Incorrect API key provided: ${KEY}.`, KEY)).toBe("Incorrect API key provided: [redacted key].");
    expect(redactSecret(`key sk-proj-SECRETab*****XYZ`, KEY)).not.toContain("SECRETab");
    expect(redactSecret("nothing here", KEY)).toBe("nothing here");
  });
});

async function proxyOn(script: (path: string, n: number) => FakeReply, o: { allow?: () => { ok: boolean; message: string | null } } = {}) {
  const up = await startFakeChatServer((r, n) => script(r.path, n));
  const proxy = new ProviderProxy({ credential: (p) => (p === "openai" ? KEY : null), upstream: () => up.url, ...(o.allow ? { allow: o.allow } : {}) });
  await proxy.start();
  closers.push(async () => { await proxy.stop(); await up.close(); });
  return { up, proxy };
}
const post = (url: string, token: string, body = "{}") => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });

describe("ProviderProxy", () => {
  it("swaps its token for the key, only on the two allowed routes, only for the token's provider", async () => {
    const { up, proxy } = await proxyOn(() => ({ status: 200, body: "{\"ok\":true}" }));
    const t = proxy.issue({ botId: "b1", provider: "openai" });
    expect(t).not.toContain(KEY);
    expect((await post(`${proxy.url}/p/openai/chat/completions`, t)).status).toBe(200);
    expect(up.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect((await fetch(`${proxy.url}/p/openai/models`, { headers: { authorization: `Bearer ${t}` } })).status).toBe(200);
    for (const bad of [`${proxy.url}/p/openai/files`, `${proxy.url}/p/openai/embeddings`, `${proxy.url}/v1/messages`, `${proxy.url}/p/anthropic/chat/completions`, `${proxy.url}/p/openai/../chat/completions`]) {
      expect((await post(bad, t)).status).toBe(404);
    }
    expect((await post(`${proxy.url}/p/gemini/chat/completions`, t)).status).toBe(401); // another provider's path
    expect((await post(`${proxy.url}/p/openai/chat/completions`, "synprov-forged")).status).toBe(401);
    expect((await post(`${proxy.url}/p/openai/chat/completions`, KEY)).status).toBe(401); // the key itself is no token
    proxy.revoke(t);
    expect((await post(`${proxy.url}/p/openai/chat/completions`, t)).status).toBe(401);
    expect(up.requests).toHaveLength(2);
  });

  it("Responses only for OpenAI, native generateContent only for Gemini (its key in x-goog-api-key)", async () => {
    const up = await startFakeChatServer(() => ({ status: 200, body: "{}" }));
    const proxy = new ProviderProxy({ credential: () => KEY, upstream: (p) => (p === "gemini" ? `${up.url}/v1beta/openai` : up.url) });
    await proxy.start();
    closers.push(async () => { await proxy.stop(); await up.close(); });
    const oa = proxy.issue({ botId: null, provider: "openai" });
    const ge = proxy.issue({ botId: null, provider: "gemini" });
    expect((await post(`${proxy.url}/p/openai/responses`, oa)).status).toBe(200);
    expect((await post(`${proxy.url}/p/gemini/responses`, ge)).status).toBe(404);
    expect((await post(`${proxy.url}/p/gemini/native/models/gemini-3.5-flash-lite:generateContent`, ge)).status).toBe(200);
    expect((await post(`${proxy.url}/p/openai/native/models/x:generateContent`, oa)).status).toBe(404);
    expect((await post(`${proxy.url}/p/gemini/native/models/../../x:generateContent`, ge)).status).toBe(404);
    expect(up.requests.map((r) => r.path)).toEqual(["/responses", "/v1beta/models/gemini-3.5-flash-lite:generateContent"]);
    expect(up.requests[1]!.headers["x-goog-api-key"]).toBe(KEY);
    expect(up.requests[1]!.headers.authorization).toBeUndefined();
  });

  it("asks the budget before a chat call, and a refusal is marked and never forwarded", async () => {
    const { up, proxy } = await proxyOn(() => ({ status: 200, body: "{}" }), { allow: () => ({ ok: false, message: "Budget reached." }) });
    const r = await post(`${proxy.url}/p/openai/chat/completions`, proxy.issue({ botId: "b1", provider: "openai" }));
    expect(r.status).toBe(429);
    expect(r.headers.get(BUDGET_HEADER)).toBe("over");
    expect(up.requests).toHaveLength(0);
  });

  it("never hands the key back: error bodies, JSON answers and streams echoing it are scrubbed", async () => {
    const half = Math.floor(KEY.length / 2);
    const { proxy } = await proxyOn((p, n) => (n === 0 ? { status: 401, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }) }
      : n === 1 ? { status: 400, body: `[{"error":{"message":"bad key ${KEY.slice(0, 20)}"}}]` }
        : p === "/models" ? { status: 200, body: JSON.stringify({ data: [{ id: KEY }] }) }
          : { sse: [{ choices: [{ index: 0, delta: { content: `echo ${KEY.slice(0, half)}` } }] }, { choices: [{ index: 0, delta: { content: `${KEY.slice(half)} done` } }] }], chunkBytes: 7 }));
    const t = proxy.issue({ botId: null, provider: "openai" });
    const bodies = [
      await (await post(`${proxy.url}/p/openai/chat/completions`, t)).text(),
      await (await post(`${proxy.url}/p/openai/chat/completions`, t)).text(),
      await (await fetch(`${proxy.url}/p/openai/models`, { headers: { authorization: `Bearer ${t}` } })).text(),
      await (await post(`${proxy.url}/p/openai/chat/completions`, t)).text(),
    ];
    for (const b of bodies) {
      expect(b).not.toContain(KEY);
      expect(b).not.toContain(KEY.slice(0, 20));
    }
    expect(bodies[0]).toContain("[redacted key]");
  });

  it("the key test's candidate key is used for that token only", async () => {
    const { up, proxy } = await proxyOn(() => ({ status: 200, body: "{}" }));
    const cand = "sk-candidate-0123456789abcdef";
    await fetch(`${proxy.url}/p/openai/models`, { headers: { authorization: `Bearer ${proxy.issue({ botId: null, provider: "openai", keyOverride: cand })}` } });
    await fetch(`${proxy.url}/p/openai/models`, { headers: { authorization: `Bearer ${proxy.issue({ botId: null, provider: "openai" })}` } });
    expect(up.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${cand}`, `Bearer ${KEY}`]);
  });
});
