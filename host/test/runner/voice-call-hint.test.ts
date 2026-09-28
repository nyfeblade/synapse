import { describe, expect, it } from "vitest";
import type { UserMessageEntry } from "@synapse/shared";
import { collectUserTurn } from "../../runner/prompt-collector";

/**
 * Bug 101 / CHAT-08: a message spoken in voice mode ("like a call") gets a TURN-scoped hint to
 * answer briefly and conversationally, because the reply is read aloud. It is a flag on the
 * message (voice.call), never a standing prompt: the next typed message carries no such hint.
 */
const msg = (over: Partial<UserMessageEntry>): UserMessageEntry => ({ kind: "message", id: "t1u", role: "user", content: "what's on my calendar", createdAt: 1, ...over });
const texts = (entries: UserMessageEntry[]) =>
  (collectUserTurn({ messages: entries.map((entry) => ({ entry, before: [], after: [] })), profileUpdate: null, blocks: [] }) as { text: string }[]).map((m) => m.text);

describe("voice-call reply hint (bug 101)", () => {
  it("a voice-call turn carries one brief-and-spoken reminder, just before the reply reminder", () => {
    const out = texts([msg({ voice: { durationMs: 2_400, call: true } })]);
    const hints = out.filter((t) => /spoken aloud/i.test(t));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/^<system_reminder>/);
    expect(hints[0]).toMatch(/short|brief/i);
    expect(out.indexOf(hints[0]!)).toBe(out.length - 2);
  });

  it("asks for a short spoken line of the model's own before tool work, and one for an approval it needs", () => {
    const hint = texts([msg({ voice: { durationMs: 2_400, call: true } })]).find((t) => /spoken aloud/i.test(t))!;
    expect(hint).toMatch(/before (you )?(use|using|run|running) (a )?tools?/i);
    expect(hint).toMatch(/approv|your OK|their OK/i);
    expect(hint).toMatch(/one sentence at a time|short sentences/i);
  });

  it("a typed message, or a voice note that wasn't a call, gets no such hint", () => {
    expect(texts([msg({})]).some((t) => /spoken aloud/i.test(t))).toBe(false);
    expect(texts([msg({ voice: { durationMs: 2_400 } })]).some((t) => /spoken aloud/i.test(t))).toBe(false);
  });

  it("when a burst ends with a typed message, the turn is not a voice turn", () => {
    const out = texts([msg({ voice: { durationMs: 900, call: true } }), msg({ id: "t2u", content: "actually, write it up" })]);
    expect(out.some((t) => /spoken aloud/i.test(t))).toBe(false);
  });
});
