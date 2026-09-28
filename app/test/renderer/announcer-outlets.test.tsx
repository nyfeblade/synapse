// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { useComputer } from "../../src/renderer/computer-state";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { useOverlays } from "../../src/renderer/overlays";
import { resetOverlayStack, topOverlayPanel } from "../../src/renderer/overlay-stack";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";
import { readSrc } from "./read-src";

/**
 * Bug 46 — the app's error channel was invisible exactly when errors happen.
 *
 * `actionError` is the renderer's catch-all failure route: ten writers plus the global sink in
 * `bridge.ts`, where `call()` reports every rejection by default. It had ONE reader — a
 * `role="alert"` inside `<nav class="sidebar">`, and `.sidebar` carries no `z-index` at all. The
 * computer view is `position: fixed; inset: 0; z-index: 40` over an opaque `var(--bg)` and the
 * modal scrim is `z-index: 50`, so every failed action announced itself underneath whatever was
 * covering the screen — and a cover being up is CORRELATED with something failing, not independent
 * of it: three of the writers (`GoogleToggle`, `AdvancedSettingsCard`, `theme.ts`) are controls that
 * live inside Settings.
 *
 * WHY THESE ASSERT CONTAINMENT RATHER THAN CSS VISIBILITY: the same reason as
 * teach-reachable.test.tsx. jsdom has no layout and no stacking, so "the alert is in the document"
 * passes on the broken code — that is the trap this file exists to avoid. The user-visible claim is
 * expressed as "the announcement is inside the surface that is on top", and the stylesheet contract
 * that makes that equivalent to "the user can see it" is pinned in announcer-cover-css.test.ts.
 * `app/e2e/covered-alert.e2e.ts` closes the loop for real: Playwright refuses to click a covered
 * element, which is the only proof that does not depend on a model of the stacking order.
 *
 * WHAT WAS NOT DONE, AND WHY: raising `.sidebar`'s z-index above the scrim. That would put a
 * navigation bar over a modal, and it would leave the alert outside `aria-modal="true"`, where a
 * screen reader is entitled to ignore it. The announcement goes ONTO the top surface instead.
 */

const rfb = { viewOnly: true, scaleViewport: false, resizeSession: false, showDotCursor: false, focusOnClick: false, background: "", disconnect: vi.fn(), focus: vi.fn(), sendKey: vi.fn(), clipboardPasteFrom: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
vi.mock("../../src/renderer/vnc/rfb", () => ({ createRfb: () => rfb }));

const SCOUT = botFixture("a", "Scout");

function boot() {
  return installFakeBridge({
    listAgents: { agents: [SCOUT], activeAgentId: "a" },
    openAgent: { agent: SCOUT },
    getAgentTranscriptTail: { entries: [] },
    getAgentAutomations: { routines: [] },
    getDisplays: { displays: [{ botId: "a", index: 2, display: ":2", cdpPort: 9222, running: true, generation: 1 }], waiting: [] },
  });
}

/** Every full-app cover, by the route a user actually opens it. */
const COVERS: { name: string; open: () => void }[] = [
  { name: "the full-window computer view", open: () => useComputer.getState().openComputer("a") },
  { name: "Settings", open: () => useUi.getState().openSettings() },
  { name: "the command palette", open: () => useOverlays.getState().openOverlay("palette") },
  { name: "the Marketplace", open: () => useMarketplace.getState().openMarketplace() },
];

const FAIL = "The computer refused that";

async function appOpen() {
  render(<App />);
  await screen.findByPlaceholderText("Message Scout");
  await waitFor(() => expect(useComputer.getState().displays.a).toBeTruthy());
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  resetOverlayStack();
  useUi.setState({ ...initialState(), settings: settingsFixture() });
  useComputer.setState({ open: null, displays: {}, displaysLoad: "loading", displaysError: null, waiting: [], lifecycle: null });
  useOverlays.setState({ open: null });
  useMarketplace.setState({ open: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetOverlayStack(); });

describe("bug 46: a failed action announces itself where the user is looking", () => {
  it("with nothing covering the app, the alert is still in the sidebar, exactly where it was", async () => {
    boot();
    await appOpen();
    act(() => { useUi.setState({ actionError: FAIL }); });

    const nav = screen.getByRole("navigation", { name: "Bots" });
    expect(within(nav).getByRole("alert").textContent).toContain(FAIL);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  for (const cover of COVERS) {
    it(`an action that fails while ${cover.name} is up announces INSIDE it`, async () => {
      boot();
      await appOpen();
      await act(async () => { cover.open(); });
      const panel = topOverlayPanel();
      expect(panel, `${cover.name} must be the surface on top`).toBeTruthy();

      await act(async () => { useUi.setState({ actionError: FAIL }); });

      const alerts = screen.getAllByRole("alert").filter((a) => a.textContent?.includes(FAIL));
      expect(alerts, "exactly one copy of the failure, and no second one under the cover").toHaveLength(1);
      expect(panel!.contains(alerts[0]!), `the alert must be inside ${cover.name}, not behind it`).toBe(true);
    });
  }

  it("an error raised BEHIND a cover is still unread and readable once the cover closes", async () => {
    boot();
    await appOpen();
    await act(async () => { useUi.getState().openSettings(); });
    await act(async () => { useUi.setState({ actionError: FAIL }); });
    expect(topOverlayPanel()!.contains(screen.getByRole("alert"))).toBe(true);

    // The message lives in the store, not in the surface: closing the cover moves the node back to
    // the app's own chrome with the same text and the same Dismiss, rather than losing it.
    await act(async () => { useUi.getState().closeSettings(); });

    const nav = screen.getByRole("navigation", { name: "Bots" });
    expect(within(nav).getByRole("alert").textContent).toContain(FAIL);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(useUi.getState().actionError).toBe(FAIL);
  });

  it("stacked surfaces: the announcement follows the TOP of the stack, not the first cover opened", async () => {
    boot();
    await appOpen();
    await act(async () => { useUi.getState().openSettings(); });
    await act(async () => { useOverlays.getState().openOverlay("palette"); });
    await act(async () => { useUi.setState({ actionError: FAIL }); });

    const top = topOverlayPanel()!;
    const alert = screen.getByRole("alert");
    expect(top.contains(alert), "the palette is on top of Settings; the alert belongs to the palette").toBe(true);
    // And it moves again when the top layer closes.
    await act(async () => { useOverlays.getState().close(); });
    expect(topOverlayPanel()!.contains(screen.getByRole("alert"))).toBe(true);
  });

  it("the Dismiss button goes with it, so a covered error can actually be dismissed", async () => {
    boot();
    await appOpen();
    await act(async () => { useComputer.getState().openComputer("a"); });
    await act(async () => { useUi.setState({ actionError: FAIL }); });

    const dismiss = screen.getByRole("button", { name: "Dismiss error" });
    expect(topOverlayPanel()!.contains(dismiss)).toBe(true);
    await act(async () => { dismiss.click(); });
    expect(useUi.getState().actionError).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the box lifecycle banner — the app's other always-mounted announcer — goes to the same outlet", async () => {
    boot();
    await appOpen();
    await act(async () => { useComputer.getState().setLifecycle({ phase: "starting", step: "starting", error: null }); });
    expect(screen.getByRole("status").textContent).toBeTruthy();

    await act(async () => { useUi.getState().openSettings(); });
    const banner = screen.getAllByRole("status").find((n) => n.className.includes("box-banner"));
    expect(banner, "the box banner must still be mounted while a cover is up").toBeTruthy();
    expect(topOverlayPanel()!.contains(banner!), "and it must be inside the surface on top").toBe(true);
  });
});

describe("bug 46, the class: a global reader may not live where the user cannot always see it", () => {
  /**
   * THE RULE. The app's always-mounted chrome — the components `App` renders unconditionally, which
   * are the only things guaranteed to be on screen — may not hold a live region unless that live
   * region is routed through `<Announce>`, the one thing that knows which surface is on top.
   *
   * It is a measurement, not an allowlist. The chrome is read out of `App.tsx` (a line that is
   * nothing but a self-closing `<Component />` is unconditional; anything inside a `{cond && …}` or
   * a ternary is not), a component that draws its own stack-joined surface is excluded because it IS
   * a surface, and everything left has to use the outlet. A third always-mounted announcer added
   * tomorrow is caught without this file being touched, and there is nothing here to quietly extend.
   */
  const LIVE_REGION = /role\s*=\s*"(alert|status)"|aria-live\s*=/g;

  /** Comments out, everything else kept at the same offsets (the technique overlay-hand-rolling.test.ts
   *  uses): prose ABOUT a live region must not count as one, which is the mistake bug 31's own grep made. */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

  /** Exemptions. Each must still name a component in the computed chrome AND still match its reason. */
  const DECLARATIONS: { component: string; because: RegExp; why: string }[] = [];

  const appSrc = stripComments(readSrc("App.tsx"));

  function chrome(): { component: string; file: string; src: string }[] {
    const unconditional = [...appSrc.matchAll(/^\s*<([A-Z][\w]*)\s*\/>\s*$/gm)].map((m) => m[1]!);
    expect(unconditional.length, "App.tsx must render some chrome unconditionally").toBeGreaterThan(1);
    return [...new Set(unconditional)].flatMap((component) => {
      const imp = new RegExp(`import\\s*\\{[^}]*\\b${component}\\b[^}]*\\}\\s*from\\s*"\\./([^"]+)"`).exec(appSrc);
      if (!imp) return [];
      const file = imp[1]! + ".tsx";
      return [{ component, file, src: stripComments(readSrc(file)) }];
    });
  }

  it("every live region in App's always-mounted chrome is routed through <Announce>", () => {
    const offenders: string[] = [];
    for (const { component, file, src } of chrome()) {
      // A component that draws a surface that joins the overlay stack IS the top surface when it is
      // up, so its own announcements are already where the user is looking.
      if (/<Dialog[\s>]/.test(src) || /\buseOverlayLayer\s*\(/.test(src)) continue;
      if (DECLARATIONS.some((d) => d.component === component)) continue;
      for (const m of src.matchAll(LIVE_REGION)) {
        const before = src.slice(0, m.index!);
        const opened = before.lastIndexOf("<Announce");
        const closed = before.lastIndexOf("</Announce>");
        if (opened === -1 || closed > opened) offenders.push(`${file}: ${m[0]} is not inside <Announce>`);
      }
    }
    expect(offenders, "a live region in always-visible chrome must go through the outlet").toEqual([]);
  });

  it("no stale exemptions: every DECLARATION still names real chrome and still measures its reason", () => {
    const byName = new Map(chrome().map((c) => [c.component, c]));
    for (const d of DECLARATIONS) {
      const c = byName.get(d.component);
      expect(c, `DECLARATION "${d.component}" (${d.why}) no longer names always-mounted chrome — drop it`).toBeTruthy();
      expect(c!.src, `DECLARATION "${d.component}": the reason "${d.why}" is no longer true of its source`).toMatch(d.because);
    }
  });

  it("every announcement carries data-announcement, so a surface's own alerts stay tellable from it", async () => {
    // Once the app-wide announcement can be portalled INTO any surface, `surface.getByRole(\"alert\")`
    // resolves two different claims at once: the error the surface itself is reporting, and this one
    // passing through. Four e2e journeys hit exactly that ambiguity. The attribute is the seam —
    // `[role=alert]:not([data-announcement])` is a surface's own — so it may not be forgotten on a
    // future occupant of the outlet. Measured from the rendered DOM, not from the source.
    boot();
    await appOpen();
    await act(async () => { useUi.getState().openSettings(); });
    await act(async () => {
      useUi.setState({ actionError: FAIL });
      useComputer.getState().setLifecycle({ phase: "starting", step: "starting", error: null });
    });
    const strip = document.querySelector(".surface-announce");
    expect(strip, "the outlet must be up while a cover is").toBeTruthy();
    expect(strip!.children.length, "both app-wide announcers must be in it for this to mean anything").toBeGreaterThanOrEqual(2);
    for (const n of [...strip!.children]) {
      expect(n.getAttribute("data-announcement"), `${n.className} must be tellable from a surface's own alert`).toBeTruthy();
    }
  });

  it("<Announce> is the only reader of actionError, and it is the one App mounts the outlet for", () => {
    // Ten writers, one reader: the point of the channel is that a failure has somewhere to go
    // without every caller choosing a surface. A second reader would be a second answer to "where
    // does this appear", which is how the first one ended up somewhere invisible.
    const sidebar = stripComments(readSrc("components/Sidebar.tsx"));
    expect(sidebar).toMatch(/<Announce>/);
    expect(appSrc, "App must mount the outlet that <Announce> portals into").toMatch(/<AnnounceOutlet\s*\/>/);
  });
});
