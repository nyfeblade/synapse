// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, Presence, ToolCallEntry, TranscriptEntry } from "@synapse/shared";
import { Transcript } from "../../src/renderer/components/Transcript";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";
import { typingIndicator } from "../../src/renderer/typing-indicator";

// The in-chat typing indicator (decisions.md, "the typing indicator and the tool-step rows").
//
// A three-dot bubble on the Bot's side while the Bot is working on a reply and nothing has streamed
// yet. It is the SAME element as the streamed reply, so the dots grow into the first text rather than
// cutting to it; and it stands down whenever a running tool-step row is already saying "working",
// so the transcript never shows two live signals for one thing.

const bot = (presence: Presence): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: presence !== "idle", presence, activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0,
});
const userMsg = (id: string, at: number): TranscriptEntry => ({ kind: "message", id, role: "user", content: `m-${id}`, createdAt: at }) as TranscriptEntry;
const botMsg = (id: string, at: number): TranscriptEntry => ({ kind: "send-message", id, requestId: `r-${id}`, createdAt: at, message: { type: "text", content: `b-${id}` } }) as TranscriptEntry;
const step = (id: string, status: ToolCallEntry["status"], at: number): TranscriptEntry => ({
  kind: "tool-call", id, requestId: "r", segmentId: `seg-${id}`, hidden: false, name: "Bash",
  step: "Running npm test", icon: "terminal", metric: null, status, startedAt: at, endedAt: status === "running" ? null : at + 1,
}) as TranscriptEntry;

const items = (entries: TranscriptEntry[]) => buildTranscriptItems(entries, 100);

describe("typingIndicator (the rule)", () => {
  it("shows dots while the Bot thinks, works or searches and has said nothing this turn", () => {
    for (const p of ["thinking", "working", "searching"] as Presence[]) {
      expect(typingIndicator(p, undefined, items([botMsg("s0", 1), userMsg("u1", 2)])), p).toBe("dots");
    }
  });

  it("shows nothing while idle, or for presences that are not composing a reply", () => {
    for (const p of ["idle", "sending", "loading", "orbit"] as Presence[]) {
      expect(typingIndicator(p, undefined, items([userMsg("u1", 1)])), p).toBeNull();
    }
  });

  it("stands down once the Bot has sent text this turn", () => {
    expect(typingIndicator("working", undefined, items([userMsg("u1", 1), botMsg("s1", 2)]))).toBeNull();
  });

  it("an earlier turn's reply does not count — only text after the latest user message", () => {
    expect(typingIndicator("thinking", undefined, items([userMsg("u0", 1), botMsg("s0", 2), userMsg("u1", 3)]))).toBe("dots");
  });

  it("does not duplicate a running tool-step row", () => {
    expect(typingIndicator("working", undefined, items([userMsg("u1", 1), step("t1", "running", 2)]))).toBeNull();
  });

  it("comes back once that tool step has finished and the Bot is still composing", () => {
    expect(typingIndicator("thinking", undefined, items([userMsg("u1", 1), step("t1", "done", 2)]))).toBe("dots");
  });

  it("an open stream wins: dots before its first chunk, text after", () => {
    expect(typingIndicator("idle", { typing: true, partialText: null }, items([userMsg("u1", 1)]))).toBe("dots");
    expect(typingIndicator("idle", { typing: true, partialText: "Hel" }, items([userMsg("u1", 1)]))).toBe("text");
  });
});

let behaviors: (ScrollBehavior | undefined)[] = [];
beforeEach(() => {
  behaviors = [];
  window.matchMedia = vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn(function (arg?: boolean | ScrollIntoViewOptions) {
    behaviors.push(typeof arg === "object" ? arg.behavior : undefined);
  }) as unknown as typeof Element.prototype.scrollIntoView;
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, view: { kind: "chat", botId: "a" }, bots: { a: bot("idle") }, transcripts: { a: [userMsg("u1", 1)] } });
});
afterEach(cleanup);

const setPresence = (p: Presence) => act(() => { useUi.setState((s) => ({ bots: { ...s.bots, a: bot(p) } })); });
const setTyping = (typing: boolean, partialText: string | null) => act(() => { useUi.setState((s) => ({ typing: { ...s.typing, a: { typing, partialText } } })); });
const bubble = () => document.querySelector(".bubble.bot.typing");
const dots = () => document.querySelector(".bubble.bot.typing .dots");

describe("the typing bubble in the transcript", () => {
  it("appears on the Bot's side with three dots when the Bot starts thinking", () => {
    render(<Transcript botId="a" />);
    expect(bubble()).toBeNull();
    setPresence("thinking");
    expect(dots()).not.toBeNull();
    expect(dots()!.querySelectorAll("i")).toHaveLength(3);
    expect(bubble()!.getAttribute("aria-label")).toBe("Typing");
  });

  it("rides the auto-scroll: appearing while at the bottom scrolls it into view", () => {
    render(<Transcript botId="a" />);
    behaviors = [];
    setPresence("thinking");
    expect(behaviors).toHaveLength(1);
  });

  it("hands off to the first streamed text in the SAME element — the dots grow into the message", () => {
    render(<Transcript botId="a" />);
    setPresence("thinking");
    const before = bubble();
    setTyping(true, "Sorting your inbox");
    expect(bubble(), "a new element would be a cut, not a morph").toBe(before);
    expect(dots()).toBeNull();
    expect(bubble()!.textContent).toContain("Sorting your inbox");
  });

  it("holds the finished text — never flips back to dots — until the reply's entry lands, which does not pop again", () => {
    render(<Transcript botId="a" />);
    setPresence("working");
    setTyping(true, "All sorted.");
    setTyping(false, null); // the stream closed; its entry has not arrived yet and the Bot is still "working"
    expect(dots(), "the reply must not regress to dots between the two events").toBeNull();
    expect(bubble()!.textContent).toContain("All sorted.");
    act(() => { useUi.setState((s) => ({ transcripts: { ...s.transcripts, a: [userMsg("u1", 1), botMsg("s1", 2)] } })); });
    expect(bubble()).toBeNull();
    expect(document.querySelector("#entry-s1")!.classList.contains("is-new"), "it was already on screen").toBe(false);
  });

  it("holds the text through the host's real landing order: SendMessage tool_start, the entry, then typing:false", () => {
    render(<Transcript botId="a" />);
    setPresence("thinking");
    setTyping(true, "All sorted.");
    setTyping(true, null); // turn-runner: the SendMessage tool_start republishes typing with no text
    expect(dots(), "the finished reply must not shrink back to dots").toBeNull();
    expect(bubble()!.textContent).toContain("All sorted.");
    // bot-tools deliver: the entry is appended BEFORE markSent's typing:false
    act(() => { useUi.setState((s) => ({ transcripts: { ...s.transcripts, a: [userMsg("u1", 1), botMsg("s1", 2)] } })); });
    expect(bubble(), "never the stream and its message at once").toBeNull();
    setTyping(false, null);
    expect(bubble()).toBeNull();
    expect(document.querySelector("#entry-s1")!.classList.contains("is-new"), "it was already on screen").toBe(false);
  });

  it("disappears if the turn ends with no text", () => {
    render(<Transcript botId="a" />);
    setPresence("working");
    expect(bubble()).not.toBeNull();
    setPresence("idle");
    expect(bubble()).toBeNull();
  });

  it("stays out of the way of a running tool step", () => {
    useUi.setState((s) => ({ transcripts: { ...s.transcripts, a: [userMsg("u1", 1), step("t1", "running", 2)] } }));
    render(<Transcript botId="a" />);
    setPresence("working");
    expect(bubble()).toBeNull();
    expect(document.querySelector(".activity-row.live")).not.toBeNull();
  });
});
