import { describe, expect, it } from "vitest";
import { HAIKU_PREFIX, PREFIX_EVERYDAY, PREFIX_SHIPPED, ROUTE_SONNET, synapseShipped, TTL_1H } from "../../../bench/compare/params";
import { simulate } from "../../../bench/compare/simulate";
import type { Conversation, Message } from "../../../bench/compare/workload";

/** cost-diet-2: the simulator's new switches (model routing, the everyday tool profile, memory batching). */
const MIN = 60_000;
const reply = (tokens: number) => ({ kind: "reply" as const, argTokens: tokens + 25, resultTokens: 15, durationMs: 500 });
const work = { kind: "work" as const, argTokens: 60, resultTokens: 2_000, durationMs: 2_000 };
function msg(i: number, t: number, over: Partial<Message> = {}): Message {
  return { i, session: 0, t, userTokens: 30, userChars: 120, memorable: true, tools: [reply(40)], recallDraw: 0.99, archiveDraw: 0.99, ...over };
}
const conv = (messages: Message[]): Conversation => ({ profile: "casual", days: 1, messages });
const chat = (n: number, gapMs = 2 * MIN, t0 = 0) => Array.from({ length: n }, (_, i) => msg(i, t0 + i * gapMs));

describe("the shipped baseline", () => {
  it("is today's everyday Bot: measured sonnet-5 prefix, 180k cap, 1 h cache, and a reply that ends the turn", () => {
    const p = synapseShipped();
    expect(p.prefix.tools + p.prefix.systemBase).toBe(PREFIX_SHIPPED.system + PREFIX_SHIPPED.tools);
    expect(p.historyCap).toBe(180_000);
    expect(p.cache.ttlMs).toBe(TTL_1H);
    expect(simulate(conv([msg(0, 0)]), p).messages[0]!.calls, "SendMessage end_turn: no closing call").toBe(1);
    expect(synapseShipped({ noBash: true, upFront: true }).prefix.tools).toBe(PREFIX_EVERYDAY.tools);
  });
});

describe("model routing", () => {
  it("routes a simple message (no tools) to the cheap model and never a work message", () => {
    const r = simulate(conv([msg(0, 0), msg(1, MIN, { tools: [reply(10), work, reply(40)] }), msg(2, 2 * MIN)]), synapseShipped({ route: ROUTE_SONNET.always }));
    expect(r.messages.map((m) => m.routed)).toEqual([true, false, true]);
    expect(r.messages[1]!.simple.write + r.messages[1]!.simple.read).toBe(0);
  });

  it("a switch writes the cheap model's own cache: models do not share one", () => {
    const r = simulate(conv([msg(0, 0, { tools: [reply(10), work, reply(40)] }), msg(1, MIN)]), synapseShipped({ route: ROUTE_SONNET.always }));
    const first = r.messages[1]!;
    expect(first.routed).toBe(true);
    expect(first.simple.read, "nothing cached on the cheap model yet").toBe(0);
    expect(first.simple.write).toBeGreaterThanOrEqual(HAIKU_PREFIX.system + HAIKU_PREFIX.tools);
  });

  it("'cold' routes only when the main model's cache has expired, then stays while messages stay simple", () => {
    const ms = [msg(0, 0), msg(1, MIN), msg(2, 90 * MIN), msg(3, 91 * MIN), msg(4, 92 * MIN, { tools: [reply(10), work, reply(40)] }), msg(5, 93 * MIN)];
    const r = simulate(conv(ms), synapseShipped({ route: { ...ROUTE_SONNET.cold, escalateRate: 0 } }));
    expect(r.messages.map((m) => m.routed)).toEqual([true, true, true, true, false, false]);
  });

  it("never routes past the cheap model's context guard", () => {
    const big = { kind: "work" as const, argTokens: 50, resultTokens: 60_000, durationMs: 2_000 };
    const ms = [msg(0, 0, { tools: [big, big, reply(10)] }), msg(1, MIN)];
    const guard = { ...ROUTE_SONNET.always, escalateRate: 0, maxContext: 100_000 };
    const r = simulate(conv(ms), synapseShipped({ route: guard }));
    expect(r.messages[1]!.routed, "~133k of context: over the guard").toBe(false);
    const small = simulate(conv([msg(0, 0), msg(1, MIN)]), synapseShipped({ route: guard }));
    expect(small.messages[1]!.routed, "the same message in a small context routes").toBe(true);
  });

  it("an escalated message pays the cheap attempt AND the full main-model run", () => {
    const route = { ...ROUTE_SONNET.always, escalateRate: 1 };
    const r = simulate(conv(chat(3)), synapseShipped({ route }));
    for (const m of r.messages) {
      expect(m.escalated).toBe(true);
      expect(m.simple.write + m.simple.read).toBeGreaterThan(0);
      expect(m.main.write + m.main.read).toBeGreaterThan(0);
    }
  });

  it("weights the cheap model's tokens by its price: a long warm run of chat costs less", () => {
    const ms = chat(40);
    const off = simulate(conv(ms), synapseShipped()).messages.reduce((a, m) => a + m.weighted, 0);
    const on = simulate(conv(ms), synapseShipped({ route: ROUTE_SONNET.always })).messages.reduce((a, m) => a + m.weighted, 0);
    expect(on).toBeLessThan(off);
  });
});

describe("background memory", () => {
  it("batching extraction makes fewer helper calls for the same memorable exchanges", () => {
    const ms = chat(30);
    const calls = (batch: number) => simulate(conv(ms), synapseShipped({ memBatch: batch })).messages.reduce((a, m) => a + m.helper.calls, 0);
    expect(calls(3)).toBeLessThan(calls(1));
  });

  it("flushes a partial batch at idle and at the end, so no memorable exchange is dropped", () => {
    const ms = [msg(0, 0), msg(1, MIN), msg(2, 120 * MIN)];
    const r = simulate(conv(ms), synapseShipped({ memBatch: 3 }));
    expect(r.extracted).toBe(3);
  });
});
