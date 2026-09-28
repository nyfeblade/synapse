import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Bug 30, THE CLASS — "one button role, spelled differently in every file that needed it".
//
// The reported symptom: `.btn-primary` (a 32px/16px pill), `.btn.primary` (30px/8px) and `.btn-dark`
// (30px/8px) all rendered "the primary action", and which one a surface got depended only on which
// file its component was written in. Destructive had the same defect with an inverted-naming trap on
// top — `.btn-danger` vs `.btn.danger` vs `.danger-btn` vs `.link-btn.danger`, where that last one
// never painted anything red at all because no rule ever matched `.danger` on a `.link-btn`.
//
// Nothing failed while that was true. A className is a string; a fourth spelling costs nothing to
// invent and nothing to ship. So this file makes the app's primary/destructive button vocabulary an
// asserted thing rather than an emergent one.
//
// THE RULE:
//
//   Every class combination used on a <button>/<label> in the renderer whose resolved style paints
//   `var(--primary)` as a background, or `var(--danger)` as a background or as ink, is a PRIMARY or
//   DESTRUCTIVE control, and must appear in ROLES below — once, with a surface and an authority.
//
// ROLES is the specification, not an exemption list, and it is built so it cannot be used as one:
//
//   * No two roles may RENDER THE SAME DESIGN (`no two roles are the same button`). This is the
//     assertion `.btn.primary` and `.btn-dark` failed: measured in Chromium at 1440x900, both were
//     30px tall, 8px radius, `--primary` fill — the same button under two names. You cannot silence
//     this guard by adding your new spelling to ROLES, because a duplicate design still fails.
//   * Every role must be USED (`no role is dead`), so entries cannot be parked here speculatively.
//   * Every role must name a SURFACE and an AUTHORITY, so adding one is a reviewable act rather
//     than a line of housekeeping.
//   * A token spelled `danger` must actually paint a destructive red (`no dead danger spelling`).
//     This is the assertion `.link-btn.danger` failed.
//     WIDENED, NOT WEAKENED (bug 41): there are now two destructive reds — `--danger` is the FILL (the
//     denied dot, the `.btn-danger` slab, the recording frame) and `--danger-ink` is semantic red TEXT,
//     which changes with the theme. `.btn.danger`, `.danger-btn` and `.menu-item.danger` are
//     ink, so they take `--danger-ink`. The claim this assertion makes is unchanged and still bites:
//     a class that says danger and paints neither red is still the inverted-naming trap, which is
//     what the `.link-btn.danger` self-test below pins.
//
// UPDATED BY THE SMOOTH PASS (Task 4, docs/sdd 2026-09-23): the boards drew two primary roles verbatim
// — a 32px/16px pill for the in-conversation decision (Allow once / Always allow / Deny, Take over /
// I'm done / Skip) and a 30px/8px rect for the app's own chrome (Cancel / Set avatar, Add Rule /
// Reconnect / Save, Manage Usage, Connect) — and this file once kept them apart on exactly that
// authority. The Apple pass (decisions.md, "the Apple refinement") already found macOS drawing ONE
// push button across those surfaces and collapsed the geometry into `.btn-primary` at the control
// scale (`--control-h` 28 / `--radius-control` 8); the radius ladder (docs/sdd 2026-09-23) is what
// that scale now reads its corner from, and the approval card's Allow once follows it rather than
// carrying its own 16px pill. ROLES below has reflected the single role for a while — this comment
// had not, and a comment describing two roles for one declared role is the kind of drift this file
// exists to catch everywhere else.
//
//   * 28px/14px pill — the bar-scale action, `.btn-compact`, one rung apart from `.btn-primary` on
//     the radius ladder and never collapsed into it. Computer.dc.html draws "Teach a task"
//     in the computer view's 44px title bar at `height: 28px; padding: 0 12px; border-radius: 14px;
//     border: 1px solid #DADADA; background: #FFFFFF; font-size: 13px`. It is the only board
//     instance of this design, and bug 35 is that the app spelled it THREE times — `.stop-btn`,
//     `.teach-btn`, `.teach-pill` — one per surface that needed it.
//
// Collapsing those into one another would be as much a defect as splitting one into three: the clone
// would then differ from the boards on whichever surface lost. What was wrong was never that several
// designs existed — it was that a spelling existed for no reason, and that the choice between them
// was made by file of origin rather than by surface.
//
// BUGS 34 AND 35 WIDENED THIS FILE past the colours bug 30 reported:
//
//   * `no two of the renderer's button bars render the same design` asks the WHOLE button
//     vocabulary, not just ROLES and not just the primary/destructive slice — which is why bug 35's
//     three outlined secondaries could exist under bug 30's guard without failing anything. It needs
//     no role table and takes no allowlist: two names for one bar fail, and a modifier on ONE bar
//     (`.btn.file-btn` is still `.btn`) is not two names.
//   * `a size modifier on a labelled bar moves the bar, not only the type` is bug 34:
//     `.btn-primary.small` moved New chat's "Create group" from 13px type to 12px and left the full
//     32px bar under it, because only `.btn-outline.small` ever shrank a bar. A size that does not
//     exist is worse than either size. The `.small` there is now gone rather than implemented — see
//     docs/bug-log.md row 34 for why that was a judgement call and not the boards.

const RENDERER = fileURLToPath(new URL("../../src/renderer/", import.meta.url));
const STYLE_DIR = RENDERER + "styles/";

/** Stylesheet load order (main.tsx, then the sheets components import), because later wins on ties. */
const SHEET_ORDER = [
  "tokens.css", "app.css", "widgets.css", "skills.css", "skill-picker.css",
  "palette.css", "message-actions.css", "bot-admin.css", "code-block.css", "files.css", "google.css", "usage-dashboard.css", "voice-calls.css",
  "living-avatars.css",
];

type Sheet = { name: string; css: string };
type Source = { path: string; tsx: string };

const blankComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function sheets(): Sheet[] {
  const present = new Set(readdirSync(STYLE_DIR).filter((f) => f.endsWith(".css")));
  const ordered = SHEET_ORDER.filter((f) => present.has(f));
  const missing = [...present].filter((f) => !SHEET_ORDER.includes(f));
  // A new stylesheet must be placed in the load order deliberately; appending it silently would let
  // its rules resolve in the wrong place and quietly change what this guard believes it sees.
  expect(missing, `stylesheet not placed in SHEET_ORDER: ${missing.join(", ")}`).toEqual([]);
  return ordered.map((name) => ({ name, css: readFileSync(STYLE_DIR + name, "utf8") }));
}

function sources(): Source[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(dir + e.name + "/") : e.name.endsWith(".tsx") ? [dir + e.name] : [],
    );
  return walk(RENDERER).map((p) => ({ path: p.slice(RENDERER.length), tsx: readFileSync(p, "utf8") }));
}

type Rule = { prelude: string; body: string; order: number };

/** Every rule at the top level of a stylesheet — nothing nested inside an at-rule. */
function topLevelRules(css: string, from: number): Rule[] {
  const clean = blankComments(css);
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of clean) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; depth++; }
    else if (ch === "}") {
      const prelude = stack.pop();
      depth--;
      if (depth === 0 && prelude && !prelude.startsWith("@")) out.push({ prelude, body: buf, order: from + out.length });
      buf = "";
    } else buf += ch;
  }
  return out;
}

const declarationsIn = (body: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(?:^|;)\s*([-a-zA-Z]+)\s*:\s*([^;]+)/g)) out[m[1]!] = m[2]!.trim();
  return out;
};

/**
 * Does `selector` describe the BASE look of an element carrying exactly `tokens`?
 * Only plain class chains count: anything with a pseudo-class, a combinator or an attribute is a
 * state or a scoped override, not the design, and is never merged in. Returns the selector's
 * specificity (its class count) so the cascade can be replayed.
 */
function specificityFor(selector: string, tokens: string[]): number | null {
  const sel = selector.trim();
  if (!sel.startsWith(".") || /[\s>+~:[\]]/.test(sel)) return null;
  const parts = sel.split(".").filter(Boolean);
  if (!parts.length || !parts.every((p) => tokens.includes(p))) return null;
  return parts.length;
}

/** The declarations an element carrying `tokens` ends up with, cascade replayed in load order. */
function resolveDesign(all: Sheet[], tokens: string[]): Record<string, string> {
  const hits: { spec: number; order: number; decls: Record<string, string> }[] = [];
  let base = 0;
  for (const sheet of all) {
    const rules = topLevelRules(sheet.css, base);
    base += rules.length + 1;
    for (const rule of rules) {
      for (const sel of rule.prelude.split(",")) {
        const spec = specificityFor(sel, tokens);
        if (spec !== null) hits.push({ spec, order: rule.order, decls: declarationsIn(rule.body) });
      }
    }
  }
  hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const out: Record<string, string> = {};
  for (const h of hits) Object.assign(out, h.decls);
  return out;
}

/**
 * What the border actually LOOKS like, which is not what it is written as. `.btn.primary` inherits
 * `border: 1px solid var(--line-button)` from `.btn` and then recolours it to `var(--primary)` — the
 * same colour as its own fill, so nothing is drawn. Comparing the declaration text would have called
 * that different from `.btn-dark`'s `border: none` and let the duplicate through; comparing what is
 * painted says they are the same button, which is the whole finding of bug 30.
 */
function borderLook(d: Record<string, string>): string {
  const shorthand = d.border ?? "";
  const colour = d["border-color"]
    ?? shorthand.match(/var\(--[\w-]+\)|#[0-9a-fA-F]{3,8}|\btransparent\b|\bcurrentColor\b/)?.[0]
    ?? "";
  if (!colour || /^\s*(none|0)\b/.test(shorthand) && !d["border-color"]) return "none";
  if (colour === "transparent") return "none";
  if (colour === (d.background ?? "")) return "none"; // a border the colour of the fill is invisible
  return colour;
}

/** What a reader of the screen sees. Two classes sharing this are one role spelled twice. */
const SIGNATURE_KEYS = ["height", "border-radius", "background", "color", "font-size", "padding"];
const signatureOf = (d: Record<string, string>) =>
  [...SIGNATURE_KEYS.map((k) => `${k}=${d[k] ?? "-"}`), `border=${borderLook(d)}`].join("  ");

/**
 * Every distinct set of class tokens the renderer puts on a <button> or <label>, keyed by the sorted
 * token list.
 *
 * Each STRING LITERAL inside the className is one candidate set, so the app's usual conditional form
 * — `className={on ? "switch on" : "switch"}` — yields `on.switch` AND `switch`, the two class sets
 * that element can really have. Unioning the branches instead would invent combinations that never
 * render (`btn-dark.btn-primary` out of `busy ? "btn-primary" : "btn-dark"`) and would then accuse
 * the renderer of them.
 */
function buttonClassUses(srcs: Source[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { path, tsx } of srcs) {
    for (const m of tsx.matchAll(/<(?:button|label)\b[\s\S]{0,400}?className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
      const value = m[1] !== undefined ? JSON.stringify(m[1]) : (m[2] ?? m[3] ?? "");
      const literals = [...value.matchAll(/`([^`$]*)`|"([^"]*)"|'([^']*)'/g)].map((l) => l[1] ?? l[2] ?? l[3] ?? "");
      for (const literal of literals) {
        const tokens = [...new Set(literal.split(/\s+/).filter((t) => /^[a-z][\w-]*$/.test(t)))].sort();
        if (!tokens.length) continue;
        const key = tokens.join(".");
        if (!out.has(key)) out.set(key, new Set());
        out.get(key)!.add(path);
      }
    }
  }
  return out;
}

/**
 * Tokens that define a button's BAR — a rule naming them sets both a height and a border-radius.
 * `.btn-primary` and `.btn-dark` do; `.primary`, `.danger`, `.small`, `.file-btn` and
 * `.btn-compact-primary` do not, because those are modifiers that recolour a bar somebody else drew.
 */
function barDefiningTokens(all: Sheet[]): Set<string> {
  const out = new Set<string>();
  let base = 0;
  for (const sheet of all) {
    const rules = topLevelRules(sheet.css, base);
    base += rules.length + 1;
    for (const rule of rules) {
      const d = declarationsIn(rule.body);
      if (!d.height || !d["border-radius"]) continue;
      for (const sel of rule.prelude.split(",")) {
        const s = sel.trim();
        if (!s.startsWith(".") || /[\s>+~:[\]]/.test(s)) continue;
        for (const t of s.split(".").filter(Boolean)) out.add(t);
      }
    }
  }
  return out;
}

const paintsPrimary = (d: Record<string, string>) => /var\(--primary\)/.test(d.background ?? "");
/** A destructive control paints one of the two destructive reds: `--danger` as a fill, or `--danger-ink`
 *  as text. Both spellings count; neither counts is the trap. */
const DESTRUCTIVE_RED = /var\(--danger(-ink)?\)/;
const paintsDanger = (d: Record<string, string>) => DESTRUCTIVE_RED.test(d.background ?? "") || DESTRUCTIVE_RED.test(d.color ?? "");

/**
 * Every class set the renderer puts on a button that DRAWS A BAR, with the one token that draws it.
 *
 * Bug 30 scoped its duplicate-design check to the primary and destructive roles, because those were
 * the ones it was reporting. Bug 35 was the same defect one size family over and outside that scope:
 * `.stop-btn`, `.teach-btn` and `.teach-pill` were three names for one 28px/14px outlined pill, and
 * nothing failed. So the check below is not scoped by colour at all — it asks the whole button
 * vocabulary, and it needs no role table to do it.
 *
 * A set is skipped unless it carries EXACTLY ONE bar-defining token. Zero means the element borrows
 * a bar from a parent and has no design of its own here; two is `no button carries two bar-defining
 * classes at once`, which is a different failure and owns its own assertion.
 */
function barsDrawn(all: Sheet[], srcs: Source[]): { key: string; bar: string; files: string[]; design: Record<string, string> }[] {
  const bars = barDefiningTokens(all);
  const out: { key: string; bar: string; files: string[]; design: Record<string, string> }[] = [];
  for (const [key, files] of buttonClassUses(srcs)) {
    const tokens = key.split(".");
    const carried = tokens.filter((t) => bars.has(t));
    if (carried.length !== 1) continue;
    const design = resolveDesign(all, tokens);
    if (!design.height || !design["border-radius"]) continue;
    out.push({ key, bar: carried[0]!, files: [...files].sort(), design });
  }
  return out;
}

/** Which of the signature's fields two designs disagree on. */
function signatureDiff(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = SIGNATURE_KEYS.filter((k) => (a[k] ?? "-") !== (b[k] ?? "-"));
  if (borderLook(a) !== borderLook(b)) keys.push("border");
  return keys;
}

/** The class sets in `srcs` that are primary or destructive controls, with where they are used. */
function primaryAndDestructiveUses(all: Sheet[], srcs: Source[]): Map<string, { files: Set<string>; design: Record<string, string> }> {
  const out = new Map<string, { files: Set<string>; design: Record<string, string> }>();
  for (const [key, files] of buttonClassUses(srcs)) {
    const design = resolveDesign(all, key.split("."));
    if (paintsPrimary(design) || paintsDanger(design)) out.set(key, { files, design });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The vocabulary. `key` is the element's class tokens, sorted and dotted — the thing the renderer
// actually writes. One entry per role. See the header for why this is a specification and not an
// allowlist, and for what stops it turning into one.
// ---------------------------------------------------------------------------------------------
type Role = { key: string; surface: string; authority: string };

const ROLES: Role[] = [
  {
    key: "btn-primary",
    surface: "THE COMMIT, everywhere — the approval card and the computer take-over in the conversation, and Save / Connect / Add Rule / Set avatar in the app's own chrome. It absorbed `.btn-dark`, which was the second spelling of this same filled bar: once the geometry stopped varying by surface the two were one button under two names, which is the defect this file exists for.",
    authority: "the Apple pass (decisions.md, \"the Apple refinement\"): macOS draws ONE push button — a 28pt bar on a small corner — in Mail, Messages, Notes and System Settings, and varies the FILL, not the geometry, to say what a control is for. The boards' 32/16 and 30/8 were two mockups of two screens, not two designs.",
  },
  {
    key: "btn-danger",
    surface: "confirming a destruction in a settings pane — Reset the computer",
    authority: "the settings pane's own geometry: a destructive confirm is the same 30px bar at the control radius as its siblings, filled red — the panel bar, not a pill",
  },
  {
    key: "btn-outline.danger",
    surface: "a destructive item sitting in a row of ordinary outlined buttons — Delete skill, next to Edit",
    authority: "no board; deliberate — it is the outlined family's danger INK, so the row keeps one bar height and one outline, and the destruction is said by the word and the colour rather than by a red slab in the middle of a row",
  },
  {
    key: "danger-btn",
    surface: "a standalone quiet destructive at the foot of a panel or the end of a settings row — Delete routine, Remove server/marketplace",
    authority: "no board; deliberate — borderless, so it cannot be mistaken for the confirm button",
  },
  {
    key: "dark.round-btn",
    surface: "the voice call's mic button while muted — a circular icon button, not a labelled bar",
    authority: "the voice-call design: a white circle with a dark glyph (the call controls reuse the composer's round button)",
  },
  {
    key: "hang-up.round-btn",
    surface: "the voice call screen's hang-up — a larger red circle that ends the call",
    authority: "the voice-call design (the call screen: a mic button and a red hang-up button); larger than the 30px round buttons so it is never mistaken for the mute toggle",
  },
  {
    key: "listening.round-btn",
    surface: "the same composer button while dictation is recording",
    authority: "no board; the red is the recording state, not a destructive action",
  },
  {
    key: "danger.menu-item",
    surface: "a destructive row inside a popover menu",
    authority: "no board; a menu row, not a button bar",
  },
  {
    key: "on.switch",
    surface: "a switch track in its on state",
    authority: "the Settings mockup: the switch is filled at 20px with a 10px radius",
  },
  {
    key: "btn-compact",
    surface: "the bar-scale action — the computer view's 44px title bar (Teach a task), the teach recording / setup bar, the composer row's Stop",
    authority: "the Computer mockup draws Teach a task at `height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid #DADADA; background: #FFFFFF; font-size: 13px` — the only mockup instance of this design, and the one that settles it for all three surfaces (bug 35, where it was `.stop-btn` + `.teach-btn` + `.teach-pill`)",
  },
  {
    key: "btn-compact.btn-compact-primary",
    surface: "the commit on one of those bars — Stop and save, Start recording",
    authority: "no board draws the filled member; it is `.btn-compact`'s fill, exactly as `.btn-dark` is `.btn`'s on the 30px scale, and it is what keeps the pair on one bar height",
  },
];

describe("bug 30, the class — the renderer has one class per button role", () => {
  it("every primary/destructive control in the renderer is a declared role", () => {
    const declared = new Set(ROLES.map((r) => r.key));
    const found = primaryAndDestructiveUses(sheets(), sources());
    const undeclared = [...found]
      .filter(([key]) => !declared.has(key))
      .map(([key, v]) => `.${key}\n      design: ${signatureOf(v.design)}\n      used in: ${[...v.files].sort().join(", ")}`);
    expect(undeclared, `a primary/destructive button class that is not a declared role — this is how a fourth spelling gets in:\n\n   ${undeclared.join("\n   ")}\n`).toEqual([]);
  });

  it("no two roles are the same button", () => {
    const all = sheets();
    const bySignature = new Map<string, string[]>();
    for (const role of ROLES) {
      const sig = signatureOf(resolveDesign(all, role.key.split(".")));
      if (!bySignature.has(sig)) bySignature.set(sig, []);
      bySignature.get(sig)!.push("." + role.key);
    }
    const duplicates = [...bySignature].filter(([, names]) => names.length > 1).map(([sig, names]) => `${names.join("  ==  ")}\n      both render: ${sig}`);
    expect(duplicates, `one role spelled more than once — adding a name to ROLES cannot get past this:\n\n   ${duplicates.join("\n   ")}\n`).toEqual([]);
  });

  it("no role is dead — every one is used by the renderer", () => {
    // Measured against the WHOLE button census, not the primary/destructive slice: a role may now be
    // declared for an outlined bar too (bug 35's 28px family), and one of those parked here
    // speculatively would otherwise never be noticed.
    const used = buttonClassUses(sources());
    const unused = ROLES.filter((r) => !used.has(r.key)).map((r) => "." + r.key);
    expect(unused, `declared but unused, so ROLES cannot silently accumulate:\n   ${unused.join("\n   ")}`).toEqual([]);
  });

  it("every role names the surface it is for and the authority that settles it", () => {
    const thin = ROLES.filter((r) => r.surface.trim().length < 20 || r.authority.trim().length < 20).map((r) => "." + r.key);
    expect(thin, `a role added without saying what it is for:\n   ${thin.join("\n   ")}`).toEqual([]);
  });

  it("no button carries two bar-defining classes at once", () => {
    // Two classes that each set a height and a radius fight, one wins by cascade order, and the
    // result is whichever the stylesheet happened to declare last — a button nobody designed.
    const bars = barDefiningTokens(sheets());
    const offenders: string[] = [];
    for (const [key, files] of buttonClassUses(sources())) {
      const carried = key.split(".").filter((t) => bars.has(t));
      if (carried.length > 1) offenders.push(`.${key}  carries ${carried.map((c) => "." + c).join(" + ")}  (${[...files].sort().join(", ")})`);
    }
    expect(offenders, `two button bars on one element — one silently wins:\n   ${offenders.join("\n   ")}`).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Bug 35. The same defect as bug 30, one size family over and outside the colour scope bug 30
  // policed: `.stop-btn` (composer Stop), `.teach-btn` (teach banner) and `.teach-pill` (computer
  // title bar) each declared `height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid
  // var(--line-button); background: var(--bg)` — one design under three names, and no colour that
  // brought it inside the primary/destructive checks above. So this asks the whole vocabulary.
  // -------------------------------------------------------------------------------------------
  it("no two of the renderer's button bars render the same design", () => {
    const all = sheets();
    // Keyed by design, then by the bar that draws it. A design reached through more than one BAR is
    // one button under two names; the same design reached twice through one bar is that bar and a
    // variant of it — `.btn.file-btn` is still `.btn` — and must not be reported, or the only way
    // past this check would be an allowlist.
    //
    // The first draft kept one design per bar, whichever the source walk reached first. TeachBanner
    // writes `teach-btn teach-btn-primary` one line above the plain `teach-btn`, so the FILLED
    // variant became "the .teach-btn design" and the outlined one it shares with `.stop-btn` and
    // `.teach-pill` vanished: the guard reported two of the three names in bug 35 and hid the third.
    const bySignature = new Map<string, Map<string, string[]>>();
    for (const { key, bar, design, files } of barsDrawn(all, sources())) {
      const sig = signatureOf(design);
      if (!bySignature.has(sig)) bySignature.set(sig, new Map());
      const bars = bySignature.get(sig)!;
      if (!bars.has(bar)) bars.set(bar, []);
      bars.get(bar)!.push(`.${key} (${files.join(", ")})`);
    }
    const duplicates = [...bySignature]
      .filter(([, bars]) => bars.size > 1)
      .map(([sig, bars]) => `${[...bars.values()].map((k) => k.join(", ")).join("\n      ==  ")}\n      all render: ${sig}`);
    expect(duplicates, `one button design spelled under more than one class name — the surface a\n   button sits on cannot be what decides which name it gets:\n\n   ${duplicates.join("\n\n   ")}\n`).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Bug 34. `.btn-primary.small` was a modifier that did nothing: the only rule shrinking a bar was
  // `.btn-outline.small`, so New chat's "Create group" got the full 32px bar with 12px type —
  // measured in Chromium at 1440x900 — which is worse than either size on its own. A modifier that
  // moves a labelled bar's TYPE and not its BAR is a size that does not exist.
  // -------------------------------------------------------------------------------------------
  it("a size modifier on a labelled bar moves the bar, not only the type", () => {
    const all = sheets();
    const offenders: string[] = [];
    for (const { key, bar, design, files } of barsDrawn(all, sources())) {
      if (bar === key) continue;
      const plain = resolveDesign(all, [bar]);
      // Only labelled bars: an icon button sets no type of its own, so a font-size on it moves
      // nothing that is drawn and says nothing about a size family.
      if (!plain["font-size"]) continue;
      const diff = signatureDiff(design, plain);
      if (diff.length === 1 && diff[0] === "font-size") {
        offenders.push(`.${key}  is .${bar} with its type moved ${plain["font-size"]} -> ${design["font-size"]} and nothing else\n      .${bar}  ${signatureOf(plain)}\n      .${key}  ${signatureOf(design)}\n      used in: ${files.join(", ")}`);
      }
    }
    expect(offenders, `a bar modifier that only resizes the label — the control keeps the full bar and\n   wears small text on it, so it reads as neither size:\n\n   ${offenders.join("\n\n   ")}\n`).toEqual([]);
  });

  it("no dead danger spelling — a token spelled `danger` paints --danger", () => {
    const all = sheets();
    const dead: string[] = [];
    for (const [key, files] of buttonClassUses(sources())) {
      if (!key.split(".").some((t) => /danger/i.test(t))) continue;
      const design = resolveDesign(all, key.split("."));
      if (!paintsDanger(design)) dead.push(`.${key}  paints bg=${design.background ?? "-"} ink=${design.color ?? "-"}  (${[...files].sort().join(", ")})`);
    }
    expect(dead, `a class that says danger and renders as if it did not — the inverted-naming trap:\n   ${dead.join("\n   ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Self-tests. A guard nobody has watched fail is a guard nobody knows the shape of. These pin what
// it MUST reject and what it MUST NOT, against stylesheets and sources written here rather than read
// from disk, so they keep meaning whatever the app's own CSS does next.
// ---------------------------------------------------------------------------------------------
const FIXTURE_CSS = `
.btn-primary { height: 32px; padding: 0 14px; border-radius: 16px; border: none; background: var(--primary); color: var(--primary-ink); font-size: 13px; }
.btn { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line-button); background: var(--bg); color: var(--ink); font-size: 13px; }
.btn-dark { height: 30px; padding: 0 12px; border-radius: 8px; border: none; background: var(--primary); color: var(--primary-ink); font-size: 13px; }
.btn-primary:not(:disabled):hover { opacity: 0.9; }
.link-btn { border: none; background: transparent; color: var(--ink-muted); font-size: 12px; }
.danger-btn { border: none; background: transparent; color: var(--danger); font-size: 13px; }
`;
const fixture = (extraCss = "") => [{ name: "fixture.css", css: FIXTURE_CSS + extraCss }];
const tsx = (body: string) => [{ path: "Fixture.tsx", tsx: body }];

describe("bug 30, the guard itself — what it must reject", () => {
  it("catches a fourth spelling of an existing design (the `.btn.primary` shape of the bug)", () => {
    const all = fixture(`.btn.primary { background: var(--primary); color: var(--primary-ink); border-color: var(--primary); }`);
    const mine = resolveDesign(all, ["btn", "primary"]);
    const theirs = resolveDesign(all, ["btn-dark"]);
    expect(paintsPrimary(mine), "`.btn.primary` must be seen as a primary control").toBe(true);
    // Same bar, same radius, same fill: one role, two names. Measured in Chromium at 1440x900, both
    // rendered 30px tall with an 8px radius and a --primary fill. This is the comparison the real
    // `no two roles are the same button` assertion makes over ROLES, and it is why adding a fourth
    // spelling to ROLES cannot silence the guard.
    expect(signatureOf(mine), "the duplicate must be detectable by design alone").toBe(signatureOf(theirs));
  });

  it("sees through a border recoloured to match its own fill", () => {
    // The trick that would otherwise hide a duplicate: `.btn` draws a 1px --line-button border and
    // `.btn.primary` repaints it --primary over a --primary fill, so the text differs and the pixels
    // do not.
    const all = fixture(`.btn.primary { background: var(--primary); color: var(--primary-ink); border-color: var(--primary); }`);
    expect(borderLook(resolveDesign(all, ["btn", "primary"])), "invisible border").toBe("none");
    expect(borderLook(resolveDesign(all, ["btn"])), "a real outline stays visible").toBe("var(--line-button)");
  });

  it("catches a primary class that never reaches the role table", () => {
    const all = fixture(`.btn-brandnew { height: 44px; border-radius: 4px; background: var(--primary); color: var(--primary-ink); }`);
    const found = primaryAndDestructiveUses(all, tsx(`<button className="btn-brandnew">Go</button>`));
    expect([...found.keys()], "an unknown primary spelling must surface").toEqual(["btn-brandnew"]);
  });

  it("catches a `danger` token that paints nothing — the inverted-naming trap", () => {
    const all = fixture();
    const design = resolveDesign(all, ["danger", "link-btn"]);
    expect(paintsDanger(design), "`.link-btn.danger` renders with no danger colour at all").toBe(false);
    expect(design.color, "it silently keeps the muted link ink").toBe("var(--ink-muted)");
  });

  it("counts BOTH destructive reds, and nothing else — the bug 41 widening, pinned", () => {
    // `--danger` is the fill and `--danger-ink` is the text, so a destructive control may legitimately
    // paint either. Pinned here so a future narrowing of `paintsDanger` back to one spelling fails
    // loudly instead of quietly declaring every red-text button dead, and so a future widening to
    // "anything reddish" cannot slip past the `.link-btn.danger` case above.
    expect(paintsDanger({ background: "var(--danger)" }), "the destructive fill").toBe(true);
    expect(paintsDanger({ color: "var(--danger-ink)" }), "the destructive ink").toBe(true);
    expect(paintsDanger({ color: "var(--warn-ink)" }), "a warning is not a destructive control").toBe(false);
    expect(paintsDanger({ color: "var(--ink)" }), "ordinary ink is not a destructive control").toBe(false);
  });

  it("catches one bar design spelled under three names (the bug 35 shape)", () => {
    const all = fixture(`
      .stop-btn  { height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--line-button); background: var(--bg); color: var(--ink); font-size: 13px; }
      .teach-btn { height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--line-button); background: var(--bg); color: var(--ink); font-size: 13px; }
      .teach-pill{ height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--line-button); background: var(--bg); color: var(--ink); font-size: 13px; display: flex; gap: 6px; }
    `);
    const drawn = barsDrawn(all, tsx(`
      <button className="stop-btn">Stop</button>
      <button className="teach-btn">Discard</button>
      <button className="teach-pill">Teach a task</button>`));
    const sigs = new Set(drawn.map((d) => signatureOf(d.design)));
    expect(drawn.map((d) => d.bar).sort(), "all three must be seen as bars").toEqual(["stop-btn", "teach-btn", "teach-pill"]);
    expect(sigs.size, "three names, one design — `display` and `gap` are how the label is laid out inside the bar, not what the bar looks like").toBe(1);
  });

  it("catches a `.small` that moves the type and leaves the bar (the bug 34 shape)", () => {
    // `.small` AFTER the bars it modifies, as app.css has it: both are one class deep, so the later
    // rule takes the type. The first draft of this fixture put `.small` first, the bar's own 13px
    // then won on order, and the "a real size" half of the test failed for a reason that exists
    // nowhere in the app.
    const all = fixture(`.btn-outline { height: 32px; padding: 0 14px; border-radius: 16px; border: 1px solid var(--line-button); background: var(--bg); color: var(--ink); font-size: 13px; } .btn-outline.small { height: 26px; padding: 0 10px; } .small { font-size: 12px; }`);
    const dead = resolveDesign(all, ["btn-primary", "small"]);
    const bar = resolveDesign(all, ["btn-primary"]);
    expect(signatureDiff(dead, bar), "the only thing `.small` reaches on a primary is the type").toEqual(["font-size"]);
    // …while the same token on the bar that DOES define a small variant moves the bar with it.
    const real = resolveDesign(all, ["btn-outline", "small"]);
    expect(signatureDiff(real, resolveDesign(all, ["btn-outline"])).sort(), "a real size").toEqual(["font-size", "height", "padding"]);
  });

  it("catches two button bars on one element", () => {
    const bars = barDefiningTokens(fixture());
    const key = [...buttonClassUses(tsx(`<button className="btn-primary btn-dark">Go</button>`)).keys()][0]!;
    expect(key.split(".").filter((t) => bars.has(t)), "both bars must be seen").toEqual(["btn-dark", "btn-primary"]);
    // …while a recolouring modifier stacked on one bar is the normal, correct way to write a variant.
    const ok = [...buttonClassUses(tsx(`<button className="btn danger">Delete</button>`)).keys()][0]!;
    expect(ok.split(".").filter((t) => bars.has(t)), "`.danger` draws no bar of its own").toEqual(["btn"]);
  });
});

describe("bug 30, the guard itself — what it must NOT reject", () => {
  it("lets the two board-verbatim primary roles coexist, because they are different buttons", () => {
    const all = fixture();
    const pill = resolveDesign(all, ["btn-primary"]);
    const panel = resolveDesign(all, ["btn-dark"]);
    expect(paintsPrimary(pill) && paintsPrimary(panel), "both are primary controls").toBe(true);
    expect(signatureOf(pill), "32px/16px and 30px/8px are two designs, not one spelled twice").not.toBe(signatureOf(panel));
  });

  it("does not treat a :hover or :disabled rule as part of the design", () => {
    const all = fixture(`.btn-primary:disabled { opacity: 0.5; } .btn-primary:not(:disabled):active { transform: scale(0.96); }`);
    const design = resolveDesign(all, ["btn-primary"]);
    expect(design.opacity, "a state rule must not merge into the base design").toBeUndefined();
    expect(design.transform, "nor must a press rule").toBeUndefined();
  });

  it("does not treat a descendant override as part of the design", () => {
    const all = fixture(`.onb .btn-dark { flex-grow: 0; }`);
    expect(resolveDesign(all, ["btn-dark"])["flex-grow"], "a scoped override belongs to the container, not the class").toBeUndefined();
  });

  it("ignores buttons that are neither primary nor destructive", () => {
    const found = primaryAndDestructiveUses(fixture(), tsx(`<button className="btn">Cancel</button>`));
    expect([...found.keys()], "an outlined secondary is not this guard's business").toEqual([]);
  });

  it("reads each branch of a conditional className as its own class set", () => {
    const uses = buttonClassUses(tsx("<button className={on ? \"switch on\" : \"switch\"} />"));
    expect([...uses.keys()].sort(), "both branches must be policed").toEqual(["on.switch", "switch"]);
  });

  it("does not call a variant of one bar a second spelling of it", () => {
    // `.btn.file-btn` resolves to exactly `.btn`'s design — `.file-btn` changes how a <label> behaves,
    // not what it looks like. That is one class with a tweak, and the duplicate check must see it as
    // one bar, or the only way past it would be an allowlist.
    const all = fixture(`.file-btn { cursor: pointer; }`);
    const drawn = barsDrawn(all, tsx(`<label className="btn file-btn">Browse</label><button className="btn">Cancel</button>`));
    expect(drawn.map((d) => d.bar).sort(), "both are the .btn bar").toEqual(["btn", "btn"]);
    expect(new Set(drawn.map((d) => signatureOf(d.design))).size, "and they do render the same thing, legitimately").toBe(1);
  });

  it("lets two genuinely different bars keep their own names", () => {
    const all = fixture(`
      .btn-compact { height: 28px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--line-button); background: var(--bg); color: var(--ink); font-size: 13px; }
      .small { font-size: 12px; }
      .btn-outline { height: 32px; padding: 0 14px; border-radius: 16px; border: 1px solid var(--line-button); background: var(--bg); color: var(--ink); font-size: 13px; }
      .btn-outline.small { height: 26px; padding: 0 10px; }
    `);
    const compact = resolveDesign(all, ["btn-compact"]);
    const small = resolveDesign(all, ["btn-outline", "small"]);
    expect(signatureOf(compact), "28px/14px and 26px/16px are two bars, not one spelled twice").not.toBe(signatureOf(small));
  });

  it("does not accuse an icon bar of a type-only modifier", () => {
    // `.icon-btn` sets no font-size, so `.small` on it moves nothing that is drawn. Firing there
    // would earn this check an allowlist, and an allowlisted check guards nothing.
    const all = fixture(`.icon-btn { width: 28px; height: 28px; border-radius: 7px; border: none; background: transparent; } .small { font-size: 12px; }`);
    expect(resolveDesign(all, ["icon-btn"])["font-size"], "no type of its own").toBeUndefined();
  });

  it("never unions two branches into a class set that cannot render", () => {
    const uses = buttonClassUses(tsx("<button className={busy ? \"btn-primary\" : \"btn-dark\"} />"));
    expect([...uses.keys()].sort(), "an element is one branch or the other, never both").toEqual(["btn-dark", "btn-primary"]);
  });
});
