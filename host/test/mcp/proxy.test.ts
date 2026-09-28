import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { McpProxyPool, type RemoteConnection } from "../../mcp/proxy";
import { McpRegistry } from "../../mcp/registry";
import { HostSettingsStore } from "../../store/host-settings";

async function fakeRemote(big = false): Promise<RemoteConnection> {
  const remote = new McpServer({ name: "linear", version: "1" });
  remote.tool("list_issues", "List issues", { team: z.string() }, async ({ team }) => ({ content: [{ type: "text", text: big ? "x".repeat(50_000) : `issues for ${team}` }] }));
  remote.tool("delete_issue", "Delete an issue", { id: z.string() }, async () => ({ content: [{ type: "text", text: "deleted" }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await remote.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return { listTools: async () => (await client.listTools()).tools, callTool: async (n, args) => (await client.callTool({ name: n, arguments: args })) as never, close: () => client.close() };
}

async function asBot(pool: McpProxyPool, botId: string, id: string): Promise<Client> {
  const cfg = pool.sdkServers(botId)[id]!;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (cfg.instance as unknown as McpServer).connect(a);
  const c = new Client({ name: "bot", version: "1" });
  await c.connect(b);
  return c;
}

let dir: string;
let reg: McpRegistry;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-"));
  reg = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1 });
  reg.add({ name: "Linear", url: "https://mcp.linear.app/mcp" }, "curated", "curated:linear");
});

describe("McpProxyPool", () => {
  it("re-exposes remote tools to a Bot and hides tools the user turned off", async () => {
    const pool = new McpProxyPool({ registry: reg, connect: () => fakeRemote(), workspace: dir, now: () => 1 });
    expect(await pool.ensure("linear")).toBe("connected");
    reg.setToolEnabled("linear", "delete_issue", false);
    const c = await asBot(pool, "bot-1", "linear");
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["list_issues"]);
    const r = await c.callTool({ name: "list_issues", arguments: { team: "GARDEN" } });
    expect((r.content as { text: string }[])[0]!.text).toBe("issues for GARDEN");
    const blocked = await c.callTool({ name: "delete_issue", arguments: { id: "1" } });
    expect(blocked.isError).toBe(true);
  });

  it("reports needs-auth and asks for one connect card only when the Bot actually calls the server (PLG-05, bug 58)", async () => {
    const asked: [string, string | null][] = [];
    const pool = new McpProxyPool({ registry: reg, connect: async () => { throw new UnauthorizedError("401"); }, workspace: dir, now: () => 1, onAuthNeeded: (s, b) => asked.push([s, b]) });
    expect(await pool.ensure("linear")).toBe("needs-auth");
    // Bug 58: the CLI lists every server's tools at every spawn, so a card asked for at listing time
    // reached the user on turns that had nothing to do with the server ("a PostHog card every message").
    const c = await asBot(pool, "bot-1", "linear");
    expect((await c.listTools()).tools).toEqual([]);
    const again = await asBot(pool, "bot-1", "linear");
    expect((await again.listTools()).tools).toEqual([]);
    expect(asked).toEqual([]);
    // The moment the Bot needs it is the moment to ask — once, however often it retries.
    const r = await c.callTool({ name: "list_issues", arguments: { team: "GARDEN" } });
    expect(r.isError).toBe(true);
    await again.callTool({ name: "list_issues", arguments: { team: "GARDEN" } });
    expect(asked).toEqual([["linear", "bot-1"]]);
  });

  it("a server turned off under a warm Bot says it is off, not that a connect card was shown (bug 54)", async () => {
    const asked: [string, string | null][] = [];
    const pool = new McpProxyPool({ registry: reg, connect: () => fakeRemote(), workspace: dir, now: () => 1, onAuthNeeded: (s, b) => asked.push([s, b]) });
    expect(await pool.ensure("linear")).toBe("connected");
    const c = await asBot(pool, "bot-1", "linear"); // spawned while the server was on
    reg.setEnabled("linear", false);
    await pool.restart("linear");
    expect(pool.status("linear")).toBe("disabled");
    expect((await c.listTools()).tools).toEqual([]);
    const r = await c.callTool({ name: "list_issues", arguments: { team: "GARDEN" } });
    const text = (r.content as { text: string }[])[0]!.text;
    expect(r.isError).toBe(true);
    // The old answer was STR5.connectorAuthNeeded: "Linear needs to be connected first. The user was
    // shown a connect card for it." No card was shown, and connecting is not what is wrong.
    expect(text, "a turned-off server told the Bot a connect card was shown").not.toMatch(/connect card/);
    expect(text).toMatch(/Linear/);
    expect(text).toMatch(/turned .*off/i);
    expect(asked).toEqual([]);
  });

  it("spills outputs over 40,000 bytes to a file (§5.1)", async () => {
    const pool = new McpProxyPool({ registry: reg, connect: () => fakeRemote(true), workspace: dir, now: () => 7 });
    await pool.ensure("linear");
    const c = await asBot(pool, "bot-1", "linear");
    const r = await c.callTool({ name: "list_issues", arguments: { team: "X" } });
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/saved to .*linear-list_issues-7\.txt \(50000 chars\)/);
    expect(fs.readFileSync(path.join(dir, ".host-out", "mcp-output", "bot-1", "linear-list_issues-7.txt"), "utf8")).toHaveLength(50_000); // bug #61: per-Bot
  });

  it("scopes restart(serverId)'s auth-ask dedup reset to that server only (PLG-05)", async () => {
    reg.add({ name: "Jira", url: "https://mcp.atlassian.com/mcp" }, "curated", "curated:jira");
    const asked: [string, string | null][] = [];
    const pool = new McpProxyPool({
      registry: reg,
      connect: async () => { throw new UnauthorizedError("401"); },
      workspace: dir,
      now: () => 1,
      onAuthNeeded: (s, b) => asked.push([s, b]),
    });

    // jira already showed its one connect card to bot-1 this turn
    await pool.ensure("jira");
    const jiraClient = await asBot(pool, "bot-1", "jira");
    await jiraClient.callTool({ name: "search", arguments: {} });
    expect(asked).toEqual([["jira", "bot-1"]]);

    // linear also has an entry (e.g. it was ensured earlier this turn too)
    await pool.ensure("linear");

    // restarting the unrelated server (linear) must not re-arm jira's dedup
    await pool.restart("linear");

    const jiraClient2 = await asBot(pool, "bot-1", "jira");
    await jiraClient2.callTool({ name: "search", arguments: {} });
    expect(asked).toEqual([["jira", "bot-1"]]);
  });

  it("gives each Bot spawn its own server instance (one transport per instance)", () => {
    const pool = new McpProxyPool({ registry: reg, connect: () => fakeRemote(), workspace: dir, now: () => 1 });
    expect(pool.sdkServers("a").linear!.instance).not.toBe(pool.sdkServers("b").linear!.instance);
    expect(pool.sdkServers("a").linear).toMatchObject({ type: "sdk", name: "linear" });
  });
});
