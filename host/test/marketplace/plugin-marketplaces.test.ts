import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PluginMarketplaces, normalizeSource, withSourceMetadata } from "../../marketplace/plugin-marketplaces";
import { McpRegistry } from "../../mcp/registry";
import { HostSettingsStore } from "../../store/host-settings";

function fixtureRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-repo-"));
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
  w(".claude-plugin/marketplace.json", JSON.stringify({ name: "Garden Plugins", owner: { name: "Ana" }, plugins: [
    { name: "garden-tools", source: "./plugins/garden-tools", description: "Water and weather helpers", category: "productivity" },
    { name: "escape", source: "../../etc", description: "tries to escape the repo" },
  ] }));
  w("plugins/garden-tools/.claude-plugin/plugin.json", JSON.stringify({ name: "garden-tools", description: "Water and weather helpers" }));
  w("plugins/garden-tools/skills/water/SKILL.md", "---\nname: water\ndescription: Water the plants\n---\nSteps…\n");
  w("plugins/garden-tools/.mcp.json", JSON.stringify({ mcpServers: { garden: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] }, weather: { type: "http", url: "https://weather.example/mcp" } } }));
  w("plugins/garden-tools/hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: [] } }));
  w("plugins/garden-tools/server.js", "// stub\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return repo;
}

let dir: string;
let pm: PluginMarketplaces;
let reg: McpRegistry;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-"));
  reg = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1 });
  pm = new PluginMarketplaces({ dir: path.join(dir, "marketplaces"), managedDir: path.join(dir, "managed"), registry: reg, now: () => 9, allowFileUrls: true });
});

describe("plugin marketplaces (D8-A, PLG-10)", () => {
  it("normalizes sources and rejects file URLs unless allowed", () => {
    expect(normalizeSource("anthropics/claude-plugins", false)).toBe("https://github.com/anthropics/claude-plugins.git");
    expect(normalizeSource("https://gitlab.com/a/b.git", false)).toBe("https://gitlab.com/a/b.git");
    expect(() => normalizeSource("file:///tmp/x", false)).toThrow(/GitHub/);
    expect(() => normalizeSource("rm -rf /", false)).toThrow(/GitHub/);
  });

  it("adds a marketplace and lists its plugins; path-escaping sources are skipped", async () => {
    const m = await pm.add(`file://${fixtureRepo()}`);
    expect(m).toMatchObject({ name: "garden-plugins", pluginCount: 1, error: null });
    expect(pm.list()).toEqual([{ id: "mkt:garden-plugins/garden-tools", name: "garden-tools", description: "Water and weather helpers", category: "Productivity", toolCount: undefined, marketplace: "garden-plugins" }]);
  });

  it("install copies skills with source metadata and registers MCP servers; hooks are never loaded", async () => {
    await pm.add(`file://${fixtureRepo()}`);
    const id = "mkt:garden-plugins/garden-tools";
    expect(pm.hasCommandServer(id)).toBe(true);
    const r = await pm.install(id);
    expect(r.serverIds.sort()).toEqual(["garden", "weather"]);
    const skill = fs.readFileSync(path.join(dir, "managed", "skills", "garden-tools", "skills", "water", "SKILL.md"), "utf8");
    expect(skill).toContain("metadata:\n  source: plugin:garden-tools");
    const root = path.join(dir, "managed", "plugins", "garden-tools");
    expect(reg.commandServerConfigs().garden).toEqual({ type: "stdio", command: "node", args: [`${root}/server.js`], env: {} });
    expect(reg.get("weather")).toMatchObject({ kind: "remote", url: "https://weather.example/mcp", catalogId: id, source: "marketplace" });
    expect(fs.existsSync(path.join(dir, "managed", "skills", "garden-tools", "skills", "hooks"))).toBe(false);
    expect(pm.isInstalled(id)).toBe(true);
    await pm.uninstall(id);
    expect(fs.existsSync(path.join(dir, "managed", "skills", "garden-tools"))).toBe(false);
    expect(reg.list()).toEqual([]);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("adds metadata inside an existing metadata block", () => {
    expect(withSourceMetadata("---\nname: a\nmetadata:\n  managed: true\n---\nbody", "plugin:x")).toBe("---\nname: a\nmetadata:\n  source: plugin:x\n  managed: true\n---\nbody");
    expect(withSourceMetadata("no front matter", "plugin:x")).toBe("---\nmetadata:\n  source: plugin:x\n---\nno front matter");
  });
});
