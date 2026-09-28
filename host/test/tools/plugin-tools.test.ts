import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { GoogleBotStatusView } from "@synapse/shared";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import type { BrainWiring } from "../../brain/types";
import { Catalog } from "../../marketplace/catalog";
import { CatalogIndex } from "../../marketplace/catalog-index";
import { createConnectorToolsModule } from "../../marketplace/connectors-module";
import { createMcpServices } from "../../mcp/module";
import { HostSettingsStore } from "../../store/host-settings";
import { createPluginTools } from "../../tools/plugin-tools";

let tools: ReturnType<typeof createPluginTools>;
let build: () => ReturnType<typeof createPluginTools>;
let appended: unknown[];
let catalog: Catalog;
let mcp: ReturnType<typeof createMcpServices>;
const slot = { turnNo: 3, nextSendK: 0, requestId: "req_1", segment: 0 } as never;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptools-"));
  appended = [];
  Object.assign(slot, { nextSendK: 0, segment: 0 });
  const ctx = { cfg: { hostPrivate: dir, workspace: dir }, hub: { publish: () => {} }, settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1, flags: () => ({}) } as never;
  mcp = createMcpServices(ctx, { connect: async () => { throw new Error("401"); } });
  catalog = new Catalog({ curated: [{ id: "curated:linear", name: "Linear", description: "Issues and projects", category: "Code", via: "remote", url: "https://mcp.linear.app/mcp" }], mcp, plugins: () => null, templates: () => null, index: new CatalogIndex(path.join(dir, "i.db")) });
  catalog.refresh();
  const bots = { appendEntry: (_b: string, e: unknown) => appended.push(e) } as never;
  build = () => createPluginTools({ botId: "b1", slot: () => slot, catalog, mcp, bots, now: () => 5 });
  tools = build();
});
// The eight manage-an-installed-connector tools are mounted only once something is installed, so the
// set is rebuilt per call here the way a real next turn rebuilds it (host/tools/plugin-tools.ts).
const run = (name: string, args: Record<string, unknown>) => {
  const t = build().find((x) => x.name === name);
  if (!t) throw new Error(`${name} is not mounted (nothing installed?)`);
  return t.handler(args);
};

describe("plugin and MCP tools (ORIG-17)", () => {
  it("has the thirteen tools with spec names, eight of them only once there is something to manage", async () => {
    // Per-turn token floor: the eight below can only act on an installed connector (each answers
    // "No MCP server <id>." otherwise), and an uncallable tool still costs its schema on every model
    // call. Measured 2026-09-19 with the CLI's own /context accounting: 1,136 tokens a turn.
    expect(tools.map((t) => t.name)).toEqual(["SearchPlugins", "GetPlugin", "InstallPlugin", "AddMcpServer", "GetMcpServerStatus"]);
    await run("InstallPlugin", { plugin_id: "curated:linear" });
    expect(build().map((t) => t.name)).toEqual(["SearchPlugins", "GetPlugin", "InstallPlugin", "UninstallPlugin", "AddMcpServer", "UninstallMcpServer", "GetMcpServerStatus", "SetMcpInstructions", "RestartMcpServers", "AuthenticateMcpServer", "RemoveMcpAccount", "RenameMcpAccount", "SetMcpToolEnabled"]);
  });

  // mcpfix: the Agent SDK's bundled JSON-schema driver crashes on zod 4.6's z.record() processor, which
  // fails the "bot" server's whole tools/list. Exercise the real SDK round trip, same pattern as
  // host/test/tools/bot-tools.test.ts, so a future z.record() regression here is caught the same way.
  it("lists all thirteen tools over MCP tools/list", async () => {
    await run("InstallPlugin", { plugin_id: "curated:linear" }); // mounts the eight manage tools
    tools = build();
    expect(tools).toHaveLength(13);
    const server = toSdkMcpServer({ botTools: () => tools } as unknown as BrainWiring);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    } finally {
      await client.close();
    }
  });

  it("searches, installs and posts a connect card when sign-in is needed (PLG-05)", async () => {
    expect((await run("SearchPlugins", { query: "lin" })).text).toContain("Linear (curated:linear)");
    const r = await run("InstallPlugin", { plugin_id: "curated:linear" });
    expect(r.text).toMatch(/Installed Linear\. The user needs to authorize it/);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ kind: "send-message", id: "t3s1", message: { type: "card", card: { kind: "connect", serverId: "linear", name: "Linear", state: "added" } } });
  });

  it("status, rename, instructions, tool toggles and removal", async () => {
    await run("InstallPlugin", { plugin_id: "curated:linear" });
    expect((await run("GetMcpServerStatus", {})).text).toContain("Linear — Needs sign-in");
    expect((await run("RenameMcpAccount", { server_id: "linear", label: "work" })).text).toBe("Renamed Linear to Linear (work).");
    expect((await run("SetMcpInstructions", { server_id: "linear", instructions: "Use team GARDEN." })).text).toBe("Saved instructions for Linear (work).");
    expect((await run("SetMcpToolEnabled", { server: "linear", tool: "delete_issue", enabled: false })).text).toBe("Turned off delete_issue for Linear (work).");
    // An unknown id is still an error while the tool is mounted; once the last connector is gone the
    // tool is not offered at all, which is the gate, not a silent success.
    expect((await run("UninstallMcpServer", { server_id: "nope" })).isError).toBe(true);
    expect((await run("RemoveMcpAccount", { server_id: "linear" })).text).toBe("Removed Linear (work).");
    expect(mcp.registry.list()).toEqual([]);
    expect(build().map((t) => t.name)).not.toContain("UninstallMcpServer");
  });

  it("the module turns @-mentions into hints and posts one connect card per auth failure", async () => {
    const sent: unknown[] = [];
    const c = { slot: () => slot, bots: { appendEntry: (_b: string, e: unknown) => appended.push(e) }, now: () => 1, sendPrompt: (...a: unknown[]) => { sent.push(a); return { entryId: "t1u" }; } } as never;
    const m = createConnectorToolsModule(c, { catalog, mcp });
    // Integration: hints ride the base handler, so attachments, replies, skills and group routing still apply.
    const wrapped = m.wrapHandlers!({ sendPrompt: async (a) => { sent.push(a); return { entryId: "base" }; } });
    await wrapped.sendPrompt!({ id: "b1", text: "file a bug", clientNonce: "n", mentions: ["Linear", "Nope"], attachmentIds: ["att1"] });
    expect(sent).toEqual([{ id: "b1", text: "file a bug", clientNonce: "n", mentions: ["Linear", "Nope"], attachmentIds: ["att1"], hints: ["The user wants you to use Linear for this"] }]);
    sent.length = 0;
    expect(await wrapped.sendPrompt!({ id: "b1", text: "hi", clientNonce: "n2" })).toEqual({ entryId: "base" });
  });

  it("wakes the Bot once when the connector it asked for finishes authorizing (EVT-02 #13)", async () => {
    const woke: unknown[] = [];
    const c = { slot: () => slot, bots: { appendEntry: (_b: string, e: unknown) => appended.push(e) }, now: () => 1, enqueueHidden: (b: string, spec: unknown) => woke.push([b, spec]) } as never;
    const m = createConnectorToolsModule(c, { catalog, mcp });
    const t = m.botTools!("b1", () => slot);
    await t.find((x) => x.name === "InstallPlugin")!.handler({ plugin_id: "curated:linear" });
    for (const fn of mcp.authorized) fn("linear");
    for (const fn of mcp.authorized) fn("linear");
    expect(woke).toEqual([["b1", expect.objectContaining({ source: "mcp-auth", lane: "background", silenceAllowed: false, text: expect.stringContaining('The "Linear" MCP server finished authorizing') })]]);
  });

  // Finding 1 (fix round 1): card() must not silently no-op when d.slot() is null (the turn has moved
  // on by the time an awaited catalog.install()/pool.ensure() resolves) — every caller's returned tool
  // text must then say the card will show later, not unconditionally claim one "was shown".
  describe("card() reports whether a connect card was actually posted when the turn has moved on (fix round 1, finding 1)", () => {
    const localTools = (opts: { catalog?: Catalog; mcp?: ReturnType<typeof createMcpServices> } = {}) => {
      const localAppended: unknown[] = [];
      const t = createPluginTools({ botId: "b1", slot: () => null, catalog: opts.catalog ?? catalog, mcp: opts.mcp ?? mcp, bots: { appendEntry: (_b: string, e: unknown) => localAppended.push(e) } as never, now: () => 5 });
      return { t, localAppended };
    };

    it("InstallPlugin needs-auth branch: no card posted, text says it'll show later", async () => {
      const { t, localAppended } = localTools();
      const r = await t.find((x) => x.name === "InstallPlugin")!.handler({ plugin_id: "curated:linear" });
      expect(r.text).toBe("Installed Linear. The user needs to authorize it; a connect card will be shown once they're back in a live turn. Its tools work after they finish.");
      expect(localAppended).toHaveLength(0);
    });

    it("AddMcpServer needs-auth branch: no card posted, text says it'll show later", async () => {
      const { t, localAppended } = localTools();
      const r = await t.find((x) => x.name === "AddMcpServer")!.handler({ name: "Custom", url: "https://example.com/mcp" });
      expect(r.text).toMatch(/^Added Custom \(server id .+\)\. The user needs to authorize it; a connect card will be shown once they're back in a live turn\.$/);
      expect(localAppended).toHaveLength(0);
    });

    it("AuthenticateMcpServer: no card posted, text says it'll show later", async () => {
      const { t, localAppended } = localTools();
      await t.find((x) => x.name === "InstallPlugin")!.handler({ plugin_id: "curated:linear" }); // registers the "linear" server
      // AuthenticateMcpServer is mounted by the install, so take the set a next turn would build.
      const r = await localTools().t.find((x) => x.name === "AuthenticateMcpServer")!.handler({ server_id: "linear" });
      expect(r.text).toBe("A connect card for Linear will be shown once the user is back in a live turn. The user completes sign-in in their browser.");
      expect(localAppended).toHaveLength(0);
    });
  });
});

// Finding 2 (fix round 1): the module's core "connect cards on background auth failure" deliverable —
// o.mcp.pool.setAuthNeededHandler(...) — had zero direct test coverage. These tests invoke the exact
// function the module registers via setAuthNeededHandler, bypassing the tool-driven onCard path.
describe("connectors-module: background auth-needed callback posts one connect card per (requestId, serverId) (fix round 1, finding 2)", () => {
  let dir: string;
  let mcp2: ReturnType<typeof createMcpServices>;
  let catalog2: Catalog;
  let appended2: unknown[];
  let woke2: unknown[];
  let authNeeded: ((serverId: string, botId: string | null) => void) | undefined;
  let slotByBot: Record<string, typeof slot | null>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptools3-"));
    appended2 = [];
    woke2 = [];
    authNeeded = undefined;
    const ctx = { cfg: { hostPrivate: dir, workspace: dir }, hub: { publish: () => {} }, settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1, flags: () => ({}) } as never;
    mcp2 = createMcpServices(ctx, { connect: async () => { throw new Error("401"); } });
    // Intercept the handler the module registers, so the test can invoke it directly instead of
    // driving it indirectly through a tool call.
    const originalSet = mcp2.pool.setAuthNeededHandler.bind(mcp2.pool);
    mcp2.pool.setAuthNeededHandler = (fn) => { authNeeded = fn; originalSet(fn); };
    catalog2 = new Catalog({ curated: [{ id: "curated:linear", name: "Linear", description: "Issues and projects", category: "Code", via: "remote", url: "https://mcp.linear.app/mcp" }], mcp: mcp2, plugins: () => null, templates: () => null, index: new CatalogIndex(path.join(dir, "i.db")) });
    catalog2.refresh();
    await catalog2.install("curated:linear"); // registers the "linear" server so connectCardFor/display resolve a name
    slotByBot = { b1: { turnNo: 1, nextSendK: 0, requestId: "req_a", segment: 0 } as never };
    const c = { slot: (b: string) => slotByBot[b] ?? null, bots: { appendEntry: (_b: string, e: unknown) => appended2.push(e) }, now: () => 1, enqueueHidden: (b: string, spec: unknown) => woke2.push([b, spec]) } as never;
    createConnectorToolsModule(c, { catalog: catalog2, mcp: mcp2 });
  });

  it("registers a handler with setAuthNeededHandler", () => {
    expect(authNeeded).toBeTypeOf("function");
  });

  it("posts one card, dedups a repeat call for the same (requestId, serverId), and posts again on a new requestId", () => {
    authNeeded!("linear", "b1");
    expect(appended2).toHaveLength(1);
    expect(appended2[0]).toMatchObject({ kind: "send-message", message: { type: "card", card: { kind: "connect", serverId: "linear" } } });

    authNeeded!("linear", "b1"); // same (requestId, serverId) pair — deduped
    expect(appended2).toHaveLength(1);

    slotByBot.b1 = { turnNo: 1, nextSendK: 0, requestId: "req_b", segment: 0 } as never; // new turn
    authNeeded!("linear", "b1");
    expect(appended2).toHaveLength(2);
  });

  it("ignores calls with no botId, and calls for a bot with no live slot", () => {
    authNeeded!("linear", null);
    authNeeded!("linear", "unknown-bot");
    expect(appended2).toHaveLength(0);
  });

  it("wakes the bot once the connector it was told about finishes authorizing", () => {
    authNeeded!("linear", "b1");
    for (const fn of mcp2.authorized) fn("linear");
    expect(woke2).toEqual([["b1", expect.objectContaining({ source: "mcp-auth", lane: "background", text: expect.stringContaining('The "Linear" MCP server finished authorizing') })]]);
  });
});

// The built-in Google connector is not in the MCP registry, so every Bot-visible connector surface used to deny it
// existed ("No MCP server google.") while the Marketplace entry said "connected" — the Bot had no way to learn that
// Google is connected to the account but turned off for it.
describe("built-in Google connector, per-Bot (ORIG-GOOGLE)", () => {
  let gstatus: GoogleBotStatusView;
  let gtools: ReturnType<typeof createPluginTools>;
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gplug-"));
    const ctx = { cfg: { hostPrivate: dir, workspace: dir }, hub: { publish: () => {} }, settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1, flags: () => ({}) } as never;
    const m = createMcpServices(ctx, { connect: async () => { throw new Error("401"); } });
    const cat = new Catalog({
      curated: [{ id: "curated:gmail", name: "Gmail", description: "Mail", category: "Code", via: "google", tools: ["gmail_search", "gmail_read"] }],
      mcp: m, plugins: () => null, templates: () => null, index: new CatalogIndex(path.join(dir, "gi.db")),
      google: () => ({ state: "connected", clientId: "1-x.apps.googleusercontent.com", email: "me@example.com", services: ["Gmail"], redirectUri: "", error: null }),
    });
    cat.refresh();
    gstatus = { state: "off-for-bot", enabled: false, account: "connected", email: "me@example.com" };
    gtools = createPluginTools({ botId: "b1", slot: () => slot, catalog: cat, mcp: m, bots: { appendEntry: () => {} } as never, now: () => 5, google: () => gstatus });
  });
  const g = (name: string, args: Record<string, unknown> = {}) => gtools.find((t) => t.name === name)!.handler(args);

  it("GetMcpServerStatus lists it and says exactly why this Bot has no Google tools", async () => {
    const all = await g("GetMcpServerStatus", {});
    expect(all.text).toContain("[google]");
    expect(all.text).toContain("turned off for this Bot");
    const one = await g("GetMcpServerStatus", { server_id: "google" });
    expect(one.text).not.toMatch(/No MCP server/);
    expect(one.text).toContain("turn Google on");
  });

  it("AuthenticateMcpServer and RestartMcpServers on google name the real next step instead of denying it exists", async () => {
    const a = await g("AuthenticateMcpServer", { server_id: "google" });
    expect(a.text).not.toMatch(/No MCP server/);
    expect(a.text).toContain("turn Google on");
    const r = await g("RestartMcpServers", { server_id: "google" });
    expect(r.text).not.toMatch(/^Restarted/);
    expect(r.text).toContain("turn Google on");
  });

  it("the catalog entry no longer reads as usable by this Bot", async () => {
    expect((await g("GetPlugin", { plugin_id: "curated:gmail" })).text).toContain("turned off for this Bot");
    expect((await g("SearchPlugins", { query: "gmail" })).text).toContain("off for this Bot");
  });

  it("with the toggle on it reports the tools that are actually callable", async () => {
    gstatus = { state: "ready", enabled: true, account: "connected", email: "me@example.com" };
    const one = await g("GetMcpServerStatus", { server_id: "google" });
    expect(one.text).toContain("gmail_search");
    expect(one.text).not.toContain("turned off for this Bot");
  });

  it("a Bot with no Google account configured at all sees nothing extra", async () => {
    gstatus = { state: "not-configured", enabled: false, account: "not-configured", email: null };
    expect((await g("GetMcpServerStatus", {})).text).toBe("No connectors are installed.");
  });
});
