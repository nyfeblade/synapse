import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Bug 31, THE CLASS — overlay number 19 cannot be hand-rolled silently.
//
// PR #31 replaced thirteen hand-rolled overlays with one <Dialog> primitive and one overlay stack,
// and nothing failed when a call site was left outside it. Bug 31 was logged because a grep for
// `role="dialog"` still found three files — and the grep was WRONG about all three: SettingsModal's
// hit is a COMMENT about the fix, and ComputerView's and VoiceOverlay's are the primitive's second
// documented entry point, `useOverlayLayer()`, which is for a surface that draws its own frame. A
// grep cannot tell a hand-rolled overlay from a legitimate one, so a grep is not the guard.
//
// The rule this enforces instead is the thing the grep was reaching for and could not express:
//
//   A `role="dialog"` / `aria-modal` element in the renderer must BE the panel its file hands to
//   `useOverlayLayer({ panelRef })`.
//
// That is a measurement, not an allowlist. ComputerView, VoiceOverlay and AvatarEditor pass it
// because they genuinely join the stack, not because they are named here; a fourth surface that
// draws its own frame passes the moment it takes the hook, and a surface that types `role="dialog"`
// and keeps its own keydown listener fails no matter what it is called. There is nothing to add to
// when the next overlay arrives, and nothing to quietly extend to let one through.
//
// Modelled on readout-affordance.test.tsx (a rendered pass plus a static sweep of every declaration
// in src/renderer) and unsafe-bots-lookup.test.ts (a deliberately blunt, zero-exception source rule,
// read from the real .ts/.tsx rather than rendered, because the defect is a claim in the source that
// only a cross-surface interaction would ever exercise). The behaviour those declarations are
// supposed to produce is driven, two surfaces at a time, in overlay-stragglers.test.tsx.
//
// SCROLL LOCK / THE BACKDROP is the last section. This app's document never scrolls — `.window` is
// `overflow: hidden` and every scrolling region is a pane inside it — so "background scroll is
// locked while an overlay is up" is not a body-style toggle here; it is the question of whether the
// surface's backdrop actually covers the panes that scroll. That is a stylesheet fact, so it is
// asserted against the stylesheet.
// ---------------------------------------------------------------------------

const RENDERER = fileURLToPath(new URL("../../src/" + "renderer", import.meta.url));
const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));

/** The primitive itself: it is where `role="dialog"` and `aria-modal` are SUPPOSED to be written. */
const PRIMITIVE = "components/Dialog.tsx";

function sources(dir = RENDERER): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = dir + "/" + e;
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(e) ? [p] : [];
  });
}

const rel = (file: string) => file.slice(file.indexOf("src/renderer/") + "src/renderer/".length);

/**
 * Comments out, everything else kept at the same offsets.
 *
 * Replacing with spaces rather than deleting keeps line numbers and indices honest, and it is the
 * whole reason this guard does not repeat bug 31's own mistake: `SettingsModal.tsx:21` is the line
 * `// Hand-testing round: \`aria-modal\` was the only thing that made this a modal.` — prose about
 * the fix, which a grep counted as an instance of the defect.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
}

/** The identifiers a file passes as `panelRef` to `useOverlayLayer`, i.e. its real stack-joined panels. */
export function panelRefNames(src: string): Set<string> {
  const out = new Set<string>();
  if (!/\buseOverlayLayer\s*\(/.test(src)) return out;
  for (const m of src.matchAll(/panelRef\s*:\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  // `useOverlayLayer({ panelRef })` — the shorthand form.
  for (const m of src.matchAll(/panelRef\s*(?=[,}])/g)) if (!src.slice(m.index!, m.index! + 20).includes(":")) out.add("panelRef");
  return out;
}

/** The opening tag surrounding `index`, brace-aware so an attribute value containing `>` cannot end it. */
function tagAround(src: string, index: number): { text: string; start: number } | null {
  let start = index;
  while (start >= 0 && src[start] !== "<") start--;
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return { text: src.slice(start, i + 1), start };
  }
  return null;
}

export interface Declaration { file: string; line: number; attr: string; tag: string; ref: string | null }

/** Every `role="dialog"` / `aria-modal` written by hand, with the ref the element is bound to. */
export function declarations(file: string, raw: string): Declaration[] {
  const src = stripComments(raw);
  const out: Declaration[] = [];
  for (const m of src.matchAll(/\brole="dialog"|\baria-modal\b/g)) {
    const tag = tagAround(src, m.index!);
    if (!tag) continue;
    out.push({
      file, line: src.slice(0, m.index!).split("\n").length, attr: m[0]!, tag: tag.text.replace(/\s+/g, " ").trim(),
      ref: tag.text.match(/\bref=\{([A-Za-z_$][\w$]*)\}/)?.[1] ?? null,
    });
  }
  return out;
}

/** A declaration is legitimate exactly when it sits on a panel the file handed to useOverlayLayer. */
export function violations(files: { file: string; src: string }[]): string[] {
  const out: string[] = [];
  for (const { file, src } of files) {
    const panels = panelRefNames(stripComments(src));
    for (const d of declarations(file, src)) {
      if (d.ref && panels.has(d.ref)) continue;
      out.push(`${d.file}:${d.line}: ${d.attr} on an element that is not a useOverlayLayer panel — ${d.tag}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The renderer, as it actually is.
// ---------------------------------------------------------------------------
describe("no renderer file hand-rolls a dialog outside the primitive", () => {
  const real = () => sources().filter((f) => rel(f) !== PRIMITIVE).map((f) => ({ file: f, src: readFileSync(f, "utf8") }));

  it("finds the declarations to check — the scan is not vacuous", () => {
    const found = real().flatMap(({ file, src }) => declarations(file, src));
    // ComputerView, VoiceOverlay and AvatarEditor each draw their own frame and each write one.
    expect(found.length, "no role=dialog/aria-modal found outside Dialog.tsx — the scan is broken").toBeGreaterThanOrEqual(3);
    expect(new Set(found.map((d) => rel(d.file)))).toContain("components/ComputerView.tsx");
    expect(new Set(found.map((d) => rel(d.file)))).toContain("voice/VoiceOverlay.tsx");
  });

  it("every one of them is the panel its file gave useOverlayLayer", () => {
    const bad = violations(real()).map((v) => v.slice(v.indexOf("src/renderer/") + "src/renderer/".length));
    expect(bad, `a surface declaring itself a dialog without joining the overlay stack:\n${bad.join("\n")}`).toEqual([]);
  });

  it("does not count prose: SettingsModal's comment about aria-modal is not a declaration", () => {
    const f = sources().find((p) => rel(p) === "components/SettingsModal.tsx")!;
    const src = readFileSync(f, "utf8");
    expect(src, "the comment bug 31 mis-read as markup is still there to mis-read").toContain("`aria-modal` was the only thing");
    expect(declarations(f, src), "SettingsModal renders <Dialog>; it declares nothing by hand").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-tests: what the rule must reject, and what it must not.
// A guard nobody has seen fail is a guard nobody knows works.
// ---------------------------------------------------------------------------
describe("the rule itself — what it rejects", () => {
  const check = (src: string) => violations([{ file: "src/renderer/x.tsx", src }]);

  it("rejects a surface that writes role=\"dialog\" and keeps its own keydown listener", () => {
    expect(check(`
      export function Sheet() {
        const box = useRef<HTMLDivElement>(null);
        useEffect(() => { window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); }); }, []);
        return <div ref={box} role="dialog" aria-modal="true" className="sheet">x</div>;
      }`)).toHaveLength(2); // both attributes are hand-rolled
  });

  it("rejects an element that claims aria-modal without any ref at all", () => {
    expect(check(`export function S() { return <div role="dialog" aria-modal="true">x</div>; }`)).toHaveLength(2);
  });

  it("rejects a file that DOES take the hook but puts the role on a different element", () => {
    const bad = check(`
      export function S() {
        const panel = useRef<HTMLDivElement>(null);
        const inner = useRef<HTMLDivElement>(null);
        useOverlayLayer({ onClose: close, panelRef: panel });
        return <div ref={panel}><div ref={inner} role="dialog" aria-modal="true">x</div></div>;
      }`);
    expect(bad, "the stack has to be holding the element that says it is a dialog").toHaveLength(2);
  });

  it("rejects a surface that takes the hook for one panel and hand-rolls a second dialog beside it", () => {
    expect(check(`
      export function S() {
        const panel = useRef<HTMLDivElement>(null);
        useOverlayLayer({ onClose: close, panelRef: panel });
        return <><div ref={panel} role="dialog">a</div><div role="dialog" aria-modal="true">b</div></>;
      }`)).toHaveLength(2);
  });
});

describe("the rule itself — what it must NOT reject", () => {
  const check = (src: string) => violations([{ file: "src/renderer/x.tsx", src }]);

  it("passes the shape ComputerView and VoiceOverlay use: own frame, behaviour from the hook", () => {
    expect(check(`
      export function S() {
        const panel = useRef<HTMLDivElement>(null);
        useOverlayLayer({ active, onClose: close, panelRef: panel, layer: "page" });
        return <div ref={panel} role="dialog" aria-modal="true" tabIndex={-1} className="own-frame">x</div>;
      }`)).toEqual([]);
  });

  it("passes a surface that renders <Dialog> and writes neither attribute", () => {
    expect(check(`export function S() { return <Dialog label="S" onClose={close}><p>x</p></Dialog>; }`)).toEqual([]);
  });

  it("passes prose — a comment is not a declaration, in either comment syntax", () => {
    expect(check(`
      // \`aria-modal\` was the only thing that made this a modal.
      /* a role="dialog" here would be markup if this were not a comment */
      export function S() { return <Dialog label="S" onClose={close}><p>x</p></Dialog>; }`)).toEqual([]);
  });

  it("passes an element whose attribute value contains a '>' before the tag ends", () => {
    expect(check(`
      export function S() {
        const panel = useRef<HTMLDivElement>(null);
        useOverlayLayer({ onClose: close, panelRef: panel });
        return <div ref={panel} role="dialog" aria-label={a > b ? "x" : "y"}>x</div>;
      }`)).toEqual([]);
  });

  it("does not silently pass everything: the same fixtures without the hook are all rejected", () => {
    // Guards against the detector degrading into "returns [] whatever it is given".
    expect(check(`export function S() { return <div role="dialog">x</div>; }`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The ordering decision, tied back to the stylesheet.
//
// overlay-stack.ts ranks layers by two declared names, "page" and "modal", because jsdom loads no
// stylesheet and a measured z-index would be "auto" in every test. That declaration is only worth
// anything while it matches the CSS, so this is where the two are put against each other.
// ---------------------------------------------------------------------------
describe("the paint ranks the stack sorts by are the z-indexes the app actually paints", () => {
  const css = () => readFileSync(stylePath("app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleFor = (sel: string) => css().match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  const zOf = (sel: string) => Number(ruleFor(sel).match(/z-index:\s*(-?\d+)/)?.[1] ?? NaN);

  it("the page layer paints below the modal layer", () => {
    const page = zOf(".computer-view");
    const modal = zOf(".scrim");
    expect(Number.isFinite(page) && Number.isFinite(modal), "both surfaces must declare a z-index").toBe(true);
    expect(page, `.computer-view (${page}) must paint under .scrim (${modal}) for layer:"page" to mean anything`).toBeLessThan(modal);
  });

  it("only a surface that genuinely covers the app takes the page rank", () => {
    const hook = readFileSync(RENDERER + "/components/ComputerView.tsx", "utf8");
    expect(stripComments(hook), "ComputerView is the page layer").toMatch(/layer:\s*"page"/);
    const frame = ruleFor(".computer-view");
    expect(frame, "a page-level layer covers the window, so aria-modal on it is true").toMatch(/position:\s*fixed/);
    expect(frame).toMatch(/inset:\s*0/);
  });

  it("and it is the only one: a second page-level surface is a decision, not a default", () => {
    const pageLayers = sources().filter((f) => /layer:\s*"page"/.test(stripComments(readFileSync(f, "utf8")))).map(rel);
    expect(pageLayers, "if this grows, the rank above needs a third name and a z-index to match").toEqual(["components/ComputerView.tsx"]);
  });
});

// ---------------------------------------------------------------------------
// The backdrop: what "background scroll is locked" means in an app whose document never scrolls.
// ---------------------------------------------------------------------------
describe("every overlay's backdrop covers the panes that scroll", () => {
  const css = () => readFileSync(stylePath("app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleFor = (sel: string, text = css()) => text.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  it("the document itself never scrolls, so no overlay has a body scroll to lock", () => {
    expect(ruleFor(".window"), "if .window ever scrolls, every overlay needs a real scroll lock").toMatch(/overflow:\s*hidden/);
  });

  it("the shared scrim covers the whole window, in both stylesheets that define it", () => {
    for (const file of ["app.css", "palette.css"]) {
      const rule = ruleFor(".scrim", readFileSync(stylePath(file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
      expect(rule, `${file}: .scrim`).toMatch(/position:\s*fixed/);
      expect(rule, `${file}: .scrim`).toMatch(/inset:\s*0/);
    }
  });

  it("the computer view covers it too — it is why it needs no scrim of its own", () => {
    expect(ruleFor(".computer-view")).toMatch(/position:\s*fixed/);
    expect(ruleFor(".computer-view")).toMatch(/inset:\s*0/);
  });

  // The voice overlay is the one surface whose backdrop is deliberately NOT the window. PR
  // "fix(voice): make the voice overlay a real dialog instead of a click trap" gave it a scrim
  // `position: absolute` inside `.main`, so the sidebar stays live behind it — which is how the
  // account button is reachable to open Settings over voice mode at all, and where Settings hands
  // focus back to when it closes. This pins that as a decision rather than an oversight: it covers
  // the scrolling pane it lives in (`.transcript`, the only scroller in `.main`), and if it ever
  // stops being pane-scoped, the focus hand-back in overlay-stragglers.test.tsx is what changes.
  it("the voice overlay covers its own pane, and the pane is the one that scrolls", () => {
    expect(ruleFor(".voice-scrim"), "pane-scoped by decision — see VoiceOverlay.tsx").toMatch(/position:\s*absolute/);
    expect(ruleFor(".voice-scrim")).toMatch(/inset:\s*0/);
    expect(ruleFor(".main"), "…and `.main` is its containing block, so `inset: 0` is the whole pane").toMatch(/position:\s*relative/);
    expect(ruleFor(".transcript"), "the scroller it has to cover lives in `.main`").toMatch(/overflow-y:\s*auto/);
  });
});
