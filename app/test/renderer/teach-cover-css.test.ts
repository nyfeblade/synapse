import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Bug 42's other half, in a non-jsdom file because `import.meta.url` is not a file URL under jsdom.
//
// The behavioural tests in teach-reachable.test.tsx assert that the teach UI is mounted INSIDE the
// surface that is on top. That is only the same claim as "the user can see it" because
// `.computer-view` genuinely hides everything behind it. jsdom cannot check that (no layout, no
// stacking), so the stylesheet contract is pinned here instead — the same technique, and the same
// reason, as layout-fit.test.ts.

describe("the CSS contract that makes 'outside the computer view' mean 'invisible'", () => {
  const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = (sel: string) => {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) if (m[1]!.split(",").some((s) => s.trim() === sel)) return m[2]!;
    return null;
  };

  it(".computer-view is a fixed, opaque, full-window cover — anything mounted under it is unreachable", () => {
    const b = body(".computer-view");
    expect(b).toBeTruthy();
    expect(b).toMatch(/position:\s*fixed/);
    expect(b).toMatch(/inset:\s*0/);
    expect(b).toMatch(/background:\s*var\(--bg\)/); // opaque: not transparent, not a scrim
    expect(b).toMatch(/z-index:\s*40/);
  });
});
