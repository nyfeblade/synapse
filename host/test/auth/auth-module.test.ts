import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR_AUTH } from "@synapse/shared";
import { AuthStore } from "../../auth/auth-store";
import { createAuthCommands } from "../../auth/module";
import { testAnthropicConnection } from "../../auth/test-connection";
import { loadOrCreateBoxKeyPair, sealTo } from "../../secrets/crypto";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

const KEY = "sk-ant-api03-" + "k".repeat(80) + "Q7zz";
let api: FakeAnthropic | null = null;
const dirs: string[] = [];
afterEach(async () => { await api?.close(); api = null; for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function setup(failures: { status: number; type: string; message?: string; retryAfterSec?: number }[] = []) {
  api = await startFakeAnthropic({ apiKey: KEY, script: [[{ text: "OK" }]], failures });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-mod-"));
  dirs.push(dir);
  const store = new AuthStore({ dir: path.join(dir, "anthropic-auth"), key: randomBytes(32) });
  const kp = await loadOrCreateBoxKeyPair(dir);
  const cmds = createAuthCommands({ store, keyPair: async () => kp, baseUrl: api.url });
  return { store, kp, cmds, api };
}

describe("Test connection (one tiny request to Anthropic)", () => {
  it("a bogus key reaches Anthropic and is rejected: 401 authentication_error → \"Reached Anthropic ✓ — key rejected\"", async () => {
    const { api } = await setup();
    const r = await testAnthropicConnection("sk-ant-api03-" + "x".repeat(60), { baseUrl: api.url });
    expect(r).toMatchObject({ ok: false, reached: true, kind: "invalid-key", status: 401, title: "Reached Anthropic ✓ — key rejected" });
    expect(STR_AUTH.keyRejected).toBe("Reached Anthropic ✓ — key rejected");
    const req = api.requests.at(-1)!;
    expect(req.path).toBe("/v1/messages");
    expect(req.apiKey).toBe("sk-ant-api03-" + "x".repeat(60)); // the key travels as x-api-key…
    expect(req.authorization).toBeNull(); // …never as a bearer token
    expect(req.version).toBe("2023-06-01");
    expect(req.body).toMatchObject({ max_tokens: 1 });
    expect((req.body.model as string)).toMatch(/haiku/);
  });

  it("a good key → ok", async () => {
    const { api } = await setup();
    expect(await testAnthropicConnection(KEY, { baseUrl: api.url })).toMatchObject({ ok: true, reached: true, kind: "ok", status: 200, title: STR_AUTH.ok });
  });

  it.each([
    [{ status: 402, type: "billing_error" }, "billing", STR_AUTH.billing],
    [{ status: 400, type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." }, "billing", STR_AUTH.billing],
    [{ status: 429, type: "rate_limit_error", retryAfterSec: 17 }, "rate-limited", STR_AUTH.rateLimited],
    [{ status: 529, type: "overloaded_error" }, "overloaded", STR_AUTH.overloaded],
    [{ status: 403, type: "permission_error" }, "permission", STR_AUTH.permission],
    [{ status: 404, type: "not_found_error" }, "model-unavailable", STR_AUTH.modelUnavailable],
    [{ status: 500, type: "api_error" }, "server", STR_AUTH.server],
  ] as [{ status: number; type: string; message?: string; retryAfterSec?: number }, string, string][])("%o → %s", async (failure, kind, title) => {
    // The test request carries no tools, so the fake answers it with the failure only when told to for every call.
    const { api } = await setup();
    const r = await testAnthropicConnection(KEY, { baseUrl: api.url, fetchFn: failingFetch(failure) });
    expect(r).toMatchObject({ ok: false, reached: true, kind, title, status: failure.status });
    if (failure.retryAfterSec) { expect(r.retryAfterSec).toBe(17); expect(r.detail).toContain("17 s"); }
  });

  it("no answer at all → \"Couldn't reach Anthropic\"", async () => {
    const r = await testAnthropicConnection(KEY, { baseUrl: "http://127.0.0.1:1" });
    expect(r).toMatchObject({ ok: false, reached: false, kind: "network", status: null, title: STR_AUTH.network });
  });
});

/** A fetch that answers like the real API does for one failure (the documented error body and headers). */
function failingFetch(f: { status: number; type: string; message?: string; retryAfterSec?: number }): typeof fetch {
  return (async () => new Response(JSON.stringify({ type: "error", error: { type: f.type, message: f.message ?? f.type }, request_id: "req_x" }), {
    status: f.status, headers: { "content-type": "application/json", ...(f.retryAfterSec ? { "retry-after": String(f.retryAfterSec) } : {}) },
  })) as typeof fetch;
}

describe("gateway commands: the key goes in sealed and never comes back", () => {
  it("setApiKey opens a sealed key, stores it, and answers with the masked form only", async () => {
    const { cmds, kp, store } = await setup();
    const view = await cmds.setApiKey!({ sealed: await sealTo(kp.publicKey, KEY) });
    expect(view.apiKey?.masked).toBe("sk-ant-…Q7zz");
    expect(store.apiKey()).toBe(KEY);
    const all = JSON.stringify([view, await cmds.getAuth!({})]);
    expect(all).not.toContain(KEY.slice(13, 40));
    expect(view.boxPublicKey).toBe(kp.publicKey);
  });

  it("never logs the key", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => { writes.push(String(c)); return true; });
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { writes.push(a.join(" ")); });
    const { cmds, kp } = await setup();
    await cmds.setApiKey!({ sealed: await sealTo(kp.publicKey, KEY) });
    await cmds.testAuthConnection!({});
    await Promise.resolve(cmds.setApiKey!({ sealed: await sealTo(kp.publicKey, "sk-ant-oat01-" + "z".repeat(60)) })).catch(() => {});
    expect(writes.join("\n")).not.toContain(KEY.slice(13, 40));
  });

  it("refuses a sealed value that is not an API key, and a plaintext one", async () => {
    const { cmds, kp } = await setup();
    await expect(cmds.setApiKey!({ sealed: await sealTo(kp.publicKey, "not a key") })).rejects.toThrow(/API key/);
    await expect(cmds.setApiKey!({ sealed: KEY })).rejects.toThrow();
  });

  it("there is no sign-in mode to switch: the view is the masked key and the box key only", async () => {
    const { cmds, kp } = await setup();
    expect((cmds as Record<string, unknown>).setAuthMode).toBeUndefined();
    expect(await cmds.getAuth!({})).toEqual({ apiKey: null, boxPublicKey: kp.publicKey });
  });

  it("clearApiKey leaves no key (Bots then wait for one) and never another sign-in", async () => {
    const { cmds, kp, store } = await setup();
    await cmds.setApiKey!({ sealed: await sealTo(kp.publicKey, KEY) });
    expect((await cmds.clearApiKey!({})).apiKey).toBeNull();
    expect(store.apiKey()).toBeNull();
  });

  it("testAuthConnection uses the saved key, or a sealed candidate before it is saved", async () => {
    const { cmds, kp, api } = await setup();
    expect(await cmds.testAuthConnection!({})).toMatchObject({ ok: false, kind: "no-key" });
    expect(await cmds.testAuthConnection!({ sealed: await sealTo(kp.publicKey, KEY) })).toMatchObject({ ok: true });
    await cmds.setApiKey!({ sealed: await sealTo(kp.publicKey, KEY) });
    expect(await cmds.testAuthConnection!({})).toMatchObject({ ok: true });
    expect(api.requests.every((r) => r.apiKey === KEY)).toBe(true);
  });
});
