import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STRC } from "@synapse/shared";
import { PendingWakes } from "../../background/pending-wakes";
import type { Completion } from "../../background/revivals";
import { SubagentService, type ChildSpec } from "../../background/subagents";
import { createSubagentTools } from "../../background/subagent-tools";
import { FakeBrain, type FakeScript } from "../../brain/fake-brain";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { BrainWiring } from "../../brain/types";
import { SseHub } from "../../gateway/sse-hub";
import { Supervisor } from "../../supervisor/supervisor";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";

const wiring = (): BrainWiring => ({
  preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}),
  stop: async () => ({ block: false }), botTools: () => [], turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
  flags: () => DEFAULT_FLAGS,
});

function setup(script: FakeScript = () => [{ text: "Found 2 fares; Northwind $264 is refundable." }], caps = { maxLive: 20, maxRunning: 20 }, rehearsals?: { start(b: string, c: string): void; end(c: string): void }) {
  const sup = new Supervisor({ caps: { ...caps, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 }, brainFactory: () => { throw new Error("no bots here"); } });
  const done: Completion[] = [];
  const specs: ChildSpec[] = [];
  const inputs: string[] = [];
  const childSessions: string[] = [];
  let t = 1_000_000;
  let turn = 10;
  const pending = new PendingWakes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sa-")), "pw.json"));
  const svc = new SubagentService({
    supervisor: sup,
    makeBrain: (spec, hooks) => {
      specs.push(spec);
      return new FakeBrain(`child:${spec.id}`, wiring(), (input, ctx) => { inputs.push(input.prompt.map((p) => ("text" in p ? p.text : "")).join("")); hooks.setSessionId("sess-1"); hooks.onAction("browser_navigate: https://x"); return script(input, ctx); });
    },
    revivals: { complete: (c) => done.push(c) }, pending,
    hub: new SseHub(), bots: { summary: () => ({ profile: { model: "claude-opus-5" } }) as never, nextTurnNo: () => ++turn, userMessageEpoch: () => 1 },
    transcriptPath: (s) => `/home/box/.claude/projects/-workspace/${s}.jsonl`, now: () => t,
    onChildSession: (b, sid) => childSessions.push(`${b}:${sid}`),
    rehearsals, onWork: (b) => worked.push(b),
  });
  const tools = createSubagentTools({ botId: "bot-a", subagents: svc });
  const tool = (n: string) => tools.find((x) => x.name === n)!;
  return { svc, tool, done, specs, inputs, pending, childSessions, advance: (ms: number) => { t += ms; } };
}
const flush = () => new Promise((r) => setTimeout(r, 30));
/** Bug 195 S2: every child start is reported (a pending GitHub sign-in is cancelled by it). */
const worked: string[] = [];

describe("Task (TOOL-13)", () => {
  it("reports the Bot as working when a child starts (bug 195 S2)", async () => {
    const { tool } = setup();
    worked.length = 0;
    await tool("Task").handler({ description: "fares", prompt: "find fares", subagent_type: "generalPurpose" });
    expect(worked).toEqual(["bot-a"]);
  });

  it("returns at once, runs the child in the background on Sonnet 5 for browserUse, and revives the parent with the report", async () => {
    const s = setup();
    const r = await s.tool("Task").handler({ description: "Find a refundable Denver fare", prompt: "Search…", subagent_type: "browserUse" });
    const id = /(subagent-[0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(r.text).toBe(`Started browserUse subagent ${id} (“Find a refundable Denver fare”). Its result wakes you when it's done, so there's no need to wait for it.`);
    await flush();
    expect(s.specs[0]).toMatchObject({ type: "browserUse", model: "claude-sonnet-5", title: "Find a refundable Denver fare" });
    expect(s.done).toHaveLength(1);
    expect(s.done[0]!.block).toMatch(new RegExp(`^Task “Find a refundable Denver fare” \\(${id}, browserUse\\) — done after \\d+s\\.\\nReport:\\nFound 2 fares; Northwind \\$264 is refundable\\.\\nTranscript: /home/box/\\.claude/projects/-workspace/sess-1\\.jsonl$`));
  });

  it("generalPurpose children use the Bot's model", async () => {
    const s = setup();
    await s.tool("Task").handler({ description: "Summarize", prompt: "…" });
    await flush();
    expect(s.specs[0]).toMatchObject({ type: "generalPurpose", model: "claude-opus-5" });
  });

  it("allows one computer/browser child per Bot and four children per Bot", async () => {
    const s = setup(() => [{ wait: 200 }, { text: "ok" }]);
    await s.tool("Task").handler({ description: "A", prompt: "…", subagent_type: "computerUse" });
    expect(await s.tool("Task").handler({ description: "B", prompt: "…", subagent_type: "browserUse" })).toEqual({ text: STRC.computerUseBusy, isError: true });
    for (const d of ["C", "D", "E"]) await s.tool("Task").handler({ description: d, prompt: "…" });
    expect(await s.tool("Task").handler({ description: "F", prompt: "…" })).toEqual({ text: STRC.tooManyTasks, isError: true });
  });

  it("says queued when the supervisor has no free slot", async () => {
    const s = setup(() => [{ wait: 100 }, { text: "ok" }], { maxLive: 1, maxRunning: 1 });
    await s.tool("Task").handler({ description: "first", prompt: "…" });
    await flush();
    const r = await s.tool("Task").handler({ description: "second", prompt: "…" });
    expect(r.text).toMatch(/ \(queued: waiting for a free slot\)$/);
  });

  it("CheckSubagent shows status, tool calls, the last actions and the transcript path", async () => {
    const s = setup(() => [{ tool: "Read", input: { file_path: "/workspace/a" } }, { wait: 300 }, { text: "ok" }]);
    const r = await s.tool("Task").handler({ description: "Look", prompt: "…" });
    const id = /(subagent-[0-9a-f-]{36})/.exec(r.text)![1]!;
    await flush();
    s.advance(125_000);
    const c = s.tool("CheckSubagent").handler({ subagent_id: id });
    expect((await c).text).toMatch(new RegExp(`^${id} \\(generalPurpose\\) “Look” — running for 2m · 1 tool call\\nLast actions:\\n- browser_navigate: https://x\\nTranscript: /home/box/\\.claude/projects/-workspace/sess-1\\.jsonl$`));
  });

  it("MessageSubagent interrupts and resumes with the steering text; StopSubagent ends it with no revival", async () => {
    const s = setup(() => [{ wait: 150 }, { text: "ok" }]);
    const r = await s.tool("Task").handler({ description: "Long", prompt: "…" });
    const id = /(subagent-[0-9a-f-]{36})/.exec(r.text)![1]!;
    await flush();
    expect((await s.tool("MessageSubagent").handler({ subagent_id: id, message: "Only check Northwind" })).text).toBe(`Sent your steering message to ${id}.`);
    await new Promise((res) => setTimeout(res, 50));
    expect(s.inputs.at(-1)).toBe("[Update from the agent that started you] Only check Northwind\nTake this into account and carry on from where you are; don't start over.");
    expect((await s.tool("StopSubagent").handler({ subagent_id: id })).text).toBe(`Stopped ${id}. It won't report back.`);
    await new Promise((res) => setTimeout(res, 250));
    expect(s.done).toEqual([]);
  });

  it("StopSubagent on a child that is still queued (no free Supervisor slot) sends no revival and clears its pending wake", async () => {
    const s = setup(() => [{ wait: 150 }, { text: "ok" }], { maxLive: 1, maxRunning: 1 });
    const r1 = await s.tool("Task").handler({ description: "first", prompt: "…" });
    const id1 = /(subagent-[0-9a-f-]{36})/.exec(r1.text)![1]!;
    await flush();
    const r2 = await s.tool("Task").handler({ description: "second", prompt: "…" });
    const id2 = /(subagent-[0-9a-f-]{36})/.exec(r2.text)![1]!;
    expect(r2.text).toMatch(/ \(queued: waiting for a free slot\)$/);
    expect(s.pending.has(id2)).toBe(true);
    expect((await s.tool("StopSubagent").handler({ subagent_id: id2 })).text).toBe(`Stopped ${id2}. It won't report back.`);
    // let the first child finish, which frees the Supervisor slot the second child's run() loop is still awaiting.
    await new Promise((res) => setTimeout(res, 250));
    await flush();
    expect(s.done.map((d) => d.taskId)).toEqual([id1]);
    expect(s.pending.has(id2)).toBe(false);
  });

  it("steers at 90 % of the 2 h wall-clock and stops at the limit with a 'timed out' revival (ORIG-15)", async () => {
    const s = setup(() => [{ wait: 5000 }, { text: "partial" }]);
    const r = await s.tool("Task").handler({ description: "Crawl", prompt: "…" });
    const id = /(subagent-[0-9a-f-]{36})/.exec(r.text)![1]!;
    await flush();
    s.advance(0.9 * 2 * 3_600_000 + 1);
    await s.svc.tick();
    await flush();
    expect(s.inputs.at(-1)).toMatch(/^\[Update from the agent that started you\] You're almost out of time\./);
    s.advance(0.1 * 2 * 3_600_000);
    await s.svc.tick();
    await flush();
    expect(s.done[0]!.block).toMatch(new RegExp(`\\(${id}, generalPurpose\\) — timed out after`));
  });
});

describe("child sessions and deletion (security fix I6)", () => {
  it("reports each child session to the parent, and a forgotten Bot can't start another child", async () => {
    const s = setup();
    await s.tool("Task").handler({ description: "One", prompt: "…" });
    await flush();
    expect(s.childSessions).toEqual(["bot-a:sess-1"]);
    await s.svc.forgetBot("bot-a");
    expect(await s.tool("Task").handler({ description: "Two", prompt: "…" })).toEqual({ text: "This Bot was deleted.", isError: true });
  });
});

describe("child activity reaches the parent's transcript (T29 box finding, CHAT-22 'Browsed N pages')", () => {
  it("each child tool call is a visible tool-call entry in the parent's transcript with its metric", async () => {
    const entries = new Map<string, any>();
    const nav = (url: string) => ({ tool: "mcp__computer__browser_navigate", input: { url } });
    const s = setup(() => [nav("https://a.example/x"), nav("https://b.example/"), nav("https://a.example/x#top"), { text: "done" }]);
    (s.svc as unknown as { d: { activity: unknown } }).d.activity = {
      append: (botId: string, e: any) => entries.set(e.id, { botId, ...e }),
      update: (botId: string, e: any) => entries.set(e.id, { botId, ...e }),
    };
    await s.tool("Task").handler({ description: "Find fares", prompt: "…", subagent_type: "browserUse" });
    await flush();
    const rows = [...entries.values()];
    expect(rows).toHaveLength(3);
    expect(rows.every((e) => e.botId === "bot-a" && e.kind === "tool-call" && e.hidden === false && e.status !== "running")).toBe(true);
    expect(new Set(rows.map((e) => e.segmentId)).size).toBe(1);
    expect(rows[0].metric).toMatchObject({ verb: "Browsed", noun: "page", nounPlural: "pages", count: 1, itemIds: ["https://a.example/x"] });
    expect(rows[2].metric.itemIds).toEqual(["https://a.example/x"]);
    expect(new Set(rows.map((e) => e.id)).size).toBe(3);
  });
});

describe("I3: Task rehearsal children", () => {
  it("a Task with rehearsal:true is registered for the child's whole run and ended after", async () => {
    const log: string[] = [];
    const s = setup(undefined, undefined, { start: (b, c) => log.push(`start ${b} ${c}`), end: (c) => log.push(`end ${c}`) });
    const task = s.tool("Task");
    expect(Object.keys(task.schema)).toContain("rehearsal");
    const r = await task.handler({ description: "Rehearse the expense skill", prompt: "Follow the skill; write rehearsal.json", subagent_type: "computerUse", rehearsal: true });
    const id = /(subagent-[0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(log[0]).toBe(`start bot-a ${id}`);
    await flush();
    expect(log).toEqual([`start bot-a ${id}`, `end ${id}`]);
    await s.tool("Task").handler({ description: "Ordinary", prompt: "x" });
    await flush();
    expect(log).toHaveLength(2); // no rehearsal flag → not registered
  });
});

describe("final box verification: a child inherits the review origin of the turn that launched it", () => {
  function launchWith(parent: Partial<TurnSlot> | null) {
    const sup = new Supervisor({ caps: { maxLive: 20, maxRunning: 20, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 }, brainFactory: () => { throw new Error("no bots here"); } });
    const slots: TurnSlot[] = [];
    const parentSlot = parent ? { ...newSlot({ botId: "bot-a", requestId: "req_p", turnNo: 4, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 }), ...parent } : null;
    const svc = new SubagentService({
      supervisor: sup,
      makeBrain: (spec, hooks) => new FakeBrain(`child:${spec.id}`, wiring(), () => { slots.push(hooks.slot()); return [{ text: "ok" }]; }),
      revivals: { complete: () => {} }, pending: new PendingWakes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sa-o-")), "pw.json")),
      hub: new SseHub(), bots: { summary: () => ({ profile: { model: "claude-opus-5" } }) as never, nextTurnNo: () => 11, userMessageEpoch: () => 1 },
      transcriptPath: () => null, parentSlot: () => parentSlot,
    });
    return { svc, slots };
  }

  it("from the user's turn: reviewSource user", async () => {
    const s = launchWith({ source: "user" });
    await s.svc.launch("bot-a", { description: "Heading", prompt: "open example.com", subagent_type: "browserUse" });
    await flush();
    expect(s.slots[0]!.source).toBe("subagent-done");
    expect(s.slots[0]!.reviewSource).toBe("user");
  });

  it("from a routine run: reviewSource routine, with the routine's wake context and text", async () => {
    const context = { chainId: null, wake: { kind: "routine" as const, routineId: "sweep", routineName: "PR sweep" }, group: null, routineRun: { routineId: "sweep", runId: "r1", startedAt: 0 }, rehearsal: false, sideEffects: 0 };
    const s = launchWith({ source: "routine", context, wakeText: "[routine] PR sweep" });
    await s.svc.launch("bot-a", { description: "Sweep", prompt: "…" });
    await flush();
    expect(s.slots[0]!.reviewSource).toBe("routine");
    expect(s.slots[0]!.context.routineRun).toEqual(context.routineRun);
    expect(s.slots[0]!.wakeText).toBe("[routine] PR sweep");
  });

  it("no parent slot: no reviewSource (reviewed as a revival, as before)", async () => {
    const s = launchWith(null);
    await s.svc.launch("bot-a", { description: "X", prompt: "…" });
    await flush();
    expect(s.slots[0]!.reviewSource).toBeUndefined();
  });
});


describe("0.1.6: computer and browser helpers run on Claude, whatever the parent's model", () => {
  function launchOn(parentModel: string, claudeReady?: () => boolean) {
    const sup = new Supervisor({ caps: { maxLive: 20, maxRunning: 20, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 }, brainFactory: () => { throw new Error("no bots here"); } });
    const specs: ChildSpec[] = [];
    const svc = new SubagentService({
      supervisor: sup,
      makeBrain: (spec) => { specs.push(spec); return new FakeBrain(`child:${spec.id}`, wiring(), () => [{ text: "ok" }]); },
      revivals: { complete: () => {} }, pending: new PendingWakes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sa-c-")), "pw.json")),
      hub: new SseHub(), bots: { summary: () => ({ profile: { model: parentModel } }) as never, nextTurnNo: () => 11, userMessageEpoch: () => 1 },
      transcriptPath: () => null, ...(claudeReady ? { claudeReady } : {}),
    });
    return { svc, specs };
  }

  it("a provider Bot's computerUse and browserUse children are Claude children; its generalPurpose child keeps its own model", async () => {
    const got: [string, string][] = [];
    for (const t of ["computerUse", "browserUse", "generalPurpose"]) { // one service each: only one desktop child runs at a time
      const s = launchOn("openai:gpt-6.1-sol", () => true);
      await s.svc.launch("bot-a", { description: "x", prompt: "y", subagent_type: t });
      await flush();
      got.push(...s.specs.map((x): [string, string] => [x.type, x.model]));
    }
    expect(got).toEqual([["computerUse", "claude-sonnet-5"], ["browserUse", "claude-sonnet-5"], ["generalPurpose", "openai:gpt-6.1-sol"]]);
  });

  it("without an Anthropic key they're refused up front with a reason the Bot can pass on; generalPurpose still runs", async () => {
    const s = launchOn("gemini:gemini-3.8-flash", () => false);
    for (const t of ["computerUse", "browserUse"]) {
      expect(await s.svc.launch("bot-a", { description: "x", prompt: "y", subagent_type: t })).toEqual({ text: STRC.computerNeedsClaude, isError: true });
    }
    expect((await s.svc.launch("bot-a", { description: "x", prompt: "y", subagent_type: "generalPurpose" })).isError).toBeFalsy();
    await flush();
    expect(s.specs.map((x) => x.type)).toEqual(["generalPurpose"]);
    expect(STRC.computerNeedsClaude).toContain("Anthropic API key");
  });
});
