import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Bug 46's stylesheet half, in a non-jsdom file (the same reason as teach-cover-css.test.ts:
 * `import.meta.url` is not a file URL under jsdom).
 *
 * The behavioural tests in announcer-outlets.test.tsx assert that an announcement is mounted INSIDE
 * the surface that is on top. That is only the same claim as "the user can see it" because the
 * covers genuinely hide what is behind them and because the outlet genuinely paints above what is
 * inside them. jsdom can check neither (no layout, no stacking), so the two stylesheet facts that
 * make containment equivalent to visibility are pinned here.
 *
 * THE DEFECT THIS REPLACES: `.sidebar` carried no `z-index` at all, so the app's one `role="alert"`
 * — the only reader of `actionError`, which ten writers and the global `call()` failure sink all
 * feed — painted under `.computer-view` (z-index 40, opaque) and under `.scrim` (z-index 50).
 * Measured in Chromium before the fix, with Settings open and a rejected save: the alert's rect was
 * (10, 844, 231x44), `document.elementFromPoint` at its centre returned `DIV.scrim`, and Playwright
 * refused to click its Dismiss button. Raising `.sidebar` would have been the wrong fix — a nav bar
 * over a modal scrim is its own defect — so the announcement moves onto the top surface instead,
 * and `.surface-announce` is what makes it paint above that surface's own contents.
 */

describe("the CSS contract that makes 'on the top surface' mean 'the user can see it'", () => {
  const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = (sel: string) => {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) if (m[1]!.split(",").some((s) => s.trim() === sel)) return m[2]!;
    return null;
  };

  it("the covers really do cover: .computer-view is opaque and full-window, .scrim sits above it", () => {
    const cv = body(".computer-view");
    expect(cv).toMatch(/position:\s*fixed/);
    expect(cv).toMatch(/inset:\s*0/);
    expect(cv).toMatch(/background:\s*var\(--bg\)/);
    expect(cv).toMatch(/z-index:\s*40/);
    const scrim = body(".scrim");
    expect(scrim).toMatch(/position:\s*fixed/);
    expect(scrim).toMatch(/inset:\s*0/);
    expect(scrim).toMatch(/z-index:\s*50/);
  });

  it(".surface-announce is fixed and paints above everything inside the surface it is portalled into", () => {
    const b = body(".surface-announce");
    expect(b, ".surface-announce must exist — it is where a covered announcement goes").toBeTruthy();
    expect(b).toMatch(/position:\s*fixed/);
    expect(b).toMatch(/z-index:\s*60/);
  });

  it("nothing else in the stylesheet declares a z-index at or above the outlet's", () => {
    // The outlet is portalled INTO the top surface, so it only has to out-stack that surface's own
    // children — but a second rule at 60+ elsewhere would be a new cover nobody routed around, which
    // is the whole shape of bug 46. Measured, not listed: every z-index in the file is read.
    const offenders: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const z = /z-index:\s*(-?\d+)/.exec(m[2]!);
      if (!z) continue;
      const sel = m[1]!.trim().replace(/\s+/g, " ");
      if (Number(z[1]) >= 60 && !sel.split(",").some((s) => s.trim() === ".surface-announce")) offenders.push(`${sel} { z-index: ${z[1]} }`);
    }
    expect(offenders, "only the announcement outlet may sit at or above z-index 60").toEqual([]);
  });

  it("the sidebar is NOT raised — the fix is not 'put the nav bar over the scrim'", () => {
    expect(body(".sidebar")).not.toMatch(/z-index/);
  });
});

describe("bug 43's stylesheet half: the marker moved in the DOM and not on screen", () => {
  const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = (sel: string) => {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) if (m[1]!.split(",").some((s) => s.trim() === sel)) return m[2]!;
    return null;
  };

  it("the marker is positioned against the holder, using the avatar's own size", () => {
    // The dot is no longer a child of `.avatar-wrap`, so `.row` / `.tile` must be the containing
    // block and must declare the avatar's size for the offsets to be computed from.
    expect(body(".row")).toMatch(/position:\s*relative/);
    expect(body(".tile")).toMatch(/position:\s*relative/);
    // The Carbon look's Graphite density: 28px row avatars, 36px pinned tiles (Sidebar.tsx BotAvatar sizes).
    expect(body(".row")).toMatch(/--avatar-size:\s*28px/);
    expect(body(".tile")).toMatch(/--avatar-size:\s*36px/);
    expect(body(".row")).toMatch(/--marker-size:\s*9px/);
    expect(body(".tile")).toMatch(/--marker-size:\s*9px/);
    expect(body(".marker")).toMatch(/position:\s*absolute/);
    expect(body(".marker")).toMatch(/box-shadow:\s*0 0 0 2px var\(--marker-ring\)/);
    expect(body(".row > .marker")).toMatch(/left:\s*calc\(8px \+ var\(--avatar-size\) \+ 1px - var\(--marker-size\)\)/);
    expect(body(".row > .marker")).toMatch(/top:\s*calc\(50% \+ var\(--avatar-size\) \/ 2 \+ 1px - var\(--marker-size\)\)/);
    expect(body(".tile > .marker")).toMatch(/left:\s*calc\(50% \+ var\(--avatar-size\) \/ 2 \+ 1px - var\(--marker-size\)\)/);
    expect(body(".tile > .marker")).toMatch(/top:\s*calc\(8px \+ var\(--avatar-size\) \+ 1px - var\(--marker-size\)\)/);
  });

  it("the ring token follows the holder's fill, now that the dot is not inside .avatar-wrap", () => {
    // `--marker-ring` is the row's own resting fill painted behind the dot; it used to be re-pointed
    // on `.avatar-wrap`, which the dot is no longer a descendant of. A stale `.avatar-wrap` selector
    // here would leave a halo of the wrong fill on every hovered, pressed and selected row.
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*--marker-ring[^{}]*)\}/g)) {
      expect(m[1]!.trim(), "a --marker-ring override must be on the row/tile the dot now belongs to").not.toMatch(/\.avatar-wrap/);
    }
  });
});
