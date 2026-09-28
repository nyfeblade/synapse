import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpModule, createMcpServices } from "../../mcp/module";
import { HostSettingsStore } from "../../store/host-settings";

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpmod-"));
  const published: unknown[] = [];
  return {
    published,
    ctx: {
      cfg: { hostPrivate: dir, workspace: dir }, hub: { publish: (e: unknown) => published.push(e) }, settings: new HostSettingsStore(path.join(dir, "s.json")),
      now: () => 1, flags: () => ({ connectorToolDisable: "disallowedTools" }),
    } as never,
  };
}

describe("MCP module", () => {
  it("adds a custom command server, lists it, and feeds spawn options", async () => {
    const { ctx: c, published } = ctx();
    const s = createMcpServices(c, { connect: async () => { throw new Error("offline"); } });
    const m = createMcpModule(c, s);
    const { server } = await m.handlers.addMcpServer!({ name: "Files", command: "npx", args: ["-y", "files-mcp"] });
    expect(server).toMatchObject({ id: "files", kind: "command", status: "unknown" });
    await m.handlers.setMcpToolEnabled!({ serverId: "files", tool: "rm", enabled: false });
    expect(m.disallowedTools!()).toEqual(["mcp__files__rm"]);
    expect(Object.keys(m.mcpServers!("bot-1"))).toEqual(["files"]);
    expect(published.some((e) => (e as { channel: string }).channel === "mcp-servers")).toBe(true);
    m.observers![0]!.onEvent!("bot-1", { kind: "session", sessionId: "s", model: "m", cliVersion: "2.1.277", tools: ["mcp__files__ls", "mcp__claude_ai_Gmail__search"] });
    const { servers } = await m.handlers.listMcpServers!({});
    expect(servers.map((x) => [x.id, x.kind, x.status])).toEqual([["files", "command", "connected"]]); // synapse-public: no claude.ai connectors
  });

  it("setMcpServerEnabled disconnects a live remote server and reconnects it, publishing each status (bug 54)", async () => {
    const { ctx: c, published } = ctx();
    let connects = 0;
    let closes = 0;
    const conn = { listTools: async () => [{ name: "search", description: "Search", inputSchema: { type: "object" as const } }], callTool: async () => ({ content: [] }) as never, close: async () => { closes += 1; } };
    const s = createMcpServices(c, { connect: async () => { connects += 1; return conn; } });
    const m = createMcpModule(c, s);
    await m.handlers.addMcpServer!({ name: "Composio", url: "https://connect.composio.dev/mcp" });
    const lastPublished = () => {
      const e = [...published].reverse().find((x) => (x as { channel: string }).channel === "mcp-servers") as { payload: { servers: { id: string; status: string; tools: unknown[] }[] } };
      return e.payload.servers.find((x) => x.id === "composio")!;
    };
    expect(lastPublished().status).toBe("connected");
    expect(connects).toBe(1);

    const off = await m.handlers.setMcpServerEnabled!({ serverId: "composio", enabled: false });
    expect(off.server.status).toBe("disabled");
    expect(closes, "turning a server off must drop its live connection").toBe(1);
    expect(connects, "turning a server off must not reconnect it").toBe(1);
    expect(lastPublished().status, "the row learns it is Off from the channel").toBe("disabled");
    expect(Object.keys(m.mcpServers!("bot-1"))).toEqual([]);

    const on = await m.handlers.setMcpServerEnabled!({ serverId: "composio", enabled: true });
    expect(on.server.status).toBe("connected");
    expect(connects, "turning it back on connects it again").toBe(2);
    expect(lastPublished().status).toBe("connected");
    expect(lastPublished().tools).toHaveLength(1);
    expect(Object.keys(m.mcpServers!("bot-1"))).toEqual(["composio"]);
  });

  it("setMcpServerEnabled turns a server off and back on (bug 54)", async () => {
    const { ctx: c } = ctx();
    const s = createMcpServices(c, { connect: async () => { throw new Error("offline"); } });
    const m = createMcpModule(c, s);
    await m.handlers.addMcpServer!({ name: "Files", command: "npx", args: ["-y", "files-mcp"] });
    const off = await m.handlers.setMcpServerEnabled!({ serverId: "files", enabled: false });
    expect(off.server.status).toBe("disabled");
    expect(Object.keys(m.mcpServers!("bot-1"))).toEqual([]);
    const on = await m.handlers.setMcpServerEnabled!({ serverId: "files", enabled: true });
    expect(on.server.status).not.toBe("disabled");
    expect(Object.keys(m.mcpServers!("bot-1"))).toEqual(["files"]);
  });
});
