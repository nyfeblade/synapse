import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { googleToolsMounted } from "@synapse/shared";
import type { ApprovalCardView, BotSummary, CatalogEntry, GoogleStatusView, MarketplaceView, TranscriptEntry, Tray } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { tmpConfig } from "../helpers";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
// Final secfix item 8: the fake Google only runs with FUZZ=1.
const fuzz0 = process.env.FUZZ;
beforeAll(() => { process.env.FUZZ = "1"; });
afterAll(() => { if (fuzz0 === undefined) delete process.env.FUZZ; else process.env.FUZZ = fuzz0; });
const until = async (f: () => Promise<boolean> | boolean, ms = 8000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

async function start() {
  const cfg = tmpConfig();
  app = await createHostApp(cfg);
  const { port } = await app.listen();
  const api = async <T>(cmd: string, args: unknown = {}): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
    return j.result as T;
  };
  const tail = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
  const texts = async (id: string) => (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
  const fake = () => app!.services.phase5.google.fake!;
  const connect = async () => {
    await api("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret" });
    const { authorizationUrl } = await api<{ authorizationUrl: string }>("startGoogleAuth");
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    // The loopback forwards every callback to completeMcpOAuth; a Google state is routed to the Google sign-in.
    return api<{ serverId: string; status: string }>("completeMcpOAuth", { state, code: "fuzz" });
  };
  return { cfg, api, tail, texts, fake, connect };
}

describe("built-in Google connector (gateway level, FUZZ fake Google)", () => {
  it("connects through the existing loopback dispatcher and reports the account, never the secret", async () => {
    const s = await start();
    expect(await s.api<GoogleStatusView>("getGoogleStatus")).toMatchObject({ state: "not-configured", email: null });
    const set = await s.api<GoogleStatusView>("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret" });
    expect(set).toMatchObject({ state: "disconnected", clientId: "123-abc.apps.googleusercontent.com" });
    expect(JSON.stringify(set)).not.toContain("GOCSPX");
    const { authorizationUrl } = await s.api<{ authorizationUrl: string }>("startGoogleAuth");
    expect(authorizationUrl).toMatch(/^https:\/\/example\.com\/authorize\?/);
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    expect(await s.api("completeMcpOAuth", { state, code: "fuzz" })).toEqual({ serverId: "google", status: "connected" });
    const st = await s.api<GoogleStatusView>("getGoogleStatus");
    expect(st).toMatchObject({ state: "connected", email: "me@example.com", services: ["Gmail", "Calendar", "Drive"] });
    expect(JSON.stringify(st)).not.toMatch(/fake-(at|rt)|GOCSPX/);
    // An unknown state still goes to the MCP dispatcher (and expires there).
    await expect(s.api("completeMcpOAuth", { state: "nope", code: "x" })).rejects.toThrow(/OAUTH_EXPIRED/);
  });

  it("Marketplace Gmail, Calendar and Drive are the built-in connector now", async () => {
    const s = await start();
    const view = await s.api<MarketplaceView>("getMarketplace");
    const all = [...view.featuredPlugins, ...view.categories.flatMap((c) => c.entries)];
    const gmail = all.find((e) => e.id === "curated:gmail")!;
    expect(gmail).toMatchObject({ source: "google", action: "connect", state: "available" });
    await s.connect();
    const { entries } = await s.api<{ entries: CatalogEntry[] }>("listPlugins");
    for (const id of ["curated:gmail", "curated:google-calendar", "curated:google-drive"]) expect(entries.find((e) => e.id === id)).toMatchObject({ source: "google", state: "connected" });
    expect(await s.api("installPlugin", { id: "curated:gmail" })).toMatchObject({ openUrl: null, needsAuth: false, serverIds: [] });
  });

  it("per-Bot: tools only for Bots with Google on (default off) and only while connected", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    const p5 = app!.services.phase5;
    await s.connect();
    expect(p5.mcpServers(id).google).toBeUndefined();
    const { agent } = await s.api<{ agent: BotSummary }>("setAgentGoogle", { id, enabled: true });
    expect(agent.settings.google).toBe(true);
    expect(p5.mcpServers(id).google).toBeTruthy();
    expect(p5.systemAppendExtra(id)).toContain("me@example.com");
    await s.api("disconnectGoogle");
    expect(p5.mcpServers(id).google).toBeUndefined();
    expect(s.fake().state.revoked.length).toBe(1);
  });

  it("journey: a Bot reads mail (fenced), sending raises a card even with Auto-review off, Allow once sends", async () => {
    const s = await start();
    await s.api("setHostSettings", { autoReviewEnabled: false });
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    await s.connect();
    await s.api("sendPrompt", { id, text: "gmail: deck", clientNonce: "n0" });
    await until(async () => (await s.texts(id)).some((t) => /Google isn't turned on|turned off for this Bot|No such tool/i.test(t)));
    await s.api("setAgentGoogle", { id, enabled: true });
    const ends: { name: string; output: string }[] = [];
    app!.services.phase5.modules.push({ name: "spy", handlers: {}, observers: [{ onEvent: (_b, e) => { if (e.kind === "tool_end") ends.push({ name: e.name, output: e.output }); } }] });
    await s.api("sendPrompt", { id, text: "gmail: deck", clientNonce: "n1" });
    await until(async () => (await s.texts(id)).some((t) => t.includes("Q3 deck")));
    // What the model sees is fenced as untrusted data, like any other outside tool output.
    expect(ends.find((e) => e.name === "mcp__google__gmail_search")!.output).toMatch(/^<untrusted_data source="mcp__google__gmail_search">\n[\s\S]*Q3 deck[\s\S]*<\/untrusted_data>$/);
    await s.api("sendPrompt", { id, text: "mail: dana@example.org | Deck | Looks good.", clientNonce: "n2" });
    let card: ApprovalCardView | null = null;
    await until(async () => {
      const e = (await s.tail(id)).find((x) => x.kind === "send-message" && x.message.type === "auto-review-approval" && x.message.approval.status === "pending");
      card = e && e.kind === "send-message" && e.message.type === "auto-review-approval" ? e.message.approval : null;
      return !!card;
    });
    expect(card!.summary).toBe("Send an email from your Gmail to dana@example.org: “Deck”");
    expect(s.fake().state.sent).toHaveLength(0);
    await s.api("resolveAutoReviewApproval", { id, approvalId: card!.approvalId, choice: "once" });
    await until(() => s.fake().state.sent.length === 1);
    await until(async () => (await s.texts(id)).some((t) => /Sent \(message id/.test(t)));
  });

  it("an expired sign-in posts one Reconnect Google notification and tools fail clearly", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    await s.connect();
    await s.api("setAgentGoogle", { id, enabled: true });
    s.fake().state.refreshInvalid = true;
    s.fake().state.accessTokens.clear(); // the access token is dead too, so the next call must refresh
    await s.api("sendPrompt", { id, text: "gmail: deck", clientNonce: "n1" });
    await until(async () => (await s.texts(id)).some((t) => t.includes("sign-in expired")));
    const { trays } = await s.api<{ trays: Tray[] }>("getTrays");
    const t = trays.filter((x) => x.dedupeKey === "google-reconnect");
    expect(t).toHaveLength(1);
    expect(t[0]!.buttons).toEqual([{ label: "Reconnect Google", action: "reconnect-google" }, { label: "Let a Bot click through", action: "reconnect-google-bot" }]);
    expect((await s.api<GoogleStatusView>("getGoogleStatus")).state).toBe("needs-reconnect");
    s.fake().state.refreshInvalid = false;
    await s.connect();
    expect((await s.api<{ trays: Tray[] }>("getTrays")).trays.filter((x) => x.dedupeKey === "google-reconnect")).toHaveLength(0);
  });

  it("deleting a Bot leaves the app-level account alone; a Bot-made duplicate starts with Google off", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    await s.connect();
    await s.api("setAgentGoogle", { id, enabled: true });
    const copy = app!.services.bots.duplicate(id, "bot");
    expect(app!.services.bots.summary(copy).settings.google).toBeFalsy();
    await s.api("deleteAgent", { id });
    expect((await s.api<GoogleStatusView>("getGoogleStatus")).state).toBe("connected");
    expect(s.fake().state.revoked).toHaveLength(0);
  });
});

describe("final secfix 8: the fake Google needs FUZZ=1", () => {
  it("a fake-brain host without FUZZ=1 starts no fake Google and refuses setGoogleClient", async () => {
    delete process.env.FUZZ;
    try {
      const s = await start();
      expect(app!.services.phase5.google.fake).toBeNull();
      await expect(s.api("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-real-secret" })).rejects.toThrow("Google can't be connected on a test host.");
      expect((await s.api<GoogleStatusView>("getGoogleStatus")).state).toBe("not-configured");
    } finally { process.env.FUZZ = "1"; }
  });

  it("with FUZZ=1 the fake Google runs and a client can be set", async () => {
    const s = await start();
    expect(app!.services.phase5.google.fake).not.toBeNull();
    expect(await s.api<GoogleStatusView>("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret" })).toMatchObject({ state: "disconnected" });
  });
});

// The reported failure: the user connected Gmail, the connector reported "connected", and the Bot never gained
// callable Google tools — because Google was never turned on for that Bot, and nothing the Bot could see said so.
describe("connected account, Google off for this Bot (per-Bot legibility)", () => {
  it("botStatus separates the account state from this Bot's state, and the system prompt says so", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    const p5 = app!.services.phase5;
    expect(p5.google.botStatus(id)).toMatchObject({ state: "not-configured", enabled: false, account: "not-configured" });
    await s.connect();
    expect(p5.google.botStatus(id)).toMatchObject({ state: "off-for-bot", enabled: false, account: "connected", email: "me@example.com" });
    const off = p5.systemAppendExtra(id);
    expect(off).toContain("turned off for this Bot");
    expect(off).toContain("me@example.com");
    await s.api("setAgentGoogle", { id, enabled: true });
    expect(p5.google.botStatus(id)).toMatchObject({ state: "ready", enabled: true, account: "connected" });
  });

  it("turning Google on wakes the Bot, so the respawn that loads the tools happens without the user messaging again", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    await s.connect();
    const settled: string[] = [];
    app!.services.phase5.modules.push({ name: "spy-enable", handlers: {}, observers: [{ onSettled: (t) => settled.push(t.source) }] });
    expect(app!.services.phase5.mcpServers(id).google).toBeUndefined();
    await s.api("setAgentGoogle", { id, enabled: true });
    await until(() => settled.includes("mcp-auth"));
    expect(app!.services.phase5.mcpServers(id).google).toBeTruthy();
  });

  it("connecting the account wakes the Bots that already have Google on, and turning it off wakes nobody", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    const settled: string[] = [];
    app!.services.phase5.modules.push({ name: "spy-connect", handlers: {}, observers: [{ onSettled: (t) => settled.push(t.source) }] });
    await s.api("setAgentGoogle", { id, enabled: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).not.toContain("mcp-auth"); // nothing to gain: the account isn't connected yet
    await s.connect();
    await until(() => settled.includes("mcp-auth"));
    const n = settled.filter((x) => x === "mcp-auth").length;
    await s.api("setAgentGoogle", { id, enabled: false });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled.filter((x) => x === "mcp-auth")).toHaveLength(n);
  });
});

// Two readers of connector state used to disagree: the Marketplace catalog read the Google account store and said
// "connected", while GetMcpServerStatus read the MCP registry (which never holds the built-in Google connector)
// and said "No connectors are installed." Bind the Bot-facing status to the same predicate that builds the spawn set.
describe("the Bot-facing Google status and the spawn set cannot disagree", () => {
  it("botStatus(id).state === 'ready' exactly when mcpServers(id).google is mounted", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    const p5 = app!.services.phase5;
    const agree = () => expect(googleToolsMounted(p5.google.botStatus(id))).toBe(!!p5.mcpServers(id).google);
    agree(); // not configured
    await s.api("setAgentGoogle", { id, enabled: true });
    agree(); // on for the Bot, no account
    await s.connect();
    agree(); // on and connected
    expect(p5.google.botStatus(id).state).toBe("ready");
    await s.api("setAgentGoogle", { id, enabled: false });
    agree(); // connected account, off for the Bot
    expect(p5.google.botStatus(id).state).toBe("off-for-bot");
    await s.api("disconnectGoogle");
    agree();
  });
});
