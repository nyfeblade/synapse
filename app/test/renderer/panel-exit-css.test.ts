import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The panel's exit is a detached clone (DetailsPanel.tsx beginPanelExit) pinned over where the panel
// was, while the chat has already widened underneath it. Two things made it a ghost:
//  1. the clone's children still match `.panel > * { animation: panel-in … backwards }`, so appending
//     the clone to <body> RE-PLAYS the entrance — content slides in again while the box fades out;
//  2. a non-wide `.panel` is `background: transparent`, so the fading clone drew its text straight
//     over the chat's own messages.
// The clone's children hold still, and the clone paints the one page colour (--bg) as it fades.

const css = () => readFileSync(fileURLToPath(new URL("../../src/renderer/styles/" + "app.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

function decl(sel: string, prop: string): string | undefined {
  let v: string | undefined;
  for (const m of css().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(",").some((s) => s.trim() === sel)) continue;
    const d = m[2]!.match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)"));
    if (d) v = d[1]!.replace(/!important/, "").trim();
  }
  return v;
}

describe("panel exit clone", () => {
  it("does not replay the entrance on its children", () => {
    expect(decl(".panel.leaving > *", "animation")).toBe("none");
  });
  it("paints the opaque page background, never transparent over the chat", () => {
    expect(decl(".panel.leaving", "background")).toBe("var(--bg)");
  });
});
