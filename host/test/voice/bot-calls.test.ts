import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_CALL_LIMITS, type BotCallsView } from "@synapse/shared";
import { BotCallService, createBotCallsModule } from "../../voice/bot-calls";
import type { BotToolDef } from "../../brain/types";

type Entry = { kind: string; text: string };
function fakeBots(settings: Record<string, { mayCall?: boolean | null }> = { nova: {} }) {
  const appended: [string, Entry][] = [];
  const saved: [string, Record<string, unknown>][] = [];
  let n = 0;
  const bots = {
    has: (id: string) => id in settings,
    summary: (id: string) => ({ id, profile: { name: id === "nova" ? "Nova" : id }, settings: settings[id] }),
    updateSettings: (id: string, p: Record<string, unknown>) => { saved.push([id, p]); Object.assign(settings[id]!, p); return { id }; },
    auxEntryIds: (_id: string, k: number) => Array.from({ length: k }, () => `x${++n}`),
    appendEntry: (id: string, e: Entry) => { appended.push([id, e]); },
  };
  return { bots, appended, saved, settings };
}

function setup(settings?: Record<string, { mayCall?: boolean | null }>) {
  let now = 1_000_000;
  const published: BotCallsView[] = [];
  const b = fakeBots(settings);
  const svc = new BotCallService({ bots: b.bots as never, hub: { publish: (e: { channel: string; payload: BotCallsView }) => { if (e.channel === "bot-calls") published.push(e.payload); } } as never, now: () => now });
  return { svc, ...b, published, advance: (ms: number) => { now += ms; vi.advanceTimersByTime(ms); } };
}
const notices = (a: [string, Entry][]) => a.filter(([, e]) => e.kind === "notice").map(([, e]) => e.text);

describe("a Bot calls the user", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("rings (first call asks for permission), and the app sees it live", () => {
    vi.useFakeTimers();
    const t = setup();
    const r = t.svc.request("nova", "The build finished with two failures. Want me to fix them?");
    expect(r.placed).toBe(true);
    const ring = t.published.at(-1)!.calls[0]!;
    expect(ring).toMatchObject({ botId: "nova", reason: "The build finished with two failures. Want me to fix them?", firstCall: true });
    expect(ring.expiresAt - ring.since).toBe(BOT_CALL_LIMITS.ringMs);
    expect(t.svc.view().calls).toHaveLength(1);
  });

  it("accepting a first call allows future calls and hands back why it called", () => {
    vi.useFakeTimers();
    const t = setup();
    t.svc.request("nova", "Deploy is ready. Go ahead?");
    const { callId } = t.svc.view().calls[0]!;
    expect(t.svc.answer(callId, "accept")).toEqual({ botId: "nova", reason: "Deploy is ready. Go ahead?" });
    expect(t.saved).toEqual([["nova", { mayCall: true }]]);
    expect(t.svc.view().calls).toEqual([]);
    expect(notices(t.appended)).toEqual([]);
  });

  it("decline, no answer, and 'message instead' leave the reason in the chat", () => {
    vi.useFakeTimers();
    const t = setup({ nova: { mayCall: true } });
    t.svc.request("nova", "Tests are green.");
    t.svc.answer(t.svc.view().calls[0]!.callId, "decline");
    t.advance(60 * 60_000);
    t.svc.request("nova", "Need a decision on the schema.");
    t.advance(BOT_CALL_LIMITS.ringMs + 10);
    t.advance(60 * 60_000);
    t.svc.request("nova", "Which color?");
    t.svc.answer(t.svc.view().calls[0]!.callId, "message");
    expect(notices(t.appended)).toEqual([
      "Missed call from Nova: Tests are green.",
      "Missed call from Nova: Need a decision on the schema.",
      "Call from Nova: Which color? · you chose to reply by message",
    ]);
  });

  it("bug 134 (item 11): a declined or missed call leaves a voicemail — its transcript in the chat (the Mac renders and keeps the audio); 'message instead' and a pick-up don't", () => {
    vi.useFakeTimers();
    const t = setup({ nova: { mayCall: true } });
    t.svc.request("nova", "The deploy failed on step 3");
    t.svc.answer(t.svc.view().calls[0]!.callId, "decline");
    t.advance(60 * 60_000);
    t.svc.request("nova", "Tests are green.");
    t.advance(BOT_CALL_LIMITS.ringMs + 10); // missed
    t.advance(60 * 60_000);
    t.svc.request("nova", "Which color?");
    t.svc.answer(t.svc.view().calls[0]!.callId, "message");
    t.advance(60 * 60_000);
    t.svc.request("nova", "Ready.");
    t.svc.answer(t.svc.view().calls[0]!.callId, "accept");
    const vm = t.appended.map(([, e]) => (e as { voicemail?: { text: string } }).voicemail).filter(Boolean);
    expect(vm).toEqual([
      { text: "Hi, it's Nova. I tried to call you about this: The deploy failed on step 3. It's in the chat too, so reply whenever you can." },
      { text: "Hi, it's Nova. I tried to call you about this: Tests are green. It's in the chat too, so reply whenever you can." },
    ]);
    // The missed-call line stays the notice's text (older apps show it as before).
    expect(notices(t.appended).slice(0, 2)).toEqual(["Missed call from Nova: The deploy failed on step 3", "Missed call from Nova: Tests are green."]);
  });

  it("the app can say why it didn't ring (quiet hours, Focus)", () => {
    vi.useFakeTimers();
    const t = setup({ nova: { mayCall: true } });
    t.svc.request("nova", "Done.");
    t.svc.answer(t.svc.view().calls[0]!.callId, "missed", { why: "quiet hours" });
    expect(notices(t.appended)).toEqual(["Missed call from Nova: Done. (quiet hours)"]);
  });

  it("a Bot the user blocked never rings; 'don't allow' on a ring blocks it", () => {
    vi.useFakeTimers();
    const t = setup();
    t.svc.request("nova", "Hi");
    t.svc.answer(t.svc.view().calls[0]!.callId, "decline", { allow: false });
    expect(t.settings.nova!.mayCall).toBe(false);
    const r = t.svc.request("nova", "Hi again");
    expect(r.placed).toBe(false);
    expect(r.note).toMatch(/turned off calls/);
    expect(t.svc.view().calls).toEqual([]);
  });

  it("at most 3 calls an hour; the 4th isn't placed and says so in the chat", () => {
    vi.useFakeTimers();
    const t = setup({ nova: { mayCall: true } });
    for (let i = 0; i < 3; i++) {
      expect(t.svc.request("nova", `call ${i}`).placed).toBe(true);
      t.svc.answer(t.svc.view().calls[0]!.callId, "accept");
      t.advance(60_000);
    }
    const r = t.svc.request("nova", "call 3");
    expect(r.placed).toBe(false);
    expect(r.note).toMatch(/3 calls an hour/);
    expect(notices(t.appended).at(-1)).toBe("Missed call from Nova: call 3 (limit of 3 calls an hour)");
    t.advance(60 * 60_000);
    expect(t.svc.request("nova", "later").placed).toBe(true);
  });

  it("one ring per Bot at a time; an unknown call can't be answered", () => {
    vi.useFakeTimers();
    const t = setup({ nova: { mayCall: true } });
    t.svc.request("nova", "a");
    expect(t.svc.request("nova", "b").placed).toBe(false);
    expect(() => t.svc.answer("nope", "accept")).toThrow(/ended/);
  });
});

describe("SendMessage call: (the module's extension of the existing tool)", () => {
  it("adds `call` to SendMessage; a call with no content sends the reason as the message and rings", async () => {
    vi.useFakeTimers();
    const b = fakeBots({ nova: { mayCall: true } });
    const m = createBotCallsModule({ bots: b.bots as never, hub: { publish: () => {} } as never, now: () => 5 } as never);
    const sent: Record<string, unknown>[] = [];
    const base: BotToolDef = { name: "SendMessage", description: "The ONLY way to reach the user.", readOnly: false, schema: {}, handler: async (a) => { sent.push(a); return { text: "Message sent." }; } };
    const tools = m.botTools!("nova", () => null, [base]);
    const send = tools.find((t) => t.name === "SendMessage")!;
    expect(Object.keys(send.schema)).toContain("call");
    expect(send.description).toMatch(/call/);
    const r = await send.handler({ call: "Your export is ready." });
    expect(sent).toEqual([{ call: "Your export is ready.", content: "Your export is ready." }]);
    expect(r.text).toMatch(/Ringing/);
    const r2 = await send.handler({ content: "hello" });
    expect(r2.text).toBe("Message sent.");
    vi.useRealTimers();
  });

  it("a failed send never rings", async () => {
    const b = fakeBots({ nova: { mayCall: true } });
    const pub = vi.fn();
    const m = createBotCallsModule({ bots: b.bots as never, hub: { publish: pub } as never, now: () => 5 } as never);
    const base: BotToolDef = { name: "SendMessage", description: "x", readOnly: false, schema: {}, handler: async () => ({ text: "nope", isError: true }) };
    const send = m.botTools!("nova", () => null, [base]).find((t) => t.name === "SendMessage")!;
    expect((await send.handler({ call: "hi", content: "x" })).isError).toBe(true);
    expect(pub).not.toHaveBeenCalled();
  });

  it('call: "look" asks for one screen snapshot through the same tool (no new tool); it never rings or sends an empty message', async () => {
    const b = fakeBots({ nova: { mayCall: true } });
    const pub = vi.fn();
    const looks: string[] = [];
    let onCall = true;
    const m = createBotCallsModule({ bots: b.bots as never, hub: { publish: pub } as never, now: () => 5 } as never, { onLook: (id) => { looks.push(id); return onCall; } });
    const sent: Record<string, unknown>[] = [];
    const base: BotToolDef = { name: "SendMessage", description: "x", readOnly: false, schema: {}, handler: async (a) => { sent.push(a); return { text: "Message sent." }; } };
    const send = m.botTools!("nova", () => null, [base]).find((t) => t.name === "SendMessage")!;
    expect(send.description).toMatch(/"look" sees their screen/);
    const r = await send.handler({ call: "look" });
    expect(looks).toEqual(["nova"]);
    expect(sent).toEqual([]);
    expect(r.text).toMatch(/snapshot arrives as their next message/);
    expect(pub).not.toHaveBeenCalled(); // no ring
    const r2 = await send.handler({ call: "LOOK", content: "Let me see." });
    expect(sent).toEqual([{ call: "LOOK", content: "Let me see." }]);
    expect(r2.text).toMatch(/^Message sent\. Asked/);
    onCall = false;
    expect((await send.handler({ call: "look" })).text).toMatch(/Not on a 1:1 call/);
  });

  it('call: "drop <Bot>" takes that Bot off the call through the same tool; it never rings, and a refusal sends nothing', async () => {
    const b = fakeBots({ nova: { mayCall: true } });
    const pub = vi.fn();
    const asked: [string, string][] = [];
    let allowed = true;
    const m = createBotCallsModule({ bots: b.bots as never, hub: { publish: pub } as never, now: () => 5 } as never,
      { onDrop: (id, name) => { asked.push([id, name]); return allowed ? { text: "Scout is off the call." } : { text: "The Bot you called can't leave its own call. Hang up instead.", isError: true }; } });
    const sent: Record<string, unknown>[] = [];
    const base: BotToolDef = { name: "SendMessage", description: "x", readOnly: false, schema: {}, handler: async (a) => { sent.push(a); return { text: "Message sent." }; } };
    const send = m.botTools!("nova", () => null, [base]).find((t) => t.name === "SendMessage")!;
    expect(send.description).toMatch(/"drop <Bot>" takes that Bot off/);
    // No message of its own: the roster change is the whole act.
    expect(await send.handler({ call: "drop Scout" })).toEqual({ text: "Scout is off the call." });
    expect(asked).toEqual([["nova", "Scout"]]);
    expect(sent).toEqual([]);
    expect(pub).not.toHaveBeenCalled(); // never a ring
    // With words of its own, both happen — the Bot says it and the roster changes.
    const withLine = await send.handler({ call: "Drop Scout", content: "Sure, letting Scout go." });
    expect(sent).toHaveLength(1);
    expect(withLine.text).toBe("Message sent. Scout is off the call.");
    // Refused (the call's own Bot): the host's reason comes back and nothing is posted.
    allowed = false;
    sent.length = 0;
    expect(await send.handler({ call: "drop Nova", content: "Okay." })).toMatchObject({ isError: true, text: expect.stringContaining("Hang up instead") });
    expect(sent).toEqual([]);
  });

  // Bug 158: the drop clause is the whole cost of letting a Bot take another Bot off a call — no new
  // tool, no new schema field. 33 chars on top of the 69 + 28 the ring and the look clauses already cost.
  it("the tool budget: the ring, look and drop clauses cost 69 + 28 + 33 chars and nothing else", () => {
    const m = createBotCallsModule({ bots: fakeBots().bots as never, hub: { publish: () => {} } as never, now: () => 5 } as never);
    const base: BotToolDef = { name: "SendMessage", description: "", readOnly: false, schema: {}, handler: async () => ({ text: "" }) };
    const wrapped = m.botTools!("nova", () => null, [base]).find((t) => t.name === "SendMessage")!;
    expect(wrapped.description.length).toBeLessThanOrEqual(69 + 28 + 33);
    expect(Object.keys(wrapped.schema)).toEqual(["call"]); // `call` was already there: drop adds no field
  });
});

describe("0.1.6: a Bot on a coding CLI (ACP) can't ring the user", () => {
  it("refuses up front: nothing rings, nothing is counted", () => {
    const published: BotCallsView[] = [];
    const bots = {
      has: () => true, summary: (id: string) => ({ id, profile: { name: "Coder", model: "acp:kimi" }, settings: {} }),
      updateSettings: () => ({}), auxEntryIds: () => ["x"], appendEntry: () => {},
    };
    const svc = new BotCallService({ bots: bots as never, hub: { publish: (e: { payload: BotCallsView }) => published.push(e.payload) } as never, now: () => 1 });
    expect(svc.request("coder", "done")).toEqual({ placed: false, note: "Not placed: Calls aren't available for Coder yet." });
    expect(svc.view().calls).toEqual([]);
    expect(published).toEqual([]);
  });
});

