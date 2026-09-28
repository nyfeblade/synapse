import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCardView, BotSummary, TranscriptEntry } from "@synapse/shared";
import type { WakeSpec } from "../../runner/turn-runner";
import { ScriptedFrontSession } from "../../voice/front-session";
import { VoiceFronts } from "../../voice/front";

// The call-behaviour branch, the host's side: how the Bot's voice (host/voice/front.ts) behaves on a 1:1 call.
// A fake clock and a scripted voice (no model).

type Script = (message: string, n: number) => { text: string; delegate?: string; firstTextMs?: number };

function harness(script: Script, o: { quiet?: (botId: string) => void; recall?: (text: string) => string | null; log?: (msg: string, f?: Record<string, unknown>) => void; pending?: ApprovalCardView[] } = {}) {
  const entries: TranscriptEntry[] = [];
  const typing: (string | null)[] = [];
  const wakes: WakeSpec[] = [];
  const sessions: ScriptedFrontSession[] = [];
  let turnNo = 10;
  let seq = 0;
  const bot = { id: "nova", profile: { name: "Nova", title: "Chief of Staff", description: "Warm, quick.", model: "claude-sonnet-5" } } as unknown as BotSummary;
  const fronts = new VoiceFronts({
    bots: {
      has: (id) => id === "nova", summary: () => bot,
      appendEntry: (_id, e) => { entries.push(e); },
      publishTyping: (_id, t, p) => { typing.push(t ? p : null); },
      tail: () => [],
      nextTurnNo: () => ++turnNo,
    },
    runner: {
      recordVoiceUtterance: (_b, text, nonce) => { const id = `t${++seq}u`; entries.push({ kind: "message", id, role: "user", content: text, clientNonce: nonce, createdAt: 0 } as TranscriptEntry); return { entryId: id }; },
      enqueueWake: (_b, spec) => { wakes.push(spec); return `w${wakes.length}`; },
    },
    gate: o.pending ? { pending: () => o.pending!, resolve: () => "denied" } : null,
    calls: { roster: () => ["nova"] },
    factory: (spec) => { const s = new ScriptedFrontSession(spec, script); sessions.push(s); return s; },
    enabled: () => true,
    now: () => Date.now(),
    ...(o.quiet ? { quiet: o.quiet } : {}),
    ...(o.recall ? { recall: (_b: string, t: string) => o.recall!(t) } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  fronts.callChanged("nova");
  const said = () => entries.flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
  return { fronts, entries, wakes, sessions, said, typing };
}

beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
afterEach(() => { vi.useRealTimers(); });

describe("plan item 10: a late continuation is merged, not answered as a fragment", () => {
  it("the fragment's reply still being written is dropped (never said); the continuation is answered once, told the user hadn't finished", async () => {
    const h = harness((m) => ({ text: /bank/.test(m) ? "Two emails from the bank this week." : "Sure, checking your email.", firstTextMs: 800 }));
    h.fronts.userPost("nova", "Check my email.", "n1");
    await vi.advanceTimersByTimeAsync(300); // the voice is still writing the fragment's reply
    h.fronts.userPost("nova", "Actually, look for anything from the bank this week.", "n2", { continues: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.said()).toEqual(["Two emails from the bank this week."]);
    expect(h.sessions[0]!.messages[1]).toContain("since your last heard reply");
    expect(h.fronts.stats("nova")!.canceledTokens).toBeGreaterThan(0);
  });

  it("a fragment whose run hadn't reached the model yet costs nothing, and its words ride with the continuation (never lost)", async () => {
    const h = harness((m) => ({ text: /bank/.test(m) ? "Two from the bank." : /weather/.test(m) ? "Sunny." : "Checking.", firstTextMs: 800 }));
    h.fronts.userPost("nova", "what's the weather", "n0");
    h.fronts.userPost("nova", "Check my email.", "n1"); // queued behind the weather turn
    h.fronts.userPost("nova", "from the bank", "n2", { continues: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.said()).toEqual(["Sunny.", "Two from the bank."]);
    expect(h.sessions[0]!.messages).toHaveLength(2);
    expect(h.sessions[0]!.messages[1]).toMatch(/User: Check my email\. from the bank$/);
    expect(h.sessions[0]!.messages[1]).not.toContain("since your last heard reply");
  });

  it("the same when the continuation's early start was held behind the unsent fragment: one run, on all the words", async () => {
    const h = harness((m) => ({ text: /bank/.test(m) ? "Two from the bank." : /weather/.test(m) ? "Sunny." : "Checking.", firstTextMs: 800 }));
    h.fronts.userPost("nova", "what's the weather", "n0");
    h.fronts.userPost("nova", "Check my email.", "n1");
    h.fronts.speculate("nova", "s1", "from the bank");
    h.fronts.userPost("nova", "from the bank", "n2", { continues: true, speculationId: "s1" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.said()).toEqual(["Sunny.", "Two from the bank."]);
    expect(h.sessions[0]!.messages.at(-1)).toMatch(/User: Check my email\. from the bank$/);
  });

  it("a fragment that already handed a task over: it is never handed over twice — the voice is told exactly what went, to add only the rest", async () => {
    // "Text Sam I'm late" … "and tell him to start without me": Sam must not get two texts.
    const h = harness((m) => {
      if (/Already handed over/.test(m)) return { text: "And I'll tell him to start.", delegate: "Tell Sam Lee to start the meeting without the user", firstTextMs: 100 };
      if (/start without me/.test(m)) return { text: "Texting Sam.", delegate: "Text Sam Lee: I'm late, start without me", firstTextMs: 100 };
      return { text: "Texting Sam now.", delegate: "Text Sam Lee: I'm running late", firstTextMs: 100 };
    });
    h.fronts.userPost("nova", "Text Sam I'm late", "n1");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.wakes).toHaveLength(1);
    h.fronts.userPost("nova", "and tell him to start without me", "n2", { continues: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const msg = h.sessions[0]!.messages.at(-1)!;
    expect(msg).toContain("Already handed over (don't send it again): Text Sam Lee: I'm running late");
    expect(h.wakes).toHaveLength(2);
    const second = (h.wakes[1]!.prompt()[0] as { text: string }).text;
    expect(second).not.toContain("I'm late, start without me");
  });

  it("…and when the continuation had an early start written before the note, that start is not kept (it could send the task again)", async () => {
    const h = harness((m) => {
      if (/Already handed over/.test(m)) return { text: "And I'll tell him to start.", delegate: "Tell Sam Lee to start the meeting without the user", firstTextMs: 100 };
      if (/start without me/.test(m)) return { text: "Texting Sam.", delegate: "Text Sam Lee: I'm late, start without me", firstTextMs: 100 };
      return { text: "Texting Sam now.", delegate: "Text Sam Lee: I'm running late", firstTextMs: 100 };
    });
    h.fronts.userPost("nova", "Text Sam I'm late", "n1");
    await vi.advanceTimersByTimeAsync(50); // the fragment is being written; its task goes out as it ends
    h.fronts.speculate("nova", "s1", "and tell him to start without me");
    await vi.advanceTimersByTimeAsync(450);
    h.fronts.userPost("nova", "and tell him to start without me", "n2", { continues: true, speculationId: "s1" });
    await vi.advanceTimersByTimeAsync(1_000);
    const tasks = h.wakes.map((w) => (w.prompt()[0] as { text: string }).text);
    expect(tasks.filter((t) => /I'm late, start without me/.test(t))).toEqual([]);
    expect(tasks).toHaveLength(2);
  });

  it("two continuations in a row: the note about what was already handed over survives a continuation that never began", async () => {
    const h = harness((m) => {
      if (m.startsWith("[result]") || m.includes("\n[result]")) return { text: "Sam got it.", firstTextMs: 2_000 };
      if (/^User: Text Sam/m.test(m)) return { text: "Texting Sam now.", delegate: "Text Sam Lee: I'm running late", firstTextMs: 100 };
      return { text: "And I'll tell him to start.", firstTextMs: 100 };
    });
    h.fronts.userPost("nova", "Text Sam I'm late", "n1");
    await vi.advanceTimersByTimeAsync(500);
    h.wakes[0]!.onSettle!({ sentTexts: ["Texted Sam."] } as never, null); // its report: a slow [result] turn is now in flight
    await vi.advanceTimersByTimeAsync(10);
    h.fronts.userPost("nova", "and tell him", "n2", { continues: true }); // queued behind the [result] turn
    await vi.advanceTimersByTimeAsync(10);
    h.fronts.userPost("nova", "to start without me", "n3", { continues: true }); // drops n2 before it ever began
    await vi.advanceTimersByTimeAsync(5_000);
    const last = h.sessions[0]!.messages.at(-1)!;
    expect(last).toMatch(/User: and tell him to start without me$/);
    expect(last).toContain("Already handed over (don't send it again): Text Sam Lee: I'm running late");
  });

  it("a fresh-voice retry of the continuation carries the note too (its first try began and said nothing)", async () => {
    const h = harness((m, n) => {
      if (/^User: Text Sam/m.test(m)) return { text: "Texting Sam now.", delegate: "Text Sam Lee: I'm running late", firstTextMs: 100 };
      return n === 1 ? { text: "" } : { text: "And I'll tell him to start.", firstTextMs: 100 };
    });
    h.fronts.userPost("nova", "Text Sam I'm late", "n1");
    await vi.advanceTimersByTimeAsync(500);
    h.fronts.userPost("nova", "and tell him to start without me", "n2", { continues: true });
    await vi.advanceTimersByTimeAsync(2_000);
    const msgs = h.sessions.flatMap((s) => s.messages);
    expect(msgs).toHaveLength(3); // the fragment, the continuation (said nothing), its retry
    expect(msgs[2]).toContain("Already handed over (don't send it again): Text Sam Lee: I'm running late");
  });

  it("a fragment's reply already said (in the chat) stays there; the voice is told it wasn't heard", async () => {
    const h = harness((m) => ({ text: /bank/.test(m) ? "Two from the bank." : "Checking your email.", firstTextMs: 100 }));
    h.fronts.userPost("nova", "Check my email.", "n1");
    await vi.advanceTimersByTimeAsync(500);
    h.fronts.userPost("nova", "from the bank", "n2", { continues: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.said()).toEqual(["Checking your email.", "Two from the bank."]);
    expect(h.sessions[0]!.messages[1]).toContain("since your last heard reply");
  });

  it("a continuation that confirms its early start: the fragment is dropped, and no stale note lands on the NEXT turn", async () => {
    const h = harness((m) => ({ text: /bank/.test(m) ? "Two from the bank." : /thanks/.test(m) ? "Any time." : "Checking.", firstTextMs: 100 }));
    h.fronts.userPost("nova", "Check my email.", "n1");
    await vi.advanceTimersByTimeAsync(500); // the fragment's reply is said
    h.fronts.speculate("nova", "s1", "from the bank");
    await vi.advanceTimersByTimeAsync(50);
    h.fronts.userPost("nova", "from the bank", "n2", { continues: true, speculationId: "s1" });
    await vi.advanceTimersByTimeAsync(1_000);
    h.fronts.userPost("nova", "thanks", "n3");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.said()).toEqual(["Checking.", "Two from the bank.", "Any time."]);
    expect(h.sessions[0]!.messages[2]).not.toContain("since your last heard reply");
  });

  it("a fragment's delegation that hadn't gone out yet never does", async () => {
    const h = harness((m) => (/bank/.test(m) ? { text: "Looking for bank emails.", delegate: "Find emails from the bank this week", firstTextMs: 100 } : { text: "On it.", delegate: "Check the user's email", firstTextMs: 800 }));
    h.fronts.userPost("nova", "Check my email.", "n1");
    await vi.advanceTimersByTimeAsync(300);
    h.fronts.userPost("nova", "from the bank", "n2", { continues: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.wakes).toHaveLength(1);
  });
});

/** The voice's system prompt as the call opens it (Nova, the harness persona). */
const systemOf = (h: ReturnType<typeof harness>) => (h.sessions[0] as unknown as { spec: { system: string } }).spec.system;
/** Measured before the call-behaviour branch: the prompt only ever gets shorter from here (trim, never raise). */
const SYSTEM_CHARS_BEFORE = 1_957;

describe("plan item 13: short, answer-first replies", () => {
  it("a spoken reply over 60 words is logged (lengths only)", async () => {
    const logs: [string, Record<string, unknown> | undefined][] = [];
    const h = harness(() => ({ text: Array.from({ length: 70 }, () => "word").join(" ") + "." }), { log: (m, f) => logs.push([m, f]) });
    h.fronts.userPost("nova", "tell me everything", "n1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logs.find(([m]) => m === "voice-front: long reply")?.[1]).toMatchObject({ botId: "nova", words: 70, kind: "user" });
  });
});

describe("plan item 27 (and 13's prompt): a plain thanks gets a word or nothing", () => {
  it("the prompt asks for the answer first, in under ten words, and at most one more short sentence — and stays as small as it was", () => {
    const s = systemOf(harness(() => ({ text: "x" })));
    expect(s).toMatch(/answer first/i);
    expect(s).toMatch(/under ten words/i);
    expect(s).toMatch(/at most one more/i);
    expect(s).toMatch(/\[result\][^\n]*at most one detail/i);
    expect(s).toMatch(/thanks or okay[^\n]*\[quiet\]/i);
    expect(s.length).toBeLessThanOrEqual(SYSTEM_CHARS_BEFORE);
  });

  it("[quiet]: nothing is said, nothing retried or handed over, and the call is told the turn is over", async () => {
    const quiet: string[] = [];
    const h = harness(() => ({ text: "[quiet]" }), { quiet: (b) => quiet.push(b) });
    h.fronts.userPost("nova", "thanks", "n1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.said()).toEqual([]);
    expect(h.wakes).toHaveLength(0);
    expect(h.sessions[0]!.messages).toHaveLength(1);
    expect(quiet).toEqual(["nova"]);
    expect(h.typing.filter((t) => t && /quiet|\[/.test(t))).toEqual([]);
  });

  it("the marker is never read out, wherever it lands", async () => {
    const h = harness(() => ({ text: "Any time. [quiet]" }));
    h.fronts.userPost("nova", "thanks", "n1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.said()).toEqual(["Any time."]);
    expect(h.typing.some((t) => t?.includes("[quiet"))).toBe(false);
  });

  it("a plain thanks doesn't pull memories into the turn (a short acknowledgement needs none)", async () => {
    const asked: string[] = [];
    const h = harness(() => ({ text: "Sure." }), { recall: (t) => { asked.push(t); return "- Sam Lee is the user's brother."; } });
    h.fronts.userPost("nova", "Thanks!", "n1");
    h.fronts.userPost("nova", "okay cool", "n2");
    h.fronts.userPost("nova", "text Sam", "n3");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(asked).toEqual(["text Sam"]);
  });
});

describe("plan item 20: the voice is told what is still in progress", () => {
  it("while a handed-over task is open, each user turn carries one short [working] line; after its [result], none", async () => {
    const h = harness((m) => (/calendar/.test(m) && !/\[/.test(m) ? { text: "On it.", delegate: "Check the user's calendar for tomorrow and list every meeting with its time" } : { text: "Still on it." }));
    h.fronts.userPost("nova", "what's on my calendar tomorrow", "n1");
    await vi.advanceTimersByTimeAsync(500);
    h.fronts.userPost("nova", "is it done yet?", "n2");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sessions[0]!.messages[1]).toMatch(/^\[working\] Check the user's calendar for tomorrow/m);
    expect(h.sessions[0]!.messages[1]!.split("\n").find((l) => l.startsWith("[working]"))!.length).toBeLessThanOrEqual(100);
    h.wakes[0]!.onSettle!({ sentTexts: ["Tomorrow: standup at 9:30."] } as never, null);
    await vi.advanceTimersByTimeAsync(500);
    h.fronts.userPost("nova", "thanks", "n3");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sessions[0]!.messages.at(-1)).not.toContain("[working]");
  });

  it("the prompt says a [working] task isn't done until its [result] — and stays as small as it was", () => {
    const s = systemOf(harness(() => ({ text: "x" })));
    expect(s).toMatch(/\[working\][^\n]*\[result\]/);
    expect(s.length).toBeLessThanOrEqual(SYSTEM_CHARS_BEFORE);
  });

  it("review round 1: \"cancel that\" while the texting task is open reaches the voice with the task in view, so it can hand over a cancel", async () => {
    const h = harness((m) => (/^User: text Sam/m.test(m) ? { text: "On it, sending.", delegate: "Text Sam Lee: I'm running late" } : /^User: Cancel that/m.test(m) ? { text: "Okay, cancelling it.", delegate: "Cancel the text to Sam Lee if it hasn't gone" } : { text: "Mm." }));
    h.fronts.userPost("nova", "text Sam I'm late", "n1");
    await vi.advanceTimersByTimeAsync(300);
    h.fronts.userPost("nova", "Cancel that.", "n2");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.sessions[0]!.messages[1]).toBe("[working] Text Sam Lee: I'm running late\nUser: Cancel that.");
    expect(h.wakes).toHaveLength(2);
  });

  it("at most two tasks are listed, however many are open", async () => {
    let n = 0;
    const h = harness((m) => (/^User: do thing/m.test(m) ? { text: "On it.", delegate: `Task number ${++n} with a fairly long description of what to do` } : { text: "Mm." }));
    for (const t of ["one", "two", "three"]) { h.fronts.userPost("nova", `do thing ${t}`, t); await vi.advanceTimersByTimeAsync(200); }
    h.fronts.userPost("nova", "thanks", "n4");
    await vi.advanceTimersByTimeAsync(500);
    const line = h.sessions[0]!.messages.at(-1)!.split("\n").find((l) => l.startsWith("[working]"))!;
    expect(line).toContain("(+1 more)");
    expect(line.length).toBeLessThanOrEqual(200);
  });
});

describe("review round 1: the markers are never read out, and [quiet] never ends an approval", () => {
  it.each(["(quiet)", "[ quiet ]", "[QUIET]", "( Quiet )"])("%s is the quiet marker too", async (m) => {
    const quiet: string[] = [];
    const h = harness(() => ({ text: m }), { quiet: (b) => quiet.push(b) });
    h.fronts.userPost("nova", "thanks", "n1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.said()).toEqual([]);
    expect(quiet).toEqual(["nova"]);
    expect(h.typing.filter((t) => t && /quiet/i.test(t))).toEqual([]);
  });

  it("a literal [working] the voice echoes is never read out", async () => {
    const h = harness(() => ({ text: "[working] Still on it, one sec." }));
    h.fronts.userPost("nova", "is it done", "n1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.said()).toEqual(["Still on it, one sec."]);
    expect(h.typing.some((t) => t?.includes("[work"))).toBe(false);
  });

  it("on an [approval] turn a [quiet] is not the end of it: the card is still waiting, so the turn is answered", async () => {
    const quiet: string[] = [];
    const card = { approvalId: "a1", summary: "Send iMessage to Sam Lee", title: "Send iMessage", status: "pending" } as unknown as ApprovalCardView;
    const h = harness((_m, n) => ({ text: n === 0 ? "[quiet]" : "Want me to send it as it is?" }), { quiet: (b) => quiet.push(b), pending: [card] });
    h.fronts.userPost("nova", "okay", "n1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(quiet).toEqual([]);
    expect(h.said()).toEqual(["Want me to send it as it is?"]);
  });
});

export { harness };
