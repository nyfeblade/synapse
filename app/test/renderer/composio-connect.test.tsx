// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSIO_APPS, COMPOSIO_DASHBOARD_URL, STRX, type ComposioStatusView } from "@synapse/shared";
import { ComposioBotRows } from "../../src/renderer/composio/ComposioBotRows";
import { ComposioMarketplaceSection } from "../../src/renderer/composio/ComposioMarketplace";
import { ComposioDisclosure, ComposioSheet } from "../../src/renderer/composio/ComposioSheet";
import { useComposio } from "../../src/renderer/composio/store";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

const view = (p: Partial<ComposioStatusView> = {}, states: Record<string, { state: ComposioStatusView["apps"][number]["state"]; bots?: string[] }> = {}): ComposioStatusView => ({
  keySet: false, disclosureAccepted: false,
  apps: COMPOSIO_APPS.map((a) => ({ toolkit: a.toolkit, name: a.name, state: states[a.toolkit]?.state ?? "available", bots: states[a.toolkit]?.bots ?? [], error: null })),
  ...p,
});

let status: ComposioStatusView;
let fb: ReturnType<typeof installFakeBridge>;
const native: [string, unknown][] = [];
let pasteResult: () => { ok: boolean; result?: unknown; error?: { code: string; message: string } };

beforeEach(() => {
  status = view();
  native.length = 0;
  pasteResult = () => { status = view({ keySet: true }); return { ok: true, result: status }; };
  fb = installFakeBridge({
    getComposioStatus: () => status,
    acceptComposioDisclosure: () => (status = { ...status, disclosureAccepted: true }),
    connectComposioApp: (a: { toolkit: string }) => { status = view({ keySet: true, disclosureAccepted: true }, { [a.toolkit]: { state: "waiting" } }); return { redirectUrl: `https://connect.composio.dev/link/${a.toolkit}`, status }; },
    setComposioGrant: (a: { toolkit: string; botId: string; enabled: boolean }) => (status = view({ keySet: true, disclosureAccepted: true }, { [a.toolkit]: { state: "connected", bots: a.enabled ? [a.botId] : [] } })),
    disconnectComposioApp: () => (status = view({ keySet: true, disclosureAccepted: true })),
    clearComposioKey: () => (status = view()),
  });
  (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = vi.fn(async (n: string, a: unknown) => {
    native.push([n, a]);
    return n === "composio.pasteKey" ? pasteResult() : { ok: true, result: {} };
  });
  useComposio.setState({ open: false, status: null, error: null, busy: null, disclosureFor: null, links: {} });
  useUi.setState({ bots: { b1: botFixture("b1", "Scout"), b2: botFixture("b2", "Pilot") } } as never);
});
afterEach(cleanup);

describe("Composio key walkthrough", () => {
  it("shows four labelled steps; Open Composio opens the dashboard; Paste asks main to read the clipboard (no key in this window)", async () => {
    await act(async () => { useComposio.getState().openSheet(); });
    render(<ComposioSheet />);
    const steps = screen.getByRole("list", { name: STRX.sheetTitle });
    expect(within(steps).getAllByRole("listitem").filter((li) => li.parentElement === steps)).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: STRX.step1Button }));
    await act(async () => {});
    expect(native).toContainEqual(["openExternal", { url: COMPOSIO_DASHBOARD_URL }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STRX.pasteButton })); });
    expect(native.find(([n]) => n === "composio.pasteKey")).toEqual(["composio.pasteKey", {}]);
    expect(fb.calls.some(([c]) => c === "setComposioKey")).toBe(false); // the renderer never sends a key
    expect(await screen.findByText(STRX.keySaved)).toBeTruthy();
  });

  it("a rejected key and an unreachable Composio read as calm one-line errors", async () => {
    for (const msg of [STRX.keyRejected, STRX.unreachable]) {
      pasteResult = () => ({ ok: false, error: { code: "BAD_ARGS", message: msg } });
      await act(async () => { useComposio.setState({ error: null }); useComposio.getState().openSheet(); });
      const { unmount } = render(<ComposioSheet />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: STRX.pasteButton })); });
      expect(screen.getByRole("alert").textContent).toBe(msg);
      unmount();
    }
  });
});

describe("one-click Connect from the Marketplace", () => {
  it("before a key: one Set up row; after: every app with a single Connect", async () => {
    render(<ComposioMarketplaceSection />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: `${STRX.setUp} ${STRX.composio}` })).toBeTruthy();
    cleanup();
    status = view({ keySet: true, disclosureAccepted: true });
    useComposio.setState({ status: null });
    render(<ComposioMarketplaceSection />);
    await act(async () => {});
    for (const a of COMPOSIO_APPS.filter((x) => !["gmail", "googlecalendar", "googledrive"].includes(x.toolkit))) expect(screen.getByRole("button", { name: `${STRX.connect} ${a.name}` })).toBeTruthy();
  });

  it("the data note is asked once: accept → connect → browser; the next Connect goes straight through", async () => {
    status = view({ keySet: true });
    render(<><ComposioMarketplaceSection /><ComposioDisclosure /></>);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${STRX.connect} Slack` })); });
    const dlg = screen.getByRole("dialog", { name: STRX.disclosureTitle });
    expect(within(dlg).getByText(STRX.disclosure)).toBeTruthy();
    expect(fb.calls.some(([c]) => c === "connectComposioApp")).toBe(false);
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: STRX.accept })); });
    expect(fb.calls.map(([c]) => c).filter((c) => c.includes("Composio") && c !== "getComposioStatus")).toEqual(["acceptComposioDisclosure", "connectComposioApp"]);
    expect(native).toContainEqual(["openExternal", { url: "https://connect.composio.dev/link/slack" }]);
    expect(screen.getByText(STRX.waiting)).toBeTruthy();
    // Composio says the account is active: the row flips to Connected.
    await act(async () => { fb.emitEvent({ channel: "composio", payload: view({ keySet: true, disclosureAccepted: true }, { slack: { state: "connected" } }) }); });
    expect(screen.getByText(STRX.connected)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${STRX.connect} GitHub` })); });
    expect(screen.queryByRole("dialog", { name: STRX.disclosureTitle })).toBeNull();
    expect(fb.calls.filter(([c]) => c === "connectComposioApp")).toHaveLength(2);
  });
});

describe("per-Bot grants", () => {
  it("a newly connected app opens its Bot list (all off); a switch grants just that Bot", async () => {
    status = view({ keySet: true, disclosureAccepted: true }, { gmail: { state: "connected" } });
    await act(async () => { useComposio.getState().openSheet(); });
    render(<ComposioSheet />);
    await act(async () => {});
    const scout = screen.getByRole("switch", { name: "Gmail: Scout" });
    expect(scout.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Gmail: Pilot" }).getAttribute("aria-checked")).toBe("false");
    await act(async () => { fireEvent.click(scout); });
    expect(fb.calls).toContainEqual(["setComposioGrant", { toolkit: "gmail", botId: "b1", enabled: true }]);
  });

  it("Bot settings shows a switch per connected app only", async () => {
    status = view({ keySet: true, disclosureAccepted: true }, { gmail: { state: "connected", bots: ["b1"] }, slack: { state: "waiting" } });
    render(<ComposioBotRows botId="b1" />);
    await act(async () => {});
    expect(screen.getByRole("switch", { name: "Gmail" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch", { name: "Slack" })).toBeNull();
  });
});

describe("Gmail, Calendar and Drive: one row, two ways in", () => {
  it("the Google rows offer Connect directly (default) and One click with Composio (marked); the Composio section lists only the other apps", async () => {
    const { GoogleTwinPill } = await import("../../src/renderer/composio/GoogleTwinPill");
    const { useGoogle } = await import("../../src/renderer/google/store");
    const openGoogle = vi.fn();
    useGoogle.setState({ openSheet: openGoogle } as never);
    status = view({ keySet: true, disclosureAccepted: true });
    const gmail = { id: "curated:gmail", kind: "plugin", source: "google", name: "Gmail", description: "", category: "Productivity", logo: null, action: "connect", state: "available" } as never;
    render(<><GoogleTwinPill e={gmail} toolkit="gmail" /><ComposioMarketplaceSection /></>);
    await act(async () => {});
    const buttons = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(buttons.indexOf("Connect directly Gmail")).toBeLessThan(buttons.indexOf("One click with Composio Gmail"));
    expect(screen.getByText(STRX.throughComposio)).toBeTruthy();
    for (const twin of ["Gmail", "Google Calendar", "Google Drive"]) expect(screen.queryByRole("button", { name: `${STRX.connect} ${twin}` })).toBeNull();
    for (const only of ["Slack", "GitHub", "Notion", "Linear"]) expect(screen.getByRole("button", { name: `${STRX.connect} ${only}` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect directly Gmail" }));
    expect(openGoogle).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "One click with Composio Gmail" })); });
    expect(fb.calls).toContainEqual(["connectComposioApp", { toolkit: "gmail" }]);
    expect(screen.getByText(STRX.waiting)).toBeTruthy();
  });
});

describe("bug 401: the sign-in link", () => {
  it("a link that isn't an https Composio link is never opened", async () => {
    status = view({ keySet: true, disclosureAccepted: true });
    fb = installFakeBridge({ getComposioStatus: () => status, connectComposioApp: () => ({ redirectUrl: "https://evil.example.com/login", status }) });
    (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = vi.fn(async (n: string, a: unknown) => { native.push([n, a]); return { ok: true, result: {} }; });
    useComposio.setState({ status });
    await act(async () => { await useComposio.getState().connect("slack"); });
    expect(native.some(([n]) => n === "openExternal")).toBe(false);
    expect(useComposio.getState().error).toBe("Composio didn't return a sign-in link.");
  });
});
