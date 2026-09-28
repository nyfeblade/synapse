// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";
import { Transcript } from "../../src/renderer/components/Transcript";

// Bug 108: add Bots to ANY call (a 1:1 included) from a dropdown next to the avatar row, up to 6.

const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];
const calls: [string, Record<string, unknown>][] = [];
const VOICES = ["zoe", "ava", "tom", "kate", "lee", "sam"].map((n) => ({ id: `v.${n}`, name: n, lang: "en-US", quality: "premium", siri: false, personal: false }));
const bot = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {}, ...over });
let roster: string[] = [];

beforeEach(() => {
  subs.clear(); invoked.length = 0; calls.length = 0;
  roster = ["n"];
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  const view = () => ({ callId: "call1", chatId: "n", anchorId: "n", participantIds: [...roster] });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
      calls.push([cmd, a]);
      if (cmd === "startCall") return { ok: true, result: view() };
      if (cmd === "addToCall") { roster.push(a.botId as string); return { ok: true, result: view() }; }
      if (cmd === "removeFromCall") { roster = roster.filter((x) => x !== a.botId); return { ok: true, result: view() }; }
      return { ok: true, result: {} };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        return { ok: true, result: n === "dictation.speak" ? { spoken: true } : n === "audio.voices.list" ? { voices: VOICES, chosen: null } : {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
  useUi.setState({ ...initialState(), bots: {
    n: bot("n", "Nova"), l: bot("l", "Ledger"), s: bot("s", "Scout"), p: bot("p", "Piper"), c: bot("c", "Courier"), a: bot("a", "Atlas"), e: bot("e", "Echo"),
    old: bot("old", "Oldie", { archived: true }), g: bot("g", "Trip", { group: { memberIds: ["n", "l"] } }),
  } } as never);
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

const sid = () => invoked.find(([n]) => n === "dictation.start")![1].sessionId;
const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: sid(), ...e }));
const spoken = () => invoked.filter(([n]) => n === "dictation.speak").map(([, a]) => a);
async function openCall() {
  useVoice.getState().open("n");
  render(<VoiceOverlay botId="n" />);
  await vi.waitFor(() => expect(calls.some(([c]) => c === "startCall")).toBe(true));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: STR5.callAddBot })).toBeTruthy());
}
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: STR5.callAddBot }));
const items = () => within(screen.getByRole("menu")).getAllByRole("menuitem").map((b) => b.getAttribute("aria-label"));

describe("Add Bot on the call screen (bug 108)", () => {
  it("a 1:1 call has the + next to the avatar; the dropdown lists only Bots not on the call (no groups, no archived)", async () => {
    await openCall();
    expect(calls).toContainEqual(["startCall", { id: "n" }]);
    openMenu();
    expect(items()).toEqual(["Ledger", "Scout", "Piper", "Courier", "Atlas", "Echo"]);
    // Each row shows the Bot's avatar with its name.
    expect(within(screen.getByRole("menuitem", { name: "Ledger" })).getByText("Ledger")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Ledger" }).querySelector("svg, img, [class*='avatar']")).toBeTruthy();
  });

  it("type to filter, arrow keys + Enter pick, Escape closes only the dropdown (the call stays up)", async () => {
    await openCall();
    openMenu();
    const filter = screen.getByLabelText(STR5.callAddFilter);
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: "c" } });
    expect(items()).toEqual(["Scout", "Courier", "Echo"]);
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "Enter" });
    await vi.waitFor(() => expect(calls).toContainEqual(["addToCall", { callId: "call1", botId: "c" }]));
    openMenu();
    fireEvent.keyDown(screen.getByLabelText(STR5.callAddFilter), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useVoice.getState().openFor).toBe("n");
  });

  it("add and remove mid-call: the joiner's avatar joins the row; × removes it; the Bot the call started with has no ×", async () => {
    await openCall();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Scout" }));
    const row = await vi.waitFor(() => screen.getByRole("list", { name: STR5.callParticipants }));
    await vi.waitFor(() => expect(within(row).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Nova", "Scout"]));
    expect(screen.queryByRole("button", { name: STR5.callRemoveBot("Nova") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: STR5.callRemoveBot("Scout") }));
    await vi.waitFor(() => expect(calls).toContainEqual(["removeFromCall", { callId: "call1", botId: "s" }]));
    await vi.waitFor(() => expect(screen.queryByRole("list", { name: STR5.callParticipants })).toBeNull());
  });

  it("the cap: at 6 Bots the + is disabled with 'Up to 6 Bots on a call'", async () => {
    roster = ["n", "l", "s", "p", "c"];
    await openCall();
    const plus = screen.getByRole("button", { name: STR5.callAddBot }) as HTMLButtonElement;
    expect(plus.disabled).toBe(false);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Atlas" }));
    await vi.waitFor(() => expect((screen.getByRole("button", { name: STR5.callAddBot }) as HTMLButtonElement).disabled).toBe(true));
    const full = screen.getByRole("button", { name: STR5.callAddBot });
    expect(full.getAttribute("title")).toBe("Up to 6 Bots on a call");
    expect(full.parentElement!.getAttribute("title")).toBe("Up to 6 Bots on a call");
    fireEvent.click(full);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("an added Bot speaks in its own voice, after the Bot that has the floor", async () => {
    roster = ["n", "l"];
    await openCall();
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "audio.voices.list")).toBe(true));
    await act(async () => { await Promise.resolve(); });
    fire({ type: "final", text: "Ledger and Nova, what's the budget" }); // bug 134: an unasked Bot would raise a hand instead
    act(() => useUi.setState({ transcripts: { n: [
      { kind: "send-message", id: "e1", createdAt: 3, author: { id: "l", name: "Ledger" }, message: { type: "text", content: "About forty dollars." } },
      { kind: "send-message", id: "e2", createdAt: 4, author: { id: "n", name: "Nova" }, message: { type: "text", content: "That works." } },
    ] } } as never));
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    fire({ type: "speak-end", id: spoken()[0]!.id, interrupted: false });
    await vi.waitFor(() => expect(spoken()).toHaveLength(2));
    expect(spoken()[0]!.text).toBe("About forty dollars."); // bug 153: the full stop goes with the words
    expect(spoken()[0]!.voice).not.toBe(spoken()[1]!.voice);
  });
});

describe("the record (bug 108)", () => {
  it("the call's lines are labeled with the speaking Bot; the joined Bot's note links back to the call's chat", async () => {
    useUi.setState({ transcripts: {
      n: [{ kind: "send-message", id: "e1", createdAt: 3, author: { id: "l", name: "Ledger" }, message: { type: "text", content: "About forty dollars." } }],
      l: [{ kind: "notice", id: "x1", createdAt: 5, text: "Joined a call in Nova · 4m", link: { botId: "n" } }],
    } } as never);
    const { unmount } = render(<Transcript botId="n" />);
    expect(screen.getByText("Ledger")).toBeTruthy();
    unmount();
    const openBot = vi.fn(async () => {});
    useUi.setState({ openBot } as never);
    render(<Transcript botId="l" />);
    fireEvent.click(screen.getByRole("button", { name: "Joined a call in Nova · 4m" }));
    expect(openBot).toHaveBeenCalledWith("n");
  });
});
