import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_LIMITS, type ComposioStatusView, type GoogleStatusView, type SseEvent } from "@synapse/shared";
import type { ComposioServices } from "../../composio/module";
import { ComposioError } from "../../composio/api";
import { SseHub } from "../../gateway/sse-hub";
import type { GoogleServices } from "../../google/module";
import { GoogleAuthError } from "../../google/oauth";
import { createHealthModule, createHealthServices } from "../../health/module";
import { createMcpModule, createMcpServices, type McpServices } from "../../mcp/module";
import type { RemoteConnection } from "../../mcp/proxy";
import { HostSettingsStore } from "../../store/host-settings";
import { TrayService } from "../../trays/trays";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-adapters-"));
  dirs.push(dir);
  let t = 1_000_000;
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const trays = new TrayService(hub, () => t);
  const settings = new HostSettingsStore(path.join(dir, "settings.json"));
  const bots = { has: (id: string) => id.startsWith("b"), summary: (id: string) => ({ profile: { name: id === "b1" ? "Scout" : "Nova" } }) };
  const ctx = { cfg: { hostPrivate: dir, workspace: dir }, hub, trays, bots, settings, now: () => t, flags: () => ({ connectorToolDisable: "disallowedTools" }) } as never;

  // Google, as the host sees it.
  // 4.3b: one account (g1), granted to b1; its health row is google:g1.
  const acct = (state: GoogleStatusView["state"]) => (state === "disconnected" ? [] : [{ id: "g1", email: "me@example.com", state: state === "needs-reconnect" ? "needs-reconnect" as const : "connected" as const, services: ["Gmail" as const], bots: ["b1"] }]);
  let gst: GoogleStatusView = { state: "connected", clientId: "c", email: "me@example.com", services: ["Gmail"], redirectUri: "", error: null, accounts: acct("connected") };
  let refresh: () => Promise<string> = async () => "t";
  let googleOutcome: ((accountId: string, r: { text: string; isError?: boolean }) => void) | null = null;
  const google = {
    status: () => gst, enabledFor: (b: string) => b === "b1",
    grantedAccounts: (b: string) => (b === "b1" ? (gst.accounts ?? []).map((a) => ({ id: a.id, email: a.email })) : []),
    onToolOutcome: (fn: typeof googleOutcome) => { googleOutcome = fn; },
    auth: { refreshExpiresAt: () => null, isConnected: () => gst.state !== "disconnected", accessToken: () => refresh() },
  } as unknown as GoogleServices;

  // Apps through Composio.
  let cx: ComposioStatusView = { keySet: true, disclosureAccepted: true, apps: [cxApp("connected")] };
  let phase: () => Promise<"active" | "failed" | "pending"> = async () => "active";
  const composio = {
    status: () => cx, grantedApps: (b: string) => (b === "b2" ? ["gmail"] : []), accountId: () => "acc_1",
    grantedAccounts: (b: string, tk: string) => (b === "b2" && tk === "gmail" ? [{ id: "acc_1", label: "Gmail" }] : []),
    accountIds: () => [{ id: "acc_1", label: "Gmail" }], onToolOutcome: () => {},
    api: { accountStatus: () => phase() },
  } as unknown as ComposioServices;

  // MCP servers: the real registry and proxy pool, with a connector the test steers.
  let mode: "ok" | "auth" | "fail" = "ok";
  const conn: RemoteConnection = { listTools: async () => [{ name: "search", inputSchema: { type: "object" } }], callTool: async () => ({ content: [] }), close: async () => {} };
  const mcp: McpServices = createMcpServices(ctx, {
    connect: async () => {
      if (mode === "auth") throw new Error("HTTP 401 Unauthorized");
      if (mode === "fail") throw new Error("spawn npx ENOENT");
      return conn;
    },
  });
  const mcpModule = createMcpModule(ctx, mcp);
  const h = createHealthServices(ctx, { google, mcp, composio, file: null });
  const mod = createHealthModule(h, { mcp, warmUpMs: 1 });
  const alerts = () => events.filter((e) => e.channel === "connector-alert");
  const state = (id: string) => h.health.get(id)?.state;
  const advance = (ms: number) => { t += ms; };
  return {
    hub, trays, h, mod, mcp, mcpModule, alerts, state, advance,
    setGoogle: (s: Partial<GoogleStatusView>) => { gst = { ...gst, ...s, accounts: acct(s.state ?? gst.state) }; hub.publish({ channel: "google", payload: gst }); },
    googleCall: (text: string, isError: boolean) => googleOutcome?.("g1", { text, isError }),
    setRefresh: (f: () => Promise<string>) => { refresh = f; },
    setComposio: (s: ComposioStatusView) => { cx = s; hub.publish({ channel: "composio", payload: cx }); },
    setPhase: (f: () => Promise<"active" | "failed" | "pending">) => { phase = f; },
    setMode: (m: typeof mode) => { mode = m; },
  };
}

function cxApp(state: "connected" | "waiting"): ComposioStatusView["apps"][number] {
  return { toolkit: "gmail", name: "Gmail", state, bots: ["b2"], error: null, accounts: [{ id: "acc_1", label: "Gmail", state, bots: ["b2"], error: null }] };
}

describe("every connector's break and recover", () => {
  it("Google: connected → sign-in expired → connected (named for its one service, told only to Bots that use it)", () => {
    const w = world();
    expect(w.state("google:g1")).toBe("ok");
    expect(w.h.health.get("google:g1")!.name).toBe("Gmail");
    w.setGoogle({ state: "needs-reconnect" });
    expect(w.state("google:g1")).toBe("needs-sign-in");
    expect(w.trays.list().find((t) => t.dedupeKey === "health:google:g1")!.title).toBe("Gmail needs you to sign in again");
    expect(w.h.noteFor("b1")).toContain("Gmail needs the user to sign in again.");
    expect(w.h.noteFor("b2")).toBeNull();
    w.setGoogle({ state: "connected" });
    expect(w.state("google:g1")).toBe("ok");
    expect(w.trays.list()).toHaveLength(0);
    w.setGoogle({ state: "disconnected" });
    expect(w.h.health.get("google:g1")).toBeUndefined();
  });

  it("Google: the daily probe (a free token refresh) finds an expired sign-in", async () => {
    const w = world();
    expect(w.h.probes.ids()).toContain("google:g1");
    w.setRefresh(async () => { w.setGoogle({ state: "needs-reconnect" }); throw new GoogleAuthError("needs-reconnect", "expired"); });
    w.advance(24 * 60 * 60_000);
    await w.h.probes.tick();
    expect(w.state("google:g1")).toBe("needs-sign-in");
  });

  it("an MCP remote server: connected → 401 on connect (needs sign-in, Fix = OAuth) → reconnected", async () => {
    const w = world();
    await w.mcpModule.handlers.addMcpServer!({ name: "Linear", url: "https://mcp.linear.app/sse" });
    expect(w.state("mcp:linear")).toBe("ok");
    w.setMode("auth");
    await w.mcp.pool.restart("linear");
    expect(w.h.health.get("mcp:linear")).toMatchObject({ state: "needs-sign-in", fix: { kind: "mcp-auth", serverId: "linear" } });
    expect(w.trays.list().some((t) => t.title === "Linear needs you to sign in again")).toBe(true);
    w.setMode("ok");
    await w.mcp.pool.restart("linear");
    expect(w.state("mcp:linear")).toBe("ok");
    expect(w.trays.list()).toHaveLength(0);
  });

  it("an MCP server whose initialize fails reads Broken (Didn't start), Fix = restart; turning it off removes it", async () => {
    const w = world();
    await w.mcpModule.handlers.addMcpServer!({ name: "Notes", url: "https://notes.example.com/mcp" });
    w.setMode("fail");
    await w.mcp.pool.restart("notes");
    expect(w.h.health.get("mcp:notes")).toMatchObject({ state: "broken", reason: "Didn't start", fix: { kind: "mcp-restart", serverId: "notes" } });
    await w.mcpModule.handlers.setMcpServerEnabled!({ serverId: "notes", enabled: false });
    expect(w.h.health.get("mcp:notes")).toBeUndefined();
  });

  it("an MCP server the CLI runs itself: its init status (connected, failed) and repeated tool failures", async () => {
    const w = world();
    await w.mcpModule.handlers.addMcpServer!({ name: "Files", command: "npx", args: ["files-mcp"] });
    expect(w.state("mcp:files")).toBe("checking"); // nothing has run it yet
    const obs = w.h.observer;
    obs.onEvent!("b1", { kind: "session", sessionId: "s", model: "m", tools: [], cliVersion: "x", mcpServers: [{ name: "files", status: "connected" }] });
    expect(w.state("mcp:files")).toBe("ok");
    obs.onEvent!("b1", { kind: "session", sessionId: "s", model: "m", tools: [], cliVersion: "x", mcpServers: [{ name: "files", status: "failed" }] });
    expect(w.h.health.get("mcp:files")).toMatchObject({ state: "broken", reason: "Didn't start" });
    obs.onEvent!("b1", { kind: "session", sessionId: "s", model: "m", tools: [], cliVersion: "x", mcpServers: [{ name: "files", status: "connected" }] });
    expect(w.state("mcp:files")).toBe("ok");
    for (let i = 0; i < HEALTH_LIMITS.toolFailuresToBreak; i++) obs.onEvent!("b1", { kind: "tool_end", toolUseId: `t${i}`, name: "mcp__files__read", isError: true, output: "EACCES: permission denied" });
    expect(w.h.health.get("mcp:files")).toMatchObject({ state: "broken", reason: "Access denied" });
    obs.onEvent!("b1", { kind: "tool_end", toolUseId: "ok", name: "mcp__files__read", isError: false, output: "hello" });
    expect(w.state("mcp:files")).toBe("ok");
  });

  it("an app through Composio: the free account-status probe finds it expired; signing in again brings it back", async () => {
    const w = world();
    expect(w.state("composio:gmail:acc_1")).toBe("ok");
    w.setPhase(async () => "failed");
    w.advance(HEALTH_LIMITS.probeEveryMs);
    await w.h.probes.tick();
    expect(w.h.health.get("composio:gmail:acc_1")).toMatchObject({ state: "needs-sign-in", fix: { kind: "composio-app", toolkit: "gmail" } });
    expect(w.h.noteFor("b2")).toContain("Gmail needs the user to sign in again.");
    expect(w.h.noteFor("b1")).toBeNull(); // not granted
    w.setPhase(async () => "active");
    w.setComposio({ keySet: true, disclosureAccepted: true, apps: [cxApp("waiting")] });
    w.setComposio({ keySet: true, disclosureAccepted: true, apps: [cxApp("connected")] });
    expect(w.state("composio:gmail:acc_1")).toBe("ok");
    expect(w.h.noteFor("b2")).toContain("Gmail is working again.");
  });

  it("Composio: a probe that can't reach Composio backs off instead of calling it broken; a rejected key needs sign-in", async () => {
    const w = world();
    w.setPhase(async () => { throw new ComposioError("unreachable", "Can't reach Composio"); });
    w.advance(HEALTH_LIMITS.probeEveryMs);
    await w.h.probes.tick();
    expect(w.state("composio:gmail:acc_1")).toBe("ok");
    w.setPhase(async () => { throw new ComposioError("rejected", "Key rejected", 401); });
    w.advance(HEALTH_LIMITS.probeRetryMs);
    await w.h.probes.tick();
    expect(w.state("composio:gmail:acc_1")).toBe("needs-sign-in");
  });

  it("Telegram: what the app's main process reports (a rejected token, then fixed); a network drop waits out its grace", async () => {
    const w = world();
    const report = w.mod.handlers.reportConnectorHealth!;
    await report({ id: "telegram", state: "ok" });
    expect(w.state("telegram")).toBe("ok");
    await report({ id: "telegram", state: "needs-sign-in", reason: "Token rejected" });
    expect(w.trays.list().some((t) => t.title === "Telegram needs you to sign in again")).toBe(true);
    await report({ id: "telegram", state: "ok" });
    expect(w.trays.list()).toHaveLength(0);
    await report({ id: "telegram", state: "broken", reason: "Can't reach it", network: true });
    expect(w.state("telegram")).toBe("checking");
    await report({ id: "telegram", state: null });
    expect(w.h.health.get("telegram")).toBeUndefined();
    await expect(Promise.resolve().then(() => report({ id: "google" as never, state: "ok" }))).rejects.toThrow();
  });

  it("GitHub (per Bot): signed in, then a git push refused for bad credentials, then signed in again", () => {
    const w = world();
    // A Bot that never signed in through Synapse: a refused push isn't a break.
    w.h.observer.onEvent!("b2", { kind: "tool_end", toolUseId: "x", name: "Shell", isError: true, output: "gh: Bad credentials (HTTP 401)" });
    expect(w.h.health.get("github:b2")).toBeUndefined();
    w.hub.publish({ channel: "github", payload: { botId: "b1", state: "signed-in", login: "me" } });
    expect(w.h.health.get("github:b1")).toMatchObject({ state: "ok", name: "GitHub (Scout)" });
    w.h.observer.onEvent!("b1", { kind: "tool_end", toolUseId: "y", name: "Shell", isError: true, output: "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/me/app.git/'" });
    expect(w.state("github:b1")).toBe("needs-sign-in");
    const tray = w.trays.list().find((t) => t.dedupeKey === "health:github:b1")!;
    expect(tray.botId).toBe("b1");
    expect(w.h.noteFor("b1")).toContain("GitHub (Scout) needs the user to sign in again.");
    expect(w.h.noteFor("b2")).toBeNull();
    w.hub.publish({ channel: "github", payload: { botId: "b1", state: "signed-in", login: "me" } });
    expect(w.state("github:b1")).toBe("ok");
    w.hub.publish({ channel: "github", payload: { botId: "b1", state: "signed-out" } });
    expect(w.h.health.get("github:b1")).toBeUndefined();
  });

  it("the Anthropic API key: the key check's answer (a rejected key needs sign-in; the weather is ignored)", () => {
    const w = world();
    const view = (works: boolean | null, kind?: string) => ({ checkedAt: 1, checking: false, works, problem: kind ? { kind, title: "Billing", detail: "", status: 400 } : null, model: null, models: [], longContext: null }) as never;
    w.hub.publish({ channel: "key-check", payload: view(true) });
    expect(w.state("provider:anthropic")).toBe("ok");
    w.hub.publish({ channel: "key-check", payload: view(false, "overloaded") });
    expect(w.state("provider:anthropic")).toBe("ok");
    w.hub.publish({ channel: "key-check", payload: view(false, "invalid-key") });
    expect(w.state("provider:anthropic")).toBe("needs-sign-in");
    w.hub.publish({ channel: "key-check", payload: view(true) });
    expect(w.state("provider:anthropic")).toBe("ok");
    w.hub.publish({ channel: "key-check", payload: view(false, "billing") });
    expect(w.h.health.get("provider:anthropic")).toMatchObject({ state: "broken", reason: "Billing" });
  });

  it("a Google tool call that hits the expired sign-in reads Needs sign-in; a turned-off tool is not a failure", () => {
    const w = world();
    // 4.3b: the Google tool reports each call against the account it used.
    w.googleCall("Google is turned off for this Bot. The user can turn it on in this Bot's settings.", true);
    expect(w.state("google:g1")).toBe("ok");
    w.googleCall("The user's Google sign-in expired. They were shown a notification.", true);
    expect(w.state("google:g1")).toBe("needs-sign-in");
  });

  it("getConnectorHealth lists every connector, in a stable order", async () => {
    const w = world();
    await w.mod.handlers.reportConnectorHealth!({ id: "telegram", state: "ok" });
    const { connectors } = (await w.mod.handlers.getConnectorHealth!({})) as { connectors: { id: string }[] };
    expect(connectors.map((c) => c.id)).toEqual(["google:g1", "composio:gmail:acc_1", "telegram"]);
  });
});
