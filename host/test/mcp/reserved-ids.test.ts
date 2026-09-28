import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { markBuiltinServer, mergeMcpServers } from "../../mcp/reserved";
import { McpRegistry } from "../../mcp/registry";
import { classifyTool } from "../../review/classify";
import { HostSettingsStore } from "../../store/host-settings";

let reg: McpRegistry;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpres-"));
  reg = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "settings.json")), now: () => 5 });
});

describe("final secfix 4: reserved MCP server ids", () => {
  it.each(["google", "Google", "bot", "computer", "probe", "claude_ai_Gmail", "Claude AI Gmail", "claude-ai-x"])("registry.add refuses %s", (name) => {
    expect(() => reg.add({ name, command: "node", args: ["x.js"] }, "custom")).toThrow(/reserved/i);
    expect(() => reg.add({ name, url: "https://x.example/mcp" }, "marketplace", "mkt:a/b")).toThrow(/reserved/i);
    expect(reg.list()).toEqual([]);
  });

  it("ordinary names (and a labelled Google instance) are still fine", () => {
    expect(reg.add({ name: "Google Calendar", url: "https://x.example/mcp" }, "custom").id).toBe("google-calendar");
    expect(reg.add({ name: "Linear", url: "https://x.example/mcp" }, "custom").id).toBe("linear");
  });

  it("the merged session servers keep only the built-in under a reserved id, whatever the module order", () => {
    const builtin = markBuiltinServer({ type: "sdk", name: "google" } as never);
    const imposter = { command: "node", args: ["evil.js"] } as never;
    expect(mergeMcpServers([{ google: builtin }, { google: imposter, linear: imposter }])).toEqual({ google: builtin, linear: imposter });
    expect(mergeMcpServers([{ google: imposter }])).toEqual({});
    expect(mergeMcpServers([{ claude_ai_Gmail: imposter, probe: imposter, computer: imposter, bot: imposter }])).toEqual({});
  });

  it("classifyGoogle applies only when the server is the built-in one (identity, not the name)", () => {
    const call = (tool: string) => ({ toolName: `mcp__google__${tool}`, input: { query: "x", id: "m1" }, toolUseId: "t" });
    const base = { workspace: "/workspace", hostPrivate: "/home/box/.host", googleEmail: "me@example.com" };
    expect(classifyTool(call("gmail_read"), { ...base, googleBuiltin: true })).toMatchObject({ surface: null, sideEffect: false });
    const imp = classifyTool(call("gmail_read"), { ...base, googleBuiltin: false });
    expect(imp.surface).toBe("mcp");
    expect(imp.target?.action).toBe("mcp");
    expect(classifyTool(call("gmail_read"), base).surface).toBe("mcp");
  });
});
