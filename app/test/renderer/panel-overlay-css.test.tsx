// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetailsPanel } from "../../src/renderer/components/DetailsPanel";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

// Under 1180px the right column lies OVER the conversation's edge instead of squeezing it. The rule
// that does it lives in app.css's `@media (max-width: 1180px)` block and is written against the DOM
// ChatView really renders: `.window > .panel-mount (display: contents) > .panel`. When DetailsPanel
// grew its `.panel-mount` wrapper, the old `.window > .panel` selectors silently stopped matching —
// the stylesheet's own tests still passed because none of them looked at the real tree. This one
// renders the panel inside a `.window` and asks the browser's own selector engine whether each
// overlay selector reaches it.

const readCss = () => readFileSync(fileURLToPath(new URL("../../src/renderer/styles/" + "app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Selectors (with their bodies) inside the `@media (max-width: 1180px)` block. */
function narrowRules(): { sel: string; body: string }[] {
  const css = readCss();
  const start = css.indexOf("@media (max-width: 1180px)");
  expect(start).toBeGreaterThan(-1);
  let i = css.indexOf("{", start) + 1;
  let depth = 1;
  const from = i;
  while (depth > 0) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
  const block = css.slice(from, i - 1);
  const out: { sel: string; body: string }[] = [];
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const s of m[1]!.split(",")) out.push({ sel: s.trim(), body: m[2]! });
  return out;
}

function overlaysFor(panel: Element): string[] {
  return narrowRules().filter((r) => /position\s*:\s*absolute/.test(r.body) && panel.matches(r.sel)).map((r) => r.sel);
}

describe("narrow window: the right panel overlays the chat's edge", () => {
  beforeEach(() => {
    installFakeBridge({ getAgentMemories: { facts: [], projects: [] }, listRoutines: { routines: [] } });
    useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") }, panel: "details", transcripts: { a: [] } } as never);
  });
  afterEach(cleanup);

  const mountInWindow = () => {
    const win = document.createElement("div");
    win.className = "window";
    document.body.appendChild(win);
    render(<DetailsPanel botId="a" />, { container: win });
    const panel = win.querySelector(".panel");
    expect(panel).toBeTruthy();
    return panel!;
  };

  it("the Now panel (not wide) is matched by an absolute-position overlay rule in the real DOM", () => {
    const panel = mountInWindow();
    expect(panel.classList.contains("wide")).toBe(false);
    expect(overlaysFor(panel).length).toBeGreaterThan(0);
  });

  it("a wide panel (Memory) is matched by an absolute-position overlay rule in the real DOM", () => {
    useUi.setState({ panel: "memory" } as never);
    const panel = mountInWindow();
    expect(panel.classList.contains("wide")).toBe(true);
    expect(overlaysFor(panel).length).toBeGreaterThan(0);
  });
});
