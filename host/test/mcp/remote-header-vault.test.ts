import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MCP_HEADER_REDACTED } from "@synapse/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpConnector } from "../../mcp/connect";
import { createMcpModule, createMcpServices } from "../../mcp/module";
import { McpProxyPool, type RemoteConnection } from "../../mcp/proxy";
import { McpRegistry } from "../../mcp/registry";
import { subkey, vaultKeySync } from "../../secrets/crypto";
import { HostSettingsStore } from "../../store/host-settings";

/**
 * Header-authenticated remote MCP servers (Composio is the first consumer, but nothing here knows
 * that). A remote server's auth header VALUE is a credential: it is the whole of the user's access
 * to that endpoint, and the app's posture (host/mcp/connect.ts:47,51 — "never in argv or the Bot's
 * env") says a credential lives sealed in the vault and nowhere else.
 *
 * Before this change `McpRegistry.add()` wrote `headers` straight into servers.json as given, so a
 * key pasted into the add-server form sat in clear text in a 0600 JSON file, was copied into every
 * snapshot of it, and was handed to anything that read the registry. These tests are the proof that
 * it no longer does — they do not assert the mechanism, they look for the literal bytes.
 *
 * The canary is deliberately distinctive so a substring search over whole files means something.
 */
const HEADER = "x-consumer-api-key";
const SECRET = "ck-canary-7Qd2f3a9-do-not-persist";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Every byte the host wrote under its private dir, as one searchable blob (plus the file list). */
function everythingOnDisk(hostPrivate: string): { files: string[]; blob: string } {
  const files = walk(hostPrivate);
  return { files, blob: files.map((f) => `${f}\n${fs.readFileSync(f, "latin1")}`).join("\n") };
}

function setup() {
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "mcphdr-"));
  const root = vaultKeySync(hp);
  const reg = new McpRegistry({
    dir: path.join(hp, "mcp"),
    settings: new HostSettingsStore(path.join(hp, "s.json")),
    now: () => 1,
    envKey: subkey(root, "bots/mcp-env/v1"),
    headerKey: subkey(root, "bots/mcp-headers/v1"),
  });
  return { hp, reg };
}

function modCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcphdrmod-"));
  const published: unknown[] = [];
  return {
    dir,
    published,
    ctx: {
      cfg: { hostPrivate: dir, workspace: dir },
      hub: { publish: (e: unknown) => published.push(e) },
      settings: new HostSettingsStore(path.join(dir, "s.json")),
      now: () => 1,
      flags: () => ({ connectorToolDisable: "disallowedTools" }),
    } as never,
  };
}

const conn: RemoteConnection = { listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => {} };

afterEach(() => vi.restoreAllMocks());

describe("a remote MCP server's header credential never reaches disk", () => {
  it("nothing the host wrote contains the header value — not servers.json, not any other file", () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");

    const { files, blob } = everythingOnDisk(hp);
    // The guard's own smoke test: a search that found no files would pass vacuously.
    expect(files.length, "the host wrote no files at all — this search proves nothing").toBeGreaterThan(1);
    expect(files.some((f) => f.endsWith("servers.json")), "servers.json missing — the registry did not persist").toBe(true);
    expect(blob).not.toContain(SECRET);
  });

  it("servers.json keeps the header NAME (not secret) and an empty value map, the way env does", () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");
    const raw = fs.readFileSync(path.join(hp, "mcp", "servers.json"), "utf8");
    expect(raw).toContain(HEADER);
    expect(raw).not.toContain(SECRET);
    expect(reg.get("composio")!.headerNames).toEqual([HEADER]);
    expect(reg.get("composio")!.headers).toEqual({});
    expect(reg.headersFor("composio")).toEqual({ [HEADER]: SECRET });
  });

  it("the sealed store is 0600 and its bytes are ciphertext, not the value", () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");
    const file = path.join(hp, "mcp", "remote-headers.sealed.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const sealed = JSON.parse(fs.readFileSync(file, "utf8")) as { v: number; iv: string; tag: string; ct: string };
    expect(sealed.v).toBe(1);
    expect(sealed.ct).not.toContain(SECRET);
    expect(Buffer.from(sealed.ct, "base64").toString("latin1")).not.toContain(SECRET);
  });

  it("a registry opened with the wrong key cannot read the value back (it is really encrypted)", () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");
    const other = new McpRegistry({
      dir: path.join(hp, "mcp"), settings: new HostSettingsStore(path.join(hp, "s.json")), now: () => 1,
      headerKey: subkey(vaultKeySync(fs.mkdtempSync(path.join(os.tmpdir(), "mcphdr-other-"))), "bots/mcp-headers/v1"),
    });
    expect(other.headersFor("composio")).toEqual({});
    expect(other.get("composio")!.headerNames).toEqual([HEADER]);
  });

  it("removing the server removes the sealed value with it", () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");
    reg.remove("composio");
    expect(reg.headersFor("composio")).toEqual({});
    expect(everythingOnDisk(hp).blob).not.toContain(SECRET);
  });

  it("a legacy servers.json written before this fix is migrated: the value is sealed and erased from the file", () => {
    const { hp } = setup();
    const dir = path.join(hp, "mcp");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({ version: 1, servers: [
      { id: "composio", name: "Composio", label: null, kind: "remote", url: "https://connect.composio.dev/mcp", transport: "http", headers: { [HEADER]: SECRET }, catalogId: null, source: "custom", enabled: true, createdAt: 1 },
    ] }), { mode: 0o600 });
    const root = vaultKeySync(hp);
    const reg = new McpRegistry({ dir, settings: new HostSettingsStore(path.join(hp, "s.json")), now: () => 1, headerKey: subkey(root, "bots/mcp-headers/v1") });
    expect(reg.headersFor("composio")).toEqual({ [HEADER]: SECRET });
    expect(reg.get("composio")!.headers).toEqual({});
    expect(reg.get("composio")!.headerNames).toEqual([HEADER]);
    expect(everythingOnDisk(hp).blob).not.toContain(SECRET);
  });
});

describe("the header credential never reaches the renderer", () => {
  it("the published mcp-servers payload carries the name and a redaction, never the value", async () => {
    const { ctx: c, published } = modCtx();
    const s = createMcpServices(c, { connect: async () => conn });
    const m = createMcpModule(c, s);
    const { server } = await m.handlers.addMcpServer!({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } });

    expect(server.headers).toEqual([{ name: HEADER, value: MCP_HEADER_REDACTED }]);
    expect(JSON.stringify(server)).not.toContain(SECRET);
    const mcpPublishes = published.filter((e) => (e as { channel: string }).channel === "mcp-servers");
    expect(mcpPublishes.length, "nothing was published — this search proves nothing").toBeGreaterThan(0);
    expect(JSON.stringify(mcpPublishes)).not.toContain(SECRET);
    expect(JSON.stringify(await m.handlers.listMcpServers!({}))).not.toContain(SECRET);
  });

  it("a connection error that quotes the value is scrubbed before it is stored or published", async () => {
    const { ctx: c, published } = modCtx();
    const s = createMcpServices(c, { connect: async () => { throw new Error(`connect ECONNREFUSED (sent ${HEADER}: ${SECRET})`); } });
    const m = createMcpModule(c, s);
    const { server } = await m.handlers.addMcpServer!({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } });
    expect(server.status).toBe("failed");
    expect(server.error, "the error was dropped entirely — the user must still be told it failed").toContain("ECONNREFUSED");
    expect(server.error).not.toContain(SECRET);
    expect(JSON.stringify(published)).not.toContain(SECRET);
  });

  it("a tool-call error that quotes the value is scrubbed before it reaches the Bot", async () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");
    const failing: RemoteConnection = {
      listTools: async () => [{ name: "search_tools", description: "", inputSchema: { type: "object" } }],
      callTool: async () => { throw new Error(`upstream rejected the request (sent ${HEADER}: ${SECRET})`); },
      close: async () => {},
    };
    const pool = new McpProxyPool({ registry: reg, workspace: hp, now: () => 1, connect: async () => failing });
    const cfg = pool.sdkServers("bot-1").composio!;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (cfg.instance as unknown as McpServer).connect(a);
    const bot = new Client({ name: "bot", version: "1" });
    await bot.connect(b);
    const r = await bot.callTool({ name: "search_tools", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content), "the error was dropped entirely — the Bot must still learn the call failed").toContain("upstream rejected");
    expect(JSON.stringify(r.content)).not.toContain(SECRET);
  });

  it("nothing the host logs contains the value, across add / connect-failure / remove", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { ctx: c } = modCtx();
      const s = createMcpServices(c, { connect: async () => { throw new Error(`boom ${SECRET}`); } });
      const m = createMcpModule(c, s);
      await m.handlers.addMcpServer!({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } });
      await m.handlers.setMcpServerHeader!({ serverId: "composio", name: HEADER, value: `${SECRET}-2` });
      await m.handlers.removeMcpServer!({ serverId: "composio" });
      const written = stderr.mock.calls.map((a) => String(a[0])).join("");
      expect(written).not.toContain(SECRET);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("the header credential does reach the one place it belongs: the outbound request", () => {
  it("the proxy hands the connector the sealed values, resolved at connect time", async () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");
    const seen: Record<string, string>[] = [];
    const pool = new McpProxyPool({ registry: reg, workspace: hp, now: () => 1, connect: async (_s, headers) => { seen.push(headers); return conn; } });
    expect(await pool.ensure("composio")).toBe("connected");
    expect(seen).toEqual([{ [HEADER]: SECRET }]);
  });

  it("httpConnector sends them on the wire — taken from its argument, not from the registry record", async () => {
    // A real loopback server, so this measures the bytes the transport actually sent rather than a
    // shape we handed a mock. It answers 401 like Composio's endpoint does unauthenticated; all we
    // need is the request headers it saw.
    const seen: http.IncomingHttpHeaders[] = [];
    const srv = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    try {
      const connector = httpConnector(() => undefined);
      // `headers` on the record is {} since the vault fix: if the connector read it, nothing is sent.
      await connector({ id: "composio", url: `http://127.0.0.1:${port}/mcp`, headers: {} } as never, { [HEADER]: SECRET }).catch(() => {});
      expect(seen.length, "the transport made no request — this proves nothing").toBeGreaterThan(0);
      expect(seen[0]![HEADER]).toBe(SECRET);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("what the user may configure, and what they may not", () => {
  it("https stays mandatory — a credential over plaintext http is impossible", () => {
    const { reg } = setup();
    expect(() => reg.add({ name: "Bad", url: "http://connect.example/mcp", headers: { [HEADER]: SECRET } }, "custom")).toThrow(/https/);
  });

  it("a header name must be an HTTP token, and no value may smuggle CR/LF (request splitting)", () => {
    const { reg } = setup();
    expect(() => reg.add({ name: "A", url: "https://a.example/mcp", headers: { "bad name": SECRET } }, "custom")).toThrow(/header name/i);
    expect(() => reg.add({ name: "B", url: "https://b.example/mcp", headers: { [HEADER]: "a\r\nX-Evil: 1" } }, "custom")).toThrow(/header value/i);
  });

  it("a rejected header never puts the value into the error the user is shown", () => {
    const { reg } = setup();
    // Not a try/catch: a `throw` inside one would be caught by the same catch, and the assertion on
    // the message would then be made about the test's own error instead of the registry's.
    let thrown: unknown = null;
    expect(() => { try { reg.add({ name: "C", url: "https://c.example/mcp", headers: { "bad name": SECRET } }, "custom"); } catch (e) { thrown = e; throw e; } }).toThrow();
    expect(String((thrown as Error).message)).not.toContain(SECRET);
  });

  it("headers belong to remote servers; a command server is told so rather than silently dropping them", () => {
    const { reg } = setup();
    expect(() => reg.add({ name: "Files", command: "npx", args: ["files-mcp"], headers: { [HEADER]: SECRET } }, "custom")).toThrow(/remote/i);
  });
});

describe("editing an existing server's key", () => {
  it("replaces the value in place, leaving nothing of the old one behind", async () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");
    reg.setHeader("composio", HEADER, `${SECRET}-rotated`);
    expect(reg.headersFor("composio")).toEqual({ [HEADER]: `${SECRET}-rotated` });
    expect(reg.get("composio")!.headerNames).toEqual([HEADER]);
    expect(everythingOnDisk(hp).blob).not.toContain(SECRET);
  });

  it("removes it, and the name goes with it", () => {
    const { hp, reg } = setup();
    reg.add({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } }, "custom");
    reg.setHeader("composio", HEADER, null);
    expect(reg.headersFor("composio")).toEqual({});
    expect(reg.get("composio")!.headerNames).toEqual([]);
    expect(everythingOnDisk(hp).blob).not.toContain(SECRET);
  });

  it("setMcpServerHeader reconnects the server so the new key is actually the one in use", async () => {
    const { ctx: c } = modCtx();
    const seen: Record<string, string>[] = [];
    const s = createMcpServices(c, { connect: async (_s, headers) => { seen.push(headers); return conn; } });
    const m = createMcpModule(c, s);
    await m.handlers.addMcpServer!({ name: "Composio", url: "https://connect.composio.dev/mcp", headers: { [HEADER]: SECRET } });
    const { server } = await m.handlers.setMcpServerHeader!({ serverId: "composio", name: HEADER, value: `${SECRET}-rotated` });
    expect(server.headers).toEqual([{ name: HEADER, value: MCP_HEADER_REDACTED }]);
    expect(seen).toEqual([{ [HEADER]: SECRET }, { [HEADER]: `${SECRET}-rotated` }]);
  });
});
