// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR, STR_COST } from "@synapse/shared";
import { ConfirmHost, askConfirm } from "../../src/renderer/components/ConfirmDialog";
import { Menu } from "../../src/renderer/components/Menus";
import { MoneyInput, formatMoney, parseMoney } from "../../src/renderer/components/MoneyInput";
import { placeholderName } from "../../src/renderer/components/Composer";
import { resetOverlayStack } from "../../src/renderer/overlay-stack";
import { resetTriggerHistory } from "../../src/renderer/overlay-trigger";
import { contrast, read, resolve, stripComments, themeBlocks } from "./contrast-kit";

// ---------------------------------------------------------------------------
// The UI-controls pass (2026-09-29): every popup, option control and fill-in field, audited in the
// running app at 1440x900 and the 1024x680 floor, light and dark
// (test-reports/ui-controls-2026-09-29/inventory.md). This file pins what that pass changed:
//
//   BEHAVIOUR  a menu never outlives a window resize (it was left painted outside a 1024 window);
//              the one confirm is Cancel-left, destructive-right, Cancel focused, Tab trapped,
//              Escape and Enter-on-Cancel both keep things as they were, focus returns to the opener;
//              money is typed into one field that formats "$1,234.50" and never lets NaN through.
//   STYLESHEET one text field (28px, border-box, a 3:1 edge), one placeholder ink, one select caret,
//              a focus halo that clears 3:1.
//   MARKUP     in an action row, Cancel / Not now comes BEFORE the commit (macOS: Cancel left).
// ---------------------------------------------------------------------------

afterEach(() => { cleanup(); act(() => resetOverlayStack()); resetTriggerHistory(); });

describe("popovers stay inside the window", () => {
  it("a menu closes when its window is resized, instead of staying at the old coordinates", () => {
    const onClose = vi.fn();
    render(<Menu label="Bot actions" x={1200} y={700} onClose={onClose} items={[{ label: "Pin", onSelect: () => {} }]} />);
    expect(screen.getByRole("menu", { name: "Bot actions" })).toBeTruthy();
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the one confirm: order, focus, Escape, Enter", () => {
  function Opener({ onAnswer }: { onAnswer(ok: boolean): void }) {
    const [asked, setAsked] = useState(false);
    return (
      <>
        <button type="button" onClick={() => { setAsked(true); void askConfirm({ title: "Delete Scout?", verb: "Delete" }).then(onAnswer); }}>Open</button>
        {asked ? <span>asked</span> : null}
        <ConfirmHost />
      </>
    );
  }

  it("draws Cancel then the red verb, focuses Cancel, and traps Tab inside", () => {
    render(<Opener onAnswer={() => {}} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Delete Scout?" });
    const buttons = [...dialog.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual([STR.cancel, "Delete"]);
    expect(buttons[1]!.className, "the destructive verb is the red button").toContain("btn-danger");
    expect(document.activeElement, "the destructive button is never the default").toBe(buttons[0]);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement, "Tab wraps inside the dialog").toBe(buttons[0]);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons[1]);
  });

  it("Escape answers no and hands focus back to the opener", async () => {
    const onAnswer = vi.fn();
    render(<Opener onAnswer={onAnswer} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Enter on the focused default (Cancel) answers no — Enter can never destroy by accident", async () => {
    const onAnswer = vi.fn();
    render(<Opener onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const cancel = screen.getByRole("button", { name: STR.cancel });
    expect(document.activeElement).toBe(cancel);
    // A focused <button> turns Enter into a click on itself; jsdom does not, so the click is the Enter.
    fireEvent.click(cancel);
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
  });
});

describe("money: one field, one format", () => {
  it("parses what people type and rejects what is not an amount", () => {
    expect(parseMoney("1234.5")).toBe(1234.5);
    expect(parseMoney("$1,234.50")).toBe(1234.5);
    expect(parseMoney(" 12 ")).toBe(12);
    expect(parseMoney(".5")).toBe(0.5);
    for (const bad of ["", "abc", "1.2.3", "-5", "$", ".", "12abc", "NaN", "Infinity"]) expect(parseMoney(bad), bad).toBeNull();
  });

  it("formats with two decimals and thousands separators", () => {
    expect(formatMoney(5)).toBe("5.00");
    expect(formatMoney(1234.5)).toBe("1,234.50");
    expect(formatMoney(1000000)).toBe("1,000,000.00");
  });

  it("the app's money string has separators and never says NaN", () => {
    expect(STR_COST.money(1234.5)).toBe("$1,234.50");
    expect(STR_COST.money(0.004)).toBe("<$0.01");
    expect(STR_COST.money(Number.NaN)).not.toMatch(/NaN/);
    expect(STR_COST.amount("usd", 25000)).toBe("$25,000.00");
  });

  it("MoneyInput draws a $, opens the decimal keypad and tidies a valid amount on blur", () => {
    function Harness() {
      const [v, setV] = useState("1234.5");
      return <MoneyInput aria-label="Monthly budget" value={v} onChange={setV} />;
    }
    const { container } = render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Monthly budget" }) as HTMLInputElement;
    expect(input.inputMode).toBe("decimal");
    expect(container.querySelector(".money-prefix")?.textContent).toBe("$");
    fireEvent.blur(input);
    expect(input.value).toBe("1,234.50");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(input.value, "an invalid amount stays as typed so it can be fixed").toBe("abc");
  });

  it("an invalid MoneyInput says so to assistive tech", () => {
    render(<MoneyInput aria-label="Budget" value="abc" onChange={() => {}} invalid aria-describedby="err" />);
    const input = screen.getByRole("textbox", { name: "Budget" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("err");
  });
});

describe("long names", () => {
  it("the composer placeholder ends in an ellipsis past 28 characters", () => {
    expect(placeholderName("Scout")).toBe("Scout");
    const long = placeholderName("Scout Research Assistant With A Really Long Name");
    expect(long.length).toBeLessThanOrEqual(28);
    expect(long.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stylesheet contract.
// ---------------------------------------------------------------------------
const appCss = stripComments(read("app.css"));
/** Every declaration app.css gives `sel` (all the rules whose selector list names it exactly, in order). */
function ruleFor(sel: string): string | null {
  const found: string[] = [];
  for (const m of appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1]!.split(",").some((s) => s.trim() === sel)) found.push(m[2]!);
  return found.length ? found.join(";") : null;
}

describe("one text field", () => {
  const FIELDS = [".text-input", ".field-input", ".field input", ".rules input"];
  it.each(FIELDS)("%s is the 28px control bar, border-box, with the 3:1 field edge", (sel) => {
    const body = ruleFor(sel);
    expect(body, `no rule for ${sel}`).not.toBeNull();
    expect(body!).toMatch(/height:\s*var\(--control-h\)/);
    expect(body!).toMatch(/border:\s*var\(--hairline\) solid var\(--line-field\)/);
  });

  it("the shared field rule is border-box (the hairline never adds to the 28px) and ellipsizes", () => {
    const body = ruleFor(".text-input")!;
    expect(body).toMatch(/box-sizing:\s*border-box/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(read("widgets.css"), "a second .text-input definition in widgets.css").not.toMatch(/(^|\})\s*\.text-input\s*\{[^}]*height/);
  });

  it("every placeholder takes --ink-faint at full opacity", () => {
    const body = ruleFor("::placeholder");
    expect(body).not.toBeNull();
    expect(body!).toMatch(/color:\s*var\(--ink-faint\)/);
    expect(body!).toMatch(/opacity:\s*1/);
  });

  it("every native select draws the same caret from a token, on the dropdown's fill", () => {
    for (const sel of ["select.dropdown", "select.field-input"]) {
      const body = ruleFor(sel);
      expect(body, sel).not.toBeNull();
      expect(body!).toMatch(/appearance:\s*none/);
      expect(body!).toMatch(/var\(--ink-icon\)/);
      expect(body!).toMatch(/background-color:\s*var\(--fill-button\)/);
    }
  });

  it("the listbox trigger is a dropdown, not a bordered second select", () => {
    const body = ruleFor(".select")!;
    expect(body).not.toMatch(/(^|;)\s*(border|background)(-color)?\s*:/);
  });
});

describe("contrast of field edges, placeholders and the focus halo (WCAG 1.4.3, 1.4.11, 2.4.13)", () => {
  const blocks = themeBlocks();
  const SURFACES = ["--bg", "--surface-raised", "--fill-group", "--fill-inset", "--fill-soft"];
  const over = (a: string, b: string, alpha: number) => {
    const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
    return "#" + [0, 1, 2].map((i) => Math.round(ch(a, i) * alpha + ch(b, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("");
  };
  const focusAlpha = () => Number(stripComments(read("tokens.css")).match(/--focus-ring-soft:\s*color-mix\(in srgb, var\(--focus-ring\) ([\d.]+)%/)![1]) / 100;

  it.each(["light", "dark"] as const)("%s: --line-field is 3:1 against every surface a field sits on", (theme) => {
    const edge = resolve(blocks, theme, "--line-field");
    for (const s of SURFACES) expect(contrast(edge, resolve(blocks, theme, s)), `${edge} on ${s}`).toBeGreaterThanOrEqual(3);
  });

  it.each(["light", "dark"] as const)("%s: placeholder ink is AA on a field", (theme) => {
    expect(contrast(resolve(blocks, theme, "--ink-faint"), resolve(blocks, theme, "--bg"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["light", "dark"] as const)("%s: the focus halo is 3:1 against every surface it is drawn over", (theme) => {
    const ring = resolve(blocks, theme, "--focus-ring");
    for (const s of SURFACES) {
      const under = resolve(blocks, theme, s);
      expect(contrast(over(ring, under, focusAlpha()), under), `halo on ${s}`).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Markup contract: Cancel before the commit.
// ---------------------------------------------------------------------------
const RENDERER = fileURLToPath(new URL("../../src/" + "renderer/", import.meta.url));
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? tsxFiles(dir + d.name + "/") : d.name.endsWith(".tsx") ? [dir + d.name] : []));
}

describe("action rows put Cancel first (macOS: Cancel left, the commit right)", () => {
  it("no btn-primary / btn-danger button is followed by a Cancel or Not now button in the same row", () => {
    const CANCEL = /\{STR[A-Z0-9_]*\.(cancel|notNow)\}<\/button>/;
    const COMMIT = /<button[^>]*className="[^"]*\b(btn-primary|btn-danger)\b[^"]*"[^>]*>/;
    const bad: string[] = [];
    for (const file of tsxFiles(RENDERER)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Same line (a one-line action row) or the next line (a row written one button per line).
        const same = COMMIT.test(line) && CANCEL.test(line.slice(line.search(COMMIT)));
        const next = COMMIT.test(line) && line.includes("</button>") && CANCEL.test(lines[i + 1] ?? "") && !COMMIT.test(lines[i + 1] ?? "");
        if (same || next) bad.push(`${file.slice(RENDERER.length)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
