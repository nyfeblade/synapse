import { describe, expect, it } from "vitest";
import { createWidgetCommands } from "../../chat/widget-commands";
import { ASKED_TEXT, HostWidgets, createWidgetExtension, createWidgetHooks, validateCard, validateWidget } from "../../chat/widgets";
import { composeHooks } from "../../runner/hooks";
import { makeRunnerHarness } from "../runner/harness";

const widgetStep = { tool: "mcp__bot__SendMessage", input: { type: "widget", widget: { question: "Which flight?", options: [{ label: "7 AM", value: "am" }, { label: "6 PM", value: "pm", style: "primary" }] } } };

describe("validation (CHAT-16)", () => {
  it("accepts 1–6 options and rejects bad specs", () => {
    expect(validateWidget({ question: "Q", options: [{ label: "A" }] })).toEqual({ question: "Q", options: [{ label: "A", value: "A", style: "default" }], allowCustom: false, dismissOnMoveOn: false });
    expect(validateWidget({ question: "Q", options: [] })).toMatch(/1–6 options/);
    expect(validateWidget({ question: "", options: [{ label: "A" }] })).toMatch(/question/);
    expect(validateCard({ kind: "table", columns: ["a"], rows: [["1"], ["2", "3"]] })).toMatch(/row 2/);
    expect(validateCard({ kind: "chart" })).toMatch(/Unknown card kind/);
    expect(validateCard({ kind: "link", url: "javascript:alert(1)" })).toMatch(/https/);
  });

  // Bug 4 (hand-test after a long engineering build): the widget option format is undocumented (SendMessage's
  // schema takes `widget` as a bare free-form object, `z.looseObject({})`, with no per-turn budget room left
  // to spell the shape out there — prompt-budget.test.ts's tool-schema ceiling is ~3 chars from the current
  // total). The shape has to live somewhere a model actually sees it before it can get it right, so both
  // validation errors below now show the exact option shape and a tiny concrete example.
  it("a bad option count's error spells out the option shape and a tiny example", () => {
    const msg = validateWidget({ question: "Q", options: [] }) as string;
    expect(msg).toMatch(/\{\s*label:\s*string.*value\?:\s*string.*style\?:/s);
    expect(msg).toContain('widget: { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }');
  });
  it("a missing-label error spells out the option shape and a tiny example", () => {
    const msg = validateWidget({ question: "Q", options: [{}] }) as string;
    expect(msg).toMatch(/\{\s*label:\s*string.*value\?:\s*string.*style\?:/s);
    expect(msg).toContain('widget: { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }');
  });
});

describe("widgets end the turn and resume with the answer (OUT-06, CHAT-17)", () => {
  it("sets awaiting, blocks later sends in the turn, and a response wakes the Bot", async () => {
    const h = await makeRunnerHarness({
      toolExtensionsFactory: (bots) => createWidgetExtension({ bots, now: Date.now }),
      hooksFactory: (bots) => composeHooks([createWidgetHooks({ bots })]),
      script: (input) => (input.source === "user" ? [widgetStep, { tool: "mcp__bot__SendMessage", input: { content: "late" } }] : [{ tool: "mcp__bot__SendMessage", input: { content: "Booked." } }]),
    });
    const id = h.bots.create({ name: "Planner", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "book my flight", "n1");
    await h.untilIdle(id);
    const w = h.bots.getEntry(id, "t1s1");
    expect(w).toMatchObject({ status: "pending", message: { type: "widget" } });
    expect(h.bots.getEntry(id, "t1s2")).toBeNull(); // the later send was refused (awaiting)
    expect(h.bots.summary(id).awaiting).toMatchObject({ tabId: "widget", reason: "Which flight?" });
    const cmd = createWidgetCommands({ bots: h.bots, acks: h.acks, wake: (b, text) => h.runner.enqueueHidden(b, { source: "widget-answer", lane: "user", silenceAllowed: false, text, ackToken: h.acks.token(b) }) });
    expect(await cmd.respondToWidget!({ id, entryId: "t1s1", value: "pm" })).toEqual({ status: "answered" });
    expect(h.bots.getEntry(id, "t1s1")).toMatchObject({ status: "answered", respondedValue: "6 PM" });
    expect(h.bots.summary(id).awaiting).toBeNull();
    await h.untilIdle(id);
    const last = h.brain(id).inputs.at(-1)!;
    expect(last.source).toBe("widget-answer");
    expect(JSON.stringify(last.prompt)).toContain('answered your question t1s1 (\\"Which flight?\\"): 6 PM');
    await expect(cmd.respondToWidget!({ id, entryId: "t1s1", value: "am" })).rejects.toThrow("This question was already answered.");
  });

  it("marks unanswered widgets skipped and lists them on the next user turn", async () => {
    const h = await makeRunnerHarness({
      toolExtensionsFactory: (bots) => createWidgetExtension({ bots, now: Date.now }),
      hooksFactory: (bots) => composeHooks([createWidgetHooks({ bots })]),
      script: (input) => (input.prompt.some((p) => "text" in p && p.text.includes("book")) ? [widgetStep] : [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }]),
    });
    const id = h.bots.create({ name: "Planner", origin: "user", kickstart: false });
    h.runner.sendPrompt(id, "book my flight", "n1");
    await h.untilIdle(id);
    h.runner.sendPrompt(id, "never mind, what's the weather", "n2");
    await h.untilIdle(id);
    expect(h.bots.getEntry(id, "t1s1")).toMatchObject({ status: "skipped" });
    expect(JSON.stringify(h.brain(id).inputs.at(-1)!.prompt)).toContain('Unanswered questions');
    expect(ASKED_TEXT).toBe("Asked the user. Your turn ends now; you'll be resumed with the answer.");
  });
});

describe("host-posted widgets on the Phase 2 service (RTN-20, Task 6 folded in, controller ruling 1)", () => {
  const spec = { question: "Keep running routines?", hostKind: "spend-guard" as const, options: [{ label: "Keep", value: "keep" }, { label: "Pause all", value: "pause" }] };

  it("hostPost appends a pending widget and sets awaiting; the answer goes to the host, not a Bot wake", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Planner", origin: "user", kickstart: false });
    const host = new HostWidgets({ bots: h.bots, now: () => 5 });
    const got: string[] = [];
    const entryId = host.hostPost(id, spec, (v) => got.push(v));
    expect(h.bots.getEntry(id, entryId)).toMatchObject({ kind: "send-message", status: "pending", message: { type: "widget", widget: { hostKind: "spend-guard" } } });
    expect(h.bots.summary(id).awaiting).toMatchObject({ tabId: "widget", reason: "Keep running routines?" });
    const wakes: string[] = [];
    const cmd = createWidgetCommands({ bots: h.bots, acks: h.acks, host, wake: (_b, t) => wakes.push(t) });
    expect(await cmd.respondToWidget!({ id, entryId, value: "pause" })).toEqual({ status: "answered" });
    expect(got).toEqual(["pause"]);
    expect(wakes).toEqual([]);
    expect(h.bots.getEntry(id, entryId)).toMatchObject({ status: "answered", respondedValue: "Pause all" });
    expect(h.bots.summary(id).awaiting).toBeNull();
  });

  it("a registered host kind survives a restart (no one-off callback) and wins", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Planner", origin: "user", kickstart: false });
    const entryId = new HostWidgets({ bots: h.bots, now: () => 5 }).hostPost(id, spec, () => { throw new Error("lost at restart"); });
    const host = new HostWidgets({ bots: h.bots, now: () => 6 });
    const kinds: string[] = [];
    host.registerHostKind("spend-guard", (b, e, v) => kinds.push(`${b === id}:${e}:${v}`));
    const cmd = createWidgetCommands({ bots: h.bots, acks: h.acks, host, wake: () => { throw new Error("no wake"); } });
    await cmd.respondToWidget!({ id, entryId, value: "keep" });
    expect(kinds).toEqual([`true:${entryId}:keep`]);
  });

  it("a user turn never skips a host-posted widget (CHAT-17 applies to Bot widgets only)", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Planner", origin: "user", kickstart: false });
    const entryId = new HostWidgets({ bots: h.bots, now: () => 5 }).hostPost(id, spec, () => {});
    const blocks = createWidgetHooks({ bots: h.bots }).turnBlocks!(id, { source: "user", hidden: false, silenceAllowed: false, queryText: "hi" });
    expect(blocks).toEqual([]);
    expect(h.bots.getEntry(id, entryId)).toMatchObject({ status: "pending" });
  });
});
