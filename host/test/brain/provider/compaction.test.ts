import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import type { CanonMessage } from "../../../brain/provider/adapters/types";
import { compactProviderSession, summarizerFor, transcriptOf } from "../../../brain/provider/compaction";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { newProviderSessionId, providerSessionFile, ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BrainWiring, TurnEvent } from "../../../brain/types";
import { setUsageSink, type MeteredRun } from "../../../usage/metered-query";
import { reply, startFakeChatServer, type FakeRequest } from "./fake-chat-server";
import { startProviderRuntime } from "./runtime";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { setUsageSink(null); for (const c of closers.splice(0)) await c(); });

const HISTORY: CanonMessage[] = [
  { role: "user", parts: [{ type: "text", text: "set up the repo" }] },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "mcp__bot__Shell", arguments: "{\"command\":\"git init\"}" }] },
  { role: "tool", toolCallId: "c1", name: "mcp__bot__Shell", text: "x".repeat(5000), isError: false },
  { role: "assistant", text: "Done.", toolCalls: [] },
  { role: "user", parts: [{ type: "text", text: "now add a README" }] },
  { role: "assistant", text: "Added.", toolCalls: [] },
];
async function setup(script: (r: FakeRequest, n: number) => ReturnType<typeof reply>) {
  const up = await startFakeChatServer(script);
  closers.push(() => up.close());
  const rt = await startProviderRuntime({ upstream: up.url });
  closers.push(rt.stop);
  const runs: MeteredRun[] = [];
  setUsageSink({ record: (r) => runs.push(r), lastTotals: () => null, noteTotals: () => {} });
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-"));
  return { up, runs, store: new ProviderSessionStore(hp), hp };
}

describe("provider compaction (spec §7)", () => {
  it("a transcript for the summarizer: roles, tool calls, tool output cut long", () => {
    const t = transcriptOf(HISTORY);
    expect(t).toContain("User: set up the repo");
    expect(t).toContain("Assistant called mcp__bot__Shell with {\"command\":\"git init\"}");
    expect(t).toContain("chars cut]");
    expect(t.length).toBeLessThan(3000);
  });

  it("the helper model summarizes when the transcript fits; otherwise the Bot's own model", () => {
    expect(summarizerFor("openai:gpt-6.1-sol", 10_000)).toBe("openai:gpt-6-luna");
    expect(summarizerFor("openai:gpt-6.1-sol", 900_000)).toBe("openai:gpt-6.1-sol");
    expect(summarizerFor("ollama:qwen3:4b", 1_000)).toBe("ollama:qwen3:4b"); // no helper
  });

  it("compacts the stored session: a tool-less metered call, then a boundary and the summary with the recent user turns", async () => {
    const s = await setup(() => reply({ text: "SUMMARY: repo set up, README added.", usage: [900, 30] }));
    const sid = newProviderSessionId();
    s.store.append("bot_1", sid, HISTORY);
    const v0 = s.store.version(sid);
    expect(await compactProviderSession({ store: s.store, botId: "bot_1", sessionId: sid, ref: "openai:gpt-6.1-sol", instructions: "Summarize.", signal: new AbortController().signal })).toBe(true);
    const req = s.up.requests[0]!.body;
    expect(req.model).toBe("gpt-6-luna");
    expect(req).not.toHaveProperty("tools");
    expect(JSON.stringify(req.messages)).toContain("<conversation>");
    expect(s.runs).toMatchObject([{ purpose: "compaction", botId: "bot_1", model: "openai:gpt-6-luna", usage: { inputTokens: 900, outputTokens: 30 } }]);
    const now = s.store.load("bot_1", sid);
    expect(now).toHaveLength(1);
    const text = (now[0] as { parts: { text: string }[] }).parts[0]!.text;
    expect(text).toContain("SUMMARY: repo set up");
    expect(text).toContain("- set up the repo\n- now add a README");
    expect(s.store.version(sid)).toBe(v0 + 1);
    // the full history stays on disk before the boundary
    expect(fs.readFileSync(providerSessionFile(s.hp, "bot_1", sid), "utf8")).toContain("git init");
  });

  it("a brain holding the old history reloads it after an outside compaction", async () => {
    const s = await setup((r) => reply({ text: JSON.stringify(r.body.messages).includes("<conversation>") ? "SUMMARY" : "hi" }));
    const sid = newProviderSessionId();
    s.store.append("bot_1", sid, HISTORY);
    const brain = new ProviderBrain({ botId: "bot_1", wiring: wiring(), store: s.store, getSessionId: () => sid, sleep: async () => {} });
    await brain.runTurn(input("openai:gpt-6.1-sol", "one"), () => {});
    await compactProviderSession({ store: s.store, botId: "bot_1", sessionId: sid, ref: "openai:gpt-6.1-sol", instructions: "Summarize.", signal: new AbortController().signal });
    await brain.runTurn(input("openai:gpt-6.1-sol", "two"), () => {});
    const last = s.up.requests.at(-1)!.body.messages as { role: string; content: string }[];
    expect(last.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(last[1]!.content).toContain("SUMMARY");
  });

  it("mid-turn: a request that would pass the line compacts first, and the turn goes on from the summary", async () => {
    const s = await setup((r) => reply({ text: JSON.stringify(r.body.messages).includes("<conversation>") ? "SUMMARY of a long chat" : "answer" }));
    const sid = newProviderSessionId();
    // Ollama's default window is 32,768 tokens: 85% is ~27.8k tokens, ~111k characters.
    const long: CanonMessage[] = Array.from({ length: 30 }, (_, i) => [
      { role: "user", parts: [{ type: "text", text: `question ${i} ${"q".repeat(2000)}` }] } as CanonMessage,
      { role: "assistant", text: `answer ${i} ${"a".repeat(2000)}`, toolCalls: [] } as CanonMessage,
    ]).flat();
    s.store.append("bot_1", sid, long);
    const events: TurnEvent[] = [];
    const brain = new ProviderBrain({ botId: "bot_1", wiring: wiring(), store: s.store, getSessionId: () => sid, sleep: async () => {}, compactInstructions: () => "Summarize.", historyKeep: () => "standard" });
    const r = await brain.runTurn(input("ollama:qwen3:4b", "and now?"), (e) => events.push(e));
    expect(r.finalText).toBe("answer");
    expect(events).toContainEqual({ kind: "compact_boundary" });
    expect(s.up.requests).toHaveLength(2);
    const turn = s.up.requests[1]!.body.messages as { role: string; content: string }[];
    expect(JSON.stringify(turn).length).toBeLessThan(20_000);
    expect(turn[1]!.content).toContain("SUMMARY of a long chat");
    expect(turn.at(-1)).toEqual({ role: "user", content: "and now?" }); // the unanswered prompt stays itself, after the summary
    expect(turn[1]!.content).not.toContain("and now?");
  });
});

function wiring(): BrainWiring {
  return {
    preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}), stop: async () => ({ block: false }),
    botTools: () => [], flags: () => DEFAULT_FLAGS, turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
  };
}
function input(model: string, text: string) {
  return { prompt: [{ text }], hidden: false, lane: "user" as const, source: "user" as const, silenceAllowed: false, requestId: "r", systemAppend: "", model, autoReviewEpoch: "continue" as const };
}

describe("the overflow path in the whole host", () => {
  it("a provider's context-length error compacts through the provider and the turn is retried, no BOT-E0404 left", async () => {
    const { createHostApp } = await import("../../../app");
    const { tmpConfig } = await import("../../helpers");
    const { sealTo } = await import("../../../secrets/crypto");
    let overflowed = false;
    const up = await startFakeChatServer((r) => {
      if (r.path === "/models") return { status: 200, body: "{\"data\":[]}" };
      const body = JSON.stringify(r.body.messages ?? []);
      if (body.includes("<conversation>")) return reply({ text: "SUMMARY of everything" });
      if (!overflowed && body.includes("second question")) { overflowed = true; return { status: 400, body: JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens.", code: "context_length_exceeded" } }) }; }
      return { sse: [...(reply({ calls: [{ id: `c${Math.random()}`.replace(".", ""), name: "SendMessage", args: { content: body.includes("SUMMARY") ? "answered after compaction" : "first answer" } }] }) as { sse: unknown[] }).sse] };
    });
    closers.push(() => up.close());
    const app = await createHostApp(tmpConfig(), { providerUpstream: () => up.url });
    closers.push(() => app.close());
    const h = app.handlers as Record<string, (a: unknown) => Promise<unknown>>;
    const v = (await h.getProviders!({})) as { boxPublicKey: string; providers: { consentVersion: number }[] };
    await h.consentProvider!({ provider: "openai", textVersion: v.providers[0]!.consentVersion });
    await h.setProviderKey!({ provider: "openai", sealed: await sealTo(v.boxPublicKey, "sk-overflow-0123456789abcdef") });
    const { id } = (await h.createAgent!({ name: "Lin", isKickstartRequested: false })) as { id: string };
    await h.updateAgent!({ id, model: "openai:gpt-6.1-sol" });
    const sent = () => app.services.bots.tail(id, 100).flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
    const until = async (f: () => boolean) => { const t = Date.now() + 8000; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((x) => setTimeout(x, 20)); } };
    await h.sendPrompt!({ id, text: "first question", clientNonce: "n1" });
    await until(() => sent().includes("first answer") && app.services.runner.isIdle(id));
    await h.sendPrompt!({ id, text: "second question", clientNonce: "n2" });
    await until(() => sent().includes("answered after compaction"));
    expect(up.requests.some((r) => JSON.stringify(r.body.messages ?? []).includes("<conversation>"))).toBe(true);
    expect(app.services.trays.list().filter((t) => t.dedupeKey === `${id}:BOT-E0404`)).toEqual([]);
  }, 30_000);
});
