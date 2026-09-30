import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProvidersView, TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../../app";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { ChatCompletionsAdapter } from "../../../brain/provider/adapters/chat-completions";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BrainWiring } from "../../../brain/types";
import { sealTo } from "../../../secrets/crypto";
import { providerFetch } from "../../../usage/metered-provider";
import { tmpConfig } from "../../helpers";
import { finish, reply, startFakeChatServer, toolChunks, usageChunk, type FakeRequest } from "./fake-chat-server";
import { startProviderRuntime } from "./runtime";

/**
 * Spec §12.1 and §12.3, track 2.4: the key guard and the consent guard.
 * - A provider key never leaves the host process: not in a Bot's env, not in any file the app writes (besides its
 *   sealed store), not in a log line, a tool result, the transcript, a tray, or a gateway answer — including when the
 *   provider echoes it back in an error body.
 * - Nothing is sent to a provider without the user's consent, whoever asks (gateway or providerFetch).
 */
const KEY = "sk-leakcheck-SECRET-0123456789abcdefXYZ";
let app: HostApp | null = null;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await app?.close();
  app = null;
  for (const c of closers.splice(0)) await c();
});
const until = async (f: () => Promise<boolean> | boolean, ms = 8000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };

function walk(dir: string, out: string[] = []): string[] {
  let es: fs.Dirent[] = [];
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

describe("provider key guard (the whole host)", () => {
  it("the key appears nowhere outside the sealed store, even when the provider echoes it back", async () => {
    const upstream = await startFakeChatServer((req: FakeRequest, n) => {
      if (req.path === "/models") return { status: 200, body: JSON.stringify({ data: [{ id: `echo ${KEY}` }] }) };
      if (req.body.model === "gpt-6-luna") return reply({ text: "OK" });
      const msgs = req.body.messages as { role: string }[];
      if (msgs.at(-1)!.role === "user") return { sse: [...toolChunks([{ id: "call_env", name: "Shell", args: { command: "env" } }]), finish("tool_calls"), usageChunk(50, 5)] };
      // After the tool result: the provider rejects the key and quotes it, as OpenAI's 401 does.
      return n >= 0 ? { status: 401, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. You can find your API key at …`, code: "invalid_api_key" } }) } : reply({});
    });
    closers.push(() => upstream.close());
    const cfg = tmpConfig();
    const logged: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array, ...a: unknown[]) => { logged.push(String(c)); return (realWrite as (...x: unknown[]) => boolean)(c, ...a); }) as typeof process.stderr.write;
    closers.push(async () => { process.stderr.write = realWrite; });
    app = await createHostApp(cfg, { providerUpstream: () => upstream.url });
    const { port } = await app.listen();
    const answers: string[] = [];
    const api = async <T>(cmd: string, args: unknown): Promise<T> => {
      const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
      const text = await r.text();
      answers.push(text);
      const j = JSON.parse(text) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
      if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
      return j.result as T;
    };
    const { id } = await api<{ id: string }>("createAgent", { name: "Kit", isKickstartRequested: false });
    const v = await api<ProvidersView>("getProviders", {});
    await api("consentProvider", { provider: "openai", textVersion: v.providers[0]!.consentVersion });
    await api("setProviderKey", { provider: "openai", sealed: await sealTo(v.boxPublicKey, KEY) });
    await api("testProviderKey", { provider: "openai" });
    await api("updateAgent", { id, model: "openai:gpt-6.1-sol" });
    await api("sendPrompt", { id, text: "what's in your environment?", clientNonce: "n1" });
    // `env` reads saved secrets, so the gate's floor cards it; the user allows it once.
    const card = async () => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries.flatMap((e) => (e.kind === "send-message" && e.message.type === "auto-review-approval" ? [e.message.approval as { approvalId: string; status: string }] : [])).at(-1);
    await until(async () => (await card())?.status === "pending");
    await api("resolveAutoReviewApproval", { id, approvalId: (await card())!.approvalId, choice: "once" });
    await until(() => upstream.requests.filter((r) => r.body.model === "gpt-6.1-sol").length >= 2 && app!.services.runner.isIdle(id));
    const tail = await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id });
    await api("getProviders", {});

    // the tool ran (its result went to the model) and the Bot's env holds no key
    const toolMsg = (upstream.requests.find((r) => (r.body.messages as { role: string }[] | undefined)?.some((m) => m.role === "tool"))!.body.messages as { role: string; content: string }[]).find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("PATH=");
    expect(toolMsg.content).not.toContain(KEY);
    expect(Object.values(app.services.spawnConfig(id).env).join("\n")).not.toContain(KEY);
    expect(process.env).not.toSatisfy((e: NodeJS.ProcessEnv) => Object.values(e).some((x) => x?.includes(KEY)));
    // the provider's echo was classified in the app's words, and nothing carried the key out
    expect(app.services.trays.list().some((t) => t.title === "Key rejected")).toBe(true);
    const everything = [JSON.stringify(tail), JSON.stringify(app.services.trays.list()), answers.join("\n"), logged.join("")];
    for (const s of everything) expect(s).not.toContain(KEY);
    // every file the app wrote: only the sealed store mentions the provider key, and not in the clear
    const files = [cfg.dataRoot, cfg.hostPrivate, cfg.workspace, cfg.claudeConfigDir, cfg.ccManagedDir].filter((d): d is string => !!d).flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const b = fs.readFileSync(f);
      expect(b.includes(KEY), f).toBe(false);
      expect(b.includes(KEY.slice(0, 20)), f).toBe(false);
    }
  }, 30_000);
});

describe("consent guard", () => {
  const wiring: BrainWiring = {
    preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}), stop: async () => ({ block: false }),
    botTools: () => [], flags: () => DEFAULT_FLAGS, turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
  };

  it("providerFetch sends nothing to a provider without consent, and a Bot's turn says why", async () => {
    const up = await startFakeChatServer(() => reply({ text: "hi" }));
    closers.push(() => up.close());
    const rt = await startProviderRuntime({ upstream: up.url, consented: (p) => p !== "openai" });
    closers.push(rt.stop);
    await expect(providerFetch({ purpose: "review", botId: null }, new ChatCompletionsAdapter("openai"), { ref: "openai:m", body: {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ cls: { code: "BOT-E0405", trayTitle: "Not allowed yet" } });
    const brain = new ProviderBrain({ botId: "b1", wiring, store: new ProviderSessionStore(fs.mkdtempSync(path.join(os.tmpdir(), "cg-"))), getSessionId: () => null, sleep: async () => {} });
    const r = await brain.runTurn({ prompt: [{ text: "hi" }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "", model: "openai:m", autoReviewEpoch: "continue" }, () => {});
    expect(r.error).toMatchObject({ code: "BOT-E0405", trayTitle: "Not allowed yet", retryable: false });
    // a consented provider still works on the same runtime
    const ok = await brain.runTurn({ prompt: [{ text: "hi" }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "", model: "gemini:g", autoReviewEpoch: "continue" }, () => {});
    expect(ok.error).toBeUndefined();
    expect(up.requests.map((q) => q.body.model)).toEqual(["g"]);
  });

  it("the gateway refuses a key, a key test and a Bot model for a provider without consent", async () => {
    app = await createHostApp(tmpConfig());
    const h = app.handlers as Record<string, (a: unknown) => Promise<unknown>>;
    const v = (await h.getProviders!({})) as ProvidersView;
    await expect(h.setProviderKey!({ provider: "gemini", sealed: await sealTo(v.boxPublicKey, KEY) })).rejects.toThrow(/allowed yet/);
    expect(await h.testProviderKey!({ provider: "gemini" })).toMatchObject({ ok: false, kind: "no-consent" });
    const { id } = (await h.createAgent!({ name: "Rae", isKickstartRequested: false })) as { id: string };
    await expect(Promise.resolve().then(() => h.updateAgent!({ id, model: "ollama:qwen3:4b" }))).rejects.toThrow(/Unknown model/); // local needs consent too
    await h.consentProvider!({ provider: "ollama", textVersion: v.providers[0]!.consentVersion });
    await h.updateAgent!({ id, model: "ollama:qwen3:4b" }); // local: consent is enough, no key
    await expect(h.consentProvider!({ provider: "gemini", textVersion: 0 })).rejects.toThrow(/changed/);
    await expect(h.setProviderKey!({ provider: "ollama", sealed: "x" })).rejects.toThrow(/needs no key/);
  });
});

describe("provider key guard (static)", () => {
  const HOST = path.resolve(__dirname, "../../..");
  const src = (f: string) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const sources = (dir: string): string[] => walk(dir).filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !f.includes(`${path.sep}node_modules${path.sep}`) && !f.startsWith(path.join(HOST, "test")) && !f.endsWith(".d.ts"));
  it("the opened key is read in one place: the provider proxy's credential lookup in app.ts", () => {
    const users = sources(HOST).filter((f) => /from\s+["'][./]*(auth\/)?provider-keys["']/.test(src(f))).map((f) => path.relative(HOST, f));
    // provider-consent and provider-setup (any-key setup) take only the directory name from it. 0.1.7: keys-module picks
    // which saved key a call pays with, and hands it only to the proxies' credential lookups and a key test.
    expect(users.sort()).toEqual(["app.ts", "auth/keys-module.ts", "auth/provider-consent.ts", "auth/provider-module.ts", "auth/provider-setup.ts"].sort());
    // provider-module reads a saved key only for its key test: by id (kept in this process as the proxy's override),
    // and the offline FUZZ test's "wrong" check. It never leaves the process.
    expect(src(path.join(HOST, "auth", "provider-module.ts")).match(/\.key\(/g)).toHaveLength(2);
    expect(src(path.join(HOST, "auth", "keys-module.ts")).match(/providers\.key\(/g)).toHaveLength(1);
    expect(src(path.join(HOST, "auth", "provider-setup.ts"))).not.toMatch(/\.key\(|keys\./);
    const app = src(path.join(HOST, "app.ts"));
    expect(app.match(/providerKeys\.key\(/g)).toHaveLength(1);
    expect(app).toMatch(/new ProviderProxy\(\{\s*credential: \(p, b\) => \(keySvc \? keySvc\.providerCredential\(p, b\) : providerKeys\.key\(p\)\)/);
    // only the proxy puts a key in an Authorization header
    const setters = sources(HOST).filter((f) => /authorization[^\n]{0,20}`Bearer \$\{key\}`/.test(src(f))).map((f) => path.relative(HOST, f));
    expect(setters).toEqual(["auth/provider-proxy.ts"]);
  });
});
