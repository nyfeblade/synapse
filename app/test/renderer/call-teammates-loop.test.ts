import { describe, expect, it } from "vitest";
import { CALL_FEEL } from "@synapse/shared";
import { VoiceLoop, type PhraseKind } from "../../src/renderer/voice/voice-loop";

// Bug 134: calls feel like calling teammates — the voice loop's side. Fillers (no dead air), polite
// interruptions both ways, "that'll take a minute", raised hands and hand-offs by name, voice
// commands that are never sent as a turn, and pick-up greetings. No per-utterance model call anywhere.

type Member = { id: string; name: string };
function harness(o: { members?: Member[]; working?: (id: string) => boolean; intercept?: (t: string) => boolean } = {}) {
  const log: string[] = [];
  const pending: { text: string; botId?: string; phrase?: PhraseKind; done: () => void }[] = [];
  const hands: string[][] = [];
  const interrupted: string[] = [];
  const h = { now: 0, log, pending, hands, interrupted, loop: null as unknown as VoiceLoop };
  const members = o.members ?? [{ id: "nova", name: "Nova" }];
  h.loop = new VoiceLoop({
    start: () => log.push("start"), stop: () => log.push("stop"),
    send: (t) => { log.push(`send:${t}`); },
    speak: (t, s) => {
      log.push(`speak:${s?.botId ?? ""}:${s?.phrase ? `(${s.phrase}) ` : ""}${t}`);
      return new Promise<void>((r) => pending.push({ text: t, botId: s?.botId, phrase: s?.phrase, done: r }));
    },
    cancelSpeech: () => log.push("cancel"),
    now: () => h.now, silenceMs: 700, helperEndpoints: true,
    phrase: (kind, botId) => `${kind} line from ${botId}`,
    members: () => members,
    working: o.working,
    intercept: o.intercept,
    onHands: (x) => hands.push(x.map((y) => y.botId)),
    onInterrupted: (who) => interrupted.push(who),
  });
  return h;
}
type H = ReturnType<typeof harness>;
const spoken = (h: H) => h.log.filter((l) => l.startsWith("speak:"));
const sent = (h: H) => h.log.filter((l) => l.startsWith("send:"));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const finishOne = async (h: H) => { h.pending.shift()!.done(); await flush(); };
const finishAll = async (h: H) => { while (h.pending.length) await finishOne(h); };
const tickFor = (h: H, ms: number) => { for (let t = 0; t < ms; t += 100) { h.now += 100; h.loop.tick(); } };

describe("no dead air: a filler when the first sentence is slow (item 2)", () => {
  it("nothing to say 1.5 s after the end of the turn → one filler in the Bot's voice, then the real reply plays after it", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what's on my calendar tomorrow");
    tickFor(h, CALL_FEEL.fillerAfterMs - 100);
    expect(spoken(h)).toEqual([]);
    tickFor(h, 200);
    expect(spoken(h)).toEqual(["speak:nova:(filler) filler line from nova"]);
    expect(h.loop.state).toBe("speaking");
    // The first sentence arrives while the filler plays: it waits behind it (never over it).
    h.loop.onBotStream("nova", "You have two meetings. ");
    expect(spoken(h)).toHaveLength(2);
    expect(h.pending.map((p) => p.phrase ?? "reply")).toEqual(["filler", "reply"]);
    await finishAll(h);
    tickFor(h, 5_000);
    expect(spoken(h).filter((l) => l.includes("(filler)"))).toHaveLength(1); // once a turn
  });

  it("the filler ends and the reply isn't there yet: back to 'thinking', not a dead 'listening'", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("check the build");
    tickFor(h, 1_600);
    await finishAll(h);
    expect(h.loop.state).toBe("thinking");
  });

  it("no filler when the first sentence is ready in time, or while any real speech is still playing", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("hi");
    h.loop.onBotStream("nova", "Hey! ");
    tickFor(h, 3_000);
    expect(spoken(h)).toEqual(["speak:nova:Hey!"]);
    // A user turn that ends while the Bot is still talking (the helper's bot-spoke end of turn).
    h.loop.onBotStream("nova", "Hey! Here is a long second sentence still playing. ");
    h.loop.onFinal("and also this");
    tickFor(h, 3_000);
    expect(spoken(h).some((l) => l.includes("(filler)"))).toBe(false);
  });

  it("bug 186: a streamed reply with no complete sentence yet is already on its way: no filler in front of it", () => {
    // Was: "the filler still plays". Measured on the user's calls, 16 of 29 fillers started after the answer's
    // text had arrived and held the answer back a median 2.0 s (test-reports/voice-call-feel).
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("summarise the doc");
    h.loop.onBotStream("nova", "So the document mostly talks about");
    tickFor(h, 1_600);
    expect(spoken(h)).toEqual([]);
  });
});

describe("polite interruptions both ways (item 3)", () => {
  async function talking(h: H) {
    h.loop.begin();
    h.loop.onFinal("tell me about the launch");
    h.loop.onBotStream("nova", "The launch is on Friday. We still need the press kit. ");
    expect(h.loop.state).toBe("speaking");
    h.loop.onPartial("wait");
    expect(h.log).toContain("cancel");
  }

  it("the user barges in with a short hold ('wait'): the Bot stops, says a pre-rendered 'sorry, go ahead', and the hold is not sent as a turn", async () => {
    const h = harness();
    await talking(h);
    h.loop.onFinal("wait");
    expect(spoken(h).at(-1)).toBe("speak:nova:(sorry) sorry line from nova");
    expect(sent(h)).toEqual(["send:tell me about the launch"]);
    await finishAll(h);
    expect(h.loop.state).toBe("listening");
  });

  it("a question after a barge-in: the sorry line, and the question goes to the Bot", async () => {
    const h = harness();
    await talking(h);
    h.loop.onFinal("is that this Friday?");
    expect(spoken(h).at(-1)).toBe("speak:nova:(sorry) sorry line from nova");
    expect(sent(h).at(-1)).toBe("send:is that this Friday?");
  });

  it("not every time: at most one sorry per 90 s, and never for a long statement or without a barge-in", async () => {
    const h = harness();
    await talking(h);
    h.loop.onFinal("wait");
    await finishAll(h);
    h.loop.onFinal("tell me more");
    h.loop.onBotStream("nova", "Sure, the press kit is half done. ");
    h.loop.onPartial("hold on");
    h.loop.onFinal("hold on");
    expect(spoken(h).filter((l) => l.includes("(sorry)"))).toHaveLength(1);
    expect(sent(h)).not.toContain("send:hold on"); // still not a turn
    h.now += CALL_FEEL.sorryMinGapMs;
    h.loop.onFinal("okay so what is left for the launch, give me the whole list please");
    expect(spoken(h).filter((l) => l.includes("(sorry)"))).toHaveLength(1);
  });

  it("a long task: the Bot says so once ('That'll take a minute, I'll stay on') while it keeps working", async () => {
    let busy = true;
    const h = harness({ working: () => busy });
    h.loop.begin();
    h.loop.onFinal("refactor the billing module");
    h.loop.onBotText("On it, let me look at the code.", "nova", "e1");
    await finishAll(h);
    tickFor(h, CALL_FEEL.longTaskAfterMs);
    expect(spoken(h).filter((l) => l.includes("(long-task)"))).toEqual(["speak:nova:(long-task) long-task line from nova"]);
    await finishAll(h);
    tickFor(h, 60_000);
    expect(spoken(h).filter((l) => l.includes("(long-task)"))).toHaveLength(1);
    // A turn that finished quickly never hears it.
    busy = false;
    h.loop.onFinal("thanks");
    h.loop.onBotText("Anytime.", "nova", "e2");
    await finishAll(h);
    tickFor(h, 30_000);
    expect(spoken(h).filter((l) => l.includes("(long-task)"))).toHaveLength(1);
  });
});

describe("raised hands and hand-offs by name (items 6, 7)", () => {
  const team = [{ id: "ann", name: "Ann" }, { id: "bo", name: "Bo" }, { id: "cy", name: "Cy" }];

  it("a Bot that wasn't asked raises a hand instead of talking over the one speaking; 'go ahead, Bo' gives it the floor and isn't sent", async () => {
    const h = harness({ members: team });
    h.loop.begin();
    h.loop.onFinal("Ann, what's the plan for today?");
    h.loop.onBotStream("ann", "First we ship the fix. Then the review. ");
    h.loop.onBotText("Actually the fix needs a test first.", "bo", "b1");
    expect(spoken(h).some((l) => l.startsWith("speak:bo"))).toBe(false);
    expect(h.hands.at(-1)).toEqual(["bo"]);
    h.loop.onBotText("First we ship the fix. Then the review.", "ann", "a1");
    await finishAll(h);
    expect(spoken(h).some((l) => l.startsWith("speak:bo"))).toBe(false); // still waiting for the user
    h.loop.onFinal("go ahead, Bo");
    expect(sent(h)).toEqual(["send:Ann, what's the plan for today?"]);
    expect(spoken(h).at(-1)).toBe("speak:bo:Actually the fix needs a test first.");
    expect(h.hands.at(-1)).toEqual([]);
  });

  it("clicking the hand does the same", async () => {
    const h = harness({ members: team });
    h.loop.begin();
    h.loop.onFinal("Ann?");
    h.loop.onBotStream("ann", "Yes, here. ");
    h.loop.onBotStream("cy", "I have a quick thing. ");
    h.loop.onBotText("Yes, here.", "ann", "a1");
    expect(h.loop.hands().map((x) => x.botId)).toEqual(["cy"]);
    h.loop.goAhead("cy");
    await finishAll(h);
    expect(spoken(h).filter((l) => l.startsWith("speak:cy"))).toEqual(["speak:cy:I have a quick thing."]);
  });

  it("a hand expires after 20 s: that reply stays in the chat but is never spoken (and isn't marked interrupted)", async () => {
    const h = harness({ members: team });
    h.loop.begin();
    h.loop.onFinal("Ann?");
    h.loop.onBotStream("ann", "Yes, here, a long answer. ");
    h.loop.onBotStream("bo", "Me too");
    h.loop.onBotText("Yes, here, a long answer.", "ann", "a1");
    tickFor(h, CALL_FEEL.handExpiresMs + 200);
    expect(h.loop.hands()).toEqual([]);
    expect(h.hands.at(-1)).toEqual([]);
    h.loop.onBotText("Me too, one more point.", "bo", "b1");
    await finishAll(h);
    expect(spoken(h).some((l) => l.startsWith("speak:bo"))).toBe(false);
    expect(h.interrupted).toEqual([]);
    // Bo's next reply is a new one, spoken normally when it's asked.
    h.loop.onFinal("Bo, your turn");
    h.loop.onBotText("Here's my take.", "bo", "b2");
    expect(spoken(h).at(-1)).toBe("speak:bo:Here's my take.");
  });

  it("hand-off by name: 'Cy, can you take the calendar part?' gives Cy the floor next — no hand needed", async () => {
    const h = harness({ members: team });
    h.loop.begin();
    h.loop.onFinal("plan my week");
    h.loop.onBotStream("ann", "I'll book the flights. Cy, can you take the calendar part? ");
    h.loop.onBotText("I'll book the flights. Cy, can you take the calendar part?", "ann", "a1");
    h.loop.onBotStream("cy", "Sure, Thursday is free. ");
    expect(h.loop.hands()).toEqual([]);
    await finishAll(h);
    expect(spoken(h).map((l) => l.split(":")[1])).toEqual(["ann", "ann", "cy"]);
  });

  it("the user asks two Bots: both answer in turn, no hands", async () => {
    const h = harness({ members: team });
    h.loop.begin();
    h.loop.onFinal("Ann and Bo, thoughts?");
    h.loop.onBotStream("ann", "Ship it. ");
    h.loop.onBotStream("bo", "Agreed. ");
    h.loop.onBotText("Ship it.", "ann", "a1");
    await finishAll(h);
    expect(h.loop.hands()).toEqual([]);
    expect(spoken(h)).toEqual(["speak:ann:Ship it.", "speak:bo:Agreed."]);
  });

  it("an unaddressed question: the first Bot to answer owns it (even behind a reply still playing from before)", async () => {
    const h = harness({ members: team });
    h.loop.begin();
    h.loop.onFinal("Ann, status?");
    h.loop.onBotStream("ann", "All green. And one more long thing to say here. ");
    h.loop.onFinal("what about the budget");
    h.loop.onBotText("All green. And one more long thing to say here.", "ann", "a1");
    h.loop.onBotText("Budget is fine.", "bo", "b1");
    expect(h.loop.hands()).toEqual([]);
    await finishAll(h);
    expect(spoken(h).at(-1)).toBe("speak:bo:Budget is fine.");
  });

  it("a 1:1 call never raises a hand", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("hi");
    h.loop.onBotStream("nova", "Hi. ");
    h.loop.onBotText("And another thing.", "nova", "x");
    expect(h.loop.hands()).toEqual([]);
  });
});

describe("voice commands and greetings", () => {
  it("an utterance the call handles itself (add or remove a Bot) is never sent as a turn and gets no filler", async () => {
    const seen: string[] = [];
    const h = harness({ intercept: (t) => { seen.push(t); return /^add /i.test(t); } });
    h.loop.begin();
    h.loop.onFinal("add Ledger");
    expect(seen).toEqual(["add Ledger"]);
    expect(sent(h)).toEqual([]);
    expect(h.loop.state).toBe("listening");
    tickFor(h, 3_000);
    expect(spoken(h)).toEqual([]);
    h.loop.onFinal("what's the weather");
    expect(sent(h)).toEqual(["send:what's the weather"]);
  });

  it("say(): a pick-up greeting plays at once in the Bot's voice and resolves when it's done; a barge-in resolves it too", async () => {
    const h = harness();
    h.loop.begin();
    let done = false;
    void h.loop.say("nova", "Hey Alex, what's up?", "greeting").then(() => { done = true; });
    expect(spoken(h)).toEqual(["speak:nova:(greeting) Hey Alex, what's up?"]);
    await finishAll(h);
    expect(done).toBe(true);
    expect(h.loop.state).toBe("listening");
    let cut = false;
    void h.loop.say("nova", "Okay, so the plan is set.", "wrap-up").then(() => { cut = true; });
    h.loop.onPartial("bye");
    await flush();
    expect(cut).toBe(true);
  });
});
