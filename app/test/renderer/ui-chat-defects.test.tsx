// @vitest-environment jsdom
/**
 * Hand-testing round: "the UI is very very buggy / a lot of the buttons do random things".
 * One test per confirmed defect on the sidebar + chat-transcript surface.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR5, type BotSummary, type SendMessageEntry, type ToolCallEntry, type TranscriptEntry, type UserMessageEntry } from "@synapse/shared";
import { ActivityGroup } from "../../src/renderer/components/ActivityGroup";
import { MessageActions } from "../../src/renderer/components/MessageActions";
import { Menu } from "../../src/renderer/components/Menus";
import { Reactions } from "../../src/renderer/components/Reactions";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { Transcript } from "../../src/renderer/components/Transcript";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { buildTranscriptItems, type TranscriptItem } from "../../src/renderer/transcript-items";
import { installFakeBridge } from "./fake-bridge";

const bot = (id: string, name: string, over: Partial<BotSummary> = {}): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name, title: "", description: "", avatarShape: "pebble", avatarColor: "#3472d9", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

const userMsg: UserMessageEntry = { kind: "message", id: "t1u", role: "user", content: "clear out my inbox", createdAt: 2 };
const botMsg: SendMessageEntry = { kind: "send-message", id: "t1s1", requestId: "req_1", createdAt: 3, message: { type: "text", content: "Done." } };

const scrolled: string[] = [];
let bridge: ReturnType<typeof installFakeBridge>;
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this.id || "(sentinel)"); });
  bridge = installFakeBridge({ openAgent: (a: unknown) => ({ agent: bot((a as { id: string }).id, "Opened") }), getAgentTranscriptTail: { entries: [] } });
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, userName: "alex" });
});
afterEach(cleanup);

// ── Defect 1 ────────────────────────────────────────────────────────────────
// A Bot can react to the user's message (the ReactToMessage tool stores `{ emoji, by: botId }`),
// so a chip with no "user" reaction in it is a normal state. The chip rendered as an enabled
// button with hover/active styling but its onClick short-circuited on `g.mine`, so it was inert.
describe("Defect 1: a reaction chip the user did not add", () => {
  it("still toggles the user's own reaction when clicked", () => {
    const entry: SendMessageEntry = { ...botMsg, reactions: [{ emoji: "🎉", by: "bot_scout" }] };
    render(<Reactions botId="b" entry={entry} />);
    fireEvent.click(screen.getByRole("button", { name: "🎉 1" }));
    expect(bridge.calls.at(-1)).toEqual(["reactToMessage", { id: "b", entryId: "t1s1", emoji: "🎉" }]);
  });
});

// ── Defect 2 ────────────────────────────────────────────────────────────────
// The bottom sentinel was scrolled into view on every appended item and every streamed
// partial-text chunk, so scrolling up to re-read history was undone several times a second.
describe("Defect 2: auto-scroll to the bottom", () => {
  const setScrollBox = (el: Element, from: number) => {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: 1000 - 300 - from });
  };

  it("does not yank the viewport down while the user is reading history", () => {
    useUi.setState({ bots: { a: bot("a", "Courier") }, transcripts: { a: [userMsg, botMsg] } });
    const { container } = render(<Transcript botId="a" />);
    setScrollBox(container.querySelector(".transcript")!, 600); // scrolled far up
    scrolled.length = 0;
    act(() => { useUi.setState({ typing: { a: { typing: true, partialText: "Working on" } } }); });
    act(() => { useUi.setState({ typing: { a: { typing: true, partialText: "Working on it" } } }); });
    expect(scrolled).toEqual([]);
  });

  it("still follows the conversation when the user is already at the bottom", () => {
    useUi.setState({ bots: { a: bot("a", "Courier") }, transcripts: { a: [userMsg, botMsg] } });
    const { container } = render(<Transcript botId="a" />);
    setScrollBox(container.querySelector(".transcript")!, 0);
    scrolled.length = 0;
    act(() => { useUi.setState({ typing: { a: { typing: true, partialText: "Working on it" } } }); });
    expect(scrolled).toEqual(["(sentinel)"]);
  });
});

// ── Defect 3 ────────────────────────────────────────────────────────────────
// jumpTo only ever wrote the same entry id, so jumping twice to the same message wrote an
// unchanged value: the scroll effect never re-ran and the selection outline stayed forever.
describe("Defect 3: jumping to the same message twice", () => {
  it("scrolls to it again on the second jump", async () => {
    useUi.setState({ bots: { a: bot("a", "Courier") }, view: { kind: "chat", botId: "a" }, transcripts: { a: [userMsg, botMsg] } });
    render(<Transcript botId="a" />);
    await act(async () => { await useUi.getState().jumpTo("a", "t1u"); });
    expect(scrolled).toContain("entry-t1u");
    scrolled.length = 0;
    await act(async () => { await useUi.getState().jumpTo("a", "t1u"); });
    expect(scrolled).toContain("entry-t1u");
  });

  it("drops the highlight again so the outline is not permanent", () => {
    vi.useFakeTimers();
    try {
      useUi.setState({ bots: { a: bot("a", "Courier") }, view: { kind: "chat", botId: "a" }, transcripts: { a: [userMsg, botMsg] } });
      render(<Transcript botId="a" />);
      act(() => { useUi.setState({ highlightEntryId: "t1u" }); });
      act(() => { vi.advanceTimersByTime(5000); });
      expect(useUi.getState().highlightEntryId).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Defect 4 ────────────────────────────────────────────────────────────────
// typing[botId] was only ever written by the SSE `typing` event. A dropped stream loses the
// `typing:false`, and nothing on reconnect cleared it, so the three-dot bubble stuck forever.
describe("Defect 4: a stuck typing bubble", () => {
  const typing = { a: { typing: true, partialText: null } };

  it("clears when the connection drops", () => {
    useUi.setState({ typing });
    act(() => { useUi.getState().setConnection({ kind: "reconnecting", attempt: 1 }); });
    expect(useUi.getState().typing).toEqual({});
  });

  it("clears when the Bot list reloads after a reconnect", async () => {
    useUi.setState({ typing });
    await useUi.getState().loadAll();
    expect(useUi.getState().typing).toEqual({});
  });

  it("clears for the Bot whose transcript is reloaded", async () => {
    useUi.setState({ typing: { ...typing, b: { typing: true, partialText: null } } });
    await useUi.getState().loadTranscript("a");
    expect(useUi.getState().typing.a).toBeUndefined();
    expect(useUi.getState().typing.b).toBeTruthy();
  });
});

// ── Defect 5 ────────────────────────────────────────────────────────────────
// "Hide from sidebar" on a pinned Bot left its tile in place (and moved the chat elsewhere),
// while the Bot also showed up in the Hidden Bots dialog.
describe("Defect 5: hiding a pinned Bot", () => {
  it("removes its pinned tile", () => {
    useUi.setState({
      bots: { a: bot("a", "Planner", { settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: true } }), b: bot("b", "Scout") },
      pinned: ["a", "b"],
    });
    render(<Sidebar />);
    const tiles = screen.getByRole("group", { name: "Pinned Bots" });
    expect(tiles.textContent).toContain("Scout");
    expect(tiles.textContent).not.toContain("Planner");
  });
});

// ── Defect 6 ────────────────────────────────────────────────────────────────
// The host sets metric:null on every errored tool call, and rowsFor skipped any step without a
// metric unless it was still running — so a segment whose steps all failed vanished entirely.
describe("Defect 6: a tool call that failed", () => {
  const failed: ToolCallEntry = {
    kind: "tool-call", id: "tc1", requestId: "r", segmentId: "s1", hidden: false, name: "Bash",
    step: "Ran npm test", icon: "terminal", metric: null, status: "error", startedAt: 1, endedAt: 2,
  };

  it("keeps the activity group in the transcript", () => {
    const items = buildTranscriptItems([failed, botMsg] as TranscriptEntry[], 10);
    const activity = items.find((i) => i.kind === "activity") as Extract<TranscriptItem, { kind: "activity" }> | undefined;
    expect(activity).toBeTruthy();
    expect(activity!.rows.map((r) => r.verb)).toEqual(["Failed: Ran npm test"]);
    expect(activity!.steps).toHaveLength(1);
  });

  it("renders that row without the running shimmer, and expands to the failed step", () => {
    const item = buildTranscriptItems([failed, botMsg] as TranscriptEntry[], 10).find((i) => i.kind === "activity")!;
    const { container } = render(<ActivityGroup item={item as Extract<TranscriptItem, { kind: "activity" }>} />);
    expect(container.querySelector(".activity-row.live")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show steps" }));
    expect(container.querySelector("li.step.error")?.textContent).toContain("Ran npm test");
  });
});

// ── Defect 7 ────────────────────────────────────────────────────────────────
// bots starts {} and is only filled once loadAll resolves, so every launch showed
// "Create your first Bot" over a sidebar whose buttons could not do anything yet.
describe("Defect 7: the sidebar before the first load", () => {
  it("does not offer the empty-state CTA while still connecting", () => {
    useUi.setState({ ...initialState(), connection: { kind: "starting" } });
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: STR5.createFirstBot })).toBeNull();
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: STR.search }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not offer it while connected but not yet loaded", () => {
    useUi.setState({ ...initialState(), connection: { kind: "connected" } });
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: STR5.createFirstBot })).toBeNull();
  });

  it("offers it once the load has resolved with no Bots", async () => {
    await useUi.getState().loadAll();
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: STR5.createFirstBot })).toBeTruthy();
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Defect 8 ────────────────────────────────────────────────────────────────
// panel/routineId are global, so opening a Routine on Bot A then clicking Bot B left
// panel="routine" pointing at A's routine: the right pane went blank and the header
// details button needed two clicks.
describe("Defect 8: switching Bots with a Routine open", () => {
  it("closes the routine sub-view", async () => {
    useUi.setState({ bots: { a: bot("a", "Planner"), b: bot("b", "Scout") }, view: { kind: "chat", botId: "a" }, panel: "routine", routineId: "r1" });
    await useUi.getState().openBot("b");
    expect(useUi.getState().panel).toBe("details");
    expect(useUi.getState().routineId).toBe(null);
  });

  it("keeps it when re-opening the same Bot", async () => {
    useUi.setState({ bots: { a: bot("a", "Planner") }, view: { kind: "chat", botId: "a" }, panel: "routine", routineId: "r1" });
    await useUi.getState().openBot("a");
    expect(useUi.getState().panel).toBe("routine");
    expect(useUi.getState().routineId).toBe("r1");
  });
});

// ── Defect 9 ────────────────────────────────────────────────────────────────
// The hover toolbar is hidden with CSS only, so an abandoned emoji picker stayed open in
// state and popped back up the next time the mouse crossed that message.
describe("Defect 9: the message emoji picker", () => {
  it("closes on an outside click", () => {
    render(<MessageActions botId="b" entry={botMsg} text="Done." />);
    fireEvent.click(screen.getByRole("button", { name: STR.react }));
    expect(screen.queryByRole("button", { name: "React 👍" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: "React 👍" })).toBeNull();
  });

  it("closes on Escape", () => {
    render(<MessageActions botId="b" entry={botMsg} text="Done." />);
    fireEvent.click(screen.getByRole("button", { name: STR.react }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "React 👍" })).toBeNull();
  });
});

// ── Defect 10 ───────────────────────────────────────────────────────────────
// The focus effect depended on onClose, which every caller passes as a fresh inline arrow,
// so a parent re-render (one per streamed chunk) snapped focus back to the first item.
describe("Defect 10: menu keyboard focus", () => {
  const items = [{ label: "Pin", onSelect: () => {} }, { label: "Duplicate", onSelect: () => {} }];

  it("stays where the user arrowed to when the parent re-renders", () => {
    const { rerender } = render(<Menu label="Bot actions" x={10} y={10} onClose={() => {}} items={[...items]} />);
    const rows = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(rows[0]);
    (rows[1] as HTMLButtonElement).focus();
    rerender(<Menu label="Bot actions" x={10} y={10} onClose={() => {}} items={[...items]} />);
    expect(document.activeElement).toBe(rows[1]);
  });

  it("still closes with Escape using the newest handler", () => {
    const closed: string[] = [];
    const { rerender } = render(<Menu label="Bot actions" x={10} y={10} onClose={() => closed.push("first")} items={[...items]} />);
    rerender(<Menu label="Bot actions" x={10} y={10} onClose={() => closed.push("second")} items={[...items]} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual(["second"]);
  });
});
