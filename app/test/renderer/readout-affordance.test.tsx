// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5, type ApprovalCardView, type ConnectCardView } from "@synapse/shared";
import { ApprovalCard } from "../../src/renderer/components/ApprovalCard";
import { ConnectCard } from "../../src/renderer/components/cards/ConnectCard";
import { ComputerSection } from "../../src/renderer/components/settings/ComputerSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Bug 23, THE CLASS — a readout must never present the affordances of a control.
//
// status-chip.test.tsx pins the three instances the audit photographed: the settled approval card's
// outcome, Settings -> Computer's network state and ConnectCard's "Connected" are `.status-chip`
// rather than `.pill`, and `.status-chip` has no box, no hover, no press and no transition. Those
// are assertions about three class NAMES, and the defect was never really about a name — it was
// that nothing in the build could tell the difference between a thing you can press and a thing
// that only reports. A `role="status"` element carrying a class that lights up under the cursor is
// the machine-checkable form of that difference, and it is what this file checks, for every
// `role="status"` in the renderer rather than for three of them.
//
// Two passes, because each misses what the other catches:
//   - RENDERED: the three surfaces are rendered, and every `role="status"` / `.status-chip` element
//     in them is put to the stylesheet via `Element.matches` — no interactive rule may reach it.
//     This is what catches a readout that picks up a hover through a class it merely happens to
//     share, which is exactly how `.pill` reached all three.
//   - STATIC: every `role="status"` with a literal className anywhere under src/renderer, checked
//     against the same interactive-rule set. jsdom cannot render thirteen surfaces; it does not
//     have to, to read thirteen class attributes.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
// Concatenated on purpose: Vite rewrites `new URL("<literal>", import.meta.url)` into an asset URL,
// which under jsdom resolves against the document and is not a file: URL.
const rendererDir = () => fileURLToPath(new URL("../../src/" + "renderer", import.meta.url));
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

const STYLESHEETS = ["app.css", "bot-admin.css", "files.css", "google.css", "message-actions.css", "palette.css", "skill-picker.css", "skills.css", "widgets.css"];

/** (file, selector, body) for every top-level rule in every stylesheet the renderer loads. */
function allRules(): { file: string; sel: string; body: string }[] {
  const out: { file: string; sel: string; body: string }[] = [];
  for (const file of STYLESHEETS) {
    const clean = stripComments(readFileSync(stylePath(file), "utf8"))
      .replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) for (const sel of m[1]!.split(",")) out.push({ file, sel: sel.trim(), body: m[2]! });
  }
  return out;
}

/**
 * The rules that give an element a control's affordances: the cursor-driven states, and the
 * transition that exists only to animate between them. Pointer states are stripped from the
 * selector before matching, so `.pill:not(:disabled):hover` is tested as `.pill:not(:disabled)` —
 * i.e. "would this element light up if a cursor were over it", which jsdom cannot ask directly.
 */
const POINTER = /:hover|:active|:focus-visible|:focus-within|:focus/g;
function interactiveRulesFor(matches: (sel: string) => boolean): string[] {
  const hits: string[] = [];
  for (const { file, sel, body } of allRules()) {
    const isState = POINTER.test(sel);
    POINTER.lastIndex = 0;
    const animates = /(?:^|;)\s*transition\s*:/.test(body);
    if (!isState && !animates) continue;
    const resting = sel.replace(POINTER, "").trim();
    if (!resting || resting.endsWith(">") || resting.endsWith("+") || resting.endsWith("~")) continue;
    if (matches(resting)) hits.push(`${file}  ${sel}`);
  }
  return hits;
}

const approval = (): ApprovalCardView => ({
  approvalId: "ap1", requestId: "req_1", surface: "mcp", title: "Your Bot would like to use a connected service",
  reason: "Delete 3 events.", summary: "delete_events", locationLine: null, details: null, command: null,
  items: [], hasProposedRule: true, status: "approved", cause: null, ruleAddedText: null, createdAt: 1, settledAt: 2,
  verdict: { reason: "x", tier: 3, matchedRuleIds: [], floorCategory: "F4", stage: "model" },
});
const connectCard = (over: Partial<ConnectCardView> = {}) => ({
  kind: "connect", name: "Linear", logo: null, catalogId: "linear", serverId: "linear", toolCount: 12,
  state: "not-installed", ...over,
}) as ConnectCardView;

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string) => ({ ok: true, result:
      cmd === "getLocalComputer" ? { computer: { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/x", autoRunRoots: [], home: "/x" } }
      : cmd === "getNetworkStats" ? { routedThisSession: 3 } : {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
  };
  useUi.setState({ ...initialState() });
});
afterEach(cleanup);

/** Every readout in a rendered tree: anything that reports rather than acts. */
function readouts(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[role="status"], .status-chip')];
}

function assertInert(el: Element, where: string) {
  expect(["SPAN", "DIV", "P", "OUTPUT"], `${where}: a readout rendered as <${el.tagName.toLowerCase()}> is focusable`).toContain(el.tagName);
  const hits = interactiveRulesFor((sel) => {
    try { return el.matches(sel); } catch { return false; }
  });
  expect(hits, `${where}: a readout does nothing, so it may not light up:\n${hits.join("\n")}`).toEqual([]);
}

describe("bug 23, the class — a rendered readout has none of a control's affordances", () => {
  it("the settled approval card's outcome reports and does not react", () => {
    const { container } = render(<ApprovalCard botId="b" approval={approval()} />);
    const found = readouts(container);
    expect(found.length, "no readout in the settled approval card").toBeGreaterThan(0);
    for (const el of found) assertInert(el, `ApprovalCard .${el.className}`);
  });

  it("Settings → Computer's network state reports and does not react", async () => {
    const { container } = render(<ComputerSection />);
    await screen.findByText(STR5.routeTraffic);
    const found = readouts(container);
    expect(found.length, "no readout on the network row").toBeGreaterThan(0);
    for (const el of found) assertInert(el, `ComputerSection .${el.className}`);
  });

  it("the connect card's Connected state reports and does not react", () => {
    const { container } = render(<ConnectCard botId="b" entryId="e1" card={connectCard({ state: "connected" }) as never} />);
    const found = readouts(container);
    expect(found.length, "no readout on the connected card").toBeGreaterThan(0);
    for (const el of found) assertInert(el, `ConnectCard .${el.className}`);
    // The control beside it is unchanged: this is a separation, not a stripping of states.
    const add = render(<ConnectCard botId="b" entryId="e2" card={connectCard() as never} />).container.querySelector(".pill")!;
    expect(interactiveRulesFor((sel) => { try { return add.matches(sel); } catch { return false; } }).length,
      "the Add button must still hover and press").toBeGreaterThan(0);
  });
});

describe("bug 23, the class — no `role=\"status\"` anywhere in the renderer wears an interactive class", () => {
  /** Every .tsx under src/renderer. */
  function sources(dir = rendererDir()): string[] {
    return readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? sources(p) : p.endsWith(".tsx") ? [p] : [];
    });
  }

  /** `role="status"` elements whose className is a literal, as (file, classes). */
  function declaredStatusClasses(): { file: string; classes: string[] }[] {
    const out: { file: string; classes: string[] }[] = [];
    for (const file of sources()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<[A-Za-z][^>]*\brole="status"[^>]*>/g)) {
        const cls = m[0].match(/className="([^"{}]+)"/)?.[1];
        if (cls) out.push({ file: file.slice(file.indexOf("src/renderer")), classes: cls.split(/\s+/).filter(Boolean) });
      }
    }
    return out;
  }

  it("finds the `role=\"status\"` readouts to check", () => {
    // If this ever collapses to nothing the two tests below would pass vacuously.
    expect(declaredStatusClasses().length, "no role=status readouts found — the scan is broken").toBeGreaterThanOrEqual(8);
  });

  it("none of them is reached by a hover, press, focus or transition rule", () => {
    const offenders: string[] = [];
    for (const { file, classes } of declaredStatusClasses()) {
      // An element with classes a b matches any selector built only from those classes.
      const hits = interactiveRulesFor((sel) => {
        const parts = sel.match(/\.[-\w]+/g);
        return parts !== null && !/[\s>+~[:]/.test(sel.replace(/:not\([^)]*\)/g, "")) && parts.every((p) => classes.includes(p.slice(1)));
      });
      for (const h of hits) offenders.push(`${file}  role="status" class="${classes.join(" ")}"  <-  ${h}`);
    }
    expect(offenders, `a readout that lights up under the cursor:\n${offenders.join("\n")}`).toEqual([]);
  });
});
