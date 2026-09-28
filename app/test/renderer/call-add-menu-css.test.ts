import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Bug 108: the call screen's Add Bot dropdown must never render behind other layers. jsdom has no
// stacking, so the stylesheet contract is pinned here (the teach-cover-css.test.ts technique),
// including the dropdown-stacking rule: entrances use fill-mode `backwards`, so no transform or
// opacity outlives the animation and traps the dropdown in a lower stacking context.

const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const bodies = (sel: string): string[] => {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) if (m[1]!.split(",").some((s) => s.trim() === sel)) out.push(m[2]!);
  return out;
};
const all = (sel: string) => bodies(sel).join(";");
const z = (b: string) => Number(b.match(/z-index:\s*(-?\d+)/)?.[1] ?? NaN);

describe("the call screen's Add Bot dropdown stacks on top (bug 108)", () => {
  it("is positioned with a z-index above every other layer inside the call screen", () => {
    const menu = all(".call-add-menu");
    expect(menu).toMatch(/position:\s*absolute/);
    const mine = z(menu);
    expect(mine).toBeGreaterThan(0);
    // Every other z-index declared on a call-screen part (.call-*, .voice-* but the scrim itself).
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    const others: [string, number][] = [];
    while ((m = re.exec(css))) {
      const sels = m[1]!.split(",").map((s) => s.trim());
      if (sels.some((s) => /^\.(call-|voice-)/.test(s) && !s.startsWith(".voice-scrim") && !s.startsWith(".call-add-menu"))) {
        const v = z(m[2]!);
        if (!Number.isNaN(v)) others.push([sels.join(","), v]);
      }
    }
    for (const [sel, v] of others) expect(mine, `${sel} (z-index ${v}) would cover the dropdown`).toBeGreaterThan(v);
  });

  it("is opaque and flat (the app's dropdown surface, no glass)", () => {
    const menu = all(".call-add-menu");
    expect(menu).toMatch(/background:\s*var\(--surface-raised\)/);
    expect(menu).not.toMatch(/backdrop-filter|blur|opacity:\s*0\.\d/);
  });

  it("its entrance (and the joining avatar's spring) use fill-mode backwards, never forwards or both", () => {
    expect(all(".call-add-menu")).toMatch(/animation:\s*pop-in var\(--motion-pop\) backwards/);
    expect(all(".call-member")).toMatch(/animation:\s*member-in var\(--motion-pop\) backwards/);
    for (const sel of [".call-add-menu", ".call-member", ".call-members", ".call-add-wrap", ".call-solo"]) {
      expect(all(sel), `${sel}`).not.toMatch(/animation[^;]*\b(forwards|both)\b/);
      expect(all(sel), `${sel}`).not.toMatch(/animation-fill-mode:\s*(forwards|both)/);
    }
  });

  it("no ancestor of the dropdown opens a stacking context that would cap it", () => {
    for (const sel of [".call-members", ".call-add-wrap", ".call-solo"]) {
      const b = all(sel);
      expect(b, `${sel}`).not.toMatch(/z-index|transform|opacity|isolation|filter|will-change|contain:/);
    }
  });
});
