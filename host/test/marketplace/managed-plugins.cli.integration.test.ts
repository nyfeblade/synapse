import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { buildBotQueryOptions } from "../../brain/spawn-options";
import { loadConfig } from "../../config";
import { PluginMarketplaces } from "../../marketplace/plugin-marketplaces";
import { McpRegistry } from "../../mcp/registry";
import { HostSettingsStore } from "../../store/host-settings";
import { execFileSync } from "node:child_process";

/**
 * Final secfix round 2 (ruling B), on the Mac with the SDK's bundled CLI (RUN_CLAUDE=1; stops at the init message,
 * before any model request, in a throwaway HOME): the skills plugin PluginMarketplaces stages is loaded by the CLI's
 * real --plugin-dir mechanism (buildBotQueryOptions `plugins`) with settingSources [], namespaced <plugin>:<skill>.
 */
describe.runIf(process.env.RUN_CLAUDE === "1")("managed skills reach the real CLI via --plugin-dir", () => {
  it("lists <plugin>:<skill> in the init message", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secfix2-cli-")));
    const repo = path.join(tmp, "repo");
    const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
    w(".claude-plugin/marketplace.json", JSON.stringify({ name: "Probe", plugins: [{ name: "garden", source: "./plugins/garden" }] }));
    w("plugins/garden/skills/water/SKILL.md", "---\nname: water\ndescription: Water the plants\n---\nWater.\n");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
    const reg = new McpRegistry({ dir: path.join(tmp, "mcp"), settings: new HostSettingsStore(path.join(tmp, "s.json")), now: () => 1 });
    const pm = new PluginMarketplaces({ dir: path.join(tmp, "mkt"), managedDir: path.join(tmp, "cc-managed"), registry: reg, now: () => 1, allowFileUrls: true });
    await pm.add(`file://${repo}`);
    await pm.install("mkt:probe/garden");
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const ac = new AbortController();
    const cfg = loadConfig({ BOX_HOME: home, WORKSPACE: tmp });
    const o = buildBotQueryOptions({
      cfg, flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: null, systemAppend: "", model: "claude-haiku-4-5-20251001",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") }, mcpServers: {}, botToolNames: [], hooks: {},
      canUseTool: async () => ({ behavior: "deny", message: "probe" }), abortController: ac, plugins: pm.cliPlugins(),
    });
    delete o.pathToClaudeCodeExecutable; // the SDK's bundled CLI on the Mac
    let skills: string[] = [];
    const t = setTimeout(() => ac.abort(), 30_000);
    try {
      for await (const m of query({ prompt: "hi", options: { ...o, persistSession: false } })) {
        if (m.type === "system" && m.subtype === "init") { skills = m.skills; ac.abort(); break; }
      }
    } catch { /* aborted after init */ }
    clearTimeout(t);
    expect(o.settingSources).toEqual([]);
    expect(skills).toContain("garden:water");
  }, 60_000);
});
