// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, TranscriptEntry } from "@synapse/shared";
import { markdownParses, renderMarkdown } from "../../src/renderer/components/BotMarkdown";
import { Transcript, TRANSCRIPT_WINDOW } from "../../src/renderer/components/Transcript";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import type { TranscriptItem } from "../../src/renderer/transcript-items";
import { sameValue, shareItems } from "../../src/renderer/transcript-share";

// Bug 442: a 100-turn chat's reply cost grew with its length (every row re-rendered and re-parsed its markdown on
// every event, and a column-flex scroller relaid out every row). These pin the three fixes.

const bot: BotSummary = {
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false, lastBotMessageAt: 0,
  profile: { name: "Archive", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
};
const say = (i: number, text = `reply **${i}**`): TranscriptEntry =>
  ({ kind: "send-message", id: `s${i}`, requestId: `r${i}`, createdAt: 10 + i, message: { type: "text", content: text } }) as unknown as TranscriptEntry;
const chat = (n: number) => Array.from({ length: n }, (_, i) => say(i));
const show = (entries: TranscriptEntry[]) => {
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { a: bot }, transcripts: { a: entries } });
  return render(<Transcript botId="a" />);
};
const append = (e: TranscriptEntry) => act(() => { useUi.setState((s) => ({ transcripts: { ...s.transcripts, a: [...(s.transcripts.a ?? []), e] } })); });

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("markdown is parsed once per message content", () => {
  it("a new message parses only itself; the history is not parsed again", () => {
    show(chat(60));
    const before = markdownParses();
    append(say(60, "a brand new reply 42f1"));
    expect(markdownParses() - before).toBe(1);
  });
  it("a remount (the chat opened again) parses nothing already seen", () => {
    show(chat(30));
    cleanup();
    const before = markdownParses();
    show(chat(30));
    expect(markdownParses()).toBe(before);
  });
  it("the cache returns the same tree for the same text", () => {
    expect(renderMarkdown("same **text** 9c2")).toBe(renderMarkdown("same **text** 9c2"));
  });
});

describe("structural sharing keeps unchanged items identical", () => {
  const act1 = (live: boolean): TranscriptItem => ({ kind: "activity", key: "k", rows: [{ verb: "Ran", noun: "1 command", count: 1, icon: "terminal" as never, live }], more: 0, steps: [], running: live });
  it("an item equal in value keeps last pass's object; a changed one is new", () => {
    const prev = new Map<string, TranscriptItem>();
    const [a] = shareItems(prev, [act1(false)]);
    const [b] = shareItems(prev, [act1(false)]);
    expect(b).toBe(a);
    const [c] = shareItems(prev, [act1(true)]);
    expect(c).not.toBe(a);
  });
  it("sameValue compares arrays and objects by value, bounded", () => {
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
  });
});

describe("a long chat renders a window of its history", () => {
  // jsdom has no IntersectionObserver; a stub that records observers lets the test fire them.
  const observers: { cb: IntersectionObserverCallback; targets: Element[] }[] = [];
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal("IntersectionObserver", class {
      targets: Element[] = [];
      constructor(public cb: IntersectionObserverCallback) { observers.push(this); }
      observe(t: Element) { this.targets.push(t); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    });
  });
  const botRows = (c: HTMLElement) => c.querySelectorAll(".msg.bot").length;

  it("renders only the last window, and a sentinel near the top renders more", () => {
    const { container } = show(chat(300));
    expect(botRows(container)).toBeLessThanOrEqual(TRANSCRIPT_WINDOW + TRANSCRIPT_WINDOW / 4);
    expect(botRows(container)).toBeGreaterThanOrEqual(TRANSCRIPT_WINDOW);
    expect(container.textContent).toContain("reply 299");
    expect(container.textContent).not.toContain("reply 10");
    const sentinel = container.querySelector(".transcript-more")!;
    const o = observers.find((x) => x.targets.includes(sentinel))!;
    const shown = botRows(container);
    act(() => o.cb([{ isIntersecting: true, target: sentinel } as unknown as IntersectionObserverEntry], o as unknown as IntersectionObserver));
    expect(botRows(container)).toBe(shown + TRANSCRIPT_WINDOW);
  });

  it("an appended message does not move the window's start on every append", () => {
    const { container } = show(chat(300));
    const first = container.querySelector(".msg.bot")!.id;
    append(say(300));
    expect(container.querySelector(".msg.bot")!.id).toBe(first);
  });

  it("a jump to an old message renders it", () => {
    const { container } = show(chat(300));
    act(() => { useUi.setState({ highlightEntryId: "s5", highlightSeq: 1 }); });
    expect(container.querySelector("#entry-s5")).not.toBeNull();
  });

  it("a short chat renders everything, with no sentinel", () => {
    const { container } = show(chat(40));
    expect(botRows(container)).toBe(40);
    expect(container.querySelector(".transcript-more")).toBeNull();
  });
});
