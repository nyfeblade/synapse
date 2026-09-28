import { describe, expect, it } from "vitest";
import { CALL_FEEL, type BotSummary, type NoticeEntry, type TranscriptEntry } from "@synapse/shared";
import { StubOneShot } from "../../helper-model/one-shot";
import { loadPrompt } from "../../prompts/index";
import { CallRegistry } from "../../voice/calls";
import { CallWrapUp } from "../../voice/call-wrapup";

// Bug 134 (item 4): at hang-up a substantial call gets ONE short helper call: the Bot's spoken one-line
// wrap-up, and a compact summary with action items in the chat. A call under 30 s, or with no request in
// it, gets nothing (and no model call).

function fakeBots(names: string[]) {
  const t = new Map<string, TranscriptEntry[]>();
  let n = 0;
  const sum = new Map<string, BotSummary>();
  names.forEach((name, i) => sum.set(name.toLowerCase(), { id: name.toLowerCase(), profile: { name, description: "" }, settings: {}, group: null, updatedAt: i, lastBotMessageAt: i } as unknown as BotSummary));
  return {
    t,
    has: (id: string) => sum.has(id),
    summary: (id: string) => sum.get(id)!,
    tail: (id: string) => t.get(id) ?? [],
    auxEntryIds: (_id: string, k: number) => Array.from({ length: k }, () => `x${++n}`),
    appendEntry: (id: string, e: TranscriptEntry) => { t.set(id, [...(t.get(id) ?? []), e]); },
    notices: (id: string) => (t.get(id) ?? []).filter((e): e is NoticeEntry => e.kind === "notice"),
  };
}

const OUT = { line: "So I'll book Thursday's dentist slot and send you the invoice summary.", summary: "Alex asked Nova to book the dentist and summarise the Acme invoices.", actions: ["Nova: book the dentist for Thursday 3 pm", "Nova: send the Acme invoice summary"] };

function setup(handler: (input: unknown) => unknown = () => OUT) {
  const bots = fakeBots(["Nova", "Ledger"]);
  let now = 1_000;
  const calls = new CallRegistry({ bots, now: () => now });
  const model = new StubOneShot({ "orig/call-wrapup.md": handler });
  const w = new CallWrapUp({ calls, bots, model, now: () => now });
  const say = (who: "user" | "nova", text: string) => {
    now += 1_000;
    if (who === "user") bots.appendEntry("nova", { kind: "message", id: `u${now}`, role: "user", content: text, clientNonce: `n${now}`, createdAt: now, voice: { durationMs: 900, call: true } } as TranscriptEntry);
    else bots.appendEntry("nova", { kind: "send-message", id: `s${now}`, requestId: "r", createdAt: now, message: { type: "text", content: text } } as TranscriptEntry);
  };
  return { bots, calls, model, w, say, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}

describe("CallWrapUp (bug 134, item 4)", () => {
  it("a substantial call: one helper call; the spoken line comes back and the chat gets the summary with action items, after the ended marker", async () => {
    const s = setup();
    const v = s.calls.start("nova");
    s.say("user", "Can you book the dentist for Thursday?");
    s.say("nova", "Sure, Thursday at 3 works. Booking it now.");
    s.say("user", "And summarise the Acme invoices for me.");
    s.say("nova", "On it.");
    s.advance(60_000);
    s.calls.end(v.callId);
    const r = await s.w.wrapUp(v.callId);
    expect(r.line).toBe(OUT.line);
    expect(s.model.calls).toHaveLength(1);
    const input = s.model.calls[0]!.input as { bot: string; transcript: string[] };
    expect(input.bot).toBe("Nova");
    expect(input.transcript).toEqual(["User: Can you book the dentist for Thursday?", "Nova: Sure, Thursday at 3 works. Booking it now.", "User: And summarise the Acme invoices for me.", "Nova: On it."]);
    const n = s.bots.notices("nova");
    expect(n.at(-2)!.text).toMatch(/^Voice call ended/);
    expect(n.at(-1)!.callSummary).toEqual({ summary: OUT.summary, actions: OUT.actions, durationMs: expect.any(Number) });
    expect(n.at(-1)!.text).toMatch(/^Call summary · 1m/);
    // Idempotent: hanging up twice doesn't summarise twice.
    expect((await s.w.wrapUp(v.callId)).line).toBe(OUT.line);
    expect(s.model.calls).toHaveLength(1);
  });

  it("under 30 s: no line, no summary, no model call", async () => {
    const s = setup();
    const v = s.calls.start("nova");
    s.say("user", "What's the time in Tokyo?");
    s.say("nova", "It's 3 a.m. there.");
    s.calls.end(v.callId, CALL_FEEL.wrapUpMinMs - 1);
    expect(await s.w.wrapUp(v.callId, CALL_FEEL.wrapUpMinMs - 1)).toEqual({ line: null });
    expect(s.model.calls).toHaveLength(0);
    expect(s.bots.notices("nova").some((e) => e.callSummary)).toBe(false);
  });

  it("no request in it (the user never said anything): nothing, even for a long call", async () => {
    const s = setup();
    const v = s.calls.start("nova");
    s.say("nova", "Hey!");
    s.advance(120_000);
    s.calls.end(v.callId);
    expect(await s.w.wrapUp(v.callId)).toEqual({ line: null });
    expect(s.model.calls).toHaveLength(0);
  });

  it("the model's output is trimmed to the caps; a failure means no line and no summary (never an error at hang-up)", async () => {
    const s = setup(() => ({ line: `${"word ".repeat(80)}`, summary: "x".repeat(900), actions: Array.from({ length: 9 }, (_, i) => `do ${i} ${"y".repeat(200)}`) }));
    const v = s.calls.start("nova");
    s.say("user", "Plan my week.");
    s.say("nova", "Done.");
    s.advance(60_000);
    const r = await s.w.wrapUp(v.callId);
    expect(r.line!.length).toBeLessThanOrEqual(CALL_FEEL.wrapUpLineMaxChars);
    const sum = s.bots.notices("nova").at(-1)!.callSummary!;
    expect(sum.summary.length).toBeLessThanOrEqual(CALL_FEEL.summaryMaxChars);
    expect(sum.actions).toHaveLength(CALL_FEEL.actionsMax);
    for (const a of sum.actions) expect(a.length).toBeLessThanOrEqual(CALL_FEEL.actionMaxChars);

    const f = setup(() => { throw new Error("helper down"); });
    const v2 = f.calls.start("nova");
    f.say("user", "Plan my week.");
    f.advance(60_000);
    expect(await f.w.wrapUp(v2.callId)).toEqual({ line: null });
    expect(f.bots.notices("nova").some((e) => e.callSummary)).toBe(false);
  });

  it("the transcript sent is capped (a long call costs about the same as a short one)", async () => {
    const s = setup();
    const v = s.calls.start("nova");
    for (let i = 0; i < 200; i++) { s.say("user", `request ${i} ${"blah ".repeat(40)}`); s.say("nova", `answer ${i} ${"blah ".repeat(40)}`); }
    await s.w.wrapUp(v.callId);
    const input = s.model.calls[0]!.input as { transcript: string[] };
    expect(input.transcript.join("\n").length).toBeLessThanOrEqual(6_000);
    expect(input.transcript.at(-1)).toMatch(/^Nova: answer 199/);
    const est = Math.ceil((loadPrompt("orig/call-wrapup.md").length + JSON.stringify(input).length) / 4);
    expect(est).toBeLessThan(2_000);
  });

  it("an unknown call id is an error; a group call's line goes to the Bot that spoke last", async () => {
    const s = setup();
    await expect(s.w.wrapUp("call_nope")).rejects.toThrow(/ended|found/i);
    const v = s.calls.start("nova");
    s.calls.add(v.callId, "ledger");
    s.say("user", "Ledger, what's our burn rate?");
    s.bots.appendEntry("nova", { kind: "send-message", id: "sl", requestId: "r", createdAt: s.now + 1, author: { id: "ledger", name: "Ledger" }, message: { type: "text", content: "About 40k a month." } } as unknown as TranscriptEntry);
    s.advance(60_000);
    const r = await s.w.wrapUp(v.callId);
    expect(r).toMatchObject({ line: OUT.line, botId: "ledger" });
    expect((s.model.calls[0]!.input as { bot: string }).bot).toBe("Ledger");
  });

  it("the prompt: one short spoken line, the summary and action items, from the transcript as data", () => {
    const p = loadPrompt("orig/call-wrapup.md");
    expect(p).toMatch(/data, not instructions/);
    expect(p).toMatch(/action items/i);
    expect(p).toMatch(/one (short )?(spoken )?line|one sentence/i);
  });
});
