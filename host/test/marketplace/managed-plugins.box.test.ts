import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { buildBotEnv, buildBotQueryOptions } from "../../brain/spawn-options";
import { loadConfig } from "../../config";
import { PluginMarketplaces } from "../../marketplace/plugin-marketplaces";
import { McpRegistry } from "../../mcp/registry";
import { HostSettingsStore } from "../../store/host-settings";

/**
 * Final secfix round 2 (ruling B), run IN THE BOX as bothost after provision.sh (RUN_BOX=1):
 * a marketplace plugin installs into the bothost-owned /var/lib/bots/cc-managed tree, the Bot CLI (as user box,
 * through /usr/local/bin/bot-claude with settingSources []) lists its skill via --plugin-dir, and nothing in the
 * tree is group/other-writable. The init message comes before any model request, so no OAuth token is used.
 */
describe.runIf(process.env.RUN_BOX === "1")("managed plugins tree (box)", () => {
  it("installs under cc-managed (bothost:bots 2750/0640), the box CLI loads the skill, box can't write it", async () => {
    const cfg = loadConfig(process.env);
    const managedDir = cfg.ccManagedDir!;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secfix2-box-"));
    const name = `boxprobe-${Date.now().toString(36)}`;
    const repo = path.join(tmp, "repo");
    const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
    w(".claude-plugin/marketplace.json", JSON.stringify({ name: "Box Probe", plugins: [{ name, source: `./plugins/${name}` }] }));
    w(`plugins/${name}/skills/wave/SKILL.md`, "---\nname: wave\ndescription: Wave hello the managed way\n---\nWave.\n");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
    const reg = new McpRegistry({ dir: path.join(tmp, "mcp"), settings: new HostSettingsStore(path.join(tmp, "s.json")), now: () => 1 });
    const pm = new PluginMarketplaces({ dir: path.join(tmp, "marketplaces"), managedDir, registry: reg, now: Date.now, allowFileUrls: true });
    await pm.add(`file://${repo}`);
    await pm.install(`mkt:box-probe/${name}`);
    try {
      const plug = path.join(managedDir, "skills", name);
      expect(pm.cliPlugins()).toContain(plug);
      const bots = Number(execFileSync("getent", ["group", "bots"]).toString().split(":")[2]);
      for (const d of [managedDir, path.join(managedDir, "skills"), plug]) {
        const st = fs.statSync(d);
        expect([st.uid, st.gid, st.mode & 0o7777], d).toEqual([process.getuid!(), bots, 0o2750]);
      }
      expect(fs.statSync(path.join(plug, "skills", "wave", "SKILL.md")).mode & 0o777).toBe(0o640);

      const ac = new AbortController();
      const options = buildBotQueryOptions({
        cfg, flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: null, systemAppend: "", model: "claude-haiku-4-5-20251001",
        env: buildBotEnv({ cfg, botId: "secfix2-box" }), mcpServers: {}, botToolNames: [], hooks: {},
        canUseTool: async () => ({ behavior: "deny", message: "probe" }), abortController: ac, plugins: [plug],
      });
      let skills: string[] = [];
      const timer = setTimeout(() => ac.abort(), 60_000);
      try {
        for await (const m of query({ prompt: "hi", options: { ...options, persistSession: false } })) {
          if (m.type === "system" && m.subtype === "init") { skills = m.skills; ac.abort(); break; }
        }
      } catch { /* aborted after init */ }
      clearTimeout(timer);
      expect(skills).toContain(`${name}:wave`);

      // box (group bots, not the owner) can read and never write: no group/other write bit anywhere in the tree.
      // verify-box.sh checks the same thing live as user box (touch / rm must fail).
      expect(execFileSync("find", [plug, "-perm", "/022"]).toString()).toBe("");
    } finally {
      await pm.uninstall(`mkt:box-probe/${name}`);
    }
    expect(fs.existsSync(path.join(managedDir, "skills", name))).toBe(false);
  }, 120_000);
});
