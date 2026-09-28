import fs from "node:fs";
import path from "node:path";
import type { HostConfig } from "../../../config";
import { BOT_FLAG_SETTINGS, BOT_MANAGED_SETTINGS } from "../../spawn-options";
import { runProbe } from "../probe";
import type { CheckOutcome, ConformanceCheck } from "../types";

export const CT20_PLUGIN = "bots-ct20-probe";
export const CT20_SKILL = "bots-ct20-probe";
const WORD = "MARMALADE-20";
const CONTENT = `---\nname: ${CT20_SKILL}\ndescription: Use this when asked for the CT-20 probe word.\n---\nThe probe word is ${WORD}. Reply with exactly that word.\n`;
const DIR_MODE = 0o2750;
const FILE_MODE = 0o640;

/** Final secfix round 4 (ruling 1): no "user" settingSource fallback any more. A failure is reported, nothing switches. */
export function judgeCt20(o: { loaded: boolean }): CheckOutcome {
  if (o.loaded) return { status: "pass", detail: "managed plugin skills load with settingSources []" };
  return { status: "fail", detail: "a managed --plugin-dir skill did not load with settingSources []; Bots read SKILL.md from the catalog path instead" };
}

function managedSkillsBase(cfg: HostConfig): string {
  return path.join(cfg.ccManagedDir ?? path.join(cfg.hostPrivate, "cc-managed"), "skills");
}

function mkdir(d: string): void {
  fs.mkdirSync(d, { mode: DIR_MODE });
  fs.chmodSync(d, DIR_MODE);
}

function writeFile(f: string, text: string): void {
  fs.writeFileSync(f, text, { mode: FILE_MODE, flag: "wx" });
  fs.chmodSync(f, FILE_MODE);
}

/**
 * Installs the CT-20 probe as a skills-only plugin in the host-owned managed tree (<ccManagedDir>/skills, bothost:bots
 * 2750, box can read, not write), the same shape PluginMarketplaces.install() writes and the Bot CLI loads via
 * --plugin-dir. The tree isn't box-writable, so plain fs calls as the host user are safe here.
 */
export function installCt20Plugin(cfg: HostConfig): string {
  const base = managedSkillsBase(cfg);
  fs.mkdirSync(base, { recursive: true, mode: DIR_MODE });
  const dir = path.join(base, CT20_PLUGIN);
  fs.rmSync(dir, { recursive: true, force: true });
  mkdir(dir);
  mkdir(path.join(dir, ".claude-plugin"));
  writeFile(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: CT20_PLUGIN, version: "0.0.0", description: "CT-20 conformance probe" }, null, 2));
  mkdir(path.join(dir, "skills"));
  mkdir(path.join(dir, "skills", CT20_SKILL));
  writeFile(path.join(dir, "skills", CT20_SKILL, "SKILL.md"), CONTENT);
  return dir;
}

export function removeCt20Plugin(cfg: HostConfig): void {
  fs.rmSync(path.join(managedSkillsBase(cfg), CT20_PLUGIN), { recursive: true, force: true });
}

/** CT-20: does a session with the Bot's own options (settingSources [], lockdown settings) load a managed plugin skill? */
export const ct20: ConformanceCheck = {
  id: "CT-20", title: "Managed plugin skills load with settingSources []", onThrow: {},
  async run(ctx) {
    const dir = installCt20Plugin(ctx.cfg);
    const prompt = `Use the Skill tool to load the skill "${CT20_PLUGIN}:${CT20_SKILL}", then reply with the probe word it contains and nothing else.`;
    try {
      const run = await runProbe(ctx, {
        prompt,
        options: {
          tools: ["Skill"], settingSources: [], settings: { ...BOT_FLAG_SETTINGS } as never, managedSettings: { ...BOT_MANAGED_SETTINGS } as never,
          plugins: [{ type: "local", path: dir, skipMcpDiscovery: true }],
          persistSession: false, canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }),
        },
        timeoutMs: 90_000,
      });
      return judgeCt20({ loaded: run.results.some((r) => String(r.result ?? "").includes(WORD)) });
    } finally {
      removeCt20Plugin(ctx.cfg);
    }
  },
};
