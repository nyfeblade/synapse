// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetailsPanel } from "../../src/renderer/components/DetailsPanel";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

// Under 1180px the right column used to lie OVER the conversation's edge. The new-user walk (bug 355)
// found it covered the composer's mic and send at the 1024px floor, so the panel now stays in the row
// and the chat column gives way (a smaller --chat-inset). This test renders the panel in the real DOM
// ChatView uses (`.window > .panel-mount (display: contents) > .panel`) and asks the browser's own
// selector engine that no absolute-position rule in the narrow block reaches it — an overlay rule
// written against any wrapper would be caught here, not only one with the old selector.

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

describe("narrow window: the right panel stays in the row (bug 355)", () => {
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

  it("the Now panel (not wide) is matched by no absolute-position overlay rule in the real DOM", () => {
    const panel = mountInWindow();
    expect(panel.classList.contains("wide")).toBe(false);
    expect(overlaysFor(panel)).toEqual([]);
  });

  it("a wide panel (Memory) is matched by no absolute-position overlay rule in the real DOM", () => {
    useUi.setState({ panel: "memory" } as never);
    const panel = mountInWindow();
    expect(panel.classList.contains("wide")).toBe(true);
    expect(overlaysFor(panel)).toEqual([]);
  });

  it("the chat column gives way instead: a smaller inset under 1180px", () => {
    expect(narrowRules().some((r) => r.sel === ".main" && /--chat-inset:\s*24px/.test(r.body))).toBe(true);
  });
});
