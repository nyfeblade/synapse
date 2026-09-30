import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Smooth-pass spec §1, "one black": the open app is ONE page colour. The sidebar, the chat, the right
// column (docked or wide, and its exit clone) and the window behind them all paint
// --bg — not a sibling token that merely holds the same value today (--canvas, --bg-sidebar), which
// is how the chat once drew #0E0E0E beside a #0C0C0C sidebar. The chat's inner wrappers paint
// nothing of their own, so --bg shows through them. Since the new-user walk (bug 355) the narrow
// panel no longer overlays the chat under 1180px; it stays in the row, transparent over .window.

const read = (f: string) => readFileSync(fileURLToPath(new URL("../../src/renderer/styles/" + f, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The winning `background`/`background-color` for `sel` across app.css (at-rule blocks included). */
function bg(sel: string): string | undefined {
  let v: string | undefined;
  const clean = read("app.css").replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(",").some((s) => s.trim() === sel)) continue;
    for (const d of m[2]!.matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g)) v = d[1]!.replace(/!important/, "").trim();
  }
  return v;
}

describe("one black: every open-app surface is --bg", () => {
  it.each(["body", ".window", ".sidebar", ".main", ".panel.wide", ".panel.leaving"])("%s paints var(--bg)", (sel) => {
    expect(bg(sel)).toBe("var(--bg)");
  });

  it.each([".transcript-wrap", ".transcript", ".composer-wrap", ".chat-header", ".panel-mount", ".panel"])("%s paints no surface of its own", (sel) => {
    const v = bg(sel);
    expect(v === undefined || v === "transparent" || v === "none").toBe(true);
  });

  it("the page-colour aliases equal --bg in light and in both dark blocks", () => {
    const tokens = read("tokens.css");
    const blocks = [...tokens.matchAll(/(:root(?:\[data-theme="dark"\]|:not\(\[data-theme="light"\]\))?)\s*\{([^{}]*)\}/g)];
    const withBg = blocks.filter((b) => /--bg\s*:/.test(b[2]!));
    expect(withBg.length).toBe(3);
    for (const [, , body] of withBg) {
      const val = (name: string) => body!.match(new RegExp("--" + name + "\\s*:\\s*([^;]+)"))?.[1]!.trim().toUpperCase();
      expect(val("canvas")).toBe(val("bg"));
      expect(val("bg-sidebar")).toBe(val("bg"));
    }
  });
});
