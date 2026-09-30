import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import { MIN_DEFERRED_CHARS, ProviderBrain } from "../../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import { ToolRegistry } from "../../../brain/provider/tool-registry";
import { searchDeferred, TOOL_SEARCH } from "../../../brain/provider/tool-search";
import type { BotToolDef, BrainWiring, TurnInput } from "../../../brain/types";
import { setProviderRuntime } from "../../../usage/metered-provider";
import { setUsageSink } from "../../../usage/metered-query";
import { finish, reply, startFakeChatServer, toolChunks, usageChunk, type FakeRequest } from "./fake-chat-server";
import { startFakeMessagesServer, type MsgRequest } from "./fake-messages-server";
import { startProviderRuntime } from "./runtime";

/**
 * 0.1.8, the coding token gap: deferred tool loading on Synapse's own loop. A Bot's rarely used tools are listed by name
 * in ToolSearch's description and loaded on demand; the request prefix stays byte-stable (Claude: defer_loading +
 * tool_reference; Chat Completions: the loaded tool appended after every up-front tool); every call is still gated.
 */
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => { setProviderRuntime(null); setUsageSink(null); for (const c of closers.splice(0)) await c.close(); });

const long = (s: string) => `${s} ${"It returns the matching records with their ids, owners, timestamps and a short summary of each. ".repeat(10)}`;
const tool = (name: string, description: string, ran: string[]): BotToolDef => ({ name, description, readOnly: true, schema: { q: z.string() }, handler: async (a) => { ran.push(`${name}:${String(a.q)}`); return { text: `${name} answered ${String(a.q)}` }; } });

function wiring(tools: BotToolDef[], log: string[]): BrainWiring {
  return {
    preToolUse: async (c) => { log.push(`pre:${c.toolName}`); return { decision: "allow" }; },
    canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}), stop: async () => ({ block: false }),
    toolBatch: async () => ({ endTurn: false }), botTools: () => tools, flags: () => DEFAULT_FLAGS,
    turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
  };
}
const input = (text: string, model: string): TurnInput => ({ prompt: [{ text }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "", model, autoReviewEpoch: "continue" });

function botTools(ran: string[]): BotToolDef[] {
  return [
    tool("SendMessage", "Reply to the user.", ran),
    tool("Shell", "Run a command.", ran),
    tool("Lookup", long("Looks up records in the tracker."), ran),
    tool("Archive", long("Archives a finished project."), ran),
    tool("Schedule", long("Schedules a routine."), ran),
    tool("Invite", long("Invites a teammate Bot."), ran),
  ];
}

describe("searchDeferred", () => {
  const reg = new ToolRegistry(botTools([]).map((def) => ({ canonical: `mcp__bot__${def.name}`, def, deferred: def.name !== "SendMessage" })), "loose");
  const d = reg.deferredTools();
  it("select: loads by name, wire or canonical, any case, in the order asked", () => {
    expect(searchDeferred(d, "select:schedule,Lookup").map((t) => t.wireName)).toEqual(["Schedule", "Lookup"]);
    expect(searchDeferred(d, "select:mcp__bot__Invite").map((t) => t.wireName)).toEqual(["Invite"]);
    expect(searchDeferred(d, "select:Nope")).toEqual([]);
  });
  it("words rank names above descriptions and cap at max_results", () => {
    expect(searchDeferred(d, "archive")[0]!.wireName).toBe("Archive");
    expect(searchDeferred(d, "records", 2)).toHaveLength(2);
    expect(searchDeferred(d, "  ")).toEqual([]);
  });
});

describe("deferred tools on Claude (Messages): defer_loading + tool_reference, prefix untouched", () => {
  it("lists deferred names, loads one by reference, keeps the tools array byte-identical, reads the cache, gates the call", async () => {
    const ran: string[] = [];
    const log: string[] = [];
    const up = await startFakeMessagesServer((r: MsgRequest, n) => (n === 0 ? { blocks: [{ tool: TOOL_SEARCH, input: { query: "select:Lookup" } }] }
      : n === 1 ? { blocks: [{ tool: "Lookup", input: { q: "invoices" } }] } : { blocks: [{ text: "Found them." }] }));
    closers.push(up);
    const rt = await startProviderRuntime({ anthropicUpstream: up.url });
    closers.push({ close: rt.stop });
    setUsageSink({ record: () => {}, lastTotals: () => null, noteTotals: () => {} });
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-"));
    closers.push({ close: async () => fs.rmSync(hp, { recursive: true, force: true }) });
    let sid: string | null = null;
    const brain = new ProviderBrain({ botId: "b", wiring: wiring(botTools(ran), log), store: new ProviderSessionStore(hp), getSessionId: () => sid, systemPrompt: () => "SYS", upFrontTools: () => ["SendMessage", "Shell"], sleep: async () => {} });
    const res = await brain.runTurn(input("find the invoices", "claude-sonnet-5-5"), (e) => { if (e.kind === "session") sid = e.sessionId; });
    expect(res.finalText).toBe("Found them.");

    type T = { name: string; description: string; defer_loading?: boolean; cache_control?: unknown };
    const t0 = up.requests[0]!.body.tools as T[];
    expect(t0.map((t) => [t.name, t.defer_loading === true])).toEqual([["SendMessage", false], ["Shell", false], [TOOL_SEARCH, false], ["Lookup", true], ["Archive", true], ["Schedule", true], ["Invite", true]]);
    expect(t0.filter((t) => t.cache_control).map((t) => t.name)).toEqual([TOOL_SEARCH]); // the last tool in the prompt, never a deferred one
    expect(t0.find((t) => t.name === TOOL_SEARCH)!.description).toContain("Lookup, Archive, Schedule, Invite");
    // The prefix never moved: every request sent exactly the same tools.
    for (const r of up.requests) expect(JSON.stringify(r.body.tools)).toBe(JSON.stringify(t0));
    const msgs = up.requests[1]!.body.messages as { role: string; content: { type: string; content?: unknown }[] }[];
    const result = msgs.flatMap((m) => m.content).find((b) => b.type === "tool_result")!;
    expect(result.content).toEqual([{ type: "tool_reference", tool_name: "Lookup" }]);
    // The cache kept reading what the call before wrote (the load did not re-write the prefix).
    expect(up.usages[1]!.read).toBeGreaterThanOrEqual(up.usages[0]!.write);
    expect(up.usages[2]!.read).toBeGreaterThanOrEqual(up.usages[1]!.read);
    // ToolSearch and the loaded tool both went through the gate; the loaded tool ran.
    expect(log).toEqual(["pre:ToolSearch", "pre:mcp__bot__Lookup"]);
    expect(ran).toEqual(["Lookup:invoices"]);
  });

  it("without a profile (a coding agent, a child) or below the threshold, every tool loads up front and there is no ToolSearch", async () => {
    const up = await startFakeMessagesServer(() => ({ blocks: [{ text: "ok" }] }));
    closers.push(up);
    const rt = await startProviderRuntime({ anthropicUpstream: up.url });
    closers.push({ close: rt.stop });
    setUsageSink({ record: () => {}, lastTotals: () => null, noteTotals: () => {} });
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-"));
    closers.push({ close: async () => fs.rmSync(hp, { recursive: true, force: true }) });
    const small = [tool("SendMessage", "Reply.", []), tool("Shell", "Run.", []), tool("Tiny", "A small tool.", [])];
    for (const [tools, upFront] of [[botTools([]), undefined], [small, ["SendMessage", "Shell"]]] as const) {
      let sid: string | null = null;
      const b = new ProviderBrain({ botId: "b", wiring: wiring([...tools], []), store: new ProviderSessionStore(hp), getSessionId: () => sid, systemPrompt: () => "SYS", ...(upFront ? { upFrontTools: () => upFront } : {}), sleep: async () => {} });
      await b.runTurn(input("hi", "claude-sonnet-5-5"), (e) => { if (e.kind === "session") sid = e.sessionId; });
      const names = (up.requests.at(-1)!.body.tools as { name: string; defer_loading?: boolean }[]);
      expect(names.map((t) => t.name)).toEqual(tools.map((t) => t.name));
      expect(names.some((t) => t.defer_loading)).toBe(false);
    }
    expect(JSON.stringify(small.map((t) => ({ n: t.name, d: t.description }))).length).toBeLessThan(MIN_DEFERRED_CHARS);
  });
});

describe("deferred tools on a Chat Completions provider: loaded tools appended, remembered from the conversation", () => {
  it("sends only the up-front tools, appends the loaded one after them from the next call, and keeps it after a restart", async () => {
    const ran: string[] = [];
    let n = 0;
    const up = await startFakeChatServer((r: FakeRequest) => {
      const k = n++;
      if (k === 0) return { sse: [...toolChunks([{ id: "c1", name: TOOL_SEARCH, args: { query: "tracker" } }]), finish("tool_calls"), usageChunk(100, 5)] };
      if (k === 1) return { sse: [...toolChunks([{ id: "c2", name: "Lookup", args: { q: "x" } }]), finish("tool_calls"), usageChunk(100, 5)] };
      void r;
      return reply({ text: "done", usage: [100, 5] });
    });
    closers.push(up);
    const rt = await startProviderRuntime({ upstream: up.url });
    closers.push({ close: rt.stop });
    setUsageSink({ record: () => {}, lastTotals: () => null, noteTotals: () => {} });
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "ts-"));
    closers.push({ close: async () => fs.rmSync(hp, { recursive: true, force: true }) });
    const store = new ProviderSessionStore(hp);
    let sid: string | null = null;
    const mk = () => new ProviderBrain({ botId: "b", wiring: wiring(botTools(ran), []), store, getSessionId: () => sid, systemPrompt: () => "SYS", upFrontTools: () => ["SendMessage", "Shell"], sleep: async () => {} });
    await mk().runTurn(input("find records", "openai:gpt-6.1-sol"), (e) => { if (e.kind === "session") sid = e.sessionId; });
    const names = (i: number) => ((up.requests[i]!.body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names(0)).toEqual(["SendMessage", "Shell", TOOL_SEARCH]);
    expect(names(1)).toEqual(["SendMessage", "Shell", TOOL_SEARCH, "Lookup"]);
    expect(JSON.stringify(up.requests[1]!.body.tools).startsWith(JSON.stringify(up.requests[0]!.body.tools).slice(0, -1))).toBe(true);
    expect(ran).toEqual(["Lookup:x"]);
    // A new brain (a restart) reads the loaded set back from the stored conversation.
    await mk().runTurn(input("again", "openai:gpt-6.1-sol"), () => {});
    expect(names(up.requests.length - 1)).toEqual(["SendMessage", "Shell", TOOL_SEARCH, "Lookup"]);
  });
});
