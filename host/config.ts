import path from "node:path";
import { LIMITS, envSetting } from "@synapse/shared";

export interface HostConfig {
  boxHome: string;
  dataRoot: string;
  hostPrivate: string;
  workspace: string;
  claudeConfigDir: string;
  /**
   * Bug #66: every Bot runs as its own OS account (walls/bot-uid.ts). Off until box/migrate-per-bot-uid.sh sets
   * SYNAPSE_PER_BOT_UID=1 in /etc/bothost.env; its rollback unsets it.
   */
  perBotUid: boolean;
  /** Bug #66: where the per-Bot homes live (/home/bots on the box; overridable for tests only). */
  botHomes: string;
  /** Final secfix round 2 (ruling B): the bothost-owned tree for managed plugins and skills (box reads, never writes). */
  ccManagedDir?: string;
  bind: string;
  port: number;
  brain: "claude" | "fake";
  reviewer: "sdk" | "stub";
  /**
   * BRAIN-03 switch, the box-wide default for a Bot whose Engineering mode is OFF. "standalone" (the
   * default since 2026-09-21) runs this host's own complete prompt (prompts/standalone.md) followed by
   * `<BotPrompt>`. "preset" starts from the vendor preset with the same `<BotPrompt>` appended. A Bot
   * with Engineering mode ON always runs the preset (see systemPromptModeFor).
   *
   *   SYNAPSE_SYSTEM_PROMPT=preset                escape hatch: every OFF Bot back on the preset
   *   SYNAPSE_SYSTEM_PROMPT_BOTS=<id>[,<id>…]     under the escape hatch, keep those Bots on standalone
   *
   * Set in /etc/bothost.env and restart the host; unset it to return to standalone. Children
   * (subagents) and compaction stay on the preset regardless; see brain/spawn-options.ts.
   */
  systemPromptMode: "preset" | "standalone";
  /** Bot ids kept on the standalone prompt while `systemPromptMode` is "preset" (per-Bot A/B). */
  standalonePromptBotIds: string[];
  /**
   * Bug 142, the voice fast path: on a 1:1 call the Bot's voice (a lean front session) answers each utterance and
   * delegates real work to the full session. SYNAPSE_VOICE_FAST_PATH=off returns to a full-session turn per utterance.
   */
  voiceFastPath: boolean;
  /**
   * Bug 117, the auth proxy (auth/proxy.ts): Claude processes get ANTHROPIC_BASE_URL = 127.0.0.1:port and a per-spawn
   * proxy token, never the real API key. SYNAPSE_AUTH_PROXY=off turns it off in a test run only (VITEST set).
   */
  authProxy: { enabled: boolean; port: number; upstream: string };
  executables: { setpriv: string; bwrap: string };
  webhookBind: string;
  webhookPort: number;
  /**
   * Test/fuzz only: report this free-space percentage instead of statfs'ing the real filesystem.
   * DiskGuard's poll runs from Phase 3's boot() and, under pressure, creates the Disk Saver Bot
   * (CMP-15 → BOT-16). Without this seam every host-app test's Bot list depended on how full the
   * developer's own Mac happened to be, which is what made app-journey pass and fail on one commit.
   */
  diskFreePct?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const boxHome = env.BOX_HOME ?? "/home/box";
  const hostPrivate = env.HOST_PRIVATE ?? path.join(boxHome, ".host");
  return {
    boxHome,
    dataRoot: env.DATA_ROOT ?? path.join(boxHome, "agent-data"),
    hostPrivate,
    workspace: env.WORKSPACE ?? "/workspace",
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? path.join(boxHome, ".claude"),
    perBotUid: envSetting(env, "PER_BOT_UID") === "1",
    botHomes: env.BOT_HOMES ?? "/home/bots",
    ccManagedDir: envSetting(env, "CC_MANAGED") ?? "/var/lib/bots/cc-managed",
    bind: env.HOST_BIND ?? "127.0.0.1",
    port: env.HOST_PORT !== undefined ? Number(env.HOST_PORT) : LIMITS.gatewayPort,
    brain: env.BRAIN === "fake" ? "fake" : "claude",
    reviewer: env.REVIEWER === "stub" ? "stub" : "sdk",
    systemPromptMode: envSetting(env, "SYSTEM_PROMPT") === "preset" ? "preset" : "standalone",
    standalonePromptBotIds: (envSetting(env, "SYSTEM_PROMPT_BOTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    voiceFastPath: envSetting(env, "VOICE_FAST_PATH") !== "off",
    authProxy: {
      // Fail closed: off only in a test run (VITEST set); a production host refuses it and keeps the proxy on.
      enabled: envSetting(env, "AUTH_PROXY") !== "off" || !env.VITEST,
      port: envSetting(env, "AUTH_PROXY_PORT") !== undefined ? Number(envSetting(env, "AUTH_PROXY_PORT")) : LIMITS.authProxyPort,
      upstream: envSetting(env, "AUTH_PROXY_UPSTREAM") ?? "https://api.anthropic.com",
    },
    executables: { setpriv: "/usr/local/bin/bot-claude", bwrap: "/usr/local/bin/bot-claude-bwrap" },
    webhookBind: env.WEBHOOK_BIND ?? "127.0.0.1", // I5: loopback by default; LAN only via an explicit setting
    webhookPort: env.WEBHOOK_PORT !== undefined ? Number(env.WEBHOOK_PORT) : LIMITS.webhookPort,
    ...(env.DISK_FREE_PCT !== undefined && Number.isFinite(Number(env.DISK_FREE_PCT)) ? { diskFreePct: Number(env.DISK_FREE_PCT) } : {}),
  };
}
