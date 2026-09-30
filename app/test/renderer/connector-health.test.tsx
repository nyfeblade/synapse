// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorHealthView, Tray } from "@synapse/shared";
import { ConnectionsSection } from "../../src/renderer/components/settings/ConnectionsSection";
import { WorkNotifyBlock } from "../../src/renderer/components/settings/WorkNotifyBlock";
import { Trays } from "../../src/renderer/components/Trays";
import { useComposio } from "../../src/renderer/composio/store";
import { useGoogle } from "../../src/renderer/google/store";
import { runFix, useHealth } from "../../src/renderer/health/store";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

const c = (id: string, name: string, state: ConnectorHealthView["state"], fix: ConnectorHealthView["fix"], reason: string | null = null, kind: ConnectorHealthView["kind"] = "mcp"): ConnectorHealthView =>
  ({ id, kind, name, state, reason, since: 0, fix });

let list: ConnectorHealthView[];
let fb: ReturnType<typeof installFakeBridge>;
const native: [string, unknown][] = [];

beforeEach(() => {
  native.length = 0;
  list = [
    c("google", "Gmail", "needs-sign-in", { kind: "google" }, null, "google"),
    c("mcp:linear", "Linear", "broken", { kind: "mcp-restart", serverId: "linear" }, "Didn't start"),
    c("telegram", "Telegram", "ok", { kind: "telegram" }, null, "telegram"),
    c("mcp:files", "Files", "checking", { kind: "mcp-restart", serverId: "files" }),
  ];
  fb = installFakeBridge({
    getConnectorHealth: () => ({ connectors: list }),
    getGoogleStatus: () => ({ state: "needs-reconnect", clientId: "1-x.apps.googleusercontent.com", email: "me@example.com", services: ["Gmail"], redirectUri: "", error: null }),
    startGoogleAuth: () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc" }),
    startMcpAuth: () => ({ authorizationUrl: "https://mcp.linear.app/authorize?x=1" }),
    connectComposioApp: () => ({ redirectUrl: "https://connect.composio.dev/link/abc", status: { keySet: true, disclosureAccepted: true, apps: [] } }),
    getComposioStatus: () => ({ keySet: true, disclosureAccepted: true, apps: [] }),
    openAgent: (a: { id: string }) => ({ agent: botFixture(a.id, "Scout") }),
    getAgentTranscriptTail: { entries: [] },
    setHostSettings: (a: Record<string, unknown>) => ({ ...settingsFixture(), ...a }),
  });
  (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = vi.fn(async (n: string, a: unknown) => {
    native.push([n, a]);
    if (n === "telegram.status") return { ok: true, result: { enabled: true, owner: { name: "Me", pairedAt: 1 } } };
    return { ok: true, result: {} };
  });
  useHealth.setState({ connectors: null, error: null });
  useGoogle.setState({ open: false, status: null, error: null, busy: false, mode: "self", checks: {}, projectId: "" });
  useComposio.setState({ status: { keySet: true, disclosureAccepted: true, apps: [] }, busy: null, error: null, links: {} });
  useUi.setState({ settingsOpen: true, settingsFocus: null, bots: { b1: botFixture("b1", "Scout") }, trays: [], settings: { ...settingsFixture(), workNotify: "on", workNotifyTelegram: false } });
});
afterEach(cleanup);

describe("Settings → Connections (4.4)", () => {
  it("shows each connector as a dot and a label; Fix only where it needs one; a Broken one says why", async () => {
    render(<ConnectionsSection />);
    const card = await screen.findByLabelText("Connections");
    const rows = card.querySelectorAll(".connection-row");
    expect([...rows].map((r) => [r.getAttribute("data-connector"), r.getAttribute("data-state")])).toEqual([
      ["google", "needs-sign-in"], ["mcp:linear", "broken"], ["telegram", "ok"], ["mcp:files", "checking"],
    ]);
    expect(within(rows[0] as HTMLElement).getByText("Needs sign-in")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Broken · Didn't start")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("OK")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Checking")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Fix / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Fix Gmail", "Fix Linear"]);
    expect((rows[0] as HTMLElement).querySelector(".health-dot.needs-sign-in")).toBeTruthy();
  });

  it("follows the host's connector-health events live", async () => {
    render(<ConnectionsSection />);
    await screen.findByLabelText("Connections");
    act(() => fb.emitEvent({ channel: "connector-health", payload: { connectors: [c("google", "Gmail", "ok", { kind: "google" }, null, "google")] } }));
    expect(screen.queryByRole("button", { name: "Fix Gmail" })).toBeNull();
    expect(screen.getByText("OK")).toBeTruthy();
  });

  it("an empty list says so", async () => {
    list = [];
    render(<ConnectionsSection />);
    expect(await screen.findByText("No connections yet")).toBeTruthy();
  });
});

describe("Fix runs the connector's existing reconnect flow", () => {
  it("Google: the reconnect sheet (Google's own sign-in)", async () => {
    await act(async () => { await runFix({ kind: "google" }); });
    expect(useGoogle.getState().open).toBe(true);
    await vi.waitFor(() => expect(fb.calls.map((x) => x[0])).toContain("startGoogleAuth"));
  });

  it("an MCP server that needs sign-in: its OAuth, in the browser; a broken one: a restart", async () => {
    await runFix({ kind: "mcp-auth", serverId: "linear" });
    expect(fb.calls).toContainEqual(["startMcpAuth", { serverId: "linear" }]);
    expect(native).toContainEqual(["openExternal", { url: "https://mcp.linear.app/authorize?x=1" }]);
    await runFix({ kind: "mcp-restart", serverId: "notes" });
    expect(fb.calls).toContainEqual(["restartMcpServers", { serverId: "notes" }]);
  });

  it("an app through Composio: Composio's hosted sign-in", async () => {
    await runFix({ kind: "composio-app", toolkit: "gmail" });
    expect(fb.calls).toContainEqual(["connectComposioApp", { toolkit: "gmail" }]);
    expect(native).toContainEqual(["openExternal", { url: "https://connect.composio.dev/link/abc" }]);
  });

  it("Telegram and the API key: their settings; GitHub: that Bot's settings", async () => {
    await runFix({ kind: "telegram" });
    expect(useUi.getState().settingsFocus).toBe("telegram");
    await runFix({ kind: "provider" });
    expect(useUi.getState().settingsFocus).toBe("account");
    await runFix({ kind: "github", botId: "b1" });
    expect(fb.calls).toContainEqual(["openAgent", { id: "b1" }]);
    expect(useUi.getState().panel).toBe("settings");
    expect(useUi.getState().settingsOpen).toBe(false);
  });

  it("the tray's Fix runs it too, and leaves the tray until the connector works again", async () => {
    const tray: Tray = { id: "t1", botId: null, title: "Linear needs you to sign in again", detail: null, requestId: null, buttons: [{ label: "Fix", action: "fix-connector", target: "mcp:linear" }], dedupeKey: "health:mcp:linear", count: 1, createdAt: 0 };
    list = [c("mcp:linear", "Linear", "needs-sign-in", { kind: "mcp-auth", serverId: "linear" })];
    useUi.setState({ trays: [tray] });
    render(<Trays botId="b1" />);
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["startMcpAuth", { serverId: "linear" }]));
    expect(fb.calls.map((x) => x[0])).not.toContain("dismissTray");
  });
});

describe("Settings → General → Work finished", () => {
  it("On / Only long tasks / Off, and Also on Telegram once Telegram is paired", async () => {
    render(<WorkNotifyBlock />);
    const group = screen.getByRole("radiogroup", { name: "Work finished" });
    fireEvent.click(within(group).getByRole("radio", { name: "Only long tasks" }));
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["setHostSettings", { workNotify: "long" }]));
    const sw = await screen.findByRole("switch", { name: "Also on Telegram" });
    fireEvent.click(sw);
    await vi.waitFor(() => expect(fb.calls).toContainEqual(["setHostSettings", { workNotifyTelegram: true }]));
  });
});
