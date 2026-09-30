import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { STRX } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { createComposioModule, createComposioServices, runComposioToolForFake } from "../../composio/module";
import { fakeComposio } from "../../composio/fake-composio";
import { ComposioStore } from "../../composio/store";
import { SseHub } from "../../gateway/sse-hub";
import { createMcpModule, createMcpServices } from "../../mcp/module";
import type { RemoteConnection } from "../../mcp/proxy";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// 4.3b: two accounts of one app through Composio (two Gmails), and MCP accounts (one server per account), with
// per-Bot grants that match Google's: a new account starts with no Bots, the host resolves the account, never a guess.

const KEY = "ak_test_Zq81xYt4Lm0pRw2vK";
const stops: { stop(): void }[] = [];
afterEach(() => { for (const s of stops.splice(0)) s.stop(); });

function setup(o: { profileEmail?: (id: string) => string | null } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const hub = new SseHub();
  const bots = new BotService({ cfg, hub, settings });
  const a = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const b = bots.create({ origin: "user", kickstart: false, name: "Pilot" });
  const fake = fakeComposio({ activateAfter: 1, ...(o.profileEmail ? { profileEmail: o.profileEmail } : {}) });
  const storeKey = randomBytes(32);
  const make = () => { const c = createComposioServices({ cfg, hub, bots, now: () => 1_000 }, { fetch: fake.fetch, pollMs: 60_000, storeKey }); stops.push(c); return c; };
  const c = make();
  return { cfg, settings, hub, bots, a, b, fake, c, make, storeKey };
}

async function twoGmails(o: Parameters<typeof setup>[0] = {}) {
  const s = setup(o);
  await s.c.setKey(KEY);
  s.c.acceptDisclosure();
  await s.c.connect("gmail");
  await s.c.poll("gmail");
  await s.c.connect("gmail");
  await s.c.poll("gmail");
  const [first, second] = s.c.status().apps.find((x) => x.toolkit === "gmail")!.accounts;
  return { ...s, first: first!, second: second! };
}
const executes = (s: { fake: ReturnType<typeof fakeComposio> }, slug: string) => s.fake.requests.filter((r) => r.path === `/tools/execute/${slug}`).map((r) => r.body as { connected_account_id: string; arguments: Record<string, unknown> });

describe("4.3b: more than one account of an app through Composio", () => {
  it("a second connect adds an account (the first stays), labelled, starting with no Bots", async () => {
    const s = await twoGmails();
    const gmail = s.c.status().apps.find((x) => x.toolkit === "gmail")!;
    expect(gmail.state).toBe("connected");
    expect(gmail.accounts.map((x) => [x.label, x.state, x.bots])).toEqual([["Gmail", "connected", []], ["Gmail 2", "connected", []]]);
    expect(s.first.id).not.toBe(s.second.id);
  });

  it("grants per account are enforced in the host: an ungranted account is refused even by name", async () => {
    const s = await twoGmails();
    s.c.setGrant("gmail", s.a, true, s.first.id);
    expect(s.c.grantedAccounts(s.a, "gmail").map((x) => x.id)).toEqual([s.first.id]);
    expect(await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_SEND_EMAIL", { query: "x", account: "Gmail 2" })).toBe(STRX.toolAccountNotGranted("Gmail", "Gmail 2", ["Gmail"]));
    expect(executes(s, "GMAIL_SEND_EMAIL")).toHaveLength(0);
    // The one granted account is implied, and `account` never reaches Composio.
    expect(await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_SEND_EMAIL", { query: "x" })).toContain("\"ok\":true");
    expect(executes(s, "GMAIL_SEND_EMAIL")).toEqual([expect.objectContaining({ connected_account_id: s.first.id, arguments: { query: "x" } })]);
    // Pilot has nothing at all.
    expect(await runComposioToolForFake(s.c, s.b, "mcp__composio_apps__GMAIL_SEND_EMAIL", { account: "Gmail" })).toBe(STRX.toolNotGranted("Gmail"));
  });

  it("two granted and none named: an error asking the Bot to choose; named, each call uses its own account", async () => {
    const s = await twoGmails();
    s.c.setGrant("gmail", s.a, true); // no account: every connected account of the app
    expect(await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_SEND_EMAIL", { query: "x" })).toBe(STRX.toolChooseAccount("Gmail", ["Gmail", "Gmail 2"]));
    await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_SEND_EMAIL", { query: "x", account: "gmail 2" });
    await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_SEND_EMAIL", { query: "y", account: s.first.id });
    expect(executes(s, "GMAIL_SEND_EMAIL").map((x) => x.connected_account_id)).toEqual([s.second.id, s.first.id]);
    const mod = createComposioModule({} as never, s.c);
    expect(mod.systemAppendExtra!(s.a)).toContain("You can use 2 Gmail accounts: Gmail, Gmail 2.");
    const tools = await s.c.listTools(s.a);
    expect((tools[0]!.inputSchema as { properties: Record<string, unknown> }).properties.account).toMatchObject({ type: "string" });
  });

  it("a Gmail account is labelled by its address; the owner can rename any account", async () => {
    const s = await twoGmails({ profileEmail: (id) => `inbox-${id}@acme.example` });
    const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };
    await until(() => s.c.status().apps.find((x) => x.toolkit === "gmail")!.accounts.every((x) => x.label.includes("@")));
    const labels = s.c.status().apps.find((x) => x.toolkit === "gmail")!.accounts.map((x) => x.label);
    expect(labels).toEqual([`inbox-${s.first.id}@acme.example`, `inbox-${s.second.id}@acme.example`]);
    s.c.rename("gmail", s.second.id, "Work");
    s.c.setGrant("gmail", s.a, true);
    expect(s.c.resolveAccount(s.a, "gmail", "work")).toEqual({ id: s.second.id, label: "Work" });
    expect(() => s.c.rename("gmail", s.first.id, "work")).toThrow(/already has that name/);
  });

  it("removing one account revokes its grants; the other keeps working", async () => {
    const s = await twoGmails();
    s.c.setGrant("gmail", s.a, true);
    await s.c.disconnect("gmail", s.second.id);
    expect(s.fake.requests.some((r) => r.method === "DELETE" && r.path === `/connected_accounts/${s.second.id}`)).toBe(true);
    const gmail = s.c.status().apps.find((x) => x.toolkit === "gmail")!;
    expect(gmail.accounts.map((x) => x.id)).toEqual([s.first.id]);
    expect(s.c.grantedAccounts(s.a, "gmail").map((x) => x.id)).toEqual([s.first.id]);
    expect(await runComposioToolForFake(s.c, s.a, "mcp__composio_apps__GMAIL_SEND_EMAIL", { query: "x" })).toContain("\"ok\":true");
  });

  it("an app connected before 4.3b becomes its first account, with its Bots, silently", async () => {
    const s = setup();
    new ComposioStore(path.join(s.cfg.hostPrivate, "composio", "account.json"), s.storeKey).write({
      apiKey: KEY, userId: "synapse-x", disclosureAccepted: true,
      apps: { slack: { accountId: "ca_old", authConfigId: "ac_1", state: "connected", since: 1 } }, grants: { slack: [s.a] },
    });
    const c = s.make();
    expect(c.status().apps.find((x) => x.toolkit === "slack")!.accounts).toEqual([{ id: "ca_old", label: "Slack", state: "connected", bots: [s.a], error: null }]);
    expect(c.grantedApps(s.a)).toEqual(["slack"]);
  });

  it("the Fix flow's reconnect takes over the account it replaces: its Bots and its name", async () => {
    const s = await twoGmails();
    s.c.setGrant("gmail", s.a, true, s.second.id);
    s.c.rename("gmail", s.second.id, "Work");
    await s.c.connect("gmail", { replace: s.second.id });
    await s.c.poll("gmail");
    const accounts = s.c.status().apps.find((x) => x.toolkit === "gmail")!.accounts;
    expect(accounts.map((x) => x.label)).toEqual(["Gmail", "Work"]);
    expect(accounts[1]!.id).not.toBe(s.second.id);
    expect(accounts[1]!.bots).toEqual([s.a]);
  });
});

describe("4.3b: MCP accounts (one server per account) get per-Bot grants too", () => {
  it("a second server of the same app starts with no Bots; grants decide the spawn set and are re-checked at call time", async () => {
    const s = setup();
    const conn: RemoteConnection = { listTools: async () => [{ name: "search", inputSchema: { type: "object" } }], callTool: async () => ({ content: [{ type: "text", text: "ok" }] }), close: async () => {} };
    const ctx = { cfg: s.cfg, hub: s.hub, trays: { list: () => [], add: () => ({}), dismiss: () => {} }, bots: s.bots, settings: s.settings, now: () => 1, flags: () => ({ connectorToolDisable: "disallowedTools" }) } as never;
    const mcp = createMcpServices(ctx, { connect: async () => conn });
    const mod = createMcpModule(ctx, mcp);
    await mod.handlers.addMcpServer!({ name: "Linear", url: "https://mcp.linear.app/sse" });
    await mod.handlers.addMcpServer!({ name: "Linear", label: "work", url: "https://mcp.linear.app/sse" } as never);
    const [first, second] = mcp.registry.list();
    expect(first!.bots).toBeUndefined(); // the first account keeps "every Bot"
    expect(second!.bots).toEqual([]);
    expect(Object.keys(mod.mcpServers!(s.a))).toEqual([first!.id]);
    await mod.handlers.setMcpServerBots!({ serverId: second!.id, botId: s.a, enabled: true });
    expect(Object.keys(mod.mcpServers!(s.a)).sort()).toEqual([first!.id, second!.id].sort());
    expect(Object.keys(mod.mcpServers!(s.b))).toEqual([first!.id]);
    // Turning the first account off for one Bot pins "every Bot" to a list without that Bot.
    await mod.handlers.setMcpServerBots!({ serverId: first!.id, botId: s.b, enabled: false });
    expect(mcp.registry.get(first!.id)!.bots).toEqual([s.a]);
    expect(mod.mcpServers!(s.b)).toEqual({});
    await mcp.pool.closeAll();
  });
});
