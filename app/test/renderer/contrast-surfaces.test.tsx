// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsModal } from "../../src/renderer/components/SettingsModal";
// Each section registers itself on import, the way the app's entry wires them.
import "../../src/renderer/components/settings/ComputerSection";
import "../../src/renderer/components/settings/UpdatesSection";
import "../../src/renderer/components/settings/UsageSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { bgOf, contrast, isHex, read, resolve, rules, SHEETS, specificity, splitTop, themeBlocks, threshold, TOKEN, type Rule } from "./contrast-kit";
import { bot, installBridge, settings } from "./settings-fixtures";

// Bug 41, the RENDERED half — "a token proved against the page fails on the card it actually renders on".
//
// The a11y sweep reported `main/settings [dark] :: color-contrast` growing from 1 node to 3: the
// Settings headings set only `color: var(--ink-faint)` and take their surface from the dialog card
// (--surface-raised) several elements up the tree. contrast-pairs.test.ts reads the stylesheet, and a
// stylesheet cannot say which element is behind which — that is a fact about the DOM. So this file
// renders the real surface, and for every element that paints text it walks the REAL tree: the ink
// is the nearest element (itself first) whose winning rule sets a colour; the surface is the nearest
// element whose winning rule paints a flat token fill, `transparent` letting the walk continue, the
// page (--bg) if nothing does. Winning = the cascade's own order, specificity then source order,
// decided with `Element.matches` against the real selectors.
//
// WHAT IT REPORTS is bug 41's class exactly, the same predicate as the static cross-rule walk: an ink
// that PASSES on the page and FAILS on the surface it really sits on. An ink that already fails on
// the page is the a11y ledger's recorded page-level debt (light --ink-muted / --ink-faint), a
// different defect, and the must-not-fire test below pins that it is routed there rather than lost.
//
// WHAT IT CANNOT SEE: pointer states (jsdom never matches :hover — the static cross-rule walk owns
// those), inline style colours, and any fill that is not one flat token (rgba scrims, gradients), for
// which the element is skipped rather than guessed at.

type Styled = Rule & { sel: string; spec: number; order: number };
const POINTER = /:(hover|active|focus|focus-visible|focus-within)\b/;

function styled(sheets: { name: string; css: string }[]): Styled[] {
  let order = 0;
  const out: Styled[] = [];
  for (const { name, css } of sheets)
    for (const r of rules(name, css)) {
      order++;
      for (const sel of splitTop(r.selector, ",")) {
        if (POINTER.test(sel) || sel.includes("::")) continue;
        out.push({ ...r, sel, spec: specificity(sel), order });
      }
    }
  return out;
}

const matches = (el: Element, sel: string) => { try { return el.matches(sel); } catch { return false; } };

/** The value the cascade would give `el` for one property, or undefined if no rule sets it. */
function winning(all: Styled[], el: Element, pick: (d: Record<string, string>) => string | undefined): string | undefined {
  let best: Styled | undefined;
  let value: string | undefined;
  for (const r of all) {
    const v = pick(r.decls);
    if (v === undefined || !matches(el, r.sel)) continue;
    if (!best || r.spec > best.spec || (r.spec === best.spec && r.order > best.order)) { best = r; value = v; }
  }
  return value;
}

type Finding = { text: string; path: string; theme: "light" | "dark"; ink: string; fill: string; ratio: number; onPage: number; need: number };

export function measureRendered(root: Element, sheets = SHEETS.map((name) => ({ name, css: read(name) }))): Finding[] {
  const all = styled(sheets);
  const blocks = themeBlocks();
  const out: Finding[] = [];
  const painters = [...root.querySelectorAll("*")].filter((el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && !el.closest("svg, [hidden], [aria-hidden='true']"));
  for (const el of painters) {
    let ink: string | undefined;
    let fill: string | undefined;
    let unknown = false;
    const type: Record<string, string> = {};
    for (let at: Element | null = el; at && (!ink || !fill); at = at.parentElement) {
      if (!ink) ink = winning(all, at, (d) => d.color)?.match(TOKEN)?.[1];
      if (!type["font-size"]) { const s = winning(all, at, (d) => d["font-size"]); if (s) type["font-size"] = s; }
      if (!type["font-weight"]) { const w = winning(all, at, (d) => d["font-weight"]); if (w) type["font-weight"] = w; }
      if (!fill) {
        const bg = winning(all, at, bgOf);
        if (bg === undefined || /^(transparent|none|inherit)$/.test(bg)) continue;
        fill = bg.match(TOKEN)?.[1];
        if (!fill) { unknown = true; break; }
      }
    }
    if (unknown) continue;
    const inkT = ink ?? "--ink";
    const fillT = fill ?? "--bg";
    const { need } = threshold(type);
    for (const theme of ["light", "dark"] as const) {
      const [i, f, page] = [resolve(blocks, theme, inkT), resolve(blocks, theme, fillT), resolve(blocks, theme, "--bg")];
      if (!isHex(i) || !isHex(f)) continue;
      out.push({
        text: el.textContent!.trim().slice(0, 40), path: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`, theme,
        ink: inkT, fill: fillT, need,
        ratio: Math.round(contrast(i, f) * 100) / 100, onPage: Math.round(contrast(i, page) * 100) / 100,
      });
    }
  }
  return out;
}

const provedOnPageFailsOnSurface = (m: Finding) => m.ratio < m.need && m.onPage >= m.need;
const describeBad = (fs: Finding[]) => fs.map((m) => `${m.ratio.toFixed(2)}:1 (page ${m.onPage.toFixed(2)}) [${m.theme}] ${m.path} "${m.text}"  ${m.ink} on ${m.fill}  needs ${m.need}`);
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  const h = installBridge();
  const base = h.gateway;
  h.gateway = (cmd, args) =>
    cmd === "getLocalComputer" ? { computer: { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/x", autoRunRoots: [], home: "/x" } }
    : cmd === "getNetworkStats" ? { routedThisSession: 3 } : base(cmd, args);
  useUi.setState({ ...initialState(), settings: settings(), settingsOpen: true, bots: [bot] } as never);
});
afterEach(cleanup);

describe("bug 41 — Settings, every section: no ink proved on the page fails on the card it renders on", () => {
  it("measures every text node of every reachable section against the surface it really sits on", async () => {
    render(<SettingsModal />);
    await settle();
    const nav = document.querySelector("nav[aria-label='Settings sections']")!;
    const sections = [...nav.querySelectorAll("button")].filter((b) => !(b as HTMLButtonElement).disabled);
    expect(sections.length, "no reachable Settings sections — the render is broken, not the colours").toBeGreaterThan(1);
    const bad: string[] = [];
    let measured = 0;
    const onCard = new Set<string>();
    for (const b of sections) {
      fireEvent.click(b);
      await settle();
      const found = measureRendered(document.body);
      measured += found.length;
      for (const f of found) if (f.fill !== "--bg") onCard.add(f.fill);
      bad.push(...describeBad(found.filter(provedOnPageFailsOnSurface)).map((s) => `${b.textContent}: ${s}`));
    }
    expect(measured, "the walk measured almost nothing — it has stopped finding text").toBeGreaterThan(40);
    // The instrument's own point: text in Settings sits on the dialog card, not on the page.
    expect([...onCard], "every Settings text was measured against the page — the surface walk is not reaching the card").toContain("--surface-raised");
    expect(bad, `an ink proved on the page fails on the surface it renders on:\n   ${bad.join("\n   ")}\n`).toEqual([]);
  });
});

describe("the rendered walk itself", () => {
  const sheet = (css: string) => [{ name: "fixture.css", css }];
  const mount = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; document.body.appendChild(d); return d; };
  afterEach(() => { document.body.innerHTML = ""; });

  it("MUST fire on bug 41's exact shape: an ink proved on the page, on a card several elements up", () => {
    const root = mount(`<div class="card"><section><p class="faint">Section heading</p></section></div>`);
    const m = measureRendered(root, sheet(`.card { background: var(--fill-selected-press); } .faint { color: var(--ink-faint); }`)).find((x) => x.theme === "dark")!;
    expect(m.fill, "the surface is the card three levels up, not the page").toBe("--fill-selected-press");
    expect(m.onPage, "--ink-faint passes on the dark page").toBeGreaterThanOrEqual(4.5);
    expect(provedOnPageFailsOnSurface(m), "and fails on the card it actually sits on").toBe(true);
  });

  it("takes the fill from the nearest painted ancestor and walks through `transparent`", () => {
    const root = mount(`<div class="outer"><div class="clear"><span class="t">x</span></div></div>`);
    const [m] = measureRendered(root, sheet(`.outer { background: var(--fill-inset); } .clear { background: transparent; } .t { color: var(--ink); }`));
    expect(m!.fill).toBe("--fill-inset");
  });

  it("lets the more specific rule win, the way the cascade does", () => {
    const root = mount(`<p class="a b">x</p>`);
    const [m] = measureRendered(root, sheet(`.a.b { color: var(--ink); } .a { color: var(--ink-faint); }`));
    expect(m!.ink).toBe("--ink");
  });

  it("must NOT fire on text that sits on the page", () => {
    const root = mount(`<p class="t">x</p>`);
    expect(measureRendered(root, sheet(`.t { color: var(--ink-icon); }`)).filter(provedOnPageFailsOnSurface)).toEqual([]);
  });

  it("must NOT report an ink that already fails on the page as this bug — it is the page-level ledger's", () => {
    const root = mount(`<div class="card"><p class="t">x</p></div>`);
    const m = measureRendered(root, sheet(`.card { background: var(--fill-inset); } .t { color: var(--ink-disabled); }`)).find((x) => x.theme === "light")!;
    expect(m.ratio).toBeLessThan(4.5);
    expect(m.onPage, "light --ink-disabled is short on the page itself").toBeLessThan(4.5);
    expect(provedOnPageFailsOnSurface(m)).toBe(false);
  });

  it("must NOT guess at a fill that is not one flat token", () => {
    const root = mount(`<div class="scrim"><p class="t">x</p></div>`);
    expect(measureRendered(root, sheet(`.scrim { background: linear-gradient(var(--bg), var(--fill-soft)); } .t { color: var(--ink-faint); }`))).toEqual([]);
  });
});
