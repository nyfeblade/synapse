import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolve, themeBlocks } from "./contrast-kit";

const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/tokens.css", import.meta.url)), "utf8");
const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
// The light `:root` block only — everything before the first `@media (prefers-color-scheme: dark)`.
const lightBlock = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
const tok = (block: string, name: string) => block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

describe("smooth pass tokens", () => {
  it("uses one deep black for page, sidebar and canvas in dark", () => {
    expect(tok(darkBlock, "--bg")).toBe("#0C0C0C");
    expect(tok(darkBlock, "--bg-sidebar")).toBe("#0C0C0C");
    expect(tok(darkBlock, "--canvas")).toBe("#0C0C0C");
  });
  it("has four readable text tiers and a quiet hairline", () => {
    expect(tok(darkBlock, "--ink")).toBe("#EDEDED");
    expect(tok(darkBlock, "--ink-2")).toBe("#A8A8A8");
    expect(tok(darkBlock, "--ink-faint")).toBe("#848484");
    expect(tok(darkBlock, "--line-pane")).toBe("#1E1E1E");
  });
  it("keeps hover, selected and press as distinct steps", () => {
    const v = ["--fill-hover", "--fill-selected", "--fill-press"].map((n) => tok(darkBlock, n));
    expect(new Set(v).size).toBe(3);
  });
  // UI polish pass (2026-09-24, critique 1.3): four radii, 6/8/14/20, and the old names are gone.
  it("has the radius ladder 6/8/14/20 and nothing else", () => {
    expect(tok(css, "--radius-xs")).toBe("6px");
    expect(tok(css, "--radius-control")).toBe("8px");
    expect(tok(css, "--radius-card")).toBe("14px");
    expect(tok(css, "--radius-surface")).toBe("20px");
    const names = [...css.matchAll(/(--radius-[\w-]+):/g)].map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual(["--radius-card", "--radius-control", "--radius-surface", "--radius-xs"]);
  });

  // Fix round 1 — "a unified color across the open app" applies to light too: the spec's Studio
  // keeps its own single white, so --bg / --bg-sidebar / --canvas converge on #FFFFFF the way the
  // dark block converges on #0C0C0C above.
  it("uses one white for page, sidebar and canvas in light too", () => {
    expect(tok(lightBlock, "--bg")).toBe("#FFFFFF");
    expect(tok(lightBlock, "--bg-sidebar")).toBe("#FFFFFF");
    expect(tok(lightBlock, "--canvas")).toBe("#FFFFFF");
  });

  it("keeps light's four neutral fills as distinct steps on the now-unified white", () => {
    const blocks = themeBlocks();
    const v = ["--fill-hover", "--fill-group", "--fill-selected", "--fill-press"].map((n) => resolve(blocks, "light", n));
    expect(new Set(v).size, `light fills collapsed onto the same white: ${v.join(", ")}`).toBe(4);
  });
});
