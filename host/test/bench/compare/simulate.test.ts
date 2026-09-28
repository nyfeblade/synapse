import { describe, expect, it } from "vitest";
import { hostedAgent, synapsePlanned, synapseToday, TTL_1H, type Policy } from "../../../bench/compare/params";
import { simulate } from "../../../bench/compare/simulate";
import type { Conversation, Message } from "../../../bench/compare/workload";

const MIN = 60_000;
const reply = (tokens: number) => ({ kind: "reply" as const, argTokens: tokens + 25, resultTokens: 15, durationMs: 500 });
function msg(i: number, t: number, over: Partial<Message> = {}): Message {
  return { i, session: 0, t, userTokens: 30, userChars: 120, memorable: true, tools: [reply(40)], recallDraw: 0.99, archiveDraw: 0.99, ...over };
}
function conv(messages: Message[]): Conversation {
  return { profile: "casual", days: 1, messages };
}
/** A tool result big enough to push a 200k window past 90% in a few messages. */
const big = { kind: "work" as const, argTokens: 50, resultTokens: 40_000, durationMs: 2_000 };

describe("the replay engine", () => {
  it("makes one model call per tool call plus the one that ends the turn", () => {
    const r = simulate(conv([msg(0, 0), msg(1, MIN, { tools: [reply(10), big, big, reply(40)] })]), synapseToday());
    expect(r.messages.map((m) => m.calls)).toEqual([2, 5]);
  });

  it("the second call of a message reads the first call's prompt from cache", () => {
    const p = synapseToday();
    const r = simulate(conv([msg(0, 0)]), p);
    const prefix = p.prefix.tools + p.prefix.systemBase;
    expect(r.messages[0]!.main.read).toBeGreaterThanOrEqual(prefix);
    expect(r.messages[0]!.main.write).toBeGreaterThanOrEqual(prefix);
  });

  it("is deterministic: the same conversation replays to the same numbers", () => {
    const c = conv([msg(0, 0), msg(1, 2 * MIN), msg(2, 30 * MIN)]);
    expect(simulate(c, hostedAgent("mid"))).toEqual(simulate(c, hostedAgent("mid")));
  });

  it("HOSTED_AGENT self-summarises at 90% of 200k; SYNAPSE_TODAY on a 1M window does not", () => {
    const ms = Array.from({ length: 6 }, (_, i) => msg(i, i * MIN, { tools: [big, reply(40)] }));
    expect(simulate(conv(ms), hostedAgent("mid")).compactions).toBeGreaterThan(0);
    expect(simulate(conv(ms), synapseToday()).compactions).toBe(0);
  });

  it("SYNAPSE_TODAY compacts at 70% of its window, and the planned cap at ~180k", () => {
    const ms = Array.from({ length: 24 }, (_, i) => msg(i, i * MIN, { tools: [big, reply(40)] }));
    const today = simulate(conv(ms), synapseToday());
    expect(today.compactions).toBe(1);
    expect(Math.max(...today.messages.map((m) => m.ctx))).toBeGreaterThanOrEqual(700_000);
    const capped = simulate(conv(ms), synapsePlanned({ cap: true }));
    expect(capped.compactions).toBeGreaterThan(3);
    expect(Math.max(...capped.messages.map((m) => m.ctx))).toBeLessThan(260_000);
  });

  it("a compaction breaks the cache after the frozen memory block: the next call reads only the stable prefix", () => {
    const g = hostedAgent("mid");
    const ms = Array.from({ length: 8 }, (_, i) => msg(i, i * MIN, { tools: [big, reply(40)] }));
    const r = simulate(conv(ms), g);
    const k = r.messages.findIndex((m) => m.compacted);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(r.messages[k]!.postCompactRead).toBe(g.prefix.tools + g.prefix.systemBase);
  });

  it("the hosted agent's extraction and episodes bill the main model; ours bill the helper model", () => {
    const ms = Array.from({ length: 6 }, (_, i) => msg(i, i * MIN));
    const g = simulate(conv(ms), hostedAgent("mid")), s = simulate(conv(ms), synapseToday());
    expect(g.messages.every((m) => m.helper.input === 0)).toBe(true);
    expect(g.messages[5]!.mainHelperCalls).toBe(2); // extraction + the 6th-turn episode
    expect(s.messages[5]!.helper.calls).toBe(2);
    expect(s.messages[5]!.mainHelperCalls).toBe(0);
  });

  it("a trivial message is not memorable and triggers no extraction", () => {
    const r = simulate(conv([msg(0, 0, { memorable: false })]), hostedAgent("mid"));
    expect(r.messages[0]!.mainHelperCalls).toBe(0);
  });

  it("dreaming replaces extraction with helper-model synthesis + verification", () => {
    const r = simulate(conv([msg(0, 0)]), hostedAgent("mid", { dreaming: true }));
    expect(r.messages[0]!.mainHelperCalls).toBe(0);
    expect(r.messages[0]!.helper.calls).toBe(2);
  });

  it("archive search fires only once something is archived, and adds a call", () => {
    const p = synapsePlanned({ cap: true, archive: true });
    const ms = Array.from({ length: 12 }, (_, i) => msg(i, i * MIN, { tools: [big, reply(40)], archiveDraw: 0 }));
    const r = simulate(conv(ms), p);
    const first = r.messages.findIndex((m) => m.compacted);
    expect(r.messages[0]!.calls).toBe(3);
    expect(r.messages[first + 1]!.calls).toBe(4);
  });

  it("recall injection lands only when its draw fires", () => {
    const p: Policy = synapseToday();
    const a = simulate(conv([msg(0, 0, { recallDraw: 0 })]), p), b = simulate(conv([msg(0, 0)]), p);
    expect(a.messages[0]!.main.write - b.messages[0]!.main.write).toBe(p.recall!.tokens); // written once
    expect(a.messages[0]!.main.read - b.messages[0]!.main.read).toBe(p.recall!.tokens); // read by the closing call
  });

  it("the standalone prompt cuts 41% of the system block and the trim cuts built-in tools", () => {
    const t = synapseToday(), s = synapsePlanned({ standalone: true }), tr = synapsePlanned({ trim: true });
    expect(s.prefix.systemBase).toBe(Math.round(t.prefix.systemBase * 0.59));
    expect(t.prefix.tools - tr.prefix.tools).toBeGreaterThanOrEqual(4_000);
    expect(t.prefix.tools - tr.prefix.tools).toBeLessThanOrEqual(7_000);
  });

  it("a 1-hour TTL turns a 30-minute gap's rewrite into a read", () => {
    const c = conv([msg(0, 0), msg(1, 30 * MIN)]);
    const five = simulate(c, synapseToday()), hour = simulate(c, synapseToday({ ttlMs: TTL_1H }));
    expect(hour.messages[1]!.firstCallRead).toBeGreaterThan(five.messages[1]!.firstCallRead);
    expect(five.messages[1]!.firstCallRead).toBe(0);
  });
});
