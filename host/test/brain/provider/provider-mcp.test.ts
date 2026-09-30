import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { mcpResultToBot, ProviderMcpClients, type ProviderMcpConfig } from "../../../brain/provider/mcp-tools";
import { ToolRegistry } from "../../../brain/provider/tool-registry";

/** Spec P2: a provider Bot's MCP servers, sdk (in memory) and stdio (spawned the way the host spawns one). */
const ECHO = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp.mjs");
const clients: ProviderMcpClients[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.close(); });

function sdkServer(opts: { hang?: boolean } = {}): McpServer {
  const s = new McpServer({ name: "notes", version: "1.0.0" });
  s.registerTool("add_note", { description: "Add a note.", inputSchema: { text: z.string(), tag: z.string().optional() } }, async ({ text }) => ({ content: [{ type: "text", text: `noted ${text}` }] }));
  s.registerTool("list_notes", { description: "List notes.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "a, b" }] }));
  if (opts.hang) s.server.setRequestHandler((z.object({ method: z.literal("tools/list") }) as never), () => new Promise(() => {}));
  return s;
}
function make(servers: () => Record<string, ProviderMcpConfig>, extra: Partial<ConstructorParameters<typeof ProviderMcpClients>[0]> = {}) {
  const spawned: string[][] = [];
  const c = new ProviderMcpClients({
    servers, spawn: (id, command, args) => { spawned.push([id, command, ...args]); return { command, args, env: { PATH: process.env.PATH ?? "" } }; }, ...extra,
  });
  clients.push(c);
  return { c, spawned };
}

describe("ProviderMcpClients", () => {
  it("lists an sdk server's tools under their canonical names and calls them through the handler", async () => {
    const server = sdkServer();
    const { c } = make(() => ({ notes: { type: "sdk", name: "notes", instance: server } }));
    const tools = await c.tools("b1");
    expect(tools.map((t) => [t.canonical, t.def.readOnly])).toEqual([["mcp__notes__add_note", false], ["mcp__notes__list_notes", true]]);
    expect(tools[0]!.jsonSchema).toMatchObject({ type: "object", required: ["text"] });
    expect(await tools[0]!.def.handler({ text: "milk" })).toEqual({ text: "noted milk" });
    // Same instance next turn: the connection is reused (a second connect would throw "Already connected").
    expect((await c.tools("b1")).length).toBe(2);
  });

  it("leaves out tools the user turned off and servers that went away, and reconnects to a new instance", async () => {
    let servers: Record<string, ProviderMcpConfig> = { notes: { type: "sdk", instance: sdkServer() } };
    const { c } = make(() => servers, { disallowed: () => ["mcp__notes__add_note"] });
    expect((await c.tools("b1")).map((t) => t.canonical)).toEqual(["mcp__notes__list_notes"]);
    servers = { notes: { type: "sdk", instance: sdkServer() } };
    expect((await c.tools("b1")).map((t) => t.canonical)).toEqual(["mcp__notes__list_notes"]);
    servers = {};
    expect(await c.tools("b1")).toEqual([]);
  });

  it("skips a server that doesn't answer within the budget, without blocking the others", async () => {
    const { c } = make(() => ({ slow: { type: "sdk", instance: sdkServer({ hang: true }) }, notes: { type: "sdk", instance: sdkServer() } }), { listTimeoutMs: 200 });
    const t0 = Date.now();
    expect((await c.tools("b1")).map((t) => t.canonical)).toEqual(["mcp__notes__add_note", "mcp__notes__list_notes"]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("spawns a stdio server through the host's spawn rule, reuses it across turns, and closes it", async () => {
    const { c, spawned } = make(() => ({ echo: { type: "stdio", command: process.execPath, args: [ECHO] } }));
    const tools = await c.tools("b1");
    expect(tools.map((t) => t.canonical)).toEqual(["mcp__echo__echo", "mcp__echo__whoami"]);
    expect(await tools[0]!.def.handler({ text: "hi" })).toEqual({ text: "echo: hi" });
    const pid = (await tools[1]!.def.handler({})).text;
    const again = await c.tools("b1");
    expect((await again[1]!.def.handler({})).text).toBe(pid); // one process per Bot and server, not one per turn
    expect(spawned).toEqual([["echo", process.execPath, ECHO]]);
    await c.close("b1");
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(Number(pid), 0)).toThrow();
  }, 20_000);

  it("ignores server types it can't reach from bothost", async () => {
    const { c } = make(() => ({ web: { type: "http", url: "https://example.invalid/mcp" } }));
    expect(await c.tools("b1")).toEqual([]);
  });
});

describe("MCP tools in the registry", () => {
  it("sends the server's own JSON Schema and checks required fields locally", async () => {
    const { c } = make(() => ({ notes: { type: "sdk", instance: sdkServer() } }));
    const reg = new ToolRegistry(await c.tools("b1"), "openai-strict");
    const t = reg.fromWire("mcp__notes__add_note")!;
    expect(t.canonical).toBe("mcp__notes__add_note");
    expect(t.wire.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
    expect(t.validator.safeParse({ text: "x", extra: 1 }).success).toBe(true);
    expect(t.validator.safeParse({ tag: "x" }).success).toBe(false);
  });

  it("turns MCP content into a tool result", () => {
    expect(mcpResultToBot({ content: [{ type: "text", text: "a" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "audio", data: "x" }] }))
      .toEqual({ text: "a\n[audio content]", images: [{ data: "AAAA", mimeType: "image/png" }] });
    expect(mcpResultToBot({ content: [], isError: true })).toEqual({ text: "Error", isError: true });
    expect(mcpResultToBot({ content: [], structuredContent: { n: 1 } })).toEqual({ text: "{\"n\":1}" });
  });
});
