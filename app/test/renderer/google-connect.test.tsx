// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_REDIRECT_URI, type CatalogEntry, type GoogleStatusView, type MarketplaceView, type Tray } from "@synapse/shared";
import { ConnectGoogleSheet } from "../../src/renderer/google/ConnectGoogleSheet";
import { ConnectedAccountsBlock } from "../../src/renderer/google/ConnectedAccountsBlock";
import { GoogleToggle } from "../../src/renderer/google/GoogleToggle";
import { useGoogle } from "../../src/renderer/google/store";
import { MarketplaceModal } from "../../src/renderer/marketplace/MarketplaceModal";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { Trays } from "../../src/renderer/components/Trays";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

const st = (p: Partial<GoogleStatusView>): GoogleStatusView => ({ state: "not-configured", clientId: null, email: null, services: [], redirectUri: GOOGLE_REDIRECT_URI, error: null, ...p });
const connected = st({ state: "connected", clientId: "1-x.apps.googleusercontent.com", email: "me@example.com", services: ["Gmail", "Calendar", "Drive"] });

let status: GoogleStatusView;
let fb: ReturnType<typeof installFakeBridge>;
const native: [string, unknown][] = [];

beforeEach(() => {
  status = st({});
  native.length = 0;
  fb = installFakeBridge({
    getGoogleStatus: () => status,
    setGoogleClient: (a: { clientId: string }) => (status = st({ state: "disconnected", clientId: a.clientId })),
    startGoogleAuth: () => { status = { ...status, state: "waiting" }; return { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc" }; },
    disconnectGoogle: () => (status = st({ state: "disconnected", clientId: "1-x.apps.googleusercontent.com" })),
    setAgentGoogle: (a: { id: string; enabled: boolean }) => ({ agent: { ...botFixture(a.id, "Scout"), settings: { ...botFixture(a.id, "Scout").settings, google: a.enabled } } }),
  });
  (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = vi.fn(async (n: string, a: unknown) => { native.push([n, a]); return { ok: true, result: {} }; });
  useGoogle.setState({ open: false, status: null, error: null, busy: false });
});
afterEach(cleanup);

describe("Connect Google sheet", () => {
  it("guides setup (numbered steps, copyable redirect URI), then saves the client and opens Google's consent", async () => {
    await act(async () => { useGoogle.getState().openSheet(); });
    render(<ConnectGoogleSheet />);
    const dlg = await screen.findByRole("dialog", { name: "Connect Google" });
    const steps = within(dlg).getByRole("list", { name: "Setup steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(6);
    expect(steps.textContent).toContain("console.cloud.google.com");
    expect(dlg.textContent).toContain("gmail.readonly");
    expect(dlg.textContent).toContain("7 days");
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(within(dlg).getByRole("button", { name: `Copy Redirect URI ${GOOGLE_REDIRECT_URI}` }));
    expect(writeText).toHaveBeenCalledWith(GOOGLE_REDIRECT_URI);
    const connect = within(dlg).getByRole("button", { name: "Connect" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText("Client ID"), { target: { value: "1-x.apps.googleusercontent.com" } });
    fireEvent.change(within(dlg).getByLabelText("Client secret"), { target: { value: "GOCSPX-abc" } });
    expect((within(dlg).getByLabelText("Client secret") as HTMLInputElement).type).toBe("password");
    fireEvent.click(connect);
    await vi.waitFor(() => expect(native).toContainEqual(["openExternal", { url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc" }]));
    expect(fb.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["setGoogleClient", "startGoogleAuth"]));
    expect(fb.calls.find((c) => c[0] === "setGoogleClient")![1]).toEqual({ clientId: "1-x.apps.googleusercontent.com", clientSecret: "GOCSPX-abc" });
    expect(await within(dlg).findByText(/Waiting for you to approve/)).toBeTruthy();
  });

  it("shows the connected account and services, and Disconnect revokes", async () => {
    status = connected;
    await act(async () => { useGoogle.getState().openSheet(); });
    render(<ConnectGoogleSheet />);
    const dlg = await screen.findByRole("dialog", { name: "Connect Google" });
    expect(await within(dlg).findByText("Connected as me@example.com")).toBeTruthy();
    expect(within(dlg).getByText("Access to Gmail, Calendar, Drive")).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Disconnect" }));
    await vi.waitFor(() => expect(fb.calls.map((c) => c[0])).toContain("disconnectGoogle"));
  });

  it("needs-reconnect offers Reconnect without re-entering the secret", async () => {
    status = st({ state: "needs-reconnect", clientId: "1-x.apps.googleusercontent.com", email: "me@example.com", error: "Google needs you to sign in again." });
    await act(async () => { useGoogle.getState().openSheet(); });
    render(<ConnectGoogleSheet />);
    const dlg = await screen.findByRole("dialog", { name: "Connect Google" });
    expect(await within(dlg).findByText("Google needs you to sign in again.")).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Reconnect Google" }));
    await vi.waitFor(() => expect(native.map((n) => n[0])).toContain("openExternal"));
    expect(fb.calls.map((c) => c[0])).not.toContain("setGoogleClient");
  });

  it("follows live status on the google channel", async () => {
    await act(async () => { useGoogle.getState().openSheet(); });
    render(<ConnectGoogleSheet />);
    await screen.findByRole("dialog", { name: "Connect Google" });
    act(() => fb.emitEvent({ channel: "google", payload: connected }));
    expect(await screen.findByText("Connected as me@example.com")).toBeTruthy();
  });
});

describe("entry points", () => {
  it("Marketplace Gmail opens the Connect Google sheet instead of installing", async () => {
    const e = (p: Partial<CatalogEntry> & { id: string; name: string }): CatalogEntry => ({ kind: "plugin", source: "google", description: "d", category: "Productivity", logo: null, action: "connect", state: "available", ...p });
    const view: MarketplaceView = { installed: { count: 0, logos: [] }, featuredBots: [], forYou: null, fromTeam: [], featuredPlugins: [e({ id: "curated:gmail", name: "Gmail" }), e({ id: "curated:google-drive", name: "Google Drive", state: "connected" })], categories: [] };
    useMarketplace.setState({ open: true, page: "home", view, query: "", results: null, waiting: {}, recent: [], detailId: null });
    render(<MarketplaceModal />);
    // UI polish pass: one verb per row — Add, Authorize or Manage.
    fireEvent.click(screen.getByRole("button", { name: "Add Gmail" }));
    expect(useGoogle.getState().open).toBe(true);
    expect(fb.calls.map((c) => c[0])).not.toContain("installPlugin");
    const drive = screen.getByRole("button", { name: "Manage Google Drive" });
    expect((drive as HTMLButtonElement).disabled).toBe(false);
  });

  it("Settings → Connected accounts has a Google row", async () => {
    status = connected;
    render(<ConnectedAccountsBlock />);
    const region = screen.getByRole("region", { name: "Connected accounts" });
    expect(await within(region).findByText("me@example.com")).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: "Manage Google" }));
    expect(useGoogle.getState().open).toBe(true);
  });

  it("Bot Settings has a per-Bot Google switch (default off)", async () => {
    useUi.setState({ bots: { b1: botFixture("b1", "Scout") } });
    status = connected;
    render(<GoogleToggle botId="b1" />);
    const sw = screen.getByRole("switch", { name: "Google" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["setAgentGoogle", { id: "b1", enabled: true }]));
    await vi.waitFor(() => expect(useUi.getState().bots.b1!.settings.google).toBe(true));
  });

  it("a connected account that is off for this Bot says so, instead of reading as usable", async () => {
    useUi.setState({ bots: { b1: botFixture("b1", "Scout") } });
    status = connected;
    render(<GoogleToggle botId="b1" />);
    expect(await screen.findByText(/off for this Bot/i)).toBeTruthy();
    expect(screen.queryByText("Let this Bot use your connected Gmail, Calendar and Drive")).toBeNull();
  });

  it("once the switch is on, the row describes the tools the Bot actually has", async () => {
    const on = botFixture("b1", "Scout");
    useUi.setState({ bots: { b1: { ...on, settings: { ...on.settings, google: true } } } });
    status = connected;
    render(<GoogleToggle botId="b1" />);
    expect(await screen.findByText(/Let this Bot use your connected Gmail, Calendar and Drive/)).toBeTruthy();
    expect(screen.queryByText(/off for this Bot/i)).toBeNull();
  });

  it("the Reconnect Google notification opens the sheet", async () => {
    const tray: Tray = { id: "t1", botId: null, title: "Reconnect Google", detail: "expired", requestId: null, buttons: [{ label: "Reconnect Google", action: "reconnect-google" }], dedupeKey: "google-reconnect", count: 1, createdAt: 0 };
    useUi.setState({ trays: [tray] });
    render(<Trays botId="b1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Google" }));
    expect(useGoogle.getState().open).toBe(true);
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["dismissTray", { trayId: "t1" }]));
  });
});
