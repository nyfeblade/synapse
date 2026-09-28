// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, type SendMessageEntry } from "@synapse/shared";
import { MessageActions } from "../../src/renderer/components/MessageActions";
import { installFakeBridge } from "./fake-bridge";

// ---------------------------------------------------------------------------
// Keyboard-and-focus audit, highest-severity finding.
//
//   .msg-actions { … display: none … }
//   .msg:hover .msg-actions, .msg:focus-within .msg-actions { display: flex }
//
// `display: none` takes React / Reply / More out of the tab order entirely, so
// `:focus-within` can never fire from the keyboard — it is a dead branch. Driven
// with Playwright against the real app: 4 action bars in the DOM, all 4 computed
// `display: none`, all 12 buttons had `offsetParent === null`, `element.focus()`
// was refused by the engine, and 0 of 45 tab stops reached one. A keyboard user
// cannot react to or reply to a message at all.
//
// The pattern that works already exists twelve lines away in app.css:456-457 —
// `.screen-hover-actions` hides with `opacity: 0` plus `:focus-within`, which
// keeps the controls focusable. This file holds that pattern in place.
// ---------------------------------------------------------------------------

const cssPath = (f: string) => fileURLToPath(new URL("../../src/renderer/styles/" + f, import.meta.url));
const read = (f: string) => readFileSync(cssPath(f), "utf8");

const entry: SendMessageEntry = {
  kind: "send-message", id: "t1s1", requestId: "req_1", createdAt: 1,
  message: { type: "text", content: "Booked the 9:10." }, reactions: [],
};

/** Put the real stylesheet in the document so getComputedStyle answers from the real cascade. */
function withStyles(): void {
  const style = document.createElement("style");
  style.textContent = read("message-actions.css");
  document.head.append(style);
}

describe("message action bar — reachable from the keyboard (audit defect: display:none)", () => {
  beforeEach(() => { installFakeBridge(); withStyles(); });
  afterEach(() => { cleanup(); document.head.querySelectorAll("style").forEach((s) => s.remove()); });

  // jsdom-level: jsdom runs the real cascade for `display`, so this is the same
  // computed value Chromium reported — and `display: none` is exactly what makes
  // the engine refuse focus.
  it("does not remove itself from the tab order: the resting bar is laid out, not display:none", () => {
    const { container } = render(<div className="msg bot"><MessageActions botId="b" entry={entry} text="Booked the 9:10." /></div>);
    const bar = container.querySelector<HTMLElement>(".msg-actions")!;
    expect(getComputedStyle(bar).display, "display:none is what makes :focus-within a dead branch").not.toBe("none");
  });

  it("hides at rest by paint, not by layout, so its buttons stay focusable", () => {
    const { container } = render(<div className="msg bot"><MessageActions botId="b" entry={entry} text="Booked the 9:10." /></div>);
    const bar = container.querySelector<HTMLElement>(".msg-actions")!;
    expect(getComputedStyle(bar).opacity, "the resting bar must be invisible, like .screen-hover-actions").toBe("0");
  });

  it("accepts focus on React / Reply / More — the engine refused it before", () => {
    render(<div className="msg bot"><MessageActions botId="b" entry={entry} text="Booked the 9:10." /></div>);
    for (const name of [STR.react, STR.reply, STR.moreMessageActions]) {
      const btn = screen.getByRole("button", { name });
      btn.focus();
      expect(document.activeElement, `${name} must be focusable`).toBe(btn);
    }
  });

  // Contract-level: jsdom does not match :hover/:focus-within in getComputedStyle,
  // so the reveal branch is asserted against the stylesheet text.
  it("reveals on :focus-within as well as :hover, the way .screen-hover-actions does", () => {
    const css = read("message-actions.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = css.match(/([^{}]*\.msg-actions[^{}]*)\{\s*opacity:\s*1[^}]*\}/);
    expect(rule, "a rule must raise .msg-actions to opacity 1").not.toBeNull();
    expect(rule![1]).toMatch(/:hover/);
    expect(rule![1]).toMatch(/:focus-within/);
  });

  // Making the bar reachable put THREE tab stops on every message: driven against the real app, 21 of
  // 45 tab stops were message-action buttons, which is its own defect in a long conversation. The
  // element already says role="toolbar", and a toolbar is one tab stop with arrow keys inside it —
  // the same promise-of-a-role problem as the menu's missing arrow keys.
  it("is one tab stop, not three: a toolbar rovers its tabindex", () => {
    render(<div className="msg bot"><MessageActions botId="b" entry={entry} text="Booked the 9:10." /></div>);
    const btns = [STR.react, STR.reply, STR.moreMessageActions].map((n) => screen.getByRole("button", { name: n }));
    expect(btns.map((b) => b.tabIndex), "only the first is in the tab order").toEqual([0, -1, -1]);
  });

  it("walks with the arrow keys, wraps, and Home/End jump to the ends", () => {
    const { container } = render(<div className="msg bot"><MessageActions botId="b" entry={entry} text="Booked the 9:10." /></div>);
    const bar = container.querySelector<HTMLElement>(".msg-actions")!;
    const name = () => (document.activeElement as HTMLElement).getAttribute("aria-label");
    screen.getByRole("button", { name: STR.react }).focus();
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(name()).toBe(STR.reply);
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(name()).toBe(STR.moreMessageActions);
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(name(), "wraps at the end").toBe(STR.react);
    fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(name(), "wraps at the start").toBe(STR.moreMessageActions);
    fireEvent.keyDown(bar, { key: "Home" });
    expect(name()).toBe(STR.react);
    fireEvent.keyDown(bar, { key: "End" });
    expect(name()).toBe(STR.moreMessageActions);
    expect(screen.getByRole("button", { name: STR.moreMessageActions }).tabIndex, "the tab stop follows focus").toBe(0);
  });

  it("never hides the bar with display:none anywhere in the sheet", () => {
    const css = read("message-actions.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const base = css.match(/\.msg-actions\s*\{([^}]*)\}/);
    expect(base).not.toBeNull();
    expect(base![1]).not.toMatch(/display:\s*none/);
  });
});
