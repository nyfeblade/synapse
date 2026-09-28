import path from "node:path";
import type { CanUseTool, EffortLevel, HookCallbackMatcher, HookEvent, McpServerConfig, Options, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { PromptCacheTtl } from "@synapse/shared";
import type { HostConfig } from "../config";
import type { ConformanceFlags } from "./conformance/flags";
import { loadPrompt } from "../prompts/index";
import { validateSecretName } from "../secrets/secret-names";
import { log } from "../util/log";
import { BOT_BUILTIN_TOOLS, DISALLOWED_TOOLS, TOOL_SEARCH, claudeExecutableFor } from "./tool-policy";
import { applyCacheEnv } from "./cache-env";
import { applySentinel, scrubClaudeAuth } from "../auth/auth-env";
import { gitShimDir } from "./git-shim";
import { botOsUser } from "../walls/bot-uid";

export interface BotSpawnParams {
  cfg: HostConfig;
  flags: ConformanceFlags;
  resumeSessionId: string | null;
  newSessionId: string | null;
  systemAppend: string;
  /** BRAIN-03 switch; omitted = "standalone", the default since 2026-09-21. A child passes "preset". */
  systemPromptMode?: SystemPromptMode;
  model: string;
  /** Reasoning effort for this Bot. Absent = SDK default (high). */
  effort?: EffortLevel;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
  /** The "bot" MCP server's own tool names (e.g. "SendMessage"), unprefixed — buildBotQueryOptions
   *  namespaces and folds them into the `tools` allowlist alongside the CLI built-ins. Without this,
   *  the real CLI rejects them with "No such tool available: mcp__bot__<name>": the conformance
   *  probes (host/brain/conformance/context.ts's baseOptions) set no `tools` restriction at all and
   *  their own MCP tools are reachable, but a real bot turn's `tools: [...BOT_BUILTIN_TOOLS]"`
   *  allowlist named only built-ins, silently excluding every mcp__bot__* tool including SendMessage
   *  itself (Task 34 Step 2's live re-run against the box). */
  botToolNames: string[];
  /** TOOL-13: a child's own built-in tool list; defaults to `BOT_BUILTIN_TOOLS`. */
  tools?: string[];
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  canUseTool: CanUseTool;
  abortController: AbortController;
  spawnProcess?: (o: SpawnOptions) => SpawnedProcess;
  stderr?: (data: string) => void;
  /** Phase 5: extra tools to disallow for this spawn only (e.g. a connector's send-type tools while unauthorized). */
  extraDisallowed?: string[];
  /** Final secfix round 2 (ruling B): managed skills plugins under the bothost-owned tree, loaded by the CLI's own
   *  --plugin-dir (works with settingSources []). The host owns their MCP servers, so discovery is off. */
  plugins?: string[];
  /** Lean engineering profile: the CLI's per-skill listing overrides, merged into the flag settings. Absent = unchanged. */
  skillOverrides?: Record<string, "on" | "name-only" | "user-invocable-only" | "off">;
  /** cost-diet-2 lever 2: a Bot's own built-in list (an everyday Bot has no Bash); absent = BOT_BUILTIN_TOOLS. */
  builtinTools?: readonly string[];
}

/**
 * Ruling (2): a repo's own .git/config can run programs on a fast-path `git status`/`diff` (core.fsmonitor,
 * diff.external, core.pager, core.sshCommand, core.hooksPath). GIT_CONFIG_* env overrides take precedence over
 * every config file, so we pin these keys to inert values. Keys named by the repo (a filter or diff driver, a remote,
 * an alias) are pinned per call by the git shim (git-shim.ts).
 */
/**
 * The pinned diff.external: git's own patch, never a repo's program. An empty value (the first pin) made every
 * plain `git diff`/`git show` die with "cannot run :" (2026-09-21 coding bench: 4-5 wasted model calls a task).
 * No env var can unset diff.external, so the pin is a differ that re-runs git's built-in diff on the two files
 * git hands it (`--no-ext-diff --no-index`, so it never recurses into itself) and relabels the temp-file headers
 * with the real path. git runs it through `sh -c '<this> "$@"'` with path, old-file, old-hex, old-mode,
 * new-file, new-hex, new-mode; anything else (an unmerged path) prints nothing. It always exits 0: a nonzero
 * exit makes git stop at that file.
 */
export const GIT_BUILTIN_DIFF =
  `f() { [ "$#" -eq 7 ] || exit 0; git diff --no-ext-diff --no-index -- "$2" "$5" | awk -v p="$1" `
  + `'h==0&&/^diff --git /{print "diff --git a/" p " b/" p; next} `
  + `BEGIN{t=index(p," ")?"\\t":""} `
  + `h==0&&/^--- /{print ($2=="/dev/null") ? $0 : "--- a/" p t; next} `
  + `h==0&&/^\\+\\+\\+ /{print ($2=="/dev/null") ? $0 : "+++ b/" p t; h=1; next} {print}'; exit 0; }; f`;

const GIT_NEUTRAL: [string, string][] = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.pager", "cat"],
  ["diff.external", GIT_BUILTIN_DIFF],
  ["core.sshCommand", "ssh"],
  // Security re-review item 1: `git log`/`show` verify a commit's gpgsig header with gpg.program (or the
  // per-format program) when the format asks for it (%G?, %GS, %GK) or log.showSignature is true.
  ["log.showSignature", "false"],
  ["gpg.program", "/bin/false"],
  ["gpg.openpgp.program", "/bin/false"],
  ["gpg.x509.program", "/bin/false"],
  ["gpg.ssh.program", "/bin/false"],
  ["gpg.ssh.defaultKeyCommand", "/bin/false"],
  // pager.<cmd> beats core.pager for that command; GIT_PAGER (set below) beats both.
  ["pager.status", "false"],
  ["pager.log", "false"],
  ["pager.diff", "false"],
  ["pager.show", "false"],
  ["pager.branch", "false"],
  ["pager.remote", "false"],
  // core.editor / sequence.editor aren't reached by the fast path; the transports are network-only.
  ["protocol.ext.allow", "never"],
  // bug-log 121 (shared /workspace repos are trusted, git-shim.ts): every other FIXED-name key that runs a
  // program from a repo's config. Keys named by the repo (drivers, remotes, aliases, …) are the shim's.
  ["core.editor", ":"],
  ["sequence.editor", ":"],
  ["core.askPass", ""],
  ["core.gitProxy", "none"],
  ["core.alternateRefsCommand", "true"],
  ["credential.helper", ""],
  ["init.templateDir", ""],
  ["interactive.diffFilter", "cat"],
  ["uploadpack.packObjectsHook", ""],
];

/** The fixed-name pins, for tests and the audit list (decisions.md). */
export const GIT_NEUTRAL_KEYS: readonly string[] = Object.freeze(GIT_NEUTRAL.map(([k]) => k));

export interface BotEnvParams {
  cfg: HostConfig;
  botId: string;
  /** The Bot's vault secrets (names re-validated here, I4). */
  secrets?: Record<string, string>;
  /** Host-generated display env (DISPLAY, BOT_CDP_PORT). */
  display?: Record<string, string>;
  /**
   * Bug #66: the real Bot this process works for. Once the box runs per-Bot accounts (cfg.perBotUid), the process
   * runs as that Bot's own account: its HOME, its CLAUDE_CONFIG_DIR, and BOT_UNIX_USER for the root helpers. Absent
   * (host-internal calls: reviewer, memory, helper, compiler, coding git) = the shared service uid box.
   */
  asBot?: string;
  /** saving-settings "Keep conversations ready": the prompt-cache TTL (default 1h, cache-env.ts). */
  promptCacheTtl?: PromptCacheTtl;
}

function accountEnv(p: BotEnvParams): Record<string, string> {
  const u = p.asBot ? botOsUser(p.cfg, p.asBot) : null;
  // BOT_ACCOUNT_OF names the account's Bot: bot-claude-as-box checks it against the account's GECOS.
  return u ? { HOME: u.home, USER: u.name, CLAUDE_CONFIG_DIR: u.claudeConfigDir, BOT_UNIX_USER: u.name, BOT_ACCOUNT_OF: p.asBot! } : {};
}

/**
 * BRAIN-07 + security fix C1/I4 (06:45 rulings): the ONE env builder for the CLI, child subagent sessions,
 * background Shell (and its bot-shell EnvironmentFile) and compaction. Display env and secrets are spread
 * FIRST; the fixed keys and every GIT_CONFIG_* pin are written LAST, so nothing a Bot stores can override
 * them. Secret names are validated again here: invalid or stale ones are dropped and logged by name only.
 */
export function buildBotEnv(p: BotEnvParams): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(p.secrets ?? {})) {
    if (validateSecretName(name)) log.warn("secret left out of the env: its name is not allowed", { botId: p.botId, name });
    else secrets[name] = value;
  }
  const env: Record<string, string> = {
    ...(p.display ?? {}),
    ...secrets,
    // bug-log 121: the host's git shim first (trusts /workspace repos, neutralizes repo-named exec keys).
    PATH: [gitShimDir(p.cfg), "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":"),
    HOME: p.cfg.boxHome,
    LANG: "C.UTF-8",
    USER: "box",
    CLAUDE_CONFIG_DIR: p.cfg.claudeConfigDir,
    BOT_ID: p.botId,
    ...accountEnv(p),
    // Lazy tools: connector tool schemas are deferred and loaded by ToolSearch on the turn that needs
    // them. "true", not "auto": the saving is the point even under the auto threshold. The host's own
    // tools opt out per tool (alwaysLoad), so SendMessage is always there (phase0-findings #3).
    ENABLE_TOOL_SEARCH: "true",
    // synapse-public: claude.ai connectors come with a Claude login, which no Bot has; the CLI never fetches them.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
  // synapse-public: no Claude login ever reaches a process (auth-env.ts CLAUDE_AUTH_SCRUB); the API key (a proxy token)
  // is added per call by prepareAuthEnv, so a background Shell built here never holds it either. Until then the env
  // carries the dead sentinel pair (review round 2, S1), so a claude run from a Shell can't fall back to a stored login.
  applySentinel(scrubClaudeAuth(env));
  applyCacheEnv(env, p.promptCacheTtl); // token diet (3): 1-hour prompt cache unless the user chose 5 minutes, see cache-env.ts
  for (const k of Object.keys(env)) if (k.startsWith("GIT_CONFIG")) delete env[k];
  env.GIT_PAGER = "cat";
  env.GIT_CONFIG_COUNT = String(GIT_NEUTRAL.length);
  GIT_NEUTRAL.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

/**
 * Final secfix round 3 (ruling 5) + round 4 (ruling 1): the "flag settings" every Bot CLI (and the CT-20 probe) runs
 * with. settingSources is always [] now, so ~/.claude/settings.json (box-writable) is never read; these keys are the
 * second line. The flag tier's object keys merge additively (an empty `hooks: {}` can't cancel a lower tier's hooks),
 * so the scalars decide: disableAllHooks is honored from the flag tier (probed on CLI 2.1.277: a hostile user
 * settings.json hook fires with the round-3 settings + the "user" source, and doesn't with disableAllHooks here).
 * The SDK's own callback hooks (the host's TurnHooks) still run. autoMemoryEnabled must stay here (CT-05).
 */
export const BOT_FLAG_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
  autoMemoryEnabled: false,
  enabledPlugins: {},
  extraKnownMarketplaces: {},
  hooks: {},
  disableAllHooks: true,
  disableCommandPluginSources: true,
});

/**
 * Final secfix round 4 (ruling 1): the SDK managedSettings tier (--managed-settings) keeps restrictive keys only and
 * drops disableAllHooks, but the CLI reads disableCommandPluginSources from the policy tier alone, so it goes here too.
 */
export const BOT_MANAGED_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
  disableCommandPluginSources: true,
});

export type SystemPromptMode = "preset" | "standalone";

/**
 * BRAIN-03 + Engineering mode (user decision 2026-09-21). Which prompt this Bot's session starts from:
 * Engineering mode ON is always the preset (Claude Code's full prompt, our Bot prompt appended);
 * OFF is the standalone prompt, unless the box owner forced the preset (SYNAPSE_SYSTEM_PROMPT=preset) and
 * did not keep this Bot on standalone. Read once per spawn; the mode is part of the spawn key
 * (host/app.ts), so a switch respawns the warm process on the next turn with the session resumed.
 */
export function systemPromptModeFor(cfg: Pick<HostConfig, "systemPromptMode" | "standalonePromptBotIds">, botId: string, engineeringMode = false): SystemPromptMode {
  if (engineeringMode) return "preset";
  if (cfg.systemPromptMode === "standalone") return "standalone";
  return cfg.standalonePromptBotIds.includes(botId) ? "standalone" : "preset";
}

/**
 * The one place either prompt is assembled, shared by a Bot spawn and by the CT probes so the two
 * paths are compared under the same text. "standalone" puts prompts/standalone.md — static, identical
 * for every Bot, so it is the cacheable head of the block — in front of the byte-identical
 * `<BotPrompt>` the preset path would have appended. Nothing downstream can tell the difference:
 * TurnRunner still renders one `systemAppend`, and the spawn key still keys on it.
 */
export function buildSystemPrompt(mode: SystemPromptMode, append: string): Options["systemPrompt"] {
  if (mode !== "standalone") return { type: "preset", preset: "claude_code", append };
  const standalone = loadPrompt("standalone.md").trim();
  return append.trim() ? `${standalone}\n\n${append}` : standalone;
}

export function buildBotQueryOptions(p: BotSpawnParams): Options {
  const strict = p.flags.isolationLevel >= 2;
  const o: Options = {
    cwd: strict ? path.join(p.cfg.boxHome, ".bot-cwd") : p.cfg.workspace,
    additionalDirectories: strict ? [p.cfg.workspace] : [],
    // Final secfix round 4 (ruling 1): never any setting source; managed skills load through --plugin-dir.
    settingSources: [],
    // CT-05: managedSettings is filtered restrictive-only and silently drops non-restrictive keys
    // like autoMemoryEnabled; Options.settings (the "flag settings" tier) is not filtered.
    settings: { ...BOT_FLAG_SETTINGS, ...(p.skillOverrides ? { skillOverrides: { ...p.skillOverrides } } : {}) } as Options["settings"],
    managedSettings: { ...BOT_MANAGED_SETTINGS } as Options["managedSettings"],
    systemPrompt: buildSystemPrompt(p.systemPromptMode ?? "standalone", p.systemAppend),
    model: p.model,
    ...(p.effort ? { effort: p.effort } : {}),
    // A child keeps exactly its own list: its servers ("bot", "computer") are all alwaysLoad.
    tools: p.tools ? [...p.tools] : [...(p.builtinTools ?? BOT_BUILTIN_TOOLS), TOOL_SEARCH, ...p.botToolNames.map((n) => `mcp__bot__${n}`)],
    disallowedTools: [...DISALLOWED_TOOLS, ...p.flags.extraDisallowed, ...(p.extraDisallowed ?? [])],
    permissionMode: "default",
    includePartialMessages: true,
    persistSession: true,
    mcpServers: p.mcpServers,
    hooks: p.hooks,
    canUseTool: p.canUseTool,
    env: p.env,
    abortController: p.abortController,
    pathToClaudeCodeExecutable: claudeExecutableFor(p.flags.runAs, p.cfg),
  };
  if (p.plugins?.length) o.plugins = p.plugins.map((dir) => ({ type: "local", path: dir, skipMcpDiscovery: true }));
  if (p.spawnProcess) o.spawnClaudeCodeProcess = p.spawnProcess;
  if (p.stderr) o.stderr = p.stderr;
  if (p.resumeSessionId) o.resume = p.resumeSessionId;
  else if (p.newSessionId && p.flags.sessionIdOption) o.sessionId = p.newSessionId;
  return o;
}
