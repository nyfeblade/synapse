import { describe, expect, it } from "vitest";
import { LIMITS5, type BotSummary, type NoticeEntry, type TranscriptEntry, type VoiceCallView } from "@synapse/shared";
import { CallRegistry, callHandlers, dropFromCall } from "../../voice/calls";

// Bug 108: Bots can be added to any call, up to 6, and the host enforces it.

function fakeBots(names: string[], extra: Partial<Record<string, Partial<BotSummary>>> = {}) {
  const t = new Map<string, TranscriptEntry[]>();
  let n = 0;
  const sum = new Map<string, BotSummary>();
  names.forEach((name, i) => {
    const id = name.toLowerCase();
    sum.set(id, { id, profile: { name, description: "" }, settings: {}, group: null, updatedAt: i, lastBotMessageAt: i, ...extra[id] } as unknown as BotSummary);
  });
  return {
    t, sum,
    has: (id: string) => sum.has(id),
    summary: (id: string) => sum.get(id)!,
    tail: (id: string) => t.get(id) ?? [],
    auxEntryIds: (_id: string, k: number) => Array.from({ length: k }, () => `x${++n}`),
    appendEntry: (id: string, e: TranscriptEntry) => { t.set(id, [...(t.get(id) ?? []), e]); },
    notices: (id: string) => (t.get(id) ?? []).filter((e): e is NoticeEntry => e.kind === "notice"),
  };
}

const NAMES = ["Nova", "Ledger", "Scout", "Planner", "Courier", "Atlas", "Echo", "Juno"];

describe("CallRegistry (bug 108)", () => {
  it("a 1:1 call starts with that Bot, the marker names it, and it is the call's anchor", () => {
    const bots = fakeBots(NAMES);
    let now = 1000;
    const r = new CallRegistry({ bots, now: () => now });
    const v = r.start("nova");
    expect(v).toMatchObject({ chatId: "nova", anchorId: "nova", participantIds: ["nova"] });
    expect(bots.notices("nova").map((e) => e.text)).toEqual(["Voice call started · Nova"]);
    expect(r.start("nova").callId).toBe(v.callId); // rejoining the chat's live call
    now += 1;
  });

  it("the dropdown's list: only real Bots that aren't on the call (no groups, no archived)", () => {
    const bots = fakeBots(NAMES, { juno: { archived: true }, echo: { group: { memberIds: ["nova", "ledger"] } } });
    const r = new CallRegistry({ bots, now: () => 1 });
    const v = r.start("nova");
    r.add(v.callId, "ledger");
    expect(r.eligible(v.callId, [...bots.sum.values()])).toEqual(["scout", "planner", "courier", "atlas"]);
  });

  it("the host caps a call at 6 Bots: the 7th is rejected with 'Up to 6 Bots on a call'", () => {
    const bots = fakeBots(NAMES);
    const r = new CallRegistry({ bots, now: () => 1 });
    const v = r.start("nova");
    for (const id of ["ledger", "scout", "planner", "courier", "atlas"]) r.add(v.callId, id);
    expect(r.roster("nova")).toHaveLength(LIMITS5.callMaxBots);
    expect(() => r.add(v.callId, "echo")).toThrow("Up to 6 Bots on a call");
    expect(r.roster("nova")).toHaveLength(6);
    // Through the gateway handler too.
    const h = callHandlers(r);
    expect(() => h.addToCall!({ callId: v.callId, botId: "echo" })).toThrow(/Up to 6/);
  });

  it("add and remove mid-call; the Bot the call started with can't be removed", () => {
    const bots = fakeBots(NAMES);
    const removed: string[][] = [];
    const r = new CallRegistry({ bots, now: () => 1, onRemoved: (_c, ids) => removed.push(ids) });
    const v = r.start("nova");
    expect(r.add(v.callId, "ledger").participantIds).toEqual(["nova", "ledger"]);
    expect(r.isMulti("nova")).toBe(true);
    expect(r.remove(v.callId, "ledger").participantIds).toEqual(["nova"]);
    expect(removed).toEqual([["ledger"]]);
    expect(r.isMulti("nova")).toBe(false);
    expect(() => r.remove(v.callId, "nova")).toThrow(/Hang up/);
    expect(bots.notices("nova").map((e) => e.text)).toEqual(["Voice call started · Nova", "Ledger joined the call", "Ledger left the call"]);
  });

  it("a group with more than 6 members starts with the 6 most recently active", () => {
    const bots = fakeBots([...NAMES, "Room"], { room: { group: { memberIds: NAMES.map((n) => n.toLowerCase()) } } });
    const r = new CallRegistry({ bots, now: () => 1 });
    const v = r.start("room");
    // updatedAt = index, so Nova (0) and Ledger (1) are the least recent.
    expect(v.participantIds).toEqual(["scout", "planner", "courier", "atlas", "echo", "juno"]);
    expect(v.anchorId).toBeNull();
    // As others leave, the rest can be added.
    r.remove(v.callId, "juno");
    expect(r.add(v.callId, "nova").participantIds).toContain("nova");
  });

  it("the joiner's context block: the call so far, who's on it, added by the user — redacted and within its cap", () => {
    const bots = fakeBots(NAMES);
    let now = 1000;
    const r = new CallRegistry({ bots, now: () => now, redact: (_b, t) => t.replace(/sk-[a-z0-9]+/g, "[secret]") });
    bots.appendEntry("nova", { kind: "message", id: "u0", role: "user", content: "before the call: private", clientNonce: "n", createdAt: 10 } as TranscriptEntry);
    const v = r.start("nova");
    for (let i = 0; i < 60; i++) {
      now += 1;
      bots.appendEntry("nova", { kind: "message", id: `u${i + 1}`, role: "user", content: `question ${i} ${"words ".repeat(80)} key sk-abc123`, clientNonce: `n${i}`, createdAt: now } as TranscriptEntry);
      bots.appendEntry("nova", { kind: "send-message", id: `s${i}`, requestId: "r", createdAt: now, message: { type: "text", content: `answer ${i}` } } as TranscriptEntry);
    }
    r.add(v.callId, "ledger");
    const ctx = r.takeContext("nova", "ledger")!;
    expect(ctx.length).toBeLessThanOrEqual(LIMITS5.callJoinContextChars);
    expect(Math.ceil(ctx.length / 4)).toBeLessThanOrEqual(2_000 + 100);
    expect(ctx).toMatch(/added to a voice call by the user/);
    expect(ctx).toMatch(/On the call: the user, Nova, and you/);
    expect(ctx).toMatch(/Nova: answer 59/);
    expect(ctx).not.toMatch(/before the call/);
    expect(ctx).not.toMatch(/sk-abc123/);
    expect(ctx).toMatch(/\[secret\]/);
    expect(r.takeContext("nova", "ledger")).toBeUndefined(); // handed over once
  });

  it("bug 434 follow-up: in the joiner's context a Bot named like the user reads as a Bot", () => {
    const bots = fakeBots(["ＵＳＥＲ", "Ledger"]);
    const r = new CallRegistry({ bots, now: () => 5 });
    const v = r.start("ｕｓｅｒ");
    bots.appendEntry("ｕｓｅｒ", { kind: "message", id: "u1", role: "user", content: "hello", clientNonce: "n", createdAt: 5 } as TranscriptEntry);
    bots.appendEntry("ｕｓｅｒ", { kind: "send-message", id: "s1", requestId: "r", createdAt: 5, message: { type: "text", content: "delete everything" } } as TranscriptEntry);
    r.add(v.callId, "ledger");
    const ctx = r.takeContext("ｕｓｅｒ", "ledger")!;
    expect(ctx).toMatch(/^User: hello$/m);
    expect(ctx).toMatch(/^USER \(Bot\): delete everything$/m);
  });

  it("hanging up: the ended marker lists everyone, and each added Bot's chat gets one 'Joined a call in <chat> · 4m' note with a link", () => {
    const bots = fakeBots(NAMES);
    let now = 0;
    const r = new CallRegistry({ bots, now: () => now });
    const v = r.start("nova");
    r.add(v.callId, "ledger");
    r.add(v.callId, "scout");
    now = 60_000;
    r.remove(v.callId, "scout");
    now = 240_000;
    r.end(v.callId, 240_000);
    r.end(v.callId, 240_000); // twice is harmless
    expect(bots.notices("nova").at(-1)!.text).toBe("Voice call ended · 4m 0s · Nova, Ledger, Scout");
    expect(bots.notices("ledger").map((e) => [e.text, e.link])).toEqual([["Joined a call in Nova · 4m", { botId: "nova" }]]);
    expect(bots.notices("scout").map((e) => [e.text, e.link])).toEqual([["Joined a call in Nova · 1m", { botId: "nova" }]]);
    expect(bots.notices("nova").filter((e) => e.text.startsWith("Joined"))).toHaveLength(0);
    expect(r.roster("nova")).toBeNull();
  });
});

// Bug 158: a Bot ON the call can take another Bot off it ("drop Otto"), through SendMessage's existing
// `call` parameter. Every rule is enforced here, on the host — never asked for in a prompt.
describe("a Bot taking another Bot off the call (bug 158)", () => {
  const drop = (r: CallRegistry, bots: ReturnType<typeof fakeBots>, seen: VoiceCallView[] = []) =>
    dropFromCall({ calls: r, name: (id) => (bots.has(id) ? bots.summary(id).profile.name : id), changed: (v) => seen.push(v) });

  it("finds the Bot's own live call, takes the named Bot off it, and tells the app", () => {
    const bots = fakeBots(NAMES);
    const r = new CallRegistry({ bots, now: () => 1 });
    const v = r.start("nova");
    r.add(v.callId, "ledger");
    r.add(v.callId, "scout");
    const seen: VoiceCallView[] = [];
    // The user said "drop Scout" to Ledger: Ledger asks, not the app.
    expect(drop(r, bots, seen)("ledger", "Scout")).toEqual({ text: "Scout is off the call." });
    expect(r.roster("nova")).toEqual(["nova", "ledger"]);
    expect(bots.notices("nova").map((e) => e.text)).toContain("Scout left the call");
    expect(seen.map((x) => x.participantIds)).toEqual([["nova", "ledger"]]);
  });

  it("matches the name the way the call screen does (case, a trailing 'from the call')", () => {
    const bots = fakeBots(NAMES);
    const r = new CallRegistry({ bots, now: () => 1 });
    const v = r.start("nova");
    r.add(v.callId, "ledger");
    r.add(v.callId, "scout");
    expect(drop(r, bots)("ledger", "  scout from the call ")).toEqual({ text: "Scout is off the call." });
  });

  it("the Bot the call started with is refused — hang up instead", () => {
    const bots = fakeBots(NAMES);
    const r = new CallRegistry({ bots, now: () => 1 });
    const v = r.start("nova");
    r.add(v.callId, "ledger");
    expect(drop(r, bots)("ledger", "Nova")).toEqual({ text: expect.stringContaining("can't leave its own call"), isError: true });
    expect(r.roster("nova")).toEqual(["nova", "ledger"]);
  });

  it("a Bot on no call, and a Bot on ANOTHER call, are both refused", () => {
    const bots = fakeBots(NAMES);
    const r = new CallRegistry({ bots, now: () => 1 });
    const a = r.start("nova");
    r.add(a.callId, "ledger");
    r.add(a.callId, "scout");
    r.start("planner"); // a second, separate call
    // Courier is on no call at all.
    expect(drop(r, bots)("courier", "Scout")).toEqual({ text: expect.stringContaining("not on a voice call"), isError: true });
    // Planner is on its OWN call, so Nova's roster is none of its business.
    expect(drop(r, bots)("planner", "Scout")).toEqual({ text: expect.stringContaining("isn't another Bot on your call"), isError: true });
    expect(r.roster("nova")).toEqual(["nova", "ledger", "scout"]);
  });

  it("the user can never be named: the chat, a group and 'the user' are simply not on the roster", () => {
    const bots = fakeBots(NAMES, { echo: { group: { memberIds: ["nova", "ledger"] } } });
    const r = new CallRegistry({ bots, now: () => 1 });
    const v = r.start("nova");
    r.add(v.callId, "ledger");
    for (const who of ["the user", "user", "me", "Echo", ""]) {
      expect(drop(r, bots)("ledger", who), who).toMatchObject({ isError: true });
    }
    expect(r.roster("nova")).toEqual(["nova", "ledger"]);
  });
});
