// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_REDIRECT_URI, GOOGLE_SCOPES, GOOGLE_SETUP_GUIDE, STRGS, type CatalogEntry, type GoogleStatusView, type MarketplaceView, type Tray } from "@synapse/shared";
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
let allowed: Record<string, boolean>;
let fb: ReturnType<typeof installFakeBridge>;
const native: [string, unknown][] = [];

beforeEach(() => {
  status = st({});
  allowed = { b2: true };
  native.length = 0;
  try { localStorage.clear(); } catch { /* none */ }
  fb = installFakeBridge({
    getGoogleStatus: () => status,
    setGoogleClient: (a: { clientId: string }) => (status = st({ state: "disconnected", clientId: a.clientId })),
    startGoogleAuth: () => { status = { ...status, state: "waiting" }; return { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc" }; },
    disconnectGoogle: () => (status = st({ state: "disconnected", clientId: "1-x.apps.googleusercontent.com" })),
    getLocalBrowserAllowed: (a: { id: string }) => ({ allowed: allowed[a.id] === true }),
    setLocalBrowserAllowed: (a: { id: string; allowed: boolean }) => { allowed[a.id] = a.allowed; return { allowed: a.allowed }; },
    startGoogleSetupTask: (a: { botId: string; mode: "setup" }) => (status = { ...status, setupTask: { botId: a.botId, botName: a.botId === "b2" ? "Nova" : "Scout", mode: a.mode, startedAt: 1, clientSaved: false } }),
    cancelGoogleSetupTask: () => (status = { ...status, setupTask: null }),
    getGoogleReconnectCheck: () => ({ enabled: true, explicit: false, testing: true, lastRunAt: null }),
    setGoogleReconnectCheck: (a: { enabled: boolean }) => ({ enabled: a.enabled, explicit: true, testing: true, lastRunAt: null }),
    // The Settings block and the Marketplace Google rows also read the Composio status (composio-oneclick).
    getComposioStatus: () => ({ keySet: false, disclosureAccepted: false, apps: [] }),
    setAgentGoogle: (a: { id: string; enabled: boolean }) => ({ agent: { ...botFixture(a.id, "Scout"), settings: { ...botFixture(a.id, "Scout").settings, google: a.enabled } } }),
  });
  (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = vi.fn(async (n: string, a: unknown) => { native.push([n, a]); return { ok: true, result: {} }; });
  useGoogle.setState({ open: false, status: null, error: null, busy: false, mode: "self", checks: {}, projectId: "" });
});
afterEach(cleanup);

describe("Connect Google sheet", () => {
  it("guides setup: six checked steps, the exact console pages, Copy for every value, then Connect", async () => {
    await act(async () => { useGoogle.getState().openSheet(); });
    render(<ConnectGoogleSheet />);
    const dlg = await screen.findByRole("dialog", { name: "Connect Google" });
    const steps = within(dlg).getByRole("list", { name: "Setup steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(6);
    for (const s of GOOGLE_SETUP_GUIDE) expect(within(steps).getByRole("checkbox", { name: s.title })).toBeTruthy();
    expect(steps.textContent).toContain("Publishing status: In production");
    // Labels only: no explanatory subtitles, one honest line on the unverified-app warning.
    expect(dlg.textContent).toContain(STRGS.unverifiedNote);
    expect(dlg.textContent).not.toContain("7 days");

    // Every value has its own Copy button: each scope, all scopes at once, the app name, the client type.
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    for (const scope of GOOGLE_SCOPES) {
      fireEvent.click(within(steps).getByRole("button", { name: `Copy ${scope.replace("https://www.googleapis.com/auth/", "")}` }));
      expect(writeText).toHaveBeenLastCalledWith(scope);
    }
    fireEvent.click(within(steps).getByRole("button", { name: "Copy All scopes" }));
    expect(writeText).toHaveBeenLastCalledWith(GOOGLE_SCOPES.join(","));
    for (const [label, value] of [["App name", "Synapse"], ["Application type", "Desktop app"], ["Redirect URI", GOOGLE_REDIRECT_URI]]) {
      fireEvent.click(within(steps).getByRole("button", { name: `Copy ${label}` }));
      expect(writeText).toHaveBeenLastCalledWith(value);
    }

    // Open in browser: the exact console page, pinned to the project once its id is given.
    fireEvent.click(within(steps).getByRole("button", { name: "Open in browser (Create a project)" }));
    expect(native).toContainEqual(["openExternal", { url: "https://console.cloud.google.com/projectcreate" }]);
    fireEvent.change(within(steps).getByLabelText("Project ID"), { target: { value: "synapse-123456" } });
    fireEvent.click(within(steps).getByRole("button", { name: "Open in browser (Publishing status: In production)" }));
    expect(native).toContainEqual(["openExternal", { url: "https://console.cloud.google.com/auth/audience?project=synapse-123456" }]);
    fireEvent.click(within(steps).getByRole("button", { name: "Open in browser (Enable the Gmail, Calendar and Drive APIs)" }));
    expect(native).toContainEqual(["openExternal", { url: "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com&project=synapse-123456" }]);

    // User-ticked steps tick; the client and connect steps are verified by the app, not ticked.
    const prod = within(steps).getByRole("checkbox", { name: "Publishing status: In production" }) as HTMLInputElement;
    fireEvent.click(prod);
    expect(prod.checked).toBe(true);
    expect((within(steps).getByRole("checkbox", { name: "Create the Desktop OAuth client" }) as HTMLInputElement).disabled).toBe(false);
    expect((within(steps).getByRole("checkbox", { name: "Paste the Client ID and secret, then Connect" }) as HTMLInputElement).disabled).toBe(true);

    const connect = within(dlg).getByRole("button", { name: "Connect" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText("Client ID"), { target: { value: "1-x.apps.googleusercontent.com" } });
    fireEvent.change(within(dlg).getByLabelText("Client secret"), { target: { value: "GOCSPX-abc" } });
    expect((within(dlg).getByLabelText("Client secret") as HTMLInputElement).type).toBe("password");
    fireEvent.click(connect);
    await vi.waitFor(() => expect(native).toContainEqual(["openExternal", { url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc" }]));
    expect(fb.calls.find((c) => c[0] === "setGoogleClient")![1]).toEqual({ clientId: "1-x.apps.googleusercontent.com", clientSecret: "GOCSPX-abc", inProduction: true });
    expect(await within(dlg).findByText("Click Allow in your browser")).toBeTruthy();
    // Saved: the client step is verified now.
    await vi.waitFor(() => expect((within(steps).getByRole("checkbox", { name: "Create the Desktop OAuth client" }) as HTMLInputElement).disabled).toBe(true));
  });

  it("Let a Bot do it: defaults to the first Bot with the Mac browser, starts the task, shows it working, Stop ends it", async () => {
    useUi.setState({ bots: { b1: botFixture("b1", "Scout"), b2: botFixture("b2", "Nova") } });
    await act(async () => { useGoogle.getState().openSheet(); });
    render(<ConnectGoogleSheet />);
    const dlg = await screen.findByRole("dialog", { name: "Connect Google" });
    fireEvent.click(within(dlg).getByRole("radio", { name: "Let a Bot do it" }));
    const panel = within(dlg).getByRole("region", { name: "Let a Bot do it" });
    await vi.waitFor(() => expect((within(panel).getByLabelText("Bot") as HTMLSelectElement).value).toBe("b2"));
    fireEvent.click(within(panel).getByRole("button", { name: "Start" }));
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["startGoogleSetupTask", { botId: "b2", mode: "setup", projectId: null }]));
    expect(await within(dlg).findByText("Nova is working in your browser")).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Stop" }));
    await vi.waitFor(() => expect(fb.calls.map((c) => c[0])).toContain("cancelGoogleSetupTask"));
    expect(await within(dlg).findByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("Let a Bot do it with no Bot allowed the browser: offers to turn it on, and Start waits for it", async () => {
    allowed = {};
    useUi.setState({ bots: { b1: botFixture("b1", "Scout") } });
    await act(async () => { useGoogle.getState().openSheet({ mode: "bot" }); });
    render(<ConnectGoogleSheet />);
    const dlg = await screen.findByRole("dialog", { name: "Connect Google" });
    const sw = await within(dlg).findByRole("switch", { name: "Turn on the browser for Scout" });
    expect((within(dlg).getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sw);
    await vi.waitFor(() => expect((within(dlg).getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));
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
    // Gmail, Calendar and Drive: Connect directly (the own-Google-app path) is the default; Composio is the quick option.
    fireEvent.click(screen.getByRole("button", { name: "Connect directly Gmail" }));
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

  it("the Reconnect Google notification opens the reconnect flow directly (Google's sign-in, no secret)", async () => {
    status = st({ state: "needs-reconnect", clientId: "1-x.apps.googleusercontent.com" });
    const tray: Tray = { id: "t1", botId: null, title: "Reconnect Google", detail: "expired", requestId: null, buttons: [{ label: "Reconnect Google", action: "reconnect-google" }, { label: "Let a Bot click through", action: "reconnect-google-bot" }], dedupeKey: "google-reconnect", count: 1, createdAt: 0 };
    useUi.setState({ trays: [tray] });
    render(<Trays botId="b1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Google" }));
    expect(useGoogle.getState().open).toBe(true);
    await vi.waitFor(() => expect(native.map((n) => n[0])).toContain("openExternal"));
    expect(fb.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["startGoogleAuth"]));
    expect(fb.calls.map((c) => c[0])).not.toContain("setGoogleClient");
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["dismissTray", { trayId: "t1" }]));
  });

  it("Let a Bot click through opens the sheet on the Bot panel, reconnect mode", async () => {
    status = st({ state: "needs-reconnect", clientId: "1-x.apps.googleusercontent.com" });
    useUi.setState({ bots: { b2: botFixture("b2", "Nova") }, trays: [{ id: "t1", botId: null, title: "Reconnect Google", detail: null, requestId: null, buttons: [{ label: "Let a Bot click through", action: "reconnect-google-bot" }], dedupeKey: "google-reconnect", count: 1, createdAt: 0 }] });
    render(<><Trays botId="b1" /><ConnectGoogleSheet /></>);
    fireEvent.click(screen.getByRole("button", { name: "Let a Bot click through" }));
    const dlg = await screen.findByRole("dialog", { name: "Connect Google" });
    const panel = await within(dlg).findByRole("region", { name: "Let a Bot click through" });
    await vi.waitFor(() => expect((within(panel).getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(panel).getByRole("button", { name: "Start" }));
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["startGoogleSetupTask", { botId: "b2", mode: "reconnect", projectId: null }]));
  });

  it("Settings → Connected accounts: Set up before a client, and the weekly check's switch once there is one", async () => {
    render(<ConnectedAccountsBlock />);
    const region = screen.getByRole("region", { name: "Connected accounts" });
    expect(await within(region).findByRole("button", { name: "Set up Google" })).toBeTruthy();
    expect(within(region).queryByRole("switch")).toBeNull();
    cleanup();
    status = st({ state: "connected", clientId: "1-x.apps.googleusercontent.com", email: "me@example.com" });
    render(<ConnectedAccountsBlock />);
    const sw = await screen.findByRole("switch", { name: STRGS.reconnectCheck });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["setGoogleReconnectCheck", { enabled: false }]));
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
  });
});
