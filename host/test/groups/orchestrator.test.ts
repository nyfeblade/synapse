import { describe, expect, it } from "vitest";
import { STR, type SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../approvals/approval-gate";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { FakeScript } from "../../brain/fake-brain";
import { FloorManager } from "../../groups/floor";
import { StubOneShot } from "../../helper-model/one-shot";
import { groupHarness, promptText, say, until } from "./harness";

const isGroupTurn = (t: string) => t.includes("[Group chat:");
const posts = (entries: ReturnType<ReturnType<typeof groupHarness>["groupEntries"]>) =>
  entries.filter((e): e is SendMessageEntry => e.kind === "send-message").map((e) => `${e.author?.name}: ${(e.message as { content: string }).content}`);

describe("GroupOrchestrator (GRP-03…06, GRP-13)", () => {
  it("runs member turns in each member's own session, posts with authors, and adds one pass row", async () => {
    const script = (name: string): FakeScript => (input, ctx) => {
      const t = promptText(input);
      if (!isGroupTurn(t)) return [say("dm")];
      if (name === "Planner") return ctx.turnIndex === 0 ? [say("Oct 17–18 and Oct 24–25 are open. I'd lean toward the 24th.")] : [say("(pass)")];
      if (name === "Scout") return ctx.turnIndex === 0 ? [say("Found 3 options near Hudson; cabin at $142 a night.")] : [say("(pass)")];
      return [say("(pass)")];
    };
    const h = groupHarness((_id, name) => script(name));
    const p = h.mk("Planner"), s = h.mk("Scout"), l = h.mk("Ledger");
    const { id: g } = h.groups.create([p, s, l], { origin: "user" });
    const { entryId } = h.orch.userPost(g, "@everyone plan a cheap weekend upstate", "n1");
    expect(entryId).toMatch(/^t\d+u$/);
    await h.orch.whenIdle(g);

    const entries = h.groupEntries(g);
    expect(posts(entries)).toEqual([
      "Planner: Oct 17–18 and Oct 24–25 are open. I'd lean toward the 24th.",
      "Scout: Found 3 options near Hudson; cabin at $142 a night.",
    ]);
    const passRows = entries.filter((e) => e.kind === "event" && e.event.type === "member-pass");
    expect(passRows).toHaveLength(1);
    expect(passRows[0]).toMatchObject({ event: { type: "member-pass", botIds: [l] } });
    expect(entries.at(-1)!.kind).toBe("event");

    // Each member ran in its own session with the group context; the pass row never reaches a prompt.
    const ledgerPrompts = h.brains.get(l)!.inputs.map(promptText);
    expect(ledgerPrompts).toHaveLength(2);
    expect(ledgerPrompts[1]).toContain("Scout: Found 3 options");
    for (const t of ledgerPrompts) expect(t).not.toMatch(/passed/);
    expect(h.bots.summary(g).statusLine).toBe("Scout: Found 3 options near Hudson; cabin at $142 a night.");
    expect(h.bots.tail(p, 50).some((e) => e.kind === "send-message")).toBe(false); // group posts don't land in the DM
  });

  it("drops acknowledgement-only posts as passes and ends a round where everyone passed (ORIG-09 §09.7)", async () => {
    const h = groupHarness((_id, name) => (input) => (isGroupTurn(promptText(input)) ? [say(name === "Scout" ? "Thanks, sounds good!" : "(pass)")] : []));
    const ids = ["Planner", "Scout", "Ledger"].map(h.mk);
    const { id: g } = h.groups.create(ids, { origin: "user" });
    h.orch.userPost(g, "any thoughts?", "n1");
    await h.orch.whenIdle(g);
    expect(posts(h.groupEntries(g))).toEqual([]);
    expect(h.groupEntries(g).find((e) => e.kind === "event" && e.event.type === "member-pass")).toMatchObject({ event: { botIds: ids } });
    expect(h.brains.get(ids[1]!)!.inputs).toHaveLength(1);
    expect(h.metrics.efficiency().messagesDropped).toBe(1);
  });

  it("routes a mention to one member only (GRP-03)", async () => {
    const h = groupHarness((_id, name) => (input, ctx) => (isGroupTurn(promptText(input)) ? [say(name === "Ledger" && ctx.turnIndex === 0 ? "Yes: cabin $284 plus train $108 is $392 all in." : "(pass)")] : []));
    const [p, s, l] = ["Planner", "Scout", "Ledger"].map(h.mk);
    const { id: g } = h.groups.create([p!, s!, l!], { origin: "user" });
    h.orch.userPost(g, "book the cabin. ledger, does that fit?", "n1");
    await h.orch.whenIdle(g);
    expect(posts(h.groupEntries(g))).toEqual(["Ledger: Yes: cabin $284 plus train $108 is $392 all in."]);
    expect(h.brains.get(p!)).toBeUndefined();
  });

  it("caps a member turn at 2 posts and refuses non-text posts (GRP-04, GRP-08)", async () => {
    const h = groupHarness((_id, name) => (input, ctx) =>
      isGroupTurn(promptText(input)) && name === "A" && ctx.turnIndex === 0
        ? [say("Option one: a cabin near Hudson at $142."), say("Option two: an inn in Kingston at $165."), say("Option three: a campsite at $40."),
           { tool: "mcp__bot__SendMessage", input: { type: "widget", widget: { question: "Which one?", options: [] } } }]
        : [say("(pass)")]);
    const [a, b] = ["A", "B"].map(h.mk);
    const { id: g } = h.groups.create([a!, b!], { origin: "user" });
    h.orch.userPost(g, "go", "n1");
    await h.orch.whenIdle(g);
    expect(posts(h.groupEntries(g))).toEqual(["A: Option one: a cabin near Hudson at $142.", "A: Option two: an inn in Kingston at $165."]);
  });

  it("a new user post cancels the running room turn and its pass rows", async () => {
    const runs: Record<string, number> = {};
    const h = groupHarness((_id, name) => (input) => {
      if (!isGroupTurn(promptText(input))) return [];
      const n = (runs[name] = (runs[name] ?? 0) + 1);
      if (name === "A" && n === 1) return [{ wait: 400 }, say("A stale answer to the first question.")];
      if ((name === "A" && n === 2) || (name === "B" && n === 1)) return [say(`${name} has a fresh answer to the second question.`)];
      return [say("(pass)")];
    });
    const [a, b] = ["A", "B"].map(h.mk);
    const { id: g } = h.groups.create([a!, b!], { origin: "user" });
    h.orch.userPost(g, "first question", "n1");
    await until(() => h.runner.recipientState(a!) === "group-member");
    h.orch.userPost(g, "actually, second question", "n2");
    await h.orch.whenIdle(g);
    const all = posts(h.groupEntries(g));
    expect(all).not.toContain("A: A stale answer to the first question.");
    expect(all).toEqual(["A: A has a fresh answer to the second question.", "B: B has a fresh answer to the second question."]);
    expect(h.groupEntries(g).filter((e) => e.kind === "event" && e.event.type === "member-pass")).toHaveLength(0); // round 2 ended silently with no one given a turn who never spoke
  });

  it("adding or removing members while a room turn runs cancels it (room epoch); the removed member's late post never lands (Task 50 fuzz)", async () => {
    const h = groupHarness((_id, name) => (input) => {
      if (!isGroupTurn(promptText(input))) return [];
      if (name === "A") return [{ wait: 400 }, say("A stale answer after being removed.")];
      return [say(`${name} answers.`)];
    });
    const [a, b, c] = ["A", "B", "C"].map(h.mk);
    const { id: g } = h.groups.create([a!, b!, c!], { origin: "user" });
    h.orch.userPost(g, "first question", "n1");
    await until(() => h.runner.recipientState(a!) === "group-member");
    const before = h.orch.epoch(g);
    h.groups.setMembers(g, [b!, c!]);
    expect(h.orch.epoch(g)).toBe(before + 1);
    await h.orch.whenIdle(g);
    await until(() => h.runner.recipientState(a!) === "idle");
    expect(posts(h.groupEntries(g))).not.toContain("A: A stale answer after being removed.");
    expect(h.groupEntries(g).filter((e) => e.kind === "event" && e.event.type === "member-pass")).toHaveLength(0);
    h.groups.setMembers(g, [a!, b!, c!]);
    expect(h.orch.epoch(g)).toBe(before + 2);
  });

  it("redrives a member turn preempted by a DM with a note (EVT-13)", async () => {
    let groupRuns = 0;
    const h = groupHarness((_id, name) => (input) => {
      const t = promptText(input);
      if (!isGroupTurn(t)) return [say("dm answer")];
      if (name !== "A") return [say("(pass)")];
      groupRuns += 1;
      if (groupRuns === 1) return [{ wait: 400 }, say("This answer is never sent.")];
      return groupRuns === 2 ? [say("After the redrive: take the 7:15 train to save $44.")] : [say("(pass)")];
    });
    const [a, b] = ["A", "B"].map(h.mk);
    const { id: g } = h.groups.create([a!, b!], { origin: "user" });
    h.orch.userPost(g, "question", "n1");
    await until(() => h.runner.recipientState(a!) === "group-member");
    h.runner.sendPrompt(a!, "quick DM", "dm1");
    await h.orch.whenIdle(g);
    const aPrompts = h.brains.get(a!)!.inputs.map(promptText).filter(isGroupTurn);
    expect(aPrompts.length).toBeGreaterThanOrEqual(2);
    expect(aPrompts[0]).not.toContain("interrupted by a direct message");
    expect(aPrompts[1]).toContain("interrupted by a direct message");
    expect(posts(h.groupEntries(g))).toEqual(["A: After the redrive: take the 7:15 train to save $44."]);
    expect(h.bots.tail(a!, 50).some((e) => e.kind === "send-message" && e.message.type === "text" && e.message.content === "dm answer")).toBe(true);
  });

  it("never raises an approval card in a member turn (GRP-07)", async () => {
    const ran: string[] = [];
    const reviewer: ReviewerLike = {
      review: async () => ({ kind: "block", stage: "S6" as never, reason: "Deletes files.", proposedRule: null, verdict: null }),
      clearCache: () => {},
    };
    const h = groupHarness(
      (_id, name) => (input) => (isGroupTurn(promptText(input)) && name === "A" ? [{ tool: "Bash", input: { command: "rm -rf /etc/x" } }, say("(pass)")] : [say("(pass)")]),
      {
        toolRunner: async (_id, name) => { ran.push(name); return "ok"; },
        gate: ({ cfg, bots, settings, runner }) =>
          new ApprovalGate({ cfg, bots, settings, reviewer, slot: (id) => runner.slot(id), flags: () => DEFAULT_FLAGS, onDeferredResolution: () => {} }),
      },
    );
    const [a, b] = ["A", "B"].map(h.mk);
    const { id: g } = h.groups.create([a!, b!], { origin: "user" });
    h.orch.userPost(g, "clean up", "n1");
    await h.orch.whenIdle(g);
    expect(ran).toEqual([]);
    const aDm = h.bots.tail(a!, 50);
    expect(aDm.some((e) => e.kind === "send-message" && e.message.type === "auto-review-approval")).toBe(false);
    const step = aDm.find((e) => e.kind === "tool-call" && e.name === "Bash");
    expect(step).toMatchObject({ status: "error" });
    expect(h.bots.summary(a!).awaiting).toBeNull();
    expect(STR.groupApprovalUnavailable).toContain("this conversation can't ask for one");
  });

  it("with Smart group turns on, only the floor manager's picks speak; unpicked members get no pass row (ORIG-10)", async () => {
    const floorModel = new StubOneShot({
      "orig/group-floor.md": (input) => {
        const i = input as { members: { id: string; name: string }[] };
        return { scores: i.members.map((m) => ({ id: m.id, relevance: m.name === "Scout" ? 0.9 : 0.1, why: "fit" })) };
      },
    });
    const h = groupHarness((_id, name) => (input, ctx) => (isGroupTurn(promptText(input)) && name === "Scout" && ctx.turnIndex === 0 ? [say("Found 3 cabins near Hudson, the best at $142 a night.")] : [say("(pass)")]), { floor: new FloorManager({ model: floorModel }) });
    const [p, s, l] = ["Planner", "Scout", "Ledger"].map(h.mk);
    const { id: g } = h.groups.create([p!, s!, l!], { origin: "user" });
    h.orch.userPost(g, "find us a cabin upstate", "n1");
    await h.orch.whenIdle(g);
    expect(posts(h.groupEntries(g))).toEqual(["Scout: Found 3 cabins near Hudson, the best at $142 a night."]);
    expect(h.brains.get(p!)).toBeUndefined();
    expect(h.brains.get(l!)).toBeUndefined();
    expect(h.groupEntries(g).some((e) => e.kind === "event" && e.event.type === "member-pass")).toBe(false);
  });

  it("does not crash the process when the background room turn throws (userPost's fire-and-forget startRoomTurn)", async () => {
    const h = groupHarness((_id, name) => (input) => (isGroupTurn(promptText(input)) ? [say("(pass)")] : []));
    const [a, b] = ["A", "B"].map(h.mk);
    const { id: g } = h.groups.create([a!, b!], { origin: "user" });
    const originalAppend = h.bots.appendEntry.bind(h.bots);
    let threw = false;
    h.bots.appendEntry = ((id: string, entry: Parameters<typeof originalAppend>[1]) => {
      if (!threw && entry.kind === "event" && entry.event.type === "member-pass") {
        threw = true;
        throw new Error("boom-io: atomic write failed");
      }
      return originalAppend(id, entry);
    }) as typeof originalAppend;
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      // As real (non-test) callers do: fire-and-forget, never awaiting whenIdle().
      h.orch.userPost(g, "hi", "n1");
      await until(() => threw);
      await new Promise((r) => setTimeout(r, 30)); // let Node's unhandledRejection check run
    } finally {
      process.off("unhandledRejection", onRejection);
      h.bots.appendEntry = originalAppend;
    }
    expect(rejections).toEqual([]);
  });

  it("does not crash the process when cancelRunning's fire-and-forget interruptActive rejects", async () => {
    const h = groupHarness((_id, name) => (input) => {
      if (!isGroupTurn(promptText(input))) return [];
      return name === "A" ? [{ wait: 400 }, say("slow")] : [say("(pass)")];
    });
    const [a, b] = ["A", "B"].map(h.mk);
    const { id: g } = h.groups.create([a!, b!], { origin: "user" });
    h.orch.userPost(g, "first", "n1");
    await until(() => h.runner.recipientState(a!) === "group-member");
    const originalInterrupt = h.runner.interruptActive.bind(h.runner);
    let threw = false;
    h.runner.interruptActive = (async (botId: string, reason: string) => {
      threw = true;
      throw new Error("boom-interrupt: brain unreachable");
    }) as typeof originalInterrupt;
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      // Second post cancels the running turn, which fires-and-forgets interruptActive for member A.
      h.orch.userPost(g, "second", "n2");
      await until(() => threw);
      await new Promise((r) => setTimeout(r, 30)); // let Node's unhandledRejection check run
    } finally {
      process.off("unhandledRejection", onRejection);
      h.runner.interruptActive = originalInterrupt;
      await h.orch.whenIdle(g); // drain so the harness doesn't leak a background turn into the next test
    }
    expect(rejections).toEqual([]);
  });

  it("posts a routine seed and runs members on the background lane (GRP-11)", async () => {
    const lanes: string[] = [];
    const h = groupHarness((_id, name) => (input) => {
      if (!isGroupTurn(promptText(input))) return [];
      lanes.push(input.lane);
      return [say(name === "A" ? "Morning summary: 3 meetings." : "(pass)")];
    });
    const [a, b] = ["A", "B"].map(h.mk);
    const { id: g } = h.groups.create([a!, b!], { origin: "user" });
    const out = await h.orch.seedRoutine(g, "Morning sync", "Summarize today's calendar.");
    expect(out.spokeIds).toEqual([a]);
    expect(h.groupEntries(g).find((e) => e.kind === "notice")).toMatchObject({ text: "Triggered by: Morning sync\nSummarize today's calendar." });
    expect(new Set(lanes)).toEqual(new Set(["background"]));
    expect(h.orch.roomHistory(g)[0]).toMatchObject({ from: "system", fromName: "Routine" });
  });
});
