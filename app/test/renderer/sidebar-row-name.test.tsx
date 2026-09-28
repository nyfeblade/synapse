// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, SidebarMarker } from "@synapse/shared";
import { MARKER_LABEL, Sidebar } from "../../src/renderer/components/Sidebar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

/**
 * Bug 43 — a sidebar row announced its badge before its name.
 *
 * `Sidebar.tsx` drew the presence/unread/blocked marker inside `.avatar-wrap`, which precedes
 * `.row-text`, so the row's accessible name was composed from the DOM in that order:
 * "Needs attention Scout Action needed". The dot is the right VISUAL (commit 0bcbb93, a corner dot
 * with a `--marker-ring`); the name ordering was an unchosen side effect of the DOM order that
 * achieved it.
 *
 * WHY THIS IS NOT COSMETIC: a row's accessible NAME changed with its STATE. Every anchored locator
 * on a Bot's name stopped resolving at exactly the moment the journey provoked the state it was
 * about (Phase 3's computer journey: `{ name: /^Scout/ }` worked until Scout's box-help card went
 * pending, then timed out at 30 s), and an assistive-technology user heard the same three words at
 * the head of every row in a busy sidebar instead of hearing whose row it is.
 *
 * THE CLAIM, driven across every marker state there is: a row's name BEGINS with the Bot's name,
 * and the states differ from the plain row only by what is appended. The states are read from
 * `MARKER_LABEL` rather than listed here, so a fourth marker added tomorrow is driven without this
 * file being touched.
 */

const bot = (id: string, name: string, over: Partial<BotSummary> = {}): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name, title: "", description: "", avatarShape: "gem", avatarColor: "#49a393", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

/** The accessible names of every link in the rendered sidebar, as an assistive technology composes them. */
function linkNames(): string[] {
  const seen: string[] = [];
  screen.queryAllByRole("link", { name: (n: string) => { seen.push(n); return false; } });
  return seen;
}

const MARKERS: SidebarMarker[] = [null, ...(Object.keys(MARKER_LABEL) as (keyof typeof MARKER_LABEL)[])];

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "alex" }),
  };
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, userName: "alex" });
});
afterEach(cleanup);

describe("bug 43: a sidebar row is named after its Bot, whatever state it is in", () => {
  for (const marker of MARKERS) {
    const label = marker ? MARKER_LABEL[marker] : "(no marker)";

    it(`a ROW with marker ${marker ?? "null"} (${label}) is still named "Scout …"`, () => {
      useUi.setState({ bots: { b: bot("b", "Scout", { marker, statusLine: "Action needed" }) }, pinned: [] });
      render(<Sidebar />);
      const names = linkNames();
      expect(names).toHaveLength(1);
      // startsWith, not a \b anchor: jsdom's accessible-name builder concatenates sibling nodes with
      // no separator ("ScoutAction needed") where Chromium inserts a space, and the claim here is about
      // what comes FIRST, not about the whitespace between the parts.
      expect(names[0]!.startsWith("Scout"), `a row with marker ${marker} must be named after its Bot, got "${names[0]}"`).toBe(true);
      // The state is still announced — it moved, it did not vanish.
      if (marker) expect(screen.getByLabelText(label)).toBeTruthy();
    });

    it(`a pinned TILE with marker ${marker ?? "null"} (${label}) is still named "Scout …"`, () => {
      useUi.setState({ bots: { b: bot("b", "Scout", { marker }) }, pinned: ["b"] });
      render(<Sidebar />);
      const names = linkNames();
      expect(names).toHaveLength(1);
      expect(names[0]!.startsWith("Scout"), `a tile with marker ${marker} must be named after its Bot, got "${names[0]}"`).toBe(true);
      if (marker) expect(screen.getByLabelText(label)).toBeTruthy();
    });
  }

  it("the marker only ever APPENDS to the plain row's name — the head of the name never moves", () => {
    const nameFor = (marker: SidebarMarker) => {
      useUi.setState({ bots: { b: bot("b", "Scout", { marker, statusLine: "Action needed" }) }, pinned: [] });
      render(<Sidebar />);
      const n = linkNames()[0]!;
      cleanup();
      return n;
    };
    const plain = nameFor(null);
    expect(plain.startsWith("Scout")).toBe(true);
    expect(plain).toContain("Action needed");
    for (const marker of MARKERS.filter((m): m is Exclude<SidebarMarker, null> => m !== null)) {
      const withMarker = nameFor(marker);
      expect(withMarker.startsWith(plain), `"${withMarker}" must begin with "${plain}"`).toBe(true);
      expect(withMarker.slice(plain.length).trim()).toBe(MARKER_LABEL[marker]);
    }
  });

  it("an anchored locator on the Bot's name survives every state — the regression that broke Phase 3", () => {
    // The group row's status line can itself contain "Planner:", so `^` is the only thing separating
    // the two; that is exactly what a state-dependent name destroyed.
    for (const marker of MARKERS) {
      useUi.setState({
        bots: {
          g: bot("g", "Planner, Scout & Ledger", { updatedAt: 9, statusLine: "Planner: Here's a first take" }),
          p: bot("p", "Planner", { marker, statusLine: "Action needed" }),
        },
        pinned: [],
      });
      render(<Sidebar />);
      const anchored = screen.getAllByRole("link", { name: /^Planner(?!,)/ });
      expect(anchored, `marker ${marker} must not hide the Planner row from an anchored locator`).toHaveLength(1);
      cleanup();
    }
  });
});

describe("bug 43, the class: a state badge may not lead the name of the thing it is about", () => {
  it("every labelled state node in a sidebar row/tile comes AFTER the Bot's name in DOM order", () => {
    useUi.setState({
      bots: { a: bot("a", "Planner", { marker: "blocked", statusLine: "Action needed" }), b: bot("b", "Scout", { marker: "unread" }) },
      pinned: ["b"],
    });
    const { container } = render(<Sidebar />);
    const holders = [...container.querySelectorAll<HTMLElement>(".row, .tile")].filter((el) => el.querySelector("[aria-label]"));
    expect(holders.length, "this guard needs at least one row and one tile carrying a marker").toBeGreaterThanOrEqual(2);
    for (const holder of holders) {
      // Every node that contributes a LABEL (rather than text) to the name must sort after the first
      // node that contributes the Bot's own NAME. Measured from the DOM, not from a list of classes.
      const labelled = [...holder.querySelectorAll<HTMLElement>("[aria-label]")];
      const nameNode = [...holder.querySelectorAll<HTMLElement>("*")].find((el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0);
      expect(nameNode, "a row must render its Bot's name as text").toBeTruthy();
      for (const l of labelled) {
        const order = nameNode!.compareDocumentPosition(l);
        expect(order & Node.DOCUMENT_POSITION_FOLLOWING, `"${l.getAttribute("aria-label")}" must follow the Bot's name in DOM order`).toBeTruthy();
      }
    }
  });
});
