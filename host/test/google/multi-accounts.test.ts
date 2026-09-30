import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ApprovalCardView, ConnectorHealthView, GoogleStatusView, SendMessageEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { fakeConsent } from "../../google/fake-google";
import { runGoogleToolForFake } from "../../google/module";
import { tmpConfig } from "../helpers";

// 4.3b: more than one Google account. Per-Bot grants enforced in the host, never a guessed account, cards that name
// the account, every connected address counts as the owner themself, removal revokes, and health per account.

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
const fuzz0 = process.env.FUZZ;
beforeAll(() => { process.env.FUZZ = "1"; });
afterAll(() => { if (fuzz0 === undefined) delete process.env.FUZZ; else process.env.FUZZ = fuzz0; });

const PERSONAL = "me@example.com";
const WORK = "work@acme.example";

async function start() {
  app = await createHostApp(tmpConfig());
  const { port } = await app.listen();
  const api = async <T>(cmd: string, args: unknown = {}): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
    return j.result as T;
  };
  const p5 = app.services.phase5;
  const fake = () => p5.google.fake!;
  /** Signs in as `email` through the real loopback route (the fake's consent page issues that address's tokens). */
  const signIn = async (email: string) => {
    const { authorizationUrl } = await api<{ authorizationUrl: string }>("startGoogleAuth");
    const { code, state } = fakeConsent(fake(), authorizationUrl, `code-${email}`, email);
    return api("completeMcpOAuth", { state, code });
  };
  const status = () => api<GoogleStatusView>("getGoogleStatus");
  const accountId = async (email: string) => (await status()).accounts!.find((a) => a.email === email)!.id;
  const bot = async (name: string) => (await api<{ id: string }>("createAgent", { name, isKickstartRequested: false })).id;
  const tool = (botId: string, name: string, input: Record<string, unknown>) => runGoogleToolForFake(p5.google, botId, `mcp__google__${name}`, input);
  await api("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret" });
  return { api, p5, fake, signIn, status, accountId, bot, tool };
}

describe("two Google accounts", () => {
  it("connects both, each with its own tokens and its address as the label; the new one starts with no Bots", async () => {
    const s = await start();
    const scout = await s.bot("Scout");
    await s.api("setAgentGoogle", { id: scout, enabled: true });
    await s.signIn(PERSONAL);
    await s.signIn(WORK);
    const st = await s.status();
    expect(st.state).toBe("connected");
    expect(st.accounts!.map((a) => [a.email, a.state, a.bots])).toEqual([[PERSONAL, "connected", [scout]], [WORK, "connected", []]]);
    // Separate tokens: every issued token signs in as exactly one of the two addresses.
    expect(new Set(s.fake().state.tokenEmail.values())).toEqual(new Set([PERSONAL, WORK]));
    expect(JSON.stringify(st)).not.toMatch(/fake-(at|rt)|GOCSPX/);
    // Signing in as an address already here is a reconnect of that account, not a third one.
    await s.signIn(WORK);
    expect((await s.status()).accounts!.map((a) => a.email)).toEqual([PERSONAL, WORK]);
  });

  it("grants are enforced in the host: a Bot can't use an account it wasn't granted, even by name", async () => {
    const s = await start();
    const scout = await s.bot("Scout");
    const other = await s.bot("Other");
    await s.api("setAgentGoogle", { id: scout, enabled: true });
    await s.signIn(PERSONAL);
    await s.signIn(WORK);
    // Scout has only the personal account: implied, and the work account is refused by the tool itself.
    expect(await s.tool(scout, "gmail_search", { query: "deck" })).toContain("Q3 deck");
    const refused = await s.tool(scout, "gmail_send", { to: "dana@example.org", subject: "Hi", body: "x", account: WORK });
    expect(refused).toMatch(/can't use the Google account “work@acme\.example”/);
    expect(refused).toContain(PERSONAL);
    expect(s.fake().state.sent).toHaveLength(0);
    // A Bot with Google on but no account ticked has no tools at all, and its prompt says why.
    await s.api("setAgentGoogle", { id: other, enabled: true });
    expect(s.p5.mcpServers(other).google).toBeUndefined();
    expect(s.p5.google.botStatus(other)).toMatchObject({ state: "off-for-bot", enabled: true });
    expect(s.p5.systemAppendExtra(other)).toContain("none of the user's Google accounts is ticked");
    // The gate refuses it too, before any card.
    const d = await app!.services.gate.preToolUse(scout, { toolName: "mcp__google__gmail_send", input: { to: "dana@example.org", subject: "Hi", body: "x", account: WORK }, toolUseId: "tu-ungranted" });
    expect(d).toMatchObject({ decision: "deny" });
    expect((d as { reason?: string }).reason ?? JSON.stringify(d)).toMatch(/can't use the Google account/);
  });

  it("with two granted accounts and none named, the call errors and asks the Bot to choose; it never guesses", async () => {
    const s = await start();
    const scout = await s.bot("Scout");
    await s.api("setAgentGoogle", { id: scout, enabled: true });
    await s.signIn(PERSONAL);
    await s.signIn(WORK);
    await s.api("setAgentGoogleAccount", { id: scout, accountId: await s.accountId(WORK), enabled: true });
    const out = await s.tool(scout, "gmail_search", { query: "deck" });
    expect(out).toMatch(/more than one Google account \(me@example\.com, work@acme\.example\)/);
    expect(out).toContain("Don't guess");
    expect(s.p5.systemAppendExtra(scout)).toContain(`You can use 2 of the user's Google accounts: ${PERSONAL}, ${WORK}`);
    expect(s.p5.google.botStatus(scout)).toMatchObject({ state: "ready", accounts: [PERSONAL, WORK] });
    // Named, each send goes out from exactly that account.
    expect(await s.tool(scout, "gmail_send", { to: "dana@example.org", subject: "A", body: "a", account: WORK, draft_hash: undefined })).toMatch(/^Sent/);
    expect(await s.tool(scout, "gmail_send", { to: "dana@example.org", subject: "B", body: "b", account: "ME@EXAMPLE.COM" })).toMatch(/^Sent/);
    expect(s.fake().state.sent.map((m) => m.account)).toEqual([WORK, PERSONAL]);
    // The gate: no account with two granted is a deny with the same "choose" message, before any card.
    const d = await app!.services.gate.preToolUse(scout, { toolName: "mcp__google__gmail_send", input: { to: "dana@example.org", subject: "Hi", body: "x" }, toolUseId: "tu-ambiguous" });
    expect(JSON.stringify(d)).toMatch(/more than one Google account/);
  });

  it("the card names the account (From work@…), and the approved call is pinned to it", async () => {
    const s = await start();
    const scout = await s.bot("Scout");
    await s.api("setAgentGoogle", { id: scout, enabled: true });
    await s.signIn(PERSONAL);
    await s.signIn(WORK);
    await s.api("setAgentGoogleAccount", { id: scout, accountId: await s.accountId(WORK), enabled: true });
    const gate = app!.services.gate;
    const call = { toolName: "mcp__google__gmail_send", input: { to: "dana@example.org", subject: "Deck", body: "Looks good.", account: "Work@Acme.example" }, toolUseId: "tu-card" };
    expect((await gate.preToolUse(scout, call)).decision).toBe("ask");
    const perm = gate.canUseTool(scout, call, new AbortController().signal);
    const card = app!.services.bots.tail(scout, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").map((e) => (e.message as { approval: ApprovalCardView }).approval).at(-1)!;
    expect(card.locationLine).toBe(`From ${WORK}`);
    gate.resolve(scout, card.approvalId, "once");
    const r = await perm;
    expect(r).toMatchObject({ behavior: "allow", updatedInput: { account: WORK } });
  });

  it("removing an account revokes its tokens and its grants; the other account keeps working", async () => {
    const s = await start();
    const scout = await s.bot("Scout");
    await s.api("setAgentGoogle", { id: scout, enabled: true });
    await s.signIn(PERSONAL);
    await s.signIn(WORK);
    const work = await s.accountId(WORK);
    await s.api("setAgentGoogleAccount", { id: scout, accountId: work, enabled: true });
    const revokedBefore = s.fake().state.revoked.length;
    const st = await s.api<GoogleStatusView>("disconnectGoogle", { accountId: work });
    expect(st.accounts!.map((a) => a.email)).toEqual([PERSONAL]);
    expect(s.fake().state.revoked.length).toBe(revokedBefore + 1);
    expect(s.p5.google.auth.grants()[work]).toBeUndefined();
    expect(await s.tool(scout, "gmail_send", { to: "dana@example.org", subject: "x", body: "x", account: WORK })).toMatch(/can't use the Google account/);
    expect(await s.tool(scout, "gmail_search", { query: "deck" })).toContain("Q3 deck"); // the one left is implied again
    // Signing the work account in again: a new account, granted to nobody.
    await s.signIn(WORK);
    expect((await s.status()).accounts!.find((a) => a.email === WORK)!.bots).toEqual([]);
  });

  it("connector health: one row per account, and one account's expired sign-in never marks the other", async () => {
    const s = await start();
    const scout = await s.bot("Scout");
    await s.api("setAgentGoogle", { id: scout, enabled: true });
    await s.signIn(PERSONAL);
    await s.signIn(WORK);
    await s.api("setAgentGoogleAccount", { id: scout, accountId: await s.accountId(WORK), enabled: true });
    const health = async () => (await s.api<{ connectors: ConnectorHealthView[] }>("getConnectorHealth")).connectors.filter((c) => c.kind === "google");
    const personal = await s.accountId(PERSONAL);
    const work = await s.accountId(WORK);
    expect((await health()).map((c) => [c.id, c.name, c.state])).toEqual([[`google:${personal}`, `Google (${PERSONAL})`, "ok"], [`google:${work}`, `Google (${WORK})`, "ok"]]);
    s.fake().state.refreshInvalidFor.add(WORK);
    s.fake().state.accessTokens.clear();
    expect(await s.tool(scout, "gmail_search", { query: "deck", account: WORK })).toMatch(/sign-in expired/);
    expect(await s.tool(scout, "gmail_search", { query: "deck", account: PERSONAL })).toMatch(/Q3 deck/); // refreshed fine
    const rows = await health();
    expect(rows.find((c) => c.id === `google:${work}`)).toMatchObject({ state: "needs-sign-in", fix: { kind: "google", accountId: work } });
    expect(rows.find((c) => c.id === `google:${personal}`)!.state).toBe("ok");
    expect((await s.status()).accounts!.map((a) => a.state)).toEqual(["connected", "needs-reconnect"]);
  });

  it("an account from before 4.3b stays granted where Google was on, with no prompt", async () => {
    const s = await start();
    const on = await s.bot("On");
    const off = await s.bot("Off");
    await s.api("setAgentGoogle", { id: on, enabled: true });
    await s.signIn(PERSONAL);
    // The first account keeps the old one-account promise; turning a Bot on with one account ticks it.
    expect((await s.status()).accounts![0]!.bots).toEqual([on]);
    await s.api("setAgentGoogle", { id: off, enabled: true });
    expect((await s.status()).accounts![0]!.bots.sort()).toEqual([on, off].sort());
  });
});

describe("Composio accounts through the whole host", () => {
  it("the card names the Composio account, and an unnamed choice among two is refused before any card", async () => {
    const s = await start();
    const scout = await s.bot("Scout");
    await s.api("setComposioKey", { key: "ak_test_Zq81xYt4Lm0pRw2vK" });
    await s.api("acceptComposioDisclosure");
    const cx = s.p5.composio;
    await cx.connect("gmail"); await cx.poll("gmail"); await cx.poll("gmail");
    await cx.connect("gmail"); await cx.poll("gmail"); await cx.poll("gmail");
    const accts = cx.status().apps.find((a) => a.toolkit === "gmail")!.accounts;
    expect(accts.map((a) => a.state)).toEqual(["connected", "connected"]);
    await s.api("setComposioGrant", { toolkit: "gmail", botId: scout, enabled: true });
    const gate = app!.services.gate;
    const refused = await gate.preToolUse(scout, { toolName: "mcp__composio_apps__GMAIL_SEND_EMAIL", input: { recipient_email: "dana@example.org", subject: "Hi", body: "x" }, toolUseId: "cx-1" });
    expect(JSON.stringify(refused)).toMatch(/more than one Gmail account/);
    const call = { toolName: "mcp__composio_apps__GMAIL_SEND_EMAIL", input: { recipient_email: "dana@example.org", subject: "Hi", body: "x", account: "Gmail 2" }, toolUseId: "cx-2" };
    expect((await gate.preToolUse(scout, call)).decision).toBe("ask");
    const perm = gate.canUseTool(scout, call, new AbortController().signal);
    const card = app!.services.bots.tail(scout, 50).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval").map((e) => (e.message as { approval: ApprovalCardView }).approval).at(-1)!;
    expect(card.locationLine).toBe("From Gmail 2 through Composio");
    gate.resolve(scout, card.approvalId, "once");
    expect(await perm).toMatchObject({ behavior: "allow", updatedInput: { account: "Gmail 2" } });
  });
});

describe("duplicating a Bot", () => {
  it("a copy the user makes gets the same Google, Composio and MCP account grants; a Bot-made copy gets none", async () => {
    const s = await start();
    const scout = await s.bot("Scout");
    await s.api("setAgentGoogle", { id: scout, enabled: true });
    await s.signIn(PERSONAL);
    await s.signIn(WORK);
    await s.api("setAgentGoogleAccount", { id: scout, accountId: await s.accountId(WORK), enabled: true });
    await s.api("setAgentGoogleAccount", { id: scout, accountId: await s.accountId(PERSONAL), enabled: false });
    await s.api("setComposioKey", { key: "ak_test_Zq81xYt4Lm0pRw2vK" });
    await s.api("acceptComposioDisclosure");
    const cx = s.p5.composio;
    await cx.connect("slack"); await cx.poll("slack"); await cx.poll("slack");
    await s.api("setComposioGrant", { toolkit: "slack", botId: scout, enabled: true });
    await s.api("addMcpServer", { name: "Linear", url: "https://mcp.linear.app/sse" });
    await s.api("addMcpServer", { name: "Linear", label: "work", url: "https://mcp.linear.app/sse" });
    const servers = async () => (await s.api<{ servers: { id: string; label: string | null; bots?: string[] | null }[] }>("listMcpServers")).servers;
    const second = (await servers()).find((x) => x.label === "work")!;
    await s.api("setMcpServerBots", { serverId: second.id, botId: scout, enabled: true });

    const { id: copy } = await s.api<{ id: string }>("duplicateAgent", { id: scout });
    expect(s.p5.google.grantedAccounts(copy).map((a) => a.email)).toEqual([WORK]);
    expect(cx.grantedApps(copy)).toEqual(["slack"]);
    expect((await servers()).find((x) => x.id === second.id)!.bots).toContain(copy);
    expect(s.p5.google.botStatus(copy).state).toBe("ready");

    const botCopy = app!.services.bots.duplicate(scout, "bot");
    expect(s.p5.google.grantedAccounts(botCopy)).toEqual([]);
    expect(cx.grantedApps(botCopy)).toEqual([]);
  });
});
