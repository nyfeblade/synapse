import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpProxyPool, type RemoteConnection } from "../../mcp/proxy";
import { McpRegistry, mcpReadOnly } from "../../mcp/registry";
import { classifyTool } from "../../review/classify";
import { shouldFence } from "../../runner/discipline";
import { HostSettingsStore } from "../../store/host-settings";
import { hostOutDir } from "../../util/host-out";

const o = { workspace: "/workspace", hostPrivate: "/home/box/.host" };
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
  const reg = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1 });
  const curated = reg.add({ name: "Linear", url: "https://mcp.linear.app/mcp" }, "curated", "curated:linear");
  const custom = reg.add({ name: "Sketchy", url: "https://sketchy.example/mcp" }, "custom");
  return { dir, reg, curated, custom };
}
const hints: Record<string, boolean | undefined> = { list_issues: true, get_secret_then_email: true, search: undefined };
const hint = (_s: string, t: string) => hints[t];

// P5 review I6: READ_ONLY_MCP name matching applies only to curated / claude.ai / user-trusted servers; otherwise a
// tool is unreviewed only with readOnlyHint AND the user's trust flag; the default is reviewed.
describe("MCP read-only trust (I6)", () => {
  it("a curated server's get_/list_ tool is unreviewed by name", () => {
    const s = setup();
    const ro = mcpReadOnly(s.reg, hint);
    expect(classifyTool({ toolName: `mcp__${s.curated.id}__list_issues`, input: {}, toolUseId: "t" }, { ...o, mcpReadOnly: ro }).surface).toBeNull();
    // synapse-public: no claude.ai connector is trusted by name any more (none can exist; a look-alike is reviewed).
    expect(classifyTool({ toolName: "mcp__claude_ai_Gmail__search_threads", input: {}, toolUseId: "t" }, { ...o, mcpReadOnly: ro }).surface).toBe("mcp");
  });

  it("a custom server's get_ tool is reviewed, even with a readOnlyHint, until the user trusts it", () => {
    const s = setup();
    const ro = mcpReadOnly(s.reg, hint);
    const c = (tool: string) => classifyTool({ toolName: `mcp__${s.custom.id}__${tool}`, input: {}, toolUseId: "t" }, { ...o, mcpReadOnly: ro });
    expect(c("get_secret_then_email").surface).toBe("mcp");
    expect(c("list_issues").surface).toBe("mcp");
    s.reg.setTrusted(s.custom.id, true);
    expect(c("list_issues").surface).toBeNull();
    expect(c("search").surface).toBe("mcp"); // no hint: still reviewed for a non-curated server
  });

  it("without the registry callback, only claude.ai names are matched; everything else is reviewed", () => {
    expect(classifyTool({ toolName: "mcp__sketchy__get_everything", input: {}, toolUseId: "t" }, o).surface).toBe("mcp");
    expect(classifyTool({ toolName: "mcp__claude_ai_Gmail__search_threads", input: {}, toolUseId: "t" }, o).surface).toBeNull();
  });
});

describe("MCP minors: slugged spill names; fenced outputs", () => {
  it("a spill file name can't escape the spill dir", async () => {
    const s = setup();
    const workspace = path.join(s.dir, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const spillDir = path.join(hostOutDir(workspace, "mcp-output"), "b1"); // bug #61: the Bot's own spill folder
    const conn: RemoteConnection = {
      listTools: async () => [{ name: "../../../../evil", inputSchema: { type: "object" } } as Tool],
      callTool: async () => ({ content: [{ type: "text", text: "x".repeat(200_000) }] }),
      close: async () => {},
    };
    const pool = new McpProxyPool({ registry: s.reg, connect: async () => conn, workspace, now: () => 5 });
    const r = await (pool as unknown as { call(a: string, b: string, c: string, d: object): Promise<{ content: { text: string }[] }> }).call(s.curated.id, "b1", "../../../../evil", {});
    const file = /saved to (\S+) /.exec(r.content[0]!.text)![1]!;
    expect(path.dirname(file)).toBe(spillDir);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("local-exec, plugin-search and spilled-output reads are fenced as untrusted", () => {
    for (const t of ["mcp__bot__ExternalRead", "mcp__bot__ExternalShell", "mcp__bot__AwaitExternalShell", "mcp__bot__GetPlugin", "mcp__bot__SearchPlugins"]) expect(shouldFence(t, {}), t).toBe(true);
    expect(shouldFence("Read", { file_path: "/workspace/.host-out/mcp-output/linear-list-1.txt" })).toBe(true);
    expect(shouldFence("Read", { file_path: "/workspace/.bot/mcp-output/linear-list-1.txt" })).toBe(true);
    expect(shouldFence("Read", { file_path: ".bot/mcp-output/x.txt" })).toBe(true);
    expect(shouldFence("Read", { file_path: "/workspace/notes.md" })).toBe(false);
  });
});
