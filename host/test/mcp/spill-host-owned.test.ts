import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS5 } from "@synapse/shared";
import { McpProxyPool, type RemoteConnection } from "../../mcp/proxy";
import { McpRegistry } from "../../mcp/registry";
import { shouldFence } from "../../runner/discipline";
import { HostSettingsStore } from "../../store/host-settings";
import { hostOutDir } from "../../util/host-out";

function setup(text = "x".repeat(50_000)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spill-"));
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const reg = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1 });
  const srv = reg.add({ name: "Linear", url: "https://mcp.linear.app/mcp" }, "curated", "curated:linear");
  const conn: RemoteConnection = {
    listTools: async () => [{ name: "list_issues", inputSchema: { type: "object" } } as never],
    callTool: async () => ({ content: [{ type: "text", text }] }),
    close: async () => {},
  };
  const pool = new McpProxyPool({ registry: reg, connect: async () => conn, workspace, now: () => 7 });
  const call = (tool = "list_issues") =>
    (pool as unknown as { call(a: string, b: string, c: string, d: object): Promise<{ content: { text: string }[]; isError?: boolean }> }).call(srv.id, "b1", tool, {});
  return { dir, workspace, reg, pool, id: srv.id, call };
}

// Final secfix round 3, ruling 4: /workspace/.bot is box-owned 2775, so a Bot could rename the
// host-created mcp-output directory away, drop a symlink in its place, and have bothost's plain
// writeFileSync truncate any file it pointed at. The spill now goes to /workspace/.host-out/
// mcp-output through writeHostOwnedFile, exactly like screenshots and saved webhook bodies.
describe("MCP output spill is a host-owned write", () => {
  it("lands under .host-out/mcp-output/<botId> (bug #61), 0640, and tells the Bot that path", async () => {
    const s = setup();
    const r = await s.call();
    const file = /saved to (\S+) /.exec(r.content[0]!.text)![1]!;
    expect(file).toBe(path.join(hostOutDir(s.workspace, "mcp-output"), "b1", `${s.id}-list_issues-7.txt`));
    expect(fs.readFileSync(file, "utf8")).toHaveLength(50_000);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o750);
    expect(fs.existsSync(path.join(s.workspace, ".bot", "mcp-output"))).toBe(false);
  });

  it("refuses a box-planted symlinked spill directory and writes nothing outside", async () => {
    const s = setup();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "spill-victim-"));
    fs.writeFileSync(path.join(elsewhere, "claude-oauth-token"), "REAL-TOKEN");
    fs.mkdirSync(path.join(s.workspace, ".host-out"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(s.workspace, ".host-out", "mcp-output"));
    const r = await s.call();
    expect(r.content[0]!.text).not.toMatch(/saved to/);
    expect(fs.readdirSync(elsewhere)).toEqual(["claude-oauth-token"]);
    expect(fs.readFileSync(path.join(elsewhere, "claude-oauth-token"), "utf8")).toBe("REAL-TOKEN");
  });

  it("refuses a symlink pre-planted at the exact spill file name (O_EXCL|O_NOFOLLOW)", async () => {
    const s = setup();
    const victim = path.join(s.dir, "claude-oauth-token");
    fs.writeFileSync(victim, "REAL-TOKEN");
    const dir = path.join(hostOutDir(s.workspace, "mcp-output"), "b1"); // bug #61: the Bot's own spill folder
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fs.symlinkSync(victim, path.join(dir, `${s.id}-list_issues-7.txt`));
    const r = await s.call();
    expect(r.content[0]!.text).not.toMatch(/saved to/);
    expect(fs.readFileSync(victim, "utf8")).toBe("REAL-TOKEN");
  });

  it("hands back a bounded excerpt when the spill is refused, never the whole output", async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.workspace, ".host-out"), { recursive: true });
    fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), "spill-victim-")), path.join(s.workspace, ".host-out", "mcp-output"));
    const r = await s.call();
    expect(r.content[0]!.text.length).toBeLessThanOrEqual(LIMITS5.mcpOutputSpillBytes + 500);
    expect(r.content[0]!.text).toContain("x".repeat(100));
  });

  it("a remote tool name still can't steer the file out of the spill dir", async () => {
    const s = setup();
    const r = await s.call("../../../../evil");
    const file = /saved to (\S+) /.exec(r.content[0]!.text)![1]!;
    expect(path.dirname(file)).toBe(path.join(hostOutDir(s.workspace, "mcp-output"), "b1")); // bug #61: per-Bot
  });

  it("small outputs are still returned inline", async () => {
    const s = setup("just a little text");
    const r = await s.call();
    expect(r.content[0]!.text).toBe("just a little text");
    expect(fs.existsSync(hostOutDir(s.workspace, "mcp-output"))).toBe(false);
  });

  it("a Read of the new spill path is fenced as untrusted content", () => {
    expect(shouldFence("Read", { file_path: "/workspace/.host-out/mcp-output/linear-list_issues-7.txt" })).toBe(true);
  });
});
