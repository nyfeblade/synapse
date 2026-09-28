import { describe, expect, it } from "vitest";
import type { UserMessageEntry } from "@synapse/shared";
import { composeHooks } from "../../runner/hooks";
import { collectUserTurn, renderBotPrompt } from "../../runner/prompt-collector";
import { makeRunnerHarness } from "./harness";

const msg = (id: string, content: string, extra: Partial<UserMessageEntry> = {}): UserMessageEntry => ({ kind: "message", id, role: "user", content, createdAt: 1, ...extra });
const texts = (ms: { text?: string }[]) => ms.map((m) => ("text" in m ? (m.text as string) : "[image]"));

describe("collectUserTurn (EVT-12 row 1 order)", () => {
  it("puts in-reply-to and skill blocks before the text, the attachment note after it, turn blocks next and the reminder last", () => {
    const out = collectUserTurn({
      messages: [{ entry: msg("t3u", "summarize it"), before: [{ text: '[In reply to t2s1: "the report"]' }, { text: "SKILL" }], after: [{ text: "<attached_files>…</attached_files>" }] }],
      profileUpdate: null,
      blocks: [{ text: "<system_reminder><recalled_memory>R</recalled_memory></system_reminder>" }],
    });
    const t = texts(out as { text?: string }[]);
    expect(t.slice(0, 5)).toEqual(['[In reply to t2s1: "the report"]', "SKILL", "[t3u] summarize it", "<attached_files>…</attached_files>", "<system_reminder><recalled_memory>R</recalled_memory></system_reminder>"]);
    expect(t.at(-1)).toMatch(/SendMessage/);
  });
});

describe("renderBotPrompt sections", () => {
  it("includes the memory and skills sections and the MEM-08 / FILE-04 lines", () => {
    const p = renderBotPrompt({
      profile: { name: "Piper", title: "", description: "", avatarShape: "pebble", avatarColor: "#3472d9", avatarKind: "shape" },
      timeZone: "UTC", teammates: [], workspace: "/workspace", sections: { memory: "# Memory\n- (learned 2026-09-01) X", skills: "# Skills\n- a" },
    });
    expect(p).toContain("- (learned 2026-09-01) X");
    expect(p).toContain("# Skills\n- a");
    expect(p).toMatch(/Treat memory as a hint, not the record/);
    expect(p).toMatch(/Facts, Assumptions, Completed, Waiting for approval, Unresolved/);
  });
});

describe("composeHooks", () => {
  it("concatenates decorations and blocks in order and returns the first non-null preToolUse", () => {
    const h = composeHooks([
      { decorateUserMessage: () => ({ before: [{ text: "a" }], after: [] }), turnBlocks: () => [{ text: "x" }], preToolUse: () => null },
      { decorateUserMessage: () => ({ before: [{ text: "b" }], after: [{ text: "c" }] }), turnBlocks: () => [{ text: "y" }], preToolUse: () => ({ decision: "deny", reason: "no" }) },
    ]);
    expect(h.decorateUserMessage!("b1", msg("t1u", "hi"))).toEqual({ before: [{ text: "a" }, { text: "b" }], after: [{ text: "c" }] });
    expect(h.turnBlocks!("b1", { source: "user", hidden: false, silenceAllowed: false, queryText: "" })).toEqual([{ text: "x" }, { text: "y" }]);
    expect(h.preToolUse!("b1", { toolName: "Skill", input: {}, toolUseId: "t" }, null)).toEqual({ decision: "deny", reason: "no" });
  });
});

describe("composeHooks isolation (Task 38 live)", () => {
  // A throwing prompt hook (recall hit a deleted Bot's facts) failed the whole user turn: the user's
  // message never reached the Bot and the ack redrive asked "what would you like help with?".
  it("a throwing hook is skipped; the other hooks' decorations, blocks and side effects still run", () => {
    const boom = () => { throw new Error("No such Bot"); };
    const seen: string[] = [];
    const h = composeHooks([
      { decorateUserMessage: boom, turnBlocks: boom, afterSettle: boom, onIdle: boom, onEvent: boom, promptSections: boom },
      { decorateUserMessage: () => ({ before: [{ text: "b" }], after: [] }), turnBlocks: () => [{ text: "y" }], afterSettle: () => seen.push("settle"), onIdle: () => seen.push("idle"), promptSections: () => ({ memory: "M", skills: "" }) },
    ]);
    expect(h.decorateUserMessage!("b1", msg("t1u", "hi"))).toEqual({ before: [{ text: "b" }], after: [] });
    expect(h.turnBlocks!("b1", { source: "user", hidden: false, silenceAllowed: false, queryText: "" })).toEqual([{ text: "y" }]);
    h.afterSettle!("b1", {} as never);
    h.onIdle!("b1");
    expect(seen).toEqual(["settle", "idle"]);
    expect(h.promptSections!("b1")).toEqual({ memory: "M", skills: "" });
  });
});

describe("TurnRunner seams", () => {
  it("runs the hooks, reports the settled turn and runs a queued maintenance job before the next turn", async () => {
    const settled: unknown[] = [];
    const h = await makeRunnerHarness({
      hooks: {
        decorateUserMessage: () => ({ before: [], after: [{ text: "NOTE" }] }),
        turnBlocks: (_b, t) => (t.source === "user" ? [{ text: "BLOCK" }] : []),
        afterSettle: (_b, t) => settled.push(t),
      },
      script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "done" } }],
    });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    let jobRan = false;
    expect(h.runner.runMaintenance(id, { id: "m1", run: async () => { jobRan = true; } })).toBe(true);
    await h.untilIdle(id);
    h.runner.sendPrompt(id, "hello", "n1");
    await h.untilIdle(id);
    expect(jobRan).toBe(true);
    const t = texts(h.brain(id).inputs.at(-1)!.prompt as { text?: string }[]);
    expect(t).toContain("NOTE");
    expect(t).toContain("BLOCK");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ source: "user", userTexts: ["hello"], sentTexts: ["done"], superseded: false });
    expect(h.bots.summary(id).lastBotMessageAt).toBeGreaterThan(0);
  });

  it("aborts a running maintenance job when a user message arrives (EVT-09)", async () => {
    const h = await makeRunnerHarness({ script: () => [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    let aborted = false;
    h.runner.runMaintenance(id, { id: "m1", run: (signal) => new Promise<void>((r) => signal.addEventListener("abort", () => { aborted = true; r(); })) });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.runner.maintenanceActive(id)).toBe(true);
    h.runner.sendPrompt(id, "hi", "n2");
    await h.untilIdle(id);
    expect(aborted).toBe(true);
  });

  it("re-renders the frozen prompt only when the compaction epoch changes (MEM-05)", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    let n = 0;
    const r = () => `v${++n}`;
    expect(h.bots.promptSnapshot(id, r)).toBe("v1");
    expect(h.bots.promptSnapshot(id, r)).toBe("v1");
    h.bots.bumpCompactionEpoch(id);
    expect(h.bots.promptSnapshot(id, r)).toBe("v2");
  });
});
