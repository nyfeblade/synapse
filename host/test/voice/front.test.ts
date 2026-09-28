import { describe, expect, it } from "vitest";
import type { ApprovalCardView, BotSummary, TranscriptEntry } from "@synapse/shared";
import type { TurnResult } from "../../brain/types";
import type { WakeSpec } from "../../runner/turn-runner";
import { ScriptedFrontSession, type FrontSpec } from "../../voice/front-session";
import { FRONT_REQUEST_PREFIX, VoiceFronts } from "../../voice/front";

// Bug 142 — the voice fast path: the Bot's voice (a lean front session) answers each utterance on a 1:1 call at
// once, hands real work to the full session (delegate → a voice-delegate wake), and speaks its report when it
// comes back. Speculative starts are held until the final confirms them; spoken approval edits decline the card
// with the user's change.

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
type Script = (message: string, n: number) => { text: string; delegate?: string };

function harness(o: { script?: Script; roster?: string[] | null; group?: boolean; enabled?: boolean; pending?: ApprovalCardView[]; chat?: TranscriptEntry[] } = {}) {
  const entries: TranscriptEntry[] = [...(o.chat ?? [])];
  const typing: (string | null)[] = [];
  const wakes: WakeSpec[] = [];
  const resolved: [string, string, string | undefined][] = [];
  const sessions: ScriptedFrontSession[] = [];
  const specs: FrontSpec[] = [];
  let turnNo = 10;
  let seq = 0;
  const bot = { id: "nova", group: o.group ? { memberIds: [] } : undefined, profile: { name: "Nova", title: "Chief of Staff", description: "Warm, quick, a little dry.", model: "claude-sonnet-5" } } as unknown as BotSummary;
  const script: Script = o.script ?? ((m) => ({ text: /text sam/i.test(m) ? "Sure, texting Sam now." : "Hey! Doing well, you?", ...(/text sam/i.test(m) ? { delegate: "Text Sam Lee: I'm running late" } : {}) }));
  const fronts = new VoiceFronts({
    bots: {
      has: (id) => id === "nova", summary: () => bot,
      appendEntry: (_id, e) => { entries.push(e); },
      publishTyping: (_id, t, p) => { if (t) typing.push(p); },
      tail: () => entries,
      nextTurnNo: () => ++turnNo,
    },
    runner: {
      recordVoiceUtterance: (_b, text, nonce) => { const id = `t${++seq}u`; entries.push({ kind: "message", id, role: "user", content: text, clientNonce: nonce, createdAt: 0, voice: { durationMs: 0, call: true } } as TranscriptEntry); return { entryId: id }; },
      enqueueWake: (_b, spec) => { wakes.push(spec); return `w${wakes.length}`; },
    },
    gate: { pending: () => o.pending ?? [], resolve: (_b, id, choice, note) => { resolved.push([id, choice, note]); return "denied"; } },
    calls: { roster: () => (o.roster === undefined ? ["nova"] : o.roster) },
    factory: (spec) => { specs.push(spec); const s = new ScriptedFrontSession(spec, script); sessions.push(s); return s; },
    enabled: () => o.enabled ?? true,
    recall: (_b, t) => (/sam/i.test(t) ? "<system_reminder><recalled_memory>\n- Sam Lee is the user's brother.\n</recalled_memory></system_reminder>" : null),
    userName: () => "Alex",
    now: () => 0,
  });
  const botTexts = () => entries.flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [{ requestId: e.requestId, message: { content: e.message.content } }] : []));
  return { fronts, entries, typing, wakes, resolved, sessions, specs, botTexts };
}

describe("the voice answers on a 1:1 call (no full-session turn)", () => {
  it("handles only a spoken post on a live 1:1 call with the fast path on", () => {
    expect(harness().fronts.handles("nova", { call: true })).toBe(true);
    expect(harness().fronts.handles("nova", { call: false })).toBe(false);
    expect(harness().fronts.handles("nova", null)).toBe(false);
    expect(harness({ roster: null }).fronts.handles("nova", { call: true })).toBe(false);
    expect(harness({ roster: ["nova", "bo"] }).fronts.handles("nova", { call: true })).toBe(false);
    expect(harness({ group: true }).fronts.handles("nova", { call: true })).toBe(false);
    expect(harness({ enabled: false }).fronts.handles("nova", { call: true })).toBe(false);
  });

  it("a call start warms the voice: the Bot's own model, a tiny prompt with its persona and the user's name", () => {
    const h = harness();
    h.fronts.callChanged("nova");
    expect(h.sessions).toHaveLength(1);
    expect(h.specs[0]!.model).toBe("claude-sonnet-5");
    expect(h.specs[0]!.system).toContain("You are Nova, on a live voice call with Alex.");
    expect(h.specs[0]!.system).toContain("Chief of Staff");
    expect(h.specs[0]!.system.length).toBeLessThan(2_600);
  });

  it("the prompt asks for prose that can be spoken: short sentences, commas to breathe, no long lists or asides", () => {
    const h = harness();
    h.fronts.callChanged("nova");
    const system = h.specs[0]!.system;
    expect(system).toContain("short sentences");
    expect(system).toContain("comma wherever you would take a breath");
    expect(system).toMatch(/no more than three|Never more than three/);
    expect(system).toMatch(/no parentheses|no parentheticals/i);
    // Two lines, not a second prompt: the whole thing stays inside the same tiny budget.
    expect(system.length).toBeLessThan(2_600);
  });

  it("an utterance: recorded in the chat, streamed as typing, then the voice's reply lands as the Bot's message", async () => {
    const h = harness();
    h.fronts.callChanged("nova");
    h.fronts.userPost("nova", "how are you", "n1");
    await flush();
    expect(h.entries[0]).toMatchObject({ kind: "message", content: "how are you" });
    expect(h.typing).toContain("Hey! Doing well, you?");
    expect(h.botTexts().map((e) => e.message.content)).toEqual(["Hey! Doing well, you?"]);
    expect(h.botTexts()[0]!.requestId.startsWith(FRONT_REQUEST_PREFIX)).toBe(true);
    expect(h.wakes).toEqual([]);
  });

  it("the first message carries the chat just before the call and the memory recall; later ones don't repeat the chat", async () => {
    const h = harness({ chat: [{ kind: "message", id: "t1u", role: "user", content: "remind me about Sam's birthday", createdAt: 0 } as TranscriptEntry] });
    h.fronts.callChanged("nova");
    h.fronts.userPost("nova", "text Sam that I'm late", "n1");
    await flush();
    h.fronts.userPost("nova", "thanks", "n2");
    await flush();
    const [m1, m2] = h.sessions[0]!.messages;
    expect(m1).toContain("[earlier]\nUser: remind me about Sam's birthday");
    expect(m1).toContain("[recall]\n- Sam Lee is the user's brother.");
    expect(m1).not.toContain("recalled_memory");
    expect(m1!.endsWith("User: text Sam that I'm late")).toBe(true);
    // The texting task is still open (its report hasn't come back): plan item 20 says so, in one short line.
    expect(m2).toBe("[working] Text Sam Lee: I'm running late\nUser: thanks");
  });
});

describe("delegation: the full session does the work, the voice speaks the result", () => {
  it("delegate → a voice-delegate wake on the full session; its report comes back and is said by the voice", async () => {
    const h = harness({ script: (m) => (m.startsWith("[result]") ? { text: "Done, Sam has it." } : { text: "Sure, texting Sam now.", delegate: "Text Sam Lee: I'm running late" }) });
    h.fronts.callChanged("nova");
    h.fronts.userPost("nova", "text Sam that I'm running late", "n1");
    await flush();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]).toMatchObject({ source: "voice-delegate", lane: "user", voiceCall: true, silenceAllowed: false });
    expect((h.wakes[0]!.prompt()[0] as { text: string }).text).toContain("Task: Text Sam Lee: I'm running late");
    h.wakes[0]!.onSettle!({ sentTexts: ["Sent to Sam Lee: I'm running late."] } as never, { aborted: false } as TurnResult);
    await flush();
    expect(h.sessions[0]!.messages[1]).toBe("[result] Sent to Sam Lee: I'm running late.");
    expect(h.botTexts().map((e) => e.message.content)).toEqual(["Sure, texting Sam now.", "Done, Sam has it."]);
    expect(h.fronts.stats("nova")).toMatchObject({ delegations: 1, turns: 2 });
  });

  it("a failed task is reported as such; a report after hang-up isn't spoken (the chat has it)", async () => {
    const h = harness({ script: (m) => (m.startsWith("[result]") ? { text: "That didn't work." } : { text: "On it.", delegate: "Open Calendar" }) });
    h.fronts.callChanged("nova");
    h.fronts.userPost("nova", "open my calendar", "n1");
    await flush();
    h.wakes[0]!.onSettle!({ sentTexts: [] } as never, { aborted: false, error: { code: "BOT-MODEL", message: "The Mac isn't connected.", retryable: false, trayTitle: "" } } as TurnResult);
    await flush();
    expect(h.sessions[0]!.messages[1]).toBe("[result] It didn't work: The Mac isn't connected.");
    h.fronts.userPost("nova", "open my calendar again", "n2");
    await flush();
    h.fronts.callEnded("nova");
    h.wakes[1]!.onSettle!({ sentTexts: ["Opened."] } as never, { aborted: false } as TurnResult);
    await flush();
    expect(h.sessions[0]!.messages).toHaveLength(3);
  });

  it("the call so far rides the full session's next turn, once", async () => {
    const h = harness();
    h.fronts.callChanged("nova");
    h.fronts.userPost("nova", "how are you", "n1");
    await flush();
    const sync = h.fronts.takeUnsynced("nova")!;
    expect(sync).toContain("User: how are you");
    expect(sync).toContain("Nova (voice): Hey! Doing well, you?");
    expect(h.fronts.takeUnsynced("nova")).toBeNull();
  });
});

describe("speculative start (at most one a user turn)", () => {
  it("held until the final confirms the same words: nothing is shown or delegated early, then it all goes at once", async () => {
    const h = harness();
    h.fronts.callChanged("nova");
    expect(h.fronts.speculate("nova", "s1", "Text Sam that I'm late.")).toEqual({ started: true });
    await flush();
    expect(h.typing).toEqual([]);
    expect(h.botTexts()).toEqual([]);
    expect(h.wakes).toEqual([]); // a held delegation never runs before the user has finished
    h.fronts.userPost("nova", "text Sam that I'm late", "n1", { speculationId: "s1" });
    await flush();
    expect(h.botTexts().map((e) => e.message.content)).toEqual(["Sure, texting Sam now."]);
    expect(h.wakes).toHaveLength(1);
    expect(h.sessions[0]!.messages).toHaveLength(1); // one model call, started early
    expect(h.fronts.stats("nova")).toMatchObject({ speculations: 1, speculationsCommitted: 1, speculationsCanceled: 0, canceledTokens: 0 });
  });

  it("the user kept talking: the early reply is dropped (tokens counted), never shown, and the voice is told", async () => {
    const h = harness();
    h.fronts.callChanged("nova");
    h.fronts.speculate("nova", "s1", "Text Sam.");
    await flush();
    h.fronts.cancelSpeculation("nova", "s1");
    h.fronts.userPost("nova", "text Sam that I'm running late", "n1");
    await flush();
    expect(h.botTexts()).toHaveLength(1);
    expect(h.wakes).toHaveLength(1);
    const st = h.fronts.stats("nova")!;
    expect(st).toMatchObject({ speculations: 1, speculationsCanceled: 1 });
    expect(st.canceledTokens).toBeGreaterThan(0);
    expect(h.sessions[0]!.messages[1]).toContain("since your last heard reply");
  });

  it("a final with different words cancels the early start even without an explicit cancel", async () => {
    const h = harness();
    h.fronts.callChanged("nova");
    h.fronts.speculate("nova", "s1", "How are you.");
    h.fronts.userPost("nova", "how are you doing today", "n1", { speculationId: "s1" });
    await flush();
    expect(h.fronts.stats("nova")).toMatchObject({ speculationsCanceled: 1, speculationsCommitted: 0 });
    expect(h.botTexts()).toHaveLength(1);
  });
});

describe("spoken approvals that aren't a plain yes / no", () => {
  const card = { approvalId: "a1", summary: "Send a message to Sam Lee: “I'm 5 minutes late”", status: "pending" } as ApprovalCardView;

  it("the voice sees the pending card; its delegate becomes a decline carrying the change (no new task)", async () => {
    const h = harness({ pending: [card], script: (m) => (m.includes("[approval]") ? { text: "Got it, ten minutes. I'll read it back.", delegate: "Say 10 minutes instead of 5" } : { text: "ok" }) });
    h.fronts.callChanged("nova");
    h.fronts.userPost("nova", "make it ten minutes", "n1");
    await flush();
    expect(h.sessions[0]!.messages[0]).toContain("[approval] Waiting for the user's OK: Send a message to Sam Lee: “I'm 5 minutes late”");
    expect(h.resolved).toEqual([["a1", "deny", "Say 10 minutes instead of 5"]]);
    expect(h.wakes).toEqual([]);
    expect(h.fronts.stats("nova")!.edits).toBe(1);
  });
});

describe("the voice failing never leaves the call silent", () => {
  it("one retry on a fresh voice; if that fails too, the full session answers and its own words are spoken", async () => {
    let fail = 2;
    const h = harness({ script: () => (fail-- > 0 ? { text: "" } : { text: "Back with you." }) });
    h.fronts.callChanged("nova");
    h.fronts.userPost("nova", "are you there", "n1");
    await flush();
    // Two attempts made nothing to say, so the full session was asked instead.
    expect(h.sessions[0]!.messages).toHaveLength(2);
    expect(h.botTexts()).toEqual([]);
    expect(h.wakes).toHaveLength(1);
    expect((h.wakes[0]!.prompt()[0] as { text: string }).text).toContain("are you there");
    h.wakes[0]!.onSettle!({ sentTexts: ["Yes — I'm here."] } as never, { aborted: false } as TurnResult);
    await flush();
    // Spoken as it is (no model call left to relay it).
    expect(h.botTexts().map((e) => e.message.content)).toEqual(["Yes — I'm here."]);
    expect(h.sessions[0]!.messages).toHaveLength(2);
  });
});

describe("a long call stays small", () => {
  it("after 40 turns the voice starts fresh with the latest lines", async () => {
    const h = harness();
    h.fronts.callChanged("nova");
    for (let i = 0; i < 41; i++) { h.fronts.userPost("nova", `line ${i}`, `n${i}`); await flush(); }
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0]!.alive).toBe(false);
    expect(h.sessions[1]!.messages[0]).toContain("[earlier]");
    expect(h.sessions[1]!.messages[0]).toContain("User: line 39");
    expect(h.sessions[1]!.messages[0]!.length).toBeLessThan(3_300);
  });
});
