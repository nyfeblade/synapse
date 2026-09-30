import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { STR_HEALTH } from "@synapse/shared";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { ChatCompletionsAdapter } from "../../../brain/provider/adapters/chat-completions";
import { ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import type { BotToolDef, BrainWiring, TurnEvent } from "../../../brain/types";
import { SseHub } from "../../../gateway/sse-hub";
import { createHealthServices } from "../../../health/module";
import { TrayService } from "../../../trays/trays";
import { providerFetch, providerGet, setProviderRuntime } from "../../../usage/metered-provider";
import { setUsageSink } from "../../../usage/metered-query";
import { tmpConfig } from "../../helpers";
import { finish, reply, startFakeChatServer, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "./fake-chat-server";
import { startProviderRuntime } from "./runtime";

/**
 * 0.1.6: the 0.1.5 features that had to reach the provider brain as well — the live spend meter's `spend` turn event
 * (5.7), and a connector-health row per provider key (4.4). The Ask floor and the loop guard are proven in
 * gate-parity.test.ts (and acp-gate-parity.test.ts), against the real gate and runner.
 */
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { setProviderRuntime(null); setUsageSink(null); for (const c of closers.splice(0)) await c(); });

async function upstream(script: (req: FakeRequest, n: number) => FakeReply) {
  const server = await startFakeChatServer(script);
  closers.push(() => server.close());
  setUsageSink({ record: () => {}, lastTotals: () => null, noteTotals: () => {} });
  const rt = await startProviderRuntime({ upstream: server.url, firstByteMs: 2000, idleMs: 2000 });
  closers.push(rt.stop);
  return { server, rt };
}

function wiring(tools: BotToolDef[]): BrainWiring {
  return {
    preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}),
    stop: async () => ({ block: false }), toolBatch: async () => ({ endTurn: false }), botTools: () => tools,
    turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }), flags: () => DEFAULT_FLAGS,
  };
}

describe("5.7 spend meter: ProviderBrain emits metered `spend` turn events", () => {
  it("cumulative list-price dollars per turn, from each model call's metered usage", async () => {
    // gpt-6-astra: $10 in / $50 out per MTok. Call 1: 1000 in + 100 out = $0.015; call 2: 2000 in + 200 out = $0.03.
    await upstream((_req, n) => (n === 0
      ? { sse: [...toolChunks([{ id: "c1", name: "Shell", args: { command: "ls" } }]), finish("tool_calls"), usageChunk(1000, 100)] }
      : reply({ text: "done", usage: [2000, 200] })));
    const shell: BotToolDef = { name: "Shell", description: "Run", readOnly: false, schema: { command: z.string() }, handler: async () => ({ text: "ok" }) };
    let sid: string | null = null;
    const brain = new ProviderBrain({ botId: "b1", wiring: wiring([shell]), store: new ProviderSessionStore(tmpConfig().hostPrivate), getSessionId: () => sid, sleep: async () => {} });
    const events: TurnEvent[] = [];
    const r = await brain.runTurn({ prompt: [{ text: "go" }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "", model: "openai:gpt-6-astra", autoReviewEpoch: "continue" }, (e) => {
      events.push(e); if (e.kind === "session") sid = e.sessionId;
    });
    const spend = events.filter((e): e is Extract<TurnEvent, { kind: "spend" }> => e.kind === "spend").map((e) => e.turnUsd);
    expect(spend).toEqual([0.015, 0.045]);
    expect(r.usage.costUsd).toBeCloseTo(0.045, 6);
    // The next turn starts from zero again.
    events.length = 0;
    await brain.runTurn({ prompt: [{ text: "again" }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r2", systemAppend: "", model: "openai:gpt-6-astra", autoReviewEpoch: "continue" }, (e) => events.push(e));
    expect(events.filter((e) => e.kind === "spend").map((e) => (e as { turnUsd: number }).turnUsd)[0]).toBeLessThan(0.045);
  });
});

describe("4.4 connector health: a row per provider key", () => {
  function world() {
    const cfg = tmpConfig();
    const hub = new SseHub();
    const trays = new TrayService(hub);
    const bots = { has: () => false, summary: () => ({ profile: { name: "x" } }) };
    const h = createHealthServices({ cfg, hub, trays, bots, now: Date.now } as never, { google: null, mcp: null, composio: null, file: null });
    return { h, trays };
  }

  it("OK on a working call, Needs sign-in on 401, Broken on 402, weather ignored, gone when the key is removed", () => {
    const { h, trays } = world();
    const row = () => h.health.get("provider:openai");
    h.providerKey("openai", 200);
    expect(row()).toMatchObject({ kind: "provider", name: STR_HEALTH.providerKey("OpenAI"), state: "ok", fix: { kind: "provider" } });
    h.providerKey("openai", 429);
    h.providerKey("openai", 503);
    expect(row()?.state).toBe("ok");
    h.providerKey("openai", 401);
    expect(row()).toMatchObject({ state: "needs-sign-in" });
    expect(trays.list().some((t) => t.title === STR_HEALTH.trayNeedsSignIn(STR_HEALTH.providerKey("OpenAI")))).toBe(true);
    h.providerKey("openai", 402);
    expect(row()).toMatchObject({ state: "broken", reason: STR_HEALTH.reasons.noCredit });
    h.providerKey("openai", null);
    expect(row()).toBeUndefined();
    // The Anthropic key keeps its own row id.
    h.keyCheck({ works: true } as never);
    expect(h.health.get("provider:anthropic")?.name).toBe(STR_HEALTH.anthropicKey);
  });

  it("the runtime reports the SAVED key's upstream status — never a candidate under test, never the budget's refusal", async () => {
    let status = 200;
    const { rt } = await upstream((req) => (req.path === "/models" ? { status, body: "{\"data\":[]}" } : status === 200 ? reply({ text: "OK" }) : { status, body: "{\"error\":{\"message\":\"nope\"}}" }));
    const seen: [string, number][] = [];
    rt.rt.onKeyStatus = (p, s) => seen.push([p, s]);
    await providerGet("openai", "models");
    status = 401;
    await providerGet("openai", "models");
    await providerGet("openai", "models", { keyOverride: "sk-candidate-0123456789abcdef" }); // a key under test: not the saved key's health
    const adapter = new ChatCompletionsAdapter("openai");
    const body = adapter.encode({ model: "gpt-6-luna", system: "s", messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], wireName: (n) => n });
    await expect(providerFetch({ purpose: "key-check", botId: null }, adapter, { ref: "openai:gpt-6-luna", body, signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    expect(seen).toEqual([["openai", 200], ["openai", 401], ["openai", 401]]);
  });

});
