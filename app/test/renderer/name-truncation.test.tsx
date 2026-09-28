// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { ChatView } from "../../src/renderer/components/ChatView";
import { NewChat } from "../../src/renderer/components/NewChat";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Bug 20 — the Bot name never truncates.
//
// Every string NEXT to the Bot name already truncates: `.row-status`, `.chip`, `.tray-detail`,
// `.rule-text`, `.attention-text`, `.copy-value`, `.file-name`, `.palette-sub`, and the shared
// `.clamp1` / `.ellipsis` helpers. The Bot name — the one string in this app a user types freely,
// and the only one with no length limit anywhere in the host — was missed on all four surfaces that
// render it: the pinned sidebar tile, the sidebar row, the chat header and the New-chat recipient
// rows. A long name makes the tile grow arbitrarily TALL (a nowrap-less span in a 3-column grid
// wraps to as many lines as it likes) and pushes the chat header's Computer and Template controls
// off the right edge.
//
// THE CLASS, not the four instances: a Bot name is placed in a box that cannot grow. This file
// therefore does not assert "`.tile-name` contains `text-overflow`" — a class rename would walk
// straight past that. It RENDERS each surface with a 240-character name, finds the element that
// actually holds the name, and asks app.css itself which declarations reach that element via
// `Element.matches`. Add a fifth surface without a truncating box and the table below fails on it.
//
// MEASURED, not inferred: jsdom has no layout engine, so nothing here can prove a pixel. All four
// surfaces were re-rendered in Chromium (Playwright, 1440x900, both themes) with the 240-character
// name below, and again with the same characters as ONE unbroken word — the two shapes fail
// differently and both had to be looked at.
//
//   a long name WITH spaces, before -> after:  tile 194px tall -> 89px (89px is also what a
//     two-letter name measures, i.e. the tile is back to its own height); sidebar row 177px -> 55px;
//     the header's <h1> 34px tall, two lines -> 20px; the recipient row's label 122px -> 20px.
//   ONE unbroken word, before -> after:  the tile's name painted 1358px wide out of a 70px column;
//     the header title measured 1678px inside an 1188px header and put the Computer button at
//     x=1954 and the Template button at x=1990-2018 — 578px past the right edge of a 1440px window,
//     with `.window { overflow: hidden }` meaning no scrollbar and no way to reach them. After:
//     title 1084px, buttons back at x=1360 and x=1396, every name element clipped to its own box
//     (scrollWidth 1358/1551/1592 against clientWidth 70/169/998/459).

// The path is built by concatenation on purpose: Vite rewrites `new URL("<literal>", import.meta.url)`
// into an asset URL, which under jsdom resolves against the document and is not a file: URL.
const readCss = () => readFileSync(fileURLToPath(new URL("../../src/renderer/styles/" + "app.css", import.meta.url)), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every top-level (selector-list, body) pair in app.css, with @keyframes removed. */
function rules(): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  const clean = stripComments(readCss()).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    for (const sel of m[1]!.split(",")) out.push({ sel: sel.trim(), body: m[2]! });
  }
  return out;
}

/**
 * The value app.css gives `prop` for this element, asking the stylesheet which of its rules reach
 * the element rather than trusting a class name. Later rules win, which is the cascade's own rule
 * for equal specificity and is what every selector here has.
 */
function declaredFor(el: Element, prop: string): string | undefined {
  let value: string | undefined;
  for (const { sel, body } of rules()) {
    if (/:hover|:active|:focus/.test(sel)) continue; // interaction states, not the resting box
    let hit = false;
    try { hit = el.matches(sel); } catch { continue; } // a selector jsdom cannot parse reaches nothing
    if (!hit) continue;
    const m = body.match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)"));
    if (m) value = m[1]!.trim();
  }
  return value;
}

/** The three declarations that, together, are a single truncating line. */
function assertTruncates(el: Element, where: string) {
  expect(declaredFor(el, "white-space"), `${where}: the name may wrap to as many lines as it likes`).toBe("nowrap");
  expect(declaredFor(el, "overflow"), `${where}: the overflow paints outside the box`).toBe("hidden");
  expect(declaredFor(el, "text-overflow"), `${where}: a clipped name with no ellipsis reads as a rendering fault`).toBe("ellipsis");
}

const LONG = "Quartermaster " + "Wolfeschlegelsteinhausenbergerdorff ".repeat(6);

const bot = (): BotSummary => ({
  id: "b1", profile: { name: LONG, description: "d", avatarKind: "shape", avatarShape: "pebble", avatarColor: "#f19d38", avatarVersion: 0, title: null },
  presence: "idle", running: false, marker: null, statusLine: "Idle", group: null, activity: null, awaiting: null,
  settings: { hiddenFromSidebar: false }, createdAt: 1, updatedAt: 1, lastBotMessageAt: 0,
} as unknown as BotSummary);

/** The store as each surface needs it: one Bot, connected, with the sidebar loaded. */
const ready = (over: Record<string, unknown> = {}) =>
  useUi.setState({ ...initialState(), bots: { b1: bot() }, connection: { kind: "connected" }, botsLoaded: true, ...over } as never);

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {},
    appInfo: async () => ({ userName: "u" }),
    native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
  };
  // jsdom has no layout, so it has no scrollIntoView; Transcript calls it on mount.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

/** The element that actually holds the name text, wherever the component chose to put it. */
function nameNode(root: HTMLElement): Element {
  const hit = [...root.querySelectorAll("*")].filter((el) => el.textContent === LONG && !el.querySelector("*"));
  expect(hit.length, "the long name is not rendered on this surface").toBeGreaterThan(0);
  return hit[0]!;
}

describe("bug 20 — a Bot name is placed in a box it cannot grow", () => {
  it("the pinned sidebar tile truncates the name instead of growing taller", () => {
    ready({ pinned: ["b1"] });
    const { container } = render(<Sidebar />);
    const tile = container.querySelector(".tile");
    expect(tile, "no pinned tile rendered").not.toBeNull();
    assertTruncates(nameNode(tile as HTMLElement), ".tile .tile-name");
    // A nowrap child of a centring flex column still escapes its column unless it is capped.
    expect(declaredFor(nameNode(tile as HTMLElement), "max-width"), "the tile column is minmax(0, 1fr); the name must be capped to it").toBe("100%");
  });

  it("the sidebar row truncates the name, as its own status line already does", () => {
    ready();
    const { container } = render(<Sidebar />);
    const row = container.querySelector(".row")!;
    assertTruncates(nameNode(row as HTMLElement), ".row .row-text > span");
    expect(declaredFor(row.querySelector(".row-text")!, "min-width"), "a flex item will not shrink below its content without this").toBe("0");
  });

  it("the chat header truncates the name instead of pushing its controls off the window", () => {
    ready({ view: { kind: "chat", botId: "b1" }, activeBotId: "b1" });
    const { container } = render(<ChatView botId="b1" />);
    const title = container.querySelector(".chat-title")!;
    assertTruncates(nameNode(title as HTMLElement), ".chat-title .title-btn > span");
    expect(declaredFor(title, "min-width"), "`flex-grow: 1` with no min-width is what pushed the controls out").toBe("0");
    expect(declaredFor(container.querySelector(".title-btn")!, "min-width"), "the button between the title and the name must shrink too").toBe("0");
  });

  it("the chat header's own controls hold their place while the name shrinks", () => {
    // A shrinkable title is only half of it: flex distributes shrinkage in proportion to each item's
    // base size, so the 28px buttons still gave up a few pixels each to a 1,437px title.
    ready({ view: { kind: "chat", botId: "b1" }, activeBotId: "b1" });
    const { container } = render(<ChatView botId="b1" />);
    const controls = [...container.querySelectorAll(".chat-header > *")].filter((el) => el.tagName === "BUTTON");
    expect(controls.length, "no header controls rendered").toBeGreaterThan(0);
    for (const el of controls) {
      expect(declaredFor(el, "flex-shrink"), `\`.${el.className}\` can still be squeezed by a long name`).toBe("0");
    }
  });

  it("the New-chat recipient rows truncate the name", () => {
    ready({ view: { kind: "new" } });
    const { container } = render(<NewChat />);
    const label = container.querySelector(".pick-label");
    expect(label, "no recipient row rendered").not.toBeNull();
    assertTruncates(label!, ".pick .pick-label");
    expect(declaredFor(label!, "min-width"), "`flex-grow: 1` alone cannot shrink below its content").toBe("0");
  });
});
