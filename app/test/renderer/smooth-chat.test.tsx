// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { ChatView } from "../../src/renderer/components/ChatView";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// `fileURLToPath(import.meta.url)` and not `new URL(dir, import.meta.url)`: under jsdom the global
// URL resolves a directory-form relative reference against the document base, not against the module
// (see overlay-overhang.test.tsx).
const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "renderer", "styles");
const css = readFileSync(path.join(stylesDir, "app.css"), "utf8");
const rule = (sel: string) => { const i = css.indexOf(`${sel} {`); return i < 0 ? "" : css.slice(i, css.indexOf("}", i)); };

describe("smooth chat", () => {
  it("does not centre the conversation in a column", () => {
    expect(rule(".transcript")).not.toMatch(/100% - 720px/);
    // UI polish pass: the inset is the chat-pane grid's token, shared with the composer.
    expect(rule(".transcript")).toMatch(/padding-inline:\s*var\(--chat-inset\)/);
    expect(rule(".composer-wrap")).toMatch(/padding:\s*6px var\(--chat-inset\) 16px/);
    expect(readFileSync(path.join(stylesDir, "tokens.css"), "utf8")).toMatch(/--chat-inset:\s*56px/);
  });
  it("anchors event lines and activity to the Bot's side", () => {
    expect(css).not.toMatch(/\.event-row,\s*\.activity-row\s*\{[^}]*align-self:\s*center/);
  });
  it("uses soft fills, not outlines, for cards", () => {
    expect(rule(".card")).toMatch(/background:\s*var\(--fill-group\)/);
    expect(rule(".card")).not.toMatch(/border:\s*var\(--hairline\) solid/);
  });
  it("keeps bold text in the body colour", () => {
    expect(css).toMatch(/\.bubble\.bot strong\s*\{[^}]*color:\s*inherit/);
  });
  it("shows the header rule only once the transcript has scrolled", () => {
    expect(css).toMatch(/\.chat-header\[data-scrolled\]\s*\{[^}]*--header-rule:\s*var\(--line-header\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 1 — Always allow / Deny are quiet text buttons on the approval card: no outline of
// their own, transparent at rest, the ordinary hover/press fills, scoped so `.btn-outline`
// everywhere else (Cancel, Save, Add Rule, …) is untouched.
// ---------------------------------------------------------------------------------------------
describe("smooth chat — fix round 1", () => {
  it("makes the approval card's outlined buttons quiet text buttons, scoped to the card", () => {
    expect(rule(".card-actions .btn-outline")).toMatch(/border-color:\s*transparent/);
    expect(rule(".card-actions .btn-outline")).toMatch(/background:\s*transparent/);
    expect(rule(".card-actions .btn-outline")).toMatch(/color:\s*var\(--ink-2\)/);
    // Scoped, not a global restyle: the bare `.btn-outline` used everywhere else must still be
    // bordered and on --bg.
    expect(rule(".btn-outline")).toMatch(/border:\s*var\(--hairline\) solid var\(--line-button\)/);
    expect(rule(".btn-outline")).toMatch(/background:\s*var\(--bg\)/);
  });
  it("keeps the quiet buttons' hover and press on the existing fills, with no outline reappearing", () => {
    expect(css).toMatch(/\.card-actions \.btn-outline:not\(:disabled\):hover\s*\{[^}]*background-color:\s*var\(--fill-hover\)[^}]*border-color:\s*transparent/);
    expect(css).toMatch(/\.card-actions \.btn-outline:not\(:disabled\):active\s*\{[^}]*background-color:\s*var\(--fill-press\)/);
  });
  it("drops the dead border-color on the now-borderless user file card's hover", () => {
    expect(css).not.toMatch(/\.file-card\.user:not\(:disabled\):hover[^{]*\{[^}]*border-color/);
  });
});

// ---------------------------------------------------------------------------------------------
// ChatView: the header's data-scrolled attribute, driven by Transcript's own scroll handler (no
// second scroll listener on `.transcript`) — the fixture below is the one chat.test.tsx uses.
// ---------------------------------------------------------------------------------------------
const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { entryId: "t9u" } })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), vncUrl: () => null,
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
  Element.prototype.scrollIntoView = vi.fn();
  useUi.setState({
    ...initialState(), connection: { kind: "connected" }, view: { kind: "chat", botId: "a" }, bots: { a: bot() },
    transcripts: { a: [
      { kind: "event", id: "tba1", createdAt: 1, event: { type: "bot-created", botId: "a", name: "Courier" } },
      { kind: "message", id: "t1u", role: "user", content: "clear out my inbox", createdAt: 2 },
      { kind: "send-message", id: "t1s1", requestId: "r", createdAt: 3, message: { type: "text", content: "**Done sorting.** 41 were newsletters." } },
    ] },
  });
});
afterEach(cleanup);

describe("ChatView: the header rule on scroll", () => {
  it("sets data-scrolled on .chat-header once the transcript's scrollTop is past 0", () => {
    const { container } = render(<ChatView botId="a" />);
    const header = container.querySelector(".chat-header")!;
    const box = container.querySelector(".transcript") as HTMLElement;
    expect(header.hasAttribute("data-scrolled")).toBe(false);
    box.scrollTop = 40;
    fireEvent.scroll(box);
    expect(header.hasAttribute("data-scrolled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The smooth pass, Task 9 (docs/sdd, 2026-09-23; controller decisions): the header's live status
// chip ("● Working · drafting …") drops its pill — plain text in --ink-faint, no fill, no border.
// The dot before it (the one thing that still reads as a status indicator) is untouched, and
// everything else in the header is unchanged.
// ---------------------------------------------------------------------------------------------
describe("smooth chat — Task 9, the header chip is plain text", () => {
  it("the live chip carries no pill background or border, in --ink-faint", () => {
    expect(rule(".live-chip")).toMatch(/color:\s*var\(--ink-faint\)/);
    expect(rule(".live-chip")).not.toMatch(/background:\s*var\(--fill-inset\)/);
    expect(rule(".live-chip")).not.toMatch(/border:\s*var\(--hairline\)/);
    expect(rule(".live-chip")).not.toMatch(/border-radius:\s*999px/);
  });
  it("keeps the status dot before it untouched", () => {
    expect(rule(".live-chip::before")).toMatch(/border-radius:\s*50%/);
    expect(rule(".live-chip::before")).toMatch(/background:\s*var\(--accent\)/);
  });
  it("leaves everything else in the header alone", () => {
    // UI polish pass: the header reads the shared bar token, which is the approved 56px.
    expect(rule(".chat-header")).toMatch(/height:\s*var\(--bar-h\)/);
    expect(readFileSync(path.join(stylesDir, "tokens.css"), "utf8")).toMatch(/--bar-h:\s*56px/);
    expect(rule(".chat-header .call-btn")).toMatch(/background:\s*var\(--accent\)/);
  });
});
