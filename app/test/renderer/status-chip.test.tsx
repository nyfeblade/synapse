// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5, type ApprovalCardView, type ConnectCardView } from "@synapse/shared";
import { ApprovalCard } from "../../src/renderer/components/ApprovalCard";
import { AvatarEditor } from "../../src/renderer/components/AvatarEditor";
import { ConnectCard } from "../../src/renderer/components/cards/ConnectCard";
import { ComputerSection } from "../../src/renderer/components/settings/ComputerSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// "Looks interactive and is not", plus the two-designs-at-once tab bar behind it.
//
// After a duplicate-selector merge, three readouts were rendering as `.pill` — the exact 26px
// bordered shape of the action buttons beside them — and they lit up on hover and press:
// #FFFFFF -> #EFEFEF with the border darkening -> #E2E2E2. They do nothing. `.pill` is also a REAL
// button (the Marketplace Add / Connect / Authorize pills), so the fix is to separate the two uses,
// not to strip the states: a readout is a `.status-chip`, which has no border, no hover, no press
// and no transition, and a `.pill` stays exactly what it was.
//
// Related, same merge: the avatar editor's selected tab wore TWO designs at once — `.tab.active`'s
// --fill-search pill AND `.tabs [aria-selected="true"]`'s inset underline — while
// `.tabs [role="tab"]`'s `padding: 8px 0` beat `.tab`'s `padding: 0 10px`, so the pill had zero
// horizontal padding and shrink-wrapped the glyphs. Manage plugins used the underline only. The
// underline is the one that is kept, because `.tabs` already draws the rule the underline sits on;
// a pill inside a ruled tab bar is two selection languages at once.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
function preludes(src: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(src)))) out.push(m[1]!.trim());
  return out;
}
const escapeSel = (sel: string) => sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function ruleBody(src: string, sel: string): string | null {
  return stripComments(src).match(new RegExp("(?:^|\\n)\\s*" + escapeSel(sel) + "\\s*\\{([^{}]*)\\}"))?.[1] ?? null;
}

const approval = (over: Partial<ApprovalCardView> = {}): ApprovalCardView => ({
  approvalId: "ap1", requestId: "req_1", surface: "mcp", title: "Your Bot would like to use a connected service",
  reason: "Delete 3 events.", summary: "delete_events", locationLine: null, details: null, command: null,
  items: [], hasProposedRule: true, status: "approved", cause: null, ruleAddedText: null, createdAt: 1, settledAt: 2,
  verdict: { reason: "x", tier: 3, matchedRuleIds: [], floorCategory: "F4", stage: "model" }, ...over,
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

describe("a status readout is not shaped like a button", () => {
  it("the settled approval card's outcome is a .status-chip, not a .pill", () => {
    const { container } = render(<ApprovalCard botId="b" approval={approval()} />);
    const chip = container.querySelector(".status-chip");
    expect(chip, "no .status-chip in the settled approval card").not.toBeNull();
    expect(chip!.tagName).toBe("SPAN");
    expect(container.querySelector(".pill"), "the readout must not also be a .pill").toBeNull();
  });

  it("Settings → Computer's network readout is a .status-chip, not a .pill", async () => {
    const { container } = render(<ComputerSection />);
    await screen.findByText(STR5.routeTraffic);
    const chip = container.querySelector(".status-chip");
    expect(chip, "no .status-chip on the network row").not.toBeNull();
    expect(chip!.getAttribute("role")).toBe("status");
    expect(container.querySelector(".pill")).toBeNull();
  });

  it("the connect card's Connected readout is a .status-chip while Add stays a .pill button", () => {
    const connected = render(<ConnectCard botId="b" entryId="e1" card={connectCard({ state: "connected" }) as never} />);
    expect(connected.container.querySelector(".status-chip")).not.toBeNull();
    expect(connected.container.querySelector(".pill")).toBeNull();
    cleanup();
    const offered = render(<ConnectCard botId="b" entryId="e2" card={connectCard() as never} />);
    const add = offered.container.querySelector(".pill");
    expect(add, "the Add action must stay a .pill").not.toBeNull();
    expect(add!.tagName).toBe("BUTTON");
  });
});

describe("the status chip and the action pill are separate designs", () => {
  it("app.css gives .status-chip no box at all — no border, no fill, no bar height", () => {
    // Deliberate, and stricter than "not a pill": a readout appears on `.card.settled`'s
    // --bubble-bot, on --fill-inset and on --bg, in both themes, and no single fill token reads on
    // all six. "No box" reads on all six and cannot be mistaken for a button on any of them.
    const body = ruleBody(read("app.css"), ".status-chip");
    expect(body, "no .status-chip rule in app.css").not.toBeNull();
    expect(body!, "a border is the action pill's shape, not the readout's").toMatch(/border:\s*none/);
    expect(body!, "a fill would have to work on six different grounds").toMatch(/background:\s*none/);
    expect(body!, "a bar height is what makes a pill a pill").not.toMatch(/(^|;)\s*height\s*:/);
    expect(body!).toMatch(/color:\s*var\(--ink-muted\)/);
  });

  it("app.css gives .status-chip no hover, no press and no transition", () => {
    const hits = preludes(read("app.css")).filter((p) => /\.status-chip/.test(p) && /:hover|:active|:focus/.test(p));
    expect(hits, "a readout that lights up is the defect this fixes").toEqual([]);
    const transitions = preludes(read("app.css")).filter((p) => /\.status-chip\b/.test(p));
    for (const p of transitions) {
      const body = stripComments(read("app.css")).split(p + " {")[1]?.split("}")[0] ?? "";
      expect(body).not.toMatch(/transition/);
    }
  });

  it("app.css keeps .pill's hover and press — it is still a real button elsewhere", () => {
    const p = preludes(read("app.css"));
    expect(p.some((x) => /\.pill:not\(:disabled\):hover/.test(x))).toBe(true);
    expect(p.some((x) => /\.pill:not\(:disabled\):active/.test(x))).toBe(true);
  });

  it("the action pill keeps the bar height and the border that make it look pressable", () => {
    const pill = ruleBody(read("app.css"), ".pill")!;
    // 26 -> 24: the Apple pass has two control sizes, the 28px standard bar and the 24px small one,
    // and `.pill` is a small inline control. What this asserts is unchanged — the pill keeps a
    // definite bar height and a hairline, which is what makes it read as pressable next to a chip
    // that is not — and 24 is now the app's one small bar rather than a third height of its own.
    expect(pill).toMatch(/height:\s*24px/);
    expect(pill).toMatch(/border:\s*(?:1px|var\(--hairline\)) solid var\(--line-button\)/);
  });
});

describe("one tab design in the tab family", () => {
  it(".tab.active no longer paints a pill behind the selected tab", () => {
    const body = ruleBody(read("app.css"), ".tab.active");
    expect(body, "no .tab.active rule").not.toBeNull();
    expect(body!, "the pill and the underline were both being drawn").not.toMatch(/background(-color)?:\s*var\(--fill-search\)/);
  });

  it("the selected tab is the underline, in both of the selectors that can express it", () => {
    const underline = /box-shadow:\s*inset 0 -2px 0 var\(--ink\)/;
    expect(ruleBody(read("app.css"), '.tabs [aria-selected="true"]')!).toMatch(underline);
    expect(ruleBody(read("app.css"), ".tab.active")!).toMatch(underline);
  });

  it("the Marketplace tab bar does not paint a second selected design under the same underline", () => {
    const body = ruleBody(read("skills.css"), ".modal.market .tab.selected");
    expect(body, "no .modal.market .tab.selected rule").not.toBeNull();
    expect(body!).not.toMatch(/background(-color)?:/);
  });

  // CAUGHT BY RE-CAPTURING: `box-shadow: inset 0 -2px 0` follows the border-radius, so on the
  // marketplace tab's 15px pill radius the new underline painted as a curved arc under the label —
  // a smile, not a rule. Every tab that can be selected must leave its BOTTOM corners square.
  it("no tab rounds the bottom edge the underline has to run along", () => {
    for (const [file, sel] of [["app.css", ".tab"], ["app.css", '.tabs [role="tab"]'], ["skills.css", ".modal.market .tab"]] as const) {
      const radius = ruleBody(read(file), sel)?.match(/border-radius:\s*([^;]+)/)?.[1]?.trim();
      if (!radius) continue;
      expect(radius, `${file} \`${sel}\` curves the underline into an arc`).toMatch(/\b0(px)?\s+0(px)?$/);
    }
  });

  it("a tab inside .tabs keeps horizontal padding, so the selected tab cannot shrink-wrap its glyphs", () => {
    const body = ruleBody(read("app.css"), '.tabs [role="tab"]')!;
    const padding = body.match(/padding:\s*([^;]+)/)?.[1]?.trim();
    expect(padding, "`padding: 8px 0` beat `.tab`'s `padding: 0 10px` and left the tab with none").toBeTruthy();
    expect(padding!, "the second value is the horizontal one").not.toMatch(/\b0(px)?$/);
  });

  it("pressing the SELECTED tab does not make it look deselected", () => {
    const press = preludes(read("app.css")).filter((p) => /\.tabs \[role="tab"\][^,]*:active/.test(p));
    expect(press.length, "no press rule for a tab").toBeGreaterThan(0);
    for (const p of press) {
      expect(p, "the press rule must exclude the selected tab, whose ink is --ink").toMatch(/:not\(\[aria-selected="true"\]\)/);
    }
  });

  it("the avatar editor's selected tab renders exactly one selected marker", async () => {
    const { container } = render(
      <AvatarEditor botId="b" shape="pebble" color="#f19d38" hasImage={false} onSave={() => {}} onImageSaved={() => {}} onCancel={() => {}} />,
    );
    const selected = container.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(selected).not.toBeNull();
    // Both selectors reach it, so they must agree on one design; `.tab.active` keeping a fill is
    // exactly the "two designs at once" the audit photographed.
    expect(selected.className).toContain("tab");
    expect(ruleBody(read("app.css"), ".tab.active")!).not.toMatch(/background/);
  });
});
