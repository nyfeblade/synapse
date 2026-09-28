// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_FEEL, STR5, STRV } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useCallPresence, useCallSlot } from "../../src/renderer/voice/call-presence";
import { useBotCalls } from "../../src/renderer/voice/bot-calls-store";
import { CallHost, useVoice } from "../../src/renderer/voice/VoiceOverlay";

// Bug 134, the call screen's side: the pick-up greeting, voice commands, seats and chimes, raised
// hands on the avatar row, the hang-up wrap-up, and the call shrinking to a pill in other chats.

const subs = new Map<string, (p: unknown) => void>();
const sse = new Set<(e: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];
const calls: [string, Record<string, unknown>][] = [];
const VOICES = ["zoe", "ava", "tom", "kate"].map((n) => ({ id: `v.${n}`, name: n, lang: "en-US", quality: "premium", siri: false, personal: false }));
const bot = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {}, ...over });
const GREETS = { n: [{ text: "Hey, Nova here!" }], l: [{ text: "Hi!" }], s1: [{ text: "Sam R here." }], s2: [{ text: "Sam O here." }] } as Record<string, { text: string }[]>;
let roster: string[] = [];
let wrap: { line: string | null; botId?: string } | "hang" = { line: null };

beforeEach(() => {
  subs.clear(); sse.clear(); invoked.length = 0; calls.length = 0;
  roster = ["n"];
  wrap = { line: null };
  try { window.localStorage.clear(); } catch { /* none */ }
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  const view = () => ({ callId: "call1", chatId: "n", anchorId: "n", participantIds: [...roster] });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
      calls.push([cmd, a]);
      if (cmd === "startCall") return { ok: true, result: view() };
      if (cmd === "addToCall") {
        if (roster.length >= 6) return { ok: false, error: { code: "CALL_FULL", message: STR5.callFull } };
        roster.push(a.botId as string); return { ok: true, result: view() };
      }
      if (cmd === "removeFromCall") { roster = roster.filter((x) => x !== a.botId); return { ok: true, result: view() }; }
      if (cmd === "getCallGreetings") return { ok: true, result: { botId: a.id, greetings: GREETS[a.id as string] ?? [{ text: "Hello." }], version: "v1", authored: true } };
      if (cmd === "wrapUpCall") return wrap === "hang" ? new Promise(() => {}) : { ok: true, result: wrap };
      return { ok: true, result: { entryId: "t1u" } };
    }),
    // Bug 158: the host can change a call's roster by itself (a Bot took another Bot off): the "call-roster" SSE.
    onEvent: (cb: (e: unknown) => void) => { sse.add(cb); return () => sse.delete(cb); },
    onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        return { ok: true, result: n === "dictation.speak" ? { spoken: true } : n === "audio.voices.list" ? { voices: VOICES, chosen: null } : n === "calls.sounds.get" ? { on: true } : {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
  useUi.setState({ ...initialState(), view: { kind: "chat", botId: "n" }, bots: {
    n: bot("n", "Nova"), l: bot("l", "Ledger"), s1: bot("s1", "Sam Rivera"), s2: bot("s2", "Sam Okafor"), z: bot("z", "Zed"),
    b3: bot("b3", "Bea"), b4: bot("b4", "Bo"), b5: bot("b5", "Cy"),
  } } as never);
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); vi.useRealTimers(); });

const sid = () => invoked.find(([n]) => n === "dictation.start")![1].sessionId;
const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: sid(), ...e }));
const spoken = () => invoked.filter(([n]) => n === "dictation.speak").map(([, a]) => a);
const sent = () => calls.filter(([c]) => c === "sendPrompt").map(([, a]) => a.text);
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
async function openCall() {
  useVoice.getState().open("n");
  render(<CallHost />);
  await vi.waitFor(() => expect(calls.some(([c]) => c === "startCall")).toBe(true));
  await vi.waitFor(() => expect(calls.some(([c, a]) => c === "getCallGreetings" && a.id === "n")).toBe(true));
  await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.list")).toBe(true));
  await flush();
}

describe("pick-up greeting (item 1)", () => {
  it("the helper is up → the Bot answers at once with one of its own greetings, from the Mac's cache when rendered; nothing is sent to the host", async () => {
    await openCall();
    fire({ type: "ready" });
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    expect(spoken()[0]).toMatchObject({ text: "Hey, Nova here!", cache: true });
    expect(sent()).toEqual([]);
    expect(screen.getByText("Hey, Nova here!")).toBeTruthy(); // captioned
    fire({ type: "ready" }); // a helper restart mid-call doesn't greet again
    await flush();
    expect(spoken()).toHaveLength(1);
  });

  it("a call the Bot placed opens with its reason instead (no greeting)", async () => {
    useBotCalls.setState({ opening: { botId: "n", text: "The deploy is done.", acceptedAt: performance.now() } });
    await openCall();
    fire({ type: "ready" });
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    expect(spoken()[0]!.text).toBe("The deploy is done.");
  });
});

describe("voice commands on a call", () => {
  it("'add Ledger': the join chime, the host adds it, Ledger says a short hello; the command is never a turn", async () => {
    await openCall();
    fire({ type: "final", text: "can you add Ledger" });
    await vi.waitFor(() => expect(calls).toContainEqual(["addToCall", { callId: "call1", botId: "l" }]));
    await vi.waitFor(() => expect(invoked.some(([n, a]) => n === "dictation.chime" && a.kind === "join")).toBe(true));
    await vi.waitFor(() => expect(spoken().some((s) => s.text === "Hi!")).toBe(true));
    expect(sent()).toEqual([]);
  });

  it("'hang up on Ledger' removes it with the leave chime", async () => {
    roster = ["n", "l"];
    await openCall();
    fire({ type: "final", text: "hang up on Ledger" });
    await vi.waitFor(() => expect(calls).toContainEqual(["removeFromCall", { callId: "call1", botId: "l" }]));
    await vi.waitFor(() => expect(invoked.some(([n, a]) => n === "dictation.chime" && a.kind === "leave")).toBe(true));
    expect(sent()).toEqual([]);
  });

  // Bug 158: every phrasing of "take this one off", the leave sound and the spoken confirmation.
  it("every remove phrasing works, each with the leave sound and one spoken line naming who left", async () => {
    for (const [text, name] of [["drop Ledger", "Ledger"], ["hang up on Ledger", "Ledger"], ["remove Ledger", "Ledger"],
      ["Ledger, you can go", "Ledger"], ["thanks Ledger, you're good", "Ledger"]] as const) {
      roster = ["n", "l"];
      await openCall();
      const at = invoked.length;
      calls.length = 0;
      fire({ type: "final", text });
      await vi.waitFor(() => expect(calls, text).toContainEqual(["removeFromCall", { callId: "call1", botId: "l" }]));
      await vi.waitFor(() => expect(invoked.slice(at).some(([n, a]) => n === "dictation.chime" && a.kind === "leave"), text).toBe(true));
      await vi.waitFor(() => expect(invoked.slice(at).some(([n, a]) => n === "dictation.speak" && a.text === STRV.botLeftCall(name)), text).toBe(true));
      expect(sent(), text).toEqual([]); // never a turn, never a token
      act(() => useVoice.getState().close());
      cleanup();
      subs.clear(); invoked.length = 0;
    }
  });

  it("the command lands while a DIFFERENT Bot is speaking: the user talks over it and the Bot still goes", async () => {
    roster = ["n", "l", "s1"];
    await openCall();
    fire({ type: "final", text: "Ledger, what's the budget" });
    act(() => useUi.setState({ transcripts: { n: [
      { kind: "send-message", id: "e1", createdAt: 3, author: { id: "l", name: "Ledger" }, message: { type: "text", content: "About forty dollars. There is more to say about it." } },
    ] } } as never));
    await vi.waitFor(() => expect(spoken().length).toBeGreaterThanOrEqual(1));
    calls.length = 0;
    // Over the top of Ledger's answer: the helper reports the barge-in, then the words.
    fire({ type: "speech-start" });
    fire({ type: "partial", text: "drop Sam Rivera" });
    fire({ type: "final", text: "drop Sam Rivera" });
    await vi.waitFor(() => expect(calls).toContainEqual(["removeFromCall", { callId: "call1", botId: "s1" }]));
    await vi.waitFor(() => expect(spoken().some((s) => s.text === STRV.botLeftCall("Sam Rivera"))).toBe(true));
    expect(sent()).toEqual([]);
  });

  it("a Bot on the call took another Bot off it (the host's call-roster event): the row and the call follow", async () => {
    roster = ["n", "l", "s1"];
    await openCall();
    act(() => { for (const cb of sse) cb({ channel: "call-roster", payload: { callId: "call1", chatId: "n", anchorId: "n", participantIds: ["n", "l"] } }); });
    await vi.waitFor(() => expect(invoked.some(([n, a]) => n === "dictation.chime" && a.kind === "leave")).toBe(true));
    await vi.waitFor(() => expect(spoken().some((s) => s.text === STRV.botLeftCall("Sam Rivera"))).toBe(true));
    expect(screen.queryByRole("listitem", { name: "Sam Rivera" })).toBeNull();
  });

  it("an ambiguous name asks on screen with chips; no match is said out loud", async () => {
    await openCall();
    fire({ type: "final", text: "call Sam" });
    const chips = await screen.findByRole("group", { name: STRV.pickBotToAdd });
    fireEvent.click(chips.querySelector("button")!);
    await vi.waitFor(() => expect(calls).toContainEqual(["addToCall", { callId: "call1", botId: "s1" }]));
    fire({ type: "final", text: "call Zebediah" });
    await vi.waitFor(() => expect(spoken().some((s) => s.text === STRV.noBotCalled("Zebediah").replace(/\.$/, "") || s.text === STRV.noBotCalled("Zebediah"))).toBe(true));
    expect(sent()).toEqual([]);
  });

  it("the call is full at 6: the host's message is said, nothing is added", async () => {
    roster = ["n", "l", "s1", "s2", "z", "b3"];
    await openCall();
    fire({ type: "final", text: "bring in Cy" });
    await vi.waitFor(() => expect(spoken().some((s) => String(s.text).startsWith("Up to 6 Bots"))).toBe(true));
    expect(roster).toHaveLength(6);
  });
});

// Bug 158: taking ONE Bot off by hand, on both surfaces the call has.
describe("removing one Bot by hand (bug 158)", () => {
  const removeLabel = (name: string) => STR5.callRemoveBot(name);
  const goAway = () => act(() => { useUi.setState({ view: { kind: "chat", botId: "l" }, openBot: vi.fn(async () => {}) } as never); useCallSlot.getState().set(null, "l"); });

  it("the call screen: an × on the avatar removes that Bot, and right-click offers 'Remove from call'", async () => {
    roster = ["n", "l"];
    await openCall();
    const row = await screen.findByRole("list", { name: STR5.callParticipants });
    // The × is a real, labelled, keyboard-reachable button (the CSS reveals it on hover and on focus).
    const x = screen.getByRole("button", { name: removeLabel("Ledger") });
    expect(x.tagName).toBe("BUTTON");
    expect(x.getAttribute("title")).toBe(removeLabel("Ledger"));
    // Right-click the member: the same act, from a menu.
    fireEvent.contextMenu(within(row).getByRole("listitem", { name: "Ledger" }));
    const menu = await screen.findByRole("menu", { name: STR5.callBotActions("Ledger") });
    fireEvent.click(within(menu).getByRole("menuitem", { name: STR5.callRemoveFromCall }));
    await vi.waitFor(() => expect(calls).toContainEqual(["removeFromCall", { callId: "call1", botId: "l" }]));
  });

  it("the call screen: the × alone removes, and the keyboard's menu gesture opens the same menu", async () => {
    roster = ["n", "l"];
    await openCall();
    const x = screen.getByRole("button", { name: removeLabel("Ledger") });
    fireEvent.keyDown(x, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: STR5.callBotActions("Ledger") })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: removeLabel("Ledger") }));
    await vi.waitFor(() => expect(calls).toContainEqual(["removeFromCall", { callId: "call1", botId: "l" }]));
  });

  it("the Bot the call started with has no × and no menu — its avatar says to hang up instead", async () => {
    roster = ["n", "l"];
    await openCall();
    expect(screen.queryByRole("button", { name: removeLabel("Nova") })).toBeNull();
    const nova = screen.getByRole("listitem", { name: "Nova" });
    expect(nova.getAttribute("title")).toBe(STR5.callCantRemoveAnchor("Nova"));
    fireEvent.contextMenu(nova);
    expect(screen.queryByRole("menu")).toBeNull();
    // And the pill says the same thing.
    goAway();
    await screen.findByTestId("mini-call");
    expect(screen.queryByRole("button", { name: removeLabel("Nova") })).toBeNull();
    expect(screen.getByTitle(STR5.callCantRemoveAnchor("Nova"))).toBeTruthy();
    expect(calls.some(([c]) => c === "removeFromCall")).toBe(false);
  });

  it("the mini pill: the same × and the same right-click menu, without going back to the call", async () => {
    roster = ["n", "l"];
    await openCall();
    goAway();
    await screen.findByTestId("mini-call");
    fireEvent.contextMenu(screen.getByTitle("Ledger"));
    const menu = await screen.findByRole("menu", { name: STR5.callBotActions("Ledger") });
    fireEvent.click(within(menu).getByRole("menuitem", { name: STR5.callRemoveFromCall }));
    await vi.waitFor(() => expect(calls).toContainEqual(["removeFromCall", { callId: "call1", botId: "l" }]));
    expect(useVoice.getState().openFor).toBe("n"); // the call is still up
  });

  it("the mini pill: the × removes that Bot and nothing else", async () => {
    roster = ["n", "l"];
    await openCall();
    goAway();
    await screen.findByTestId("mini-call");
    const x = screen.getByRole("button", { name: removeLabel("Ledger") });
    expect(x.getAttribute("title")).toBe(removeLabel("Ledger"));
    fireEvent.click(x);
    await vi.waitFor(() => expect(calls).toContainEqual(["removeFromCall", { callId: "call1", botId: "l" }]));
    expect(calls.some(([c]) => c === "endCall")).toBe(false);
  });
});

describe("a group call's seats and sounds (items 5, 8)", () => {
  it("2+ Bots (bug 213): each line carries its Bot's seat angle and whose seat it is; the helper is never asked to rebuild", async () => {
    roster = ["n", "l"];
    await openCall();
    fire({ type: "final", text: "Nova and Ledger, thoughts?" });
    act(() => useUi.setState({ transcripts: { n: [
      { kind: "send-message", id: "e1", createdAt: 3, author: { id: "n", name: "Nova" }, message: { type: "text", content: "Ship it." } },
      { kind: "send-message", id: "e2", createdAt: 4, author: { id: "l", name: "Ledger" }, message: { type: "text", content: "Agreed." } },
    ] } } as never));
    await vi.waitFor(() => expect(spoken().some((s) => s.text === "Ship it.")).toBe(true));
    const ship = spoken().find((s) => s.text === "Ship it.")!;
    fire({ type: "speak-end", id: ship.id, interrupted: false });
    await vi.waitFor(() => expect(spoken().some((s) => s.text === "Agreed.")).toBe(true));
    expect(ship).toMatchObject({ azimuth: -30, seat: "n" });
    expect(spoken().find((s) => s.text === "Agreed.")).toMatchObject({ azimuth: 30, seat: "l" });
    // The helper learns which Bots hold seats (a Bot that leaves frees its headphone player).
    expect(invoked.some(([n, a]) => n === "dictation.seats" && JSON.stringify(a.ids) === JSON.stringify(["n", "l"]))).toBe(true);
  });

  // Review round 1: a 1:1 call is exactly as before; stereo only for a group call.
  it("a group chat's call starts the helper spatial at once — no rebuild later", async () => {
    roster = ["n", "l"];
    useUi.setState((s) => ({ bots: { ...s.bots, g: bot("g", "Team", { group: { memberIds: ["n", "l"] } }) } }) as never);
    useVoice.getState().open("g");
    render(<CallHost />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    expect(invoked.find(([n]) => n === "dictation.start")![1].spatial).toBe(true);
    await vi.waitFor(() => expect(calls.some(([c]) => c === "startCall")).toBe(true));
    await flush();
    expect(invoked.some(([n]) => n === "dictation.spatial")).toBe(false);
  });

  it("a call started with others to bring in (palette / wake word) starts spatial too", async () => {
    useVoice.getState().open("n", ["z"]);
    render(<CallHost />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    expect(invoked.find(([n]) => n === "dictation.start")![1].spatial).toBe(true);
    await vi.waitFor(() => expect(calls).toContainEqual(["addToCall", { callId: "call1", botId: "z" }]));
    await flush();
    expect(invoked.some(([n]) => n === "dictation.spatial")).toBe(false);
  });

  it("a 1:1 call is exactly as before (no seat, not spatial); a Bot joining rebuilds once; a Bot leaving never goes back", async () => {
    await openCall();
    expect(invoked.find(([n]) => n === "dictation.start")![1].spatial).toBeFalsy();
    fire({ type: "ready" });
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    expect(spoken()[0]!.azimuth).toBeUndefined();
    expect(spoken()[0]!.seat).toBeUndefined();
    fire({ type: "final", text: "add Ledger" });
    await vi.waitFor(() => expect(calls).toContainEqual(["addToCall", { callId: "call1", botId: "l" }]));
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.spatial")).toEqual([["dictation.spatial", expect.objectContaining({ on: true })]]));
    fire({ type: "final", text: "drop Ledger" });
    await vi.waitFor(() => expect(calls).toContainEqual(["removeFromCall", { callId: "call1", botId: "l" }]));
    await flush();
    expect(invoked.filter(([n]) => n === "dictation.spatial")).toHaveLength(1);
  });

  it("'call A and B' while a call is already open brings them into that call", async () => {
    await openCall();
    act(() => useVoice.getState().bringIn(["z", "n"]));
    await vi.waitFor(() => expect(calls).toContainEqual(["addToCall", { callId: "call1", botId: "z" }]));
    await flush();
    expect(calls.filter(([c, a]) => c === "addToCall" && a.botId === "n")).toEqual([]); // already on it
  });

  it("the avatars are drawn in seat order, so the picture matches the sound: a third Bot sits between the first two", async () => {
    roster = ["n", "l"];
    await openCall();
    const names = () => within(screen.getByRole("list", { name: STR5.callParticipants })).getAllByRole("listitem").map((x) => x.getAttribute("aria-label"));
    expect(names()).toEqual(["Nova", "Ledger"]);
    fire({ type: "final", text: "bring in Zed" });
    await vi.waitFor(() => expect(names()).toEqual(["Nova", "Zed", "Ledger"]));
    // …and its voice is the centre seat, Nova's the left, Ledger's the right.
    fire({ type: "final", text: "Zed, go" });
    act(() => useUi.setState({ transcripts: { n: [
      { kind: "send-message", id: "z1", createdAt: 5, author: { id: "z", name: "Zed" }, message: { type: "text", content: "On it." } },
    ] } } as never));
    await vi.waitFor(() => expect(spoken().some((s) => s.text === "On it.")).toBe(true));
    expect(spoken().find((s) => s.text === "On it.")).toMatchObject({ azimuth: 0, seat: "z" });
  });

  it("a call opened with others to bring in (the palette's 'call Nova and Zed'): they join as soon as it connects", async () => {
    useVoice.getState().open("n", ["z", "b3"]);
    render(<CallHost />);
    await vi.waitFor(() => expect(calls.filter(([c]) => c === "addToCall").map(([, a]) => a.botId)).toEqual(["z", "b3"]));
    expect(calls.findIndex(([c]) => c === "startCall")).toBeLessThan(calls.findIndex(([c]) => c === "addToCall"));
    const names = () => within(screen.getByRole("list", { name: STR5.callParticipants })).getAllByRole("listitem").map((x) => x.getAttribute("aria-label"));
    await vi.waitFor(() => expect(names()).toEqual(["Nova", "Bea", "Zed"]));
    expect(useVoice.getState().adding).toEqual([]);
  });

  it("'bring in Zed and Bea' adds both with one utterance", async () => {
    await openCall();
    fire({ type: "final", text: "bring in Zed and Bea" });
    await vi.waitFor(() => expect(calls).toContainEqual(["addToCall", { callId: "call1", botId: "z" }]));
    await vi.waitFor(() => expect(calls).toContainEqual(["addToCall", { callId: "call1", botId: "b3" }]));
    expect(sent()).toEqual([]);
  });

  it("the helper opened the Mac's mic to keep a headset in stereo: one short line says so", async () => {
    await openCall();
    fire({ type: "mic-choice", input: { uid: "BuiltIn", name: "MacBook Pro Microphone" }, instead: { uid: "AP", name: "AirPods Pro" }, reason: "keep-stereo" });
    expect(screen.getByText(STR5.micKeepsStereo)).toBeTruthy();
  });

  it("a Bot that wasn't asked raises a hand on its avatar; clicking it gives it the floor", async () => {
    roster = ["n", "l"];
    await openCall();
    fire({ type: "final", text: "Nova, status?" });
    act(() => useUi.setState({ transcripts: { n: [
      { kind: "send-message", id: "e1", createdAt: 3, author: { id: "n", name: "Nova" }, message: { type: "text", content: "All green." } },
      { kind: "send-message", id: "e2", createdAt: 4, author: { id: "l", name: "Ledger" }, message: { type: "text", content: "One thing on budget." } },
    ] } } as never));
    const hand = await screen.findByRole("button", { name: new RegExp(STRV.handRaised("Ledger")) });
    fireEvent.click(hand);
    fire({ type: "speak-end", id: spoken()[0]!.id, interrupted: false });
    await vi.waitFor(() => expect(spoken().some((s) => s.text === "One thing on budget.")).toBe(true));
  });
});

describe("hang-up wrap-up (item 4)", () => {
  it("a substantial call: the Bot says its one-line wrap-up, then the call ends; the host posts the summary", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wrap = { line: "So I'll book Thursday and send the invoices.", botId: "n" };
    await openCall();
    await act(async () => { vi.advanceTimersByTime(CALL_FEEL.wrapUpMinMs + 5_000); });
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(useVoice.getState().openFor).toBe("n");
    expect(screen.getByTestId("voice-state").textContent).toBe(STRV.wrappingUp);
    await vi.waitFor(() => expect(spoken().some((s) => String(s.text).startsWith("So I'll book Thursday"))).toBe(true));
    const line = spoken().find((s) => String(s.text).startsWith("So I'll book"))!;
    expect(calls.map(([c]) => c)).toEqual(expect.arrayContaining(["endCall", "wrapUpCall"]));
    fire({ type: "speak-end", id: line.id, interrupted: false });
    await vi.waitFor(() => expect(useVoice.getState().openFor).toBeNull());
  });

  it("a short call just ends (no wrap-up, no model call); a second press ends a slow wrap-up at once", async () => {
    await openCall();
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(useVoice.getState().openFor).toBeNull();
    expect(calls.some(([c]) => c === "wrapUpCall")).toBe(false);
    cleanup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wrap = "hang";
    await openCall();
    await act(async () => { vi.advanceTimersByTime(CALL_FEEL.wrapUpMinMs + 1_000); });
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(useVoice.getState().openFor).toBe("n");
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(useVoice.getState().openFor).toBeNull();
  });
});

describe("the call keeps running in other chats, as a pill (item 10)", () => {
  it("another chat → a pill (mute, hang up, back); coming back is the same call, not a new one", async () => {
    const main = document.createElement("main");
    document.body.appendChild(main);
    act(() => useCallSlot.getState().set(main, "n"));
    await openCall();
    expect(main.querySelector('[role="dialog"]')).toBeTruthy(); // the full screen, in the call's chat pane
    expect(useCallPresence.getState()).toMatchObject({ chatId: "n", members: ["n"] });
    const openBot = vi.fn(async (id: string) => { useUi.setState({ view: { kind: "chat", botId: id } } as never); });
    act(() => { useUi.setState({ view: { kind: "chat", botId: "l" }, openBot } as never); useCallSlot.getState().set(null, "l"); });
    const pill = await screen.findByTestId("mini-call");
    expect(pill.textContent).toContain("Nova");
    fireEvent.click(screen.getByRole("button", { name: STR5.voiceMute }));
    expect(invoked.some(([n, a]) => n === "dictation.mute" && a.muted === true)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: STRV.returnToCall("Nova") }));
    expect(openBot).toHaveBeenCalledWith("n");
    act(() => useCallSlot.getState().set(main, "n"));
    await vi.waitFor(() => expect(main.querySelector('[role="dialog"]')).toBeTruthy());
    expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1);
    main.remove();
  });
});
