import { describe, expect, it } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import type { FakeScript } from "../../brain/fake-brain";
import { FloorManager } from "../../groups/floor";
import { routeSendPrompt } from "../../groups/orchestrator";
import { StubOneShot } from "../../helper-model/one-shot";
import { groupHarness, promptText, say, until } from "./harness";

// Bug 108: Bots added to any call (1:1 included). The call is a room: only the Bot with the floor
// runs a model turn; say a name to address a Bot; Bot-to-Bot follow-ups are capped at 2 per user turn.

const isMemberTurn = (p: string) => p.includes("[Group chat:");

function setup(scripts: Record<string, (p: string, n: number) => string>, floor?: FloorManager) {
  const seen: Record<string, number> = {};
  const h = groupHarness((_id, name) => ((input) => {
    const p = promptText(input);
    if (!isMemberTurn(p)) return [say("dm reply")];
    seen[name] = (seen[name] ?? 0) + 1;
    return [say(scripts[name]?.(p, seen[name]!) ?? "(pass)")];
  }) as FakeScript, floor ? { floor } : {});
  const send = routeSendPrompt(h.groups, h.orch, h.runner, h.calls);
  let nonce = 0;
  const speak = async (chatId: string, text: string) => {
    const room = h.calls.isMulti(chatId);
    const had = h.brains.get(chatId)?.inputs.length ?? 0;
    await send({ id: chatId, text, clientNonce: `c${++nonce}`, voice: { durationMs: 900, call: true } });
    await h.orch.whenIdle(chatId);
    // A 1:1 call turn is the Bot's own turn (the runner, not a room): wait for it to run and settle.
    if (!room) await until(() => (h.brains.get(chatId)?.inputs.length ?? 0) > had && h.runner.recipientState(chatId) === "idle");
  };
  const turns = (id: string) => (h.brains.get(id)?.inputs ?? []).map(promptText).filter(isMemberTurn);
  const posts = (chatId: string) => h.groupEntries(chatId).filter((e): e is SendMessageEntry => e.kind === "send-message");
  return { h, speak, turns, posts, seen };
}

describe("calls with added Bots (bug 108)", () => {
  it("a 1:1 call with an added Bot: unaddressed speech runs ONE model turn (the Bot the call started with); the others don't run", async () => {
    const { h, speak, turns, posts } = setup({ Nova: (_p, n) => `Pasta tonight, option ${n}.`, Ledger: () => "Budget is fine.", Scout: () => "Weather is clear." });
    const nova = h.mk("Nova"), ledger = h.mk("Ledger"), scout = h.mk("Scout");
    const v = h.calls.start(nova);
    h.calls.add(v.callId, ledger);
    h.calls.add(v.callId, scout);
    await speak(nova, "what should we cook tonight");
    expect(turns(nova)).toHaveLength(1);
    expect(turns(ledger)).toHaveLength(0);
    expect(turns(scout)).toHaveLength(0);
    // The line lands in the chat the call started in, labeled with the speaking Bot.
    expect(posts(nova).map((e) => [e.author?.name, e.message.type === "text" ? e.message.content : ""])).toEqual([["Nova", "Pasta tonight, option 1."]]);
  });

  it("say its name to address an added Bot: it answers with the call's context block, and never sees the 1:1 chat before the call", async () => {
    const { h, speak, turns, posts } = setup({ Nova: () => "Pasta.", Scout: () => "Clear skies all evening." });
    const nova = h.mk("Nova"), scout = h.mk("Scout");
    h.bots.appendEntry(nova, { kind: "message", id: "u-old", role: "user", content: "my private diary entry", clientNonce: "old", createdAt: Date.now() - 60_000 });
    const v = h.calls.start(nova);
    await speak(nova, "what should we cook tonight");
    h.calls.add(v.callId, scout);
    await speak(nova, "Scout, what's the weather tonight");
    // The first utterance was a plain 1:1 turn; the second named Scout, so Nova didn't run a room turn.
    expect(turns(nova)).toHaveLength(0);
    const [first] = turns(scout);
    expect(first).toMatch(/added to a voice call by the user/);
    expect(first).toMatch(/On the call: the user, Nova, and you/);
    expect(first).toMatch(/User: what should we cook tonight/);
    expect(first).toMatch(/Nova: dm reply/);
    expect(first).not.toMatch(/private diary/);
    expect(first).toMatch(/spoken aloud/); // a voice-call turn like any group-call Bot
    expect(posts(nova).at(-1)!.author).toEqual({ id: scout, name: "Scout" });
  });

  it("floor control with added Bots: named follow-ups only, at most 2 per user turn", async () => {
    const { h, speak, turns, posts } = setup({
      Nova: (_p, n) => `Ledger, can you check the budget for plan ${n}?`,
      Ledger: (_p, n) => `Nova, plan ${n} costs ${n * 12} dollars.`,
      Scout: () => "I have thoughts too.",
    });
    const nova = h.mk("Nova"), ledger = h.mk("Ledger"), scout = h.mk("Scout");
    const v = h.calls.start(nova);
    h.calls.add(v.callId, ledger);
    h.calls.add(v.callId, scout);
    await speak(nova, "plan a cheap dinner");
    // Nova answers; Ledger (named) follows up; Nova (named) follows up; the cap of 2 stops the rest.
    expect(posts(nova).map((e) => e.author?.name)).toEqual(["Nova", "Ledger", "Nova"]);
    expect(turns(scout)).toHaveLength(0);
    expect(turns(ledger)).toHaveLength(1);
  });

  it("a removed Bot leaves the room: it is not addressed any more and the call is 1:1 again", async () => {
    const { h, speak, turns } = setup({ Nova: () => "Sure.", Ledger: () => "Budget ok." });
    const nova = h.mk("Nova"), ledger = h.mk("Ledger");
    const v = h.calls.start(nova);
    h.calls.add(v.callId, ledger);
    h.calls.remove(v.callId, ledger);
    await speak(nova, "Ledger, are you there?");
    expect(turns(ledger)).toHaveLength(0);
    // Back to 1:1: the Bot's own turn (not a room turn).
    expect(turns(nova)).toHaveLength(0);
    expect(h.brains.get(nova)!.inputs.length).toBeGreaterThan(0);
  });

  it("cost per utterance (fake model): 1 Bot vs 6 Bots — one model turn either way, plus at most one cheap floor call", async () => {
    const floorModel = new StubOneShot({ "orig/group-floor.md": (input: unknown) => ({ scores: (input as { members: { id: string }[] }).members.map((m, i) => ({ id: m.id, relevance: i === 2 ? 0.9 : 0.1, why: "x" })) }) });
    const names = ["Nova", "Ledger", "Scout", "Planner", "Courier", "Atlas"];
    const { h, speak, turns } = setup(Object.fromEntries(names.map((n) => [n, () => `${n} here with a new idea.`])), new FloorManager({ model: floorModel }));
    const ids = names.map((n) => h.mk(n));
    const size = (id: string) => (h.brains.get(id)?.inputs ?? []).map(promptText).join("").length;

    // 1 Bot: a plain 1:1 call turn.
    h.calls.start(ids[0]!);
    await speak(ids[0]!, "what should we cook tonight");
    const one = { turns: h.brains.get(ids[0]!)!.inputs.length, floorCalls: floorModel.calls.length, promptChars: size(ids[0]!) };

    // 6 Bots on the same call.
    const v = h.calls.start(ids[0]!);
    for (const id of ids.slice(1)) h.calls.add(v.callId, id);
    const before = Object.fromEntries(ids.map((id) => [id, turns(id).length]));
    const charsBefore = ids.reduce((s, id) => s + size(id), 0);
    await speak(ids[0]!, "what should we cook tonight");
    const ran = ids.filter((id) => turns(id).length > before[id]!);
    const floorCalls = floorModel.calls.length - one.floorCalls;
    const floorChars = floorModel.calls.slice(one.floorCalls).map((c) => JSON.stringify(c.input).length).reduce((a, b) => a + b, 0);
    const six = { turns: ran.length, floorCalls, promptChars: ids.reduce((s, id) => s + size(id), 0) - charsBefore, floorChars };

    expect(one).toMatchObject({ turns: 1, floorCalls: 0 });
    expect(six.turns).toBe(1); // only the Bot with the floor runs a model turn
    expect(ran).toHaveLength(1);
    // Call-behaviour (decision D4, bug 249): who answers is decided in code on a call — no floor-manager call at all.
    expect(six.floorCalls).toBe(0);
    console.log(`[bug 108 cost] per utterance — 1 Bot: ${one.turns} model turn, ${one.floorCalls} floor calls, ~${Math.round(one.promptChars / 4)} prompt tokens; 6 Bots: ${six.turns} model turn, ${six.floorCalls} floor call (~${Math.round(six.floorChars / 4)} tokens in), ~${Math.round(six.promptChars / 4)} member-turn prompt tokens`);
  });
});

describe("call-behaviour (decision D4, bug 249): who answers an unnamed utterance on a 3-Bot call is decided in code", () => {
  it("no floor-manager model call; the Bot whose job matches the words answers (not just the one the call started with)", async () => {
    const floorModel = new StubOneShot({ "orig/group-floor.md": (input: unknown) => ({ scores: (input as { members: { id: string }[] }).members.map((m) => ({ id: m.id, relevance: 0.5, why: "x" })) }) });
    const { h, speak, turns } = setup({ Nova: () => "Your calendar is clear.", Ledger: () => "Invoices are paid.", Scout: () => "Flights are cheap." }, new FloorManager({ model: floorModel }));
    const nova = h.bots.create({ origin: "user", kickstart: false, name: "Nova", description: "Chief of Staff. Calendar, meetings and email." });
    const ledger = h.bots.create({ origin: "user", kickstart: false, name: "Ledger", description: "Finance. Budgets, invoices and expenses." });
    const scout = h.bots.create({ origin: "user", kickstart: false, name: "Scout", description: "Travel. Flights, hotels and trips." });
    const v = h.calls.start(nova);
    h.calls.add(v.callId, ledger);
    h.calls.add(v.callId, scout);
    await speak(nova, "how are the invoices looking this month");
    expect(floorModel.calls).toHaveLength(0);
    expect([turns(nova).length, turns(ledger).length, turns(scout).length]).toEqual([0, 1, 0]);
  });
});
