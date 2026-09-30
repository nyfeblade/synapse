import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { ChatCompletionsAdapter } from "../../../brain/provider/adapters/chat-completions";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BrainWiring } from "../../../brain/types";
import { providerFetch, ProviderCallError, setProviderRuntime, type ProviderRuntime } from "../../../usage/metered-provider";
import { setUsageSink, type MeteredRun } from "../../../usage/metered-query";
import { startProviderRuntime } from "./runtime";
import { reply, startFakeChatServer, textChunks, usageChunk, type FakeReply } from "./fake-chat-server";

/**
 * Guard (spec §4 providerFetch, §13 "guard tests: metering"): every provider call goes through
 * usage/metered-provider.ts, which asks the budget first and records the call however it ends. Source scan (no
 * allowlist of call sites) plus runtime checks that each request a provider saw was metered exactly once.
 */
const HOST = path.resolve(__dirname, "../../..");
const WRAPPER = path.join(HOST, "usage", "metered-provider.ts");
const QUIRKS = path.join(HOST, "brain", "provider", "adapters", "quirks.ts");
const PROXY = path.join(HOST, "auth", "provider-proxy.ts");
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== path.join(HOST, "test")) out.push(...sources(p)); }
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const UPSTREAMS = /api\.openai\.com|openrouter\.ai|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.deepseek\.com|:11434|host\.orb\.internal:1234/;

describe("provider metering guard: static", () => {
  it("provider brain code has no network of its own (no fetch, http, https, net, undici)", () => {
    const offenders: string[] = [];
    for (const f of sources(path.join(HOST, "brain", "provider")).concat(path.join(HOST, "brain", "brain-switch.ts"))) {
      const src = strip(fs.readFileSync(f, "utf8"));
      if (/\bfetch\s*\(/.test(src)) offenders.push(`${path.relative(HOST, f)}: fetch(`);
      if (/from\s+["'](node:)?(http|https|net|tls|http2|undici)["']/.test(src) || /(import|require)\s*\(\s*["'](node:)?(http|https|net|undici)["']/.test(src)) offenders.push(`${path.relative(HOST, f)}: network import`);
    }
    expect(offenders).toEqual([]);
  });

  it("only the quirks table names a provider upstream; only the provider proxy reads its baseUrl; only providerFetch and the proxy speak chat/completions", () => {
    const named = sources(HOST).filter((f) => f !== QUIRKS && UPSTREAMS.test(strip(fs.readFileSync(f, "utf8")))).map((f) => path.relative(HOST, f));
    expect(named).toEqual([]);
    // (Anthropic's own base URL lives in the auth code; this is about the provider quirks table.)
    const readers = sources(HOST).filter((f) => { const src = strip(fs.readFileSync(f, "utf8")); return f !== QUIRKS && /adapters\/quirks["']/.test(src) && /\.baseUrl\b/.test(src); }).map((f) => path.relative(HOST, f));
    expect(readers).toEqual([path.relative(HOST, PROXY)]);
    for (const route of [/chat\/completions/, /\/responses\b|"responses"/, /:generateContent/]) {
      const senders = sources(HOST).filter((f) => route.test(strip(fs.readFileSync(f, "utf8"))) && /\bfetch\b/.test(strip(fs.readFileSync(f, "utf8")))).map((f) => path.relative(HOST, f));
      expect(senders, String(route)).toEqual([path.relative(HOST, WRAPPER)]);
    }
  });

  it("the wrapper asks the budget before it sends, and records in the one place every path reaches", () => {
    const src = strip(fs.readFileSync(WRAPPER, "utf8"));
    // Each of the two model-call functions asks the budget before its fetch, and records in one place every path reaches.
    for (const fn of ["export async function providerFetch", "export async function providerJson"]) {
      const body = src.slice(src.indexOf(fn), src.indexOf("\n}\n", src.indexOf(fn)));
      expect(body.indexOf("r.allow(meter.botId)"), fn).toBeGreaterThan(0);
      expect(body.indexOf("r.allow(meter.botId)"), fn).toBeLessThan(body.indexOf("(r.fetch ?? fetch)("));
      expect(body.match(/recordMeteredRun\(/g), fn).toHaveLength(1);
    }
    expect(src.match(/recordMeteredRun\(/g)).toHaveLength(2);
    const pf = src.slice(src.indexOf("export async function providerFetch"));
    const afterSend = pf.slice(pf.indexOf("(r.fetch ?? fetch)("), pf.indexOf("export function consentError"));
    expect(afterSend.match(/finish\(\)/g)!.length).toBeGreaterThanOrEqual(3);
    // providerJson records in its finally, so every exit is metered
    const pj = src.slice(src.indexOf("export async function providerJson"));
    expect(pj.slice(pj.indexOf("} finally {"), pj.indexOf("} finally {") + 400)).toContain("recordMeteredRun(");
  });
});

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  setProviderRuntime(null);
  setUsageSink(null);
  for (const s of servers.splice(0)) await s.close();
});

async function withServer(script: (n: number) => FakeReply, rt: Partial<Parameters<typeof startProviderRuntime>[0]> = {}) {
  const server = await startFakeChatServer((_r, n) => script(n));
  servers.push(server);
  const runs: MeteredRun[] = [];
  setUsageSink({ record: (r) => runs.push(r), lastTotals: () => null, noteTotals: () => {} });
  const r = await startProviderRuntime({ upstream: server.url, firstByteMs: 300, idleMs: 300, ...rt });
  servers.push({ close: r.stop });
  return { server, runs };
}
const call = (signal = new AbortController().signal, onUsage?: (u: unknown) => void) => ({ ref: "openai:m", body: { model: "m", stream: true, messages: [{ role: "user", content: "x".repeat(400) }] }, signal, ...(onUsage ? { onUsage } : {}) });
async function drain(s: { chunks: AsyncIterable<unknown> }) { for await (const _ of s.chunks) { /* consume */ } }

describe("provider metering guard: runtime", () => {
  const adapter = new ChatCompletionsAdapter("openai");

  it("every request the provider saw is recorded exactly once: complete, error status, cut stream, hang/timeout, aborted", async () => {
    const script: FakeReply[] = [
      reply({ text: "ok", usage: [100, 5] }),
      { status: 500, body: "{}" },
      { sse: textChunks("partial", 3), cutAfter: 2, chunkBytes: 10, delayMs: 5 },
      { hang: true },
      { sse: textChunks("slow", 4), delayMs: 400 },
    ];
    const s = await withServer((n) => script[n]!);
    const meter = { purpose: "review", botId: "bot_1" };
    await drain(await providerFetch(meter, adapter, call()));
    await expect(providerFetch(meter, adapter, call())).rejects.toBeInstanceOf(ProviderCallError);
    await expect(drain(await providerFetch(meter, adapter, call()))).rejects.toBeInstanceOf(ProviderCallError);
    await expect(providerFetch(meter, adapter, call())).rejects.toMatchObject({ cls: { code: "BOT-E0402" } });
    const ac = new AbortController();
    const slow = await providerFetch(meter, adapter, call(ac.signal));
    setTimeout(() => ac.abort(), 50);
    await expect(drain(slow)).rejects.toBeTruthy();
    expect(s.server.requests).toHaveLength(5);
    expect(s.runs).toHaveLength(5);
    expect(s.runs.map((r) => [r.purpose, r.botId, r.model])).toEqual(Array(5).fill(["review", "bot_1", "openai:m"]));
    expect(s.runs[0]!.usage).toMatchObject({ inputTokens: 100, outputTokens: 5 });
    expect(s.runs[1]!.usage.inputTokens).toBe(0); // an error status isn't billed
    for (const i of [2, 3, 4]) expect(s.runs[i]!.usage.inputTokens).toBeGreaterThan(0); // no usage frame: estimated, never 0
  });

  it("the budget is asked first: a refusal sends nothing and says so; no runtime at all refuses too (fail closed)", async () => {
    const asked: (string | null)[] = [];
    const s = await withServer(() => reply({ text: "x" }), { allow: (b) => { asked.push(b); return { ok: false, message: "Weekly budget reached." }; } });
    await expect(providerFetch({ purpose: "turn", botId: "bot_9" }, adapter, call())).rejects.toMatchObject({ cls: { code: "BOT-E0405", message: "Weekly budget reached.", trayTitle: "Spend budget reached" } });
    expect(asked).toEqual(["bot_9"]);
    setProviderRuntime(null);
    await expect(providerFetch({ purpose: "turn", botId: "bot_9" }, adapter, call())).rejects.toMatchObject({ cls: { code: "BOT-E0405" } });
    expect(s.server.requests).toHaveLength(0);
  });

  it("no key: refused before sending; a local provider needs none and sends no Authorization", async () => {
    const s = await withServer(() => reply({ text: "x" }), { key: null });
    await expect(providerFetch({ purpose: "turn", botId: null }, adapter, call())).rejects.toMatchObject({ cls: { code: "BOT-E0421", trayTitle: "No key saved" } });
    expect(s.server.requests).toHaveLength(0);
    await drain(await providerFetch({ purpose: "turn", botId: null }, new ChatCompletionsAdapter("ollama"), { ...call(), ref: "ollama:qwen3:4b" }));
    expect(s.server.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("a Bot turn's usage (every attempt) lands in its TurnResult, not a second time in the sink; over budget ends the turn with the budget's words", async () => {
    let n = 0;
    const s = await withServer(() => (n++ === 0 ? { status: 503, body: "{}" } : { sse: [...textChunks("hi"), usageChunk(200, 3, { prompt_tokens_details: { cached_tokens: 150 } })] }));
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
    const wiring: BrainWiring = {
      preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}), stop: async () => ({ block: false }),
      botTools: () => [], flags: () => DEFAULT_FLAGS, turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    };
    const brain = new ProviderBrain({ botId: "bot_1", wiring, store: new ProviderSessionStore(hp), getSessionId: () => null, sleep: async () => {} });
    const input = { prompt: [{ text: "hi" }], hidden: false, lane: "user" as const, source: "user" as const, silenceAllowed: false, requestId: "r", systemAppend: "", model: "openai:m", autoReviewEpoch: "continue" as const };
    const r = await brain.runTurn(input, () => {});
    expect(r.usage).toMatchObject({ inputTokens: 50, cacheReadTokens: 150, outputTokens: 3 });
    expect(r.usage.costUsd).toBeGreaterThan(0);
    expect(s.runs).toEqual([]);
    const refusing = await startProviderRuntime({ upstream: s.server.url, allow: () => ({ ok: false, message: "Budget for Piper reached." }) });
    servers.push({ close: refusing.stop });
    const over = await brain.runTurn(input, () => {});
    expect(over.error).toMatchObject({ code: "BOT-E0405", message: "Budget for Piper reached.", retryable: false });
    expect(s.server.requests).toHaveLength(2);
  });
});
