import { buildBotEnv } from "../../brain/spawn-options";
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandServerSpawn, MCP_USER } from "../../mcp/connect";
import { FileOAuthProvider } from "../../mcp/oauth";
import { McpProxyPool, type RemoteConnection } from "../../mcp/proxy";
import { McpRegistry } from "../../mcp/registry";
import { subkey, vaultKeySync } from "../../secrets/crypto";
import { HostSettingsStore } from "../../store/host-settings";
import { loadConfig } from "../../config";

function setup() {
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "cmdenv-"));
  const reg = new McpRegistry({ dir: path.join(hp, "mcp"), settings: new HostSettingsStore(path.join(hp, "s.json")), now: () => 1, envKey: subkey(vaultKeySync(hp), "bots/mcp-env/v1") });
  return { hp, reg };
}

// Integration open item 1: a command-type MCP server's env (API keys) lives in the vault and reaches ONLY that
// server's process (host-proxied); it is never in the Bot's CLI config or process env.
describe("command MCP server env comes from the vault (open item 1, minor: command-MCP env)", () => {
  it("env values are sealed at rest; servers.json keeps only the names", () => {
    const { hp, reg } = setup();
    reg.add({ name: "Files", command: "npx", args: ["-y", "files-mcp"], env: { API_KEY: "sk-live-abc123" } }, "custom");
    const raw = fs.readFileSync(path.join(hp, "mcp", "servers.json"), "utf8");
    expect(raw).not.toContain("sk-live-abc123");
    expect(JSON.stringify(fs.readdirSync(path.join(hp, "mcp")).map((f) => fs.readFileSync(path.join(hp, "mcp", f), "utf8")))).not.toContain("sk-live-abc123");
    expect(reg.envFor("files")).toEqual({ API_KEY: "sk-live-abc123" });
    expect(reg.get("files")!.env).toEqual({});
    expect(reg.get("files")!.envNames).toEqual(["API_KEY"]);
  });

  it("a server with env is never handed to the Bot's CLI; it is host-proxied and its process gets the env", async () => {
    const { reg } = setup();
    reg.add({ name: "Plain", command: "node", args: ["plain.js"] }, "custom");
    reg.add({ name: "Files", command: "npx", args: ["files-mcp"], env: { API_KEY: "sk-live-abc123" } }, "custom");
    expect(Object.keys(reg.commandServerConfigs())).toEqual(["plain"]);
    expect(JSON.stringify(reg.commandServerConfigs())).not.toContain("sk-live-abc123");
    const spawned: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const conn: RemoteConnection = { listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => {} };
    const pool = new McpProxyPool({ registry: reg, workspace: fs.mkdtempSync(path.join(os.tmpdir(), "cmdenv-ws-")), now: () => 1, connect: async () => { throw new Error("remote only"); },
      connectCommand: async (s, env) => { spawned.push({ command: s.command!, args: s.args!, env }); return conn; } });
    expect(Object.keys(pool.sdkServers("b1"))).toEqual(["files"]);
    expect(await pool.ensure("files")).toBe("connected");
    expect(spawned).toEqual([{ command: "npx", args: ["files-mcp"], env: { API_KEY: "sk-live-abc123" } }]);
  });

  it("on the box the process is started as box via the root helper; values travel in a 0600 host-private file, never argv", () => {
    const cfg = { ...loadConfig({ BOX_HOME: "/home/box" }) };
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "cmdenv-run-"));
    const sp = commandServerSpawn({ cfg: { ...cfg, hostPrivate: hp }, runAs: "setpriv" }, { id: "files", command: "npx", args: ["files-mcp"] }, { API_KEY: "sk-live-abc123" });
    expect(sp.command).toBe("sudo");
    expect(sp.args.slice(0, 2)).toEqual(["-n", "/usr/local/libexec/bot-mcp-as-box"]);
    expect(sp.args.join(" ")).not.toContain("sk-live-abc123");
    expect(JSON.stringify(sp.env)).not.toContain("sk-live-abc123");
    const envFile = sp.args[2]!;
    expect(fs.readFileSync(envFile, "utf8")).toContain("API_KEY=sk-live-abc123");
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    const local = commandServerSpawn({ cfg, runAs: "same-uid" as never }, { id: "files", command: "npx", args: ["files-mcp"] }, { API_KEY: "k" });
    expect(local).toMatchObject({ command: "npx", args: ["files-mcp"] });
    expect(local.env.API_KEY).toBe("k");
    expect(local.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("final secfix 7: the bot-mcp-as-box env file = buildBotEnv (no OAuth token) + the vault values", () => {
  it("writes the Bot env baseline and the vault values to the one-shot file; never an OAuth token", () => {
    const cfg = { ...loadConfig({ BOX_HOME: "/home/box" }) };
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "cmdenv-run7-"));
    const sp = commandServerSpawn({ cfg: { ...cfg, hostPrivate: hp }, runAs: "setpriv" }, { id: "files", command: "npx", args: ["files-mcp"] }, { API_KEY: "sk-live-abc123", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-leak" });
    const lines = fs.readFileSync(sp.args[2]!, "utf8").split("\n").filter(Boolean);
    const env = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const base = buildBotEnv({ cfg, botId: "mcp-files" });
    for (const k of Object.keys(base)) if (!["HOME", "USER", "LOGNAME"].includes(k)) expect(env[k], k).toBe(base[k]);
    expect(env.API_KEY).toBe("sk-live-abc123");
    expect(env.BOT_ID).toBe("mcp-files");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const local = commandServerSpawn({ cfg, runAs: "same-uid" as never }, { id: "files", command: "npx", args: ["files-mcp"] }, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-leak" });
    expect(local.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("HKDF subkeys per cipher (minor)", () => {
  it("OAuth tokens are sealed with their own subkey (not the raw vault key) and legacy files still open", () => {
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "hkdf-"));
    const root = vaultKeySync(hp);
    const k = subkey(root, "bots/mcp-oauth/v1");
    expect(Buffer.from(k).equals(Buffer.from(root))).toBe(false);
    expect(Buffer.from(subkey(root, "bots/mcp-env/v1")).equals(Buffer.from(k))).toBe(false);
    const file = path.join(hp, "o.json");
    // a legacy file sealed with the root key
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", root, iv);
    const ct = Buffer.concat([c.update(JSON.stringify({ tokens: { access_token: "legacy", token_type: "bearer" } }), "utf8"), c.final()]);
    fs.writeFileSync(file, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }));
    const p = new FileOAuthProvider(file, "x", k, root);
    expect(p.tokens()?.access_token).toBe("legacy");
    p.saveTokens({ access_token: "new", token_type: "bearer" });
    expect(new FileOAuthProvider(file, "x", k).tokens()?.access_token).toBe("new");
    expect(new FileOAuthProvider(file, "x", root).tokens()).toBeUndefined();
  });
});

describe("ruling (final box verification): keyed command MCP servers run as their own uid boxmcp", () => {
  it("the one-shot env file names boxmcp and its home, never box's", () => {
    const cfg = { ...loadConfig({ BOX_HOME: "/home/box" }) };
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "cmdenv-boxmcp-"));
    const sp = commandServerSpawn({ cfg: { ...cfg, hostPrivate: hp }, runAs: "setpriv" }, { id: "files", command: "npx", args: ["files-mcp"] }, { API_KEY: "k", HOME: "/home/box", USER: "box" });
    const lines = fs.readFileSync(sp.args[2]!, "utf8").split("\n").filter(Boolean);
    const env = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect(MCP_USER).toBe("boxmcp");
    expect(env.HOME).toBe("/var/lib/boxmcp");
    expect(env.USER).toBe("boxmcp");
    expect(env.LOGNAME).toBe("boxmcp");
    expect(env.API_KEY).toBe("k");
  });
});
