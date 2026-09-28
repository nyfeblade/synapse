// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, TranscriptEntry } from "@synapse/shared";
import { MessageActions } from "../../src/renderer/components/MessageActions";
import { Transcript } from "../../src/renderer/components/Transcript";
import { Trays } from "../../src/renderer/components/Trays";
import { isGliding, stopGlide } from "../../src/renderer/scroll-glide";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Motion BEHAVIOUR (docs/motion-spec.md §3.1, §3.6, §7.5).
//
// Unlike motion-css.test.ts, which reads stylesheets, everything here drives a real component and
// asserts what it actually did: which ScrollBehavior reached scrollIntoView, which elements carry
// `.is-new` after a given sequence of renders, and whether a copy puts a toast in the document. Those
// are the three parts of this tier that are logic, not CSS, and they are the three that can be wrong
// in a way no stylesheet assertion would catch.

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

const userMsg = (id: string, at: number): TranscriptEntry => ({ kind: "message", id, role: "user", content: `m-${id}`, createdAt: at }) as TranscriptEntry;
const botMsg = (id: string, at: number): TranscriptEntry => ({ kind: "send-message", id, requestId: `r-${id}`, createdAt: at, message: { type: "text", content: `b-${id}` } }) as TranscriptEntry;

/** Every ScrollBehavior handed to scrollIntoView, in order. `undefined` means the call passed none. */
let behaviors: (ScrollBehavior | undefined)[] = [];
let reduce = false;

beforeEach(() => {
  behaviors = [];
  reduce = false;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })), onEvent: () => () => {}, onConnection: () => () => {},
    retry: () => {}, appInfo: async () => ({ userName: "u" }), vncUrl: () => null,
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
  window.matchMedia = vi.fn((q: string) => ({
    matches: q.includes("prefers-reduced-motion") ? reduce : false,
    media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    behaviors.push(typeof arg === "object" ? arg.behavior : undefined);
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  useUi.setState({
    ...initialState(), connection: { kind: "connected" }, view: { kind: "chat", botId: "a" },
    bots: { a: bot(), b: bot({ id: "b" }) },
    transcripts: { a: [userMsg("u1", 1), botMsg("s1", 2)], b: [userMsg("u9", 1)] },
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const setEntries = (botId: string, entries: TranscriptEntry[]) =>
  act(() => { useUi.setState((s) => ({ transcripts: { ...s.transcripts, [botId]: entries } })); });
const setTyping = (botId: string, typing: boolean, partialText: string | null) =>
  act(() => { useUi.setState((s) => ({ typing: { ...s.typing, [botId]: { typing, partialText } } })); });

describe("§3.6 — the scroll gate (behavioural)", () => {
  it("lands instantly on the first render for a Bot rather than gliding", () => {
    render(<Transcript botId="a" />);
    expect(behaviors).toEqual(["auto"]);
  });

  it("glides when the message COUNT grows", () => {
    // "Ultra liquid": the glide is JS-driven on the glide spring (scroll-glide.ts), not the browser's
    // smooth scroll, so it needs real distance to cover: 3 rows of 200px, a 300px viewport, at the bottom.
    const { container } = render(<Transcript botId="a" />);
    const el = container.querySelector(".transcript") as HTMLElement;
    let top = 0;
    const height = () => el.querySelectorAll(".msg").length * 200;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: height });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
    top = height() - 300;
    behaviors = [];
    setEntries("a", [userMsg("u1", 1), botMsg("s1", 2), userMsg("u2", 3)]);
    expect(behaviors, "no instant jump").toEqual([]);
    expect(isGliding(el), "a spring glide is under way").toBe(true);
    stopGlide(el);
  });

  // THE defect the spec singles out. The same effect re-runs on every partialText republish, many
  // times a second. A smooth scroll re-issued before it converges never converges, so the transcript
  // crawls behind the text forever. The gate is the item COUNT, never the content.
  it("does NOT glide on a stream republish — the count has not changed", () => {
    render(<Transcript botId="a" />);
    setTyping("a", true, "Th");
    behaviors = [];
    setTyping("a", true, "Thinking");
    setTyping("a", true, "Thinking it ");
    setTyping("a", true, "Thinking it through");
    expect(behaviors, "every streamed chunk must scroll instantly").toEqual(["auto", "auto", "auto"]);
  });

  it("still lands instantly when a new entry and a stream republish arrive together", () => {
    render(<Transcript botId="a" />);
    setTyping("a", true, "partial");
    behaviors = [];
    setTyping("a", true, "partial text");
    expect(behaviors).toEqual(["auto"]);
  });

  // §2: a `behavior` passed as a JS argument is NOT reached by the CSS universal reduced-motion
  // block. The caller has to consult the media query itself, so this is the one reduced-motion
  // assertion in this tier that cannot be made against a stylesheet.
  it("never glides under prefers-reduced-motion, even on a count change", () => {
    reduce = true;
    render(<Transcript botId="a" />);
    behaviors = [];
    setEntries("a", [userMsg("u1", 1), botMsg("s1", 2), userMsg("u2", 3)]);
    expect(behaviors).toEqual(["auto"]);
  });
});

describe("§3.1 — the is-new gate (behavioural)", () => {
  const news = () => [...document.querySelectorAll(".is-new")];

  it("animates nothing when a transcript hydrates", () => {
    render(<Transcript botId="a" />);
    expect(news(), "a hydrating transcript must not animate ~200 bubbles at once").toEqual([]);
  });

  it("marks only the entry that arrived while we were watching", () => {
    render(<Transcript botId="a" />);
    setEntries("a", [userMsg("u1", 1), botMsg("s1", 2), userMsg("u2", 3)]);
    expect(news().map((e) => e.id)).toEqual(["entry-u2"]);
  });

  it("re-seeds on a Bot switch, so switching never animates the new Bot's history", () => {
    const { rerender } = render(<Transcript botId="a" />);
    rerender(<Transcript botId="b" />);
    expect(news(), "the whole of Bot b hydrated on this render").toEqual([]);
    setEntries("b", [userMsg("u9", 1), userMsg("u10", 2)]);
    expect(news().map((e) => e.id)).toEqual(["entry-u10"]);
  });

  // §3.1's second precondition and §10.6. When a reply finishes, the streamed `.bubble.bot.typing`
  // unmounts and a fresh `.msg.bot` mounts for the persisted entry. If that plays an entrance the
  // user watches the reply pop a second time after already reading it.
  it("does not let a streamed reply play a second entrance when it lands", () => {
    render(<Transcript botId="a" />);
    setTyping("a", true, null);
    setTyping("a", true, "Done sorting.");
    act(() => {
      useUi.setState((s) => ({
        transcripts: { ...s.transcripts, a: [userMsg("u1", 1), botMsg("s1", 2), botMsg("s2", 3)] },
        typing: { ...s.typing, a: { typing: false, partialText: null } },
      }));
    });
    expect(news(), "the reply was already on screen as the typing bubble").toEqual([]);
  });

  it("does not use :last-child — the real last child is the scroll sentinel (§10.8)", () => {
    render(<Transcript botId="a" />);
    setEntries("a", [userMsg("u1", 1), botMsg("s1", 2), userMsg("u2", 3)]);
    const marked = document.querySelector(".is-new")!;
    expect(marked.nextElementSibling, "the sentinel sits after the last message").not.toBeNull();
  });
});

describe("§5.2 — trays are gated the same way", () => {
  const tray = (id: string) => ({ id, botId: "a", title: `t-${id}`, detail: null, requestId: null, buttons: [], dedupeKey: null, count: 1, createdAt: 1 });

  it("does not animate trays that were already there", () => {
    act(() => { useUi.setState({ trays: [tray("x")] as never }); });
    render(<Trays botId="a" />);
    expect(document.querySelectorAll(".tray.is-new")).toHaveLength(0);
  });

  it("animates a tray that arrives", () => {
    act(() => { useUi.setState({ trays: [tray("x")] as never }); });
    render(<Trays botId="a" />);
    act(() => { useUi.setState({ trays: [tray("x"), tray("y")] as never }); });
    expect([...document.querySelectorAll(".tray.is-new")]).toHaveLength(1);
  });
});

describe("§7.5 — copy confirmation (behavioural)", () => {
  const entry = { kind: "message", id: "t1u", role: "user", content: "hello", createdAt: 1 } as TranscriptEntry;

  it("a copy is now distinguishable from a misclick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MessageActions botId="a" entry={entry as never} text="hello" />);
    fireEvent.click(screen.getByLabelText("More message actions"));
    fireEvent.click(screen.getByText("Copy"));
    await act(async () => { await Promise.resolve(); });
    const toast = document.querySelector(".link-copied");
    expect(toast, "copying used to give no feedback whatsoever").not.toBeNull();
    expect(toast!.getAttribute("role")).toBe("status");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  it("the toast leaves on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MessageActions botId="a" entry={entry as never} text="hello" />);
    fireEvent.click(screen.getByLabelText("More message actions"));
    fireEvent.click(screen.getByText("Copy"));
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(document.querySelector(".link-copied.leaving"), "it should play its 120ms exit").not.toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(document.querySelector(".link-copied")).toBeNull();
  });

  it("says nothing when the clipboard refuses — nothing was copied", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    render(<MessageActions botId="a" entry={entry as never} text="hello" />);
    fireEvent.click(screen.getByLabelText("More message actions"));
    fireEvent.click(screen.getByText("Copy"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector(".link-copied")).toBeNull();
  });
});
