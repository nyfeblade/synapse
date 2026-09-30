import type { AvatarShape, BotSummary } from "./bots";
import type { ModelId } from "./models";
import type { PermAction, PermMode } from "./perm-rules";
import type { ComputerPerception } from "./computer";
import type { SavingsEstimates } from "./savings";
import { browserBindTarget, type BrowserArgs, type BrowserSessionCardView, type BrowserUsageView } from "./browser";
import { macAppBindTarget, type MacAppArgs } from "./macapp";

type None = Record<string, never>;

// ---------- Marketplace (PLG-01…12, D8-A, §4.3 Catalog entry) ----------
export type CatalogKind = "plugin" | "bot-template";
export type CatalogSource = "curated" | "marketplace" | "starter" | "local-template" | "google";
export const CATALOG_CATEGORIES = ["Code", "Data", "Sales", "Finance", "Research", "Support", "Productivity", "Login and Credential Management"] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];
export interface CatalogAuthor { name: string; avatarUrl?: string }
/** "unavailable": an entry that can't be added here. */
export type CatalogState = "available" | "installed" | "connected" | "added" | "needs-auth" | "waiting-auth" | "unavailable";
export interface CatalogEntry {
  id: string;                       // "curated:linear", "mkt:<marketplace>/<plugin>", "starter:chief-of-staff", "tpl:<templateId>"
  kind: CatalogKind;
  source: CatalogSource;
  name: string;
  description: string;
  category: CatalogCategory | null;
  logo: string | null;              // data: URL; null renders the initials tile ("Gr", "1P")
  action: "add" | "connect";        // PLG-12
  author?: CatalogAuthor;           // TPL-04
  state: CatalogState;
  featured?: boolean;
  toolCount?: number;
}
export interface CatalogDetail { longDescription: string; tools: string[]; homepage: string | null; sourceLabel: string }
export interface MarketplaceView {
  installed: { count: number; logos: { name: string; logo: string | null }[] };
  featuredBots: CatalogEntry[];
  forYou: { because: string; entries: CatalogEntry[] } | null;
  fromTeam: CatalogEntry[];
  featuredPlugins: CatalogEntry[];
  categories: { name: CatalogCategory; entries: CatalogEntry[]; total: number }[];
}
export interface CatalogSearchResult { plugins: CatalogEntry[]; bots: CatalogEntry[] }

// ---------- MCP servers (PLG-02, 08, 09) ----------
export interface McpToolView { name: string; description: string; enabled: boolean }
/**
 * What the renderer is shown in place of a remote server's header value. The value itself is sealed
 * in the host's vault and is never sent to this process — see McpHeaderView.
 */
export const MCP_HEADER_REDACTED = "••••••••";
/**
 * PLG header auth: one request header a remote MCP server is sent. The NAME is not secret (a server
 * advertises the header it wants in `access-control-allow-headers`, and the user has to type it),
 * so the UI can list it. `value` is ALWAYS `MCP_HEADER_REDACTED` — the host reads it from the
 * server's on-disk header names and never from the sealed store, so there is nothing here to leak.
 */
export interface McpHeaderView { name: string; value: string }
export type McpServerStatus = "connected" | "needs-auth" | "waiting-auth" | "failed" | "disabled" | "unknown";
export interface McpServerView {
  id: string;                       // registry id = SDK server name (lowercase slug, "gmail-work")
  name: string;                     // display name ("Gmail")
  label: string | null;             // PLG-09 account label ("work")
  kind: "remote" | "command";
  status: McpServerStatus;
  catalogId: string | null;
  tools: McpToolView[];
  instructions: string;             // mcpCustomInstructions (≤500)
  error: string | null;
  /** P5 review I6: the user trusts this non-curated server (its readOnlyHint tools may skip Auto-review). */
  trusted?: boolean;
  /** Remote servers only: the request headers set on this server, each with a redacted stand-in for
   *  its value. Absent for command servers, which have no headers. */
  headers?: McpHeaderView[];
}
/**
 * `headers`: a remote server's request headers, name → value. EVERY VALUE IS TREATED AS A
 * CREDENTIAL. The host seals them in the vault on the way in (McpRegistry.add) and servers.json
 * keeps only `headerNames`, so no caller — the add-server form, a plugin marketplace's .mcp.json,
 * the Bot-facing AddMcpServer tool — has to know which of its headers is the secret one. Erring the
 * other way (a per-header "this one is secret" flag) would put that judgement on every caller, and
 * the one that got it wrong would write a key to disk in clear text with a green test suite.
 *
 * `env`: the same rule for a command server's environment.
 */
export interface AddMcpServerArgs { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; catalogId?: string }

/**
 * Slack's hosted MCP answers 401 with a Bearer challenge. People paste the User OAuth Token
 * (`xoxp-…`) from api.slack.com with no scheme. Prefix it; leave every other header as typed.
 */
export function normalizeMcpHeaderValue(name: string, value: string): string {
  if (!/^authorization$/i.test(name.trim())) return value;
  const v = value.trim();
  if (/^bearer\s+/i.test(v)) return `Bearer ${v.replace(/^bearer\s+/i, "")}`;
  if (/^xox[pbea]-/i.test(v)) return `Bearer ${v}`;
  if (/^(ghp_|github_pat_)/i.test(v)) return `Bearer ${v}`;
  return value;
}
export interface PluginMarketplaceView { name: string; source: string; pluginCount: number; updatedAt: number; error: string | null }

// ---------- Usage (USE-01…06, ORIG-14) ----------
export type LadderLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export interface UsageBotRow { botId: string; name: string; model: ModelId; turns: number; tokens: number; costUsd: number }
export interface EfficiencyTiles { dropped: number; wakesAvoided: number; burstsCoalesced: number; loopsEnded: number }
/** What the host's model calls were for, grouped for the Usage view. Order is display order. */
export const USAGE_PURPOSE_GROUPS = ["conversations", "memory", "coding", "helpers"] as const;
export type UsagePurposeGroup = (typeof USAGE_PURPOSE_GROUPS)[number];
export interface UsagePurposeRow { group: UsagePurposeGroup; costUsd: number; calls: number; tokens: number }
/** A recorded call's purpose (host/usage/metered-query.ts) → its Usage view group. */
export function purposeGroup(purpose: string): UsagePurposeGroup {
  if (purpose === "turn" || purpose === "compaction") return "conversations";
  if (purpose === "extraction" || purpose === "episode" || purpose === "dreaming") return "memory";
  if (purpose === "coding") return "coding";
  return "helpers";
}
/** Rows written before per-run accounting held running totals; the host rebuilt them (2026-09-21 fix).
 *  `before` is the last such row's time; `estimated` counts rows whose own cost could not be derived exactly. */
export interface UsageCostHistory { repaired: number; estimated: number; before: number }
export interface UsageView {
  source: "rate_limit_event" | "metering";
  /** The share of the account's monthly budget spent; null when none is set. */
  budgetPct: number | null;
  level: LadderLevel;
  limitedUntil: number | null;
  weekStart: number;
  rows: UsageBotRow[];
  efficiency: EfficiencyTiles;
  /** How this week's prompt tokens were billed (cache read 0.1x / cache write 1.25x / uncached 1x).
   *  Optional: a host that predates the accounting simply omits it. */
  cache?: CachePrompts;
  /** This week's spend by kind of work (conversations vs background). Optional: older hosts omit it. */
  byPurpose?: UsagePurposeRow[];
  /** Present while this week includes figures rebuilt from pre-fix running totals. */
  costHistory?: UsageCostHistory | null;
  /** saving-settings: each Savings choice's measured weekly figure. Absent on older hosts (no figure is shown). */
  savings?: SavingsEstimates;
}

/** Prompt-token accounting. The static prefix a Bot re-sends every model call is ~30k tokens, so the
 *  split between these three is most of what the app costs to run. */
export interface CachePrompts {
  inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; promptTokens: number;
  /** Percentage of prompt tokens served from the cache; null before the first turn of the week. */
  hitRate: number | null;
  writeRate: number | null;
}

// ---------- Local execution (LOC-*) ----------
export type ExecutionPolicy = "always" | "ask" | "never";
export interface LocalComputer {
  computerId: string; label: string; isCurrent: boolean; executionPolicy: ExecutionPolicy; localRoot: string;
  /** Final secfix round 2 (ruling A): folders where an "Always" call may auto-run on this Mac. Missing/empty = none. */
  autoRunRoots?: string[];
  /** The Mac user's home (for ~ in a command); the host falls back to localRoot. */
  home?: string;
}
// feat-mac-access-parity: CLI-parity file ops (edit-file exact-string replace like Claude Code's Edit; glob; grep;
// read-file gains line ranges). run-command now runs in ANY directory the user can (full access), not only a root.
// mac-browser: "browser" = one Browser tool action in the Synapse window on the Mac (card action + grant key).
// mac-apps: "mac-app" = one MacApp tool action in an app on this Mac (card action + grant key).
export type LocalAction = "run-command" | "send-input" | "read-file" | "list-directory" | "write-file" | "edit-file" | "glob" | "grep" | "browser" | "mac-app";
export interface LocalExecRequest {
  execId: string;
  botId: string;
  approvalId: string | null;        // LOC-05: required when the policy is "ask"
  op: LocalAction | "copy-to-box" | "copy-from-box" | "kill" | "revoke-grants"; // revoke-grants: ruling (b), a deleted Bot's Mac grants go
  command?: string;
  path?: string;
  input?: string;
  content?: string;
  cwd?: string;
  boxPath?: string;
  timeoutMs?: number;
  /** read-file line range (1-based, inclusive). */
  offset?: number;
  limit?: number;
  /** edit-file: exact-string replace (Claude Code's Edit). */
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  /** glob/grep: the pattern, and grep's search root/glob filter. */
  pattern?: string;
  /** fix-fullauto-adoption: the Bot's mode as the HOST has it. The Mac never grants from it: a higher claim than the
   *  Mac's own record only raises the one-time adoption card (answered on the Mac); a lower claim caps the Mac's mode. */
  hostMode?: PermMode;
  /** Bug 258: whether the HOST has this Bot in No limits. Like hostMode it only ever restricts: false caps the Mac's
   *  own record; true grants nothing (only the Mac's record, written by the app's confirm, does). */
  hostNoLimits?: boolean;
  /** mac-browser (op "browser"): the Bot's action, its name (the window bar), whether the user gave the typed value
   *  in this very turn (the only way into a password or card field), and the turn (a Stop holds until a new user turn). */
  browser?: BrowserArgs;
  /** mac-apps (op "mac-app"): the Bot's action in an app on this Mac. */
  macapp?: MacAppArgs;
  botName?: string;
  explicit?: boolean;
  turn?: string;
  userTurn?: boolean;
}
export type LocalAskStatus = "pending" | "allowed" | "denied" | "always" | "never" | "expired";
export type LocalAskChoice = "always" | "once" | "never" | "deny";

// ---------- Templates (TPL-01…04) ----------
export interface TemplateManifest {
  profile: { name: string; title: string; description: string; avatarShape: AvatarShape; avatarColor: string; model?: ModelId };
  skills: { id: string; name: string; description: string }[];
  memories: string[];
  routines: { name: string; prompt: string; schedule: string | null }[];
  plugins: { catalogId: string; name: string }[];
}
export interface TemplateRecord { id: string; name: string; author?: CatalogAuthor; sourceBotId: string | null; visibility: "local"; createdAt: number; updatedAt: number; manifest: TemplateManifest; /** Bot sharing: saved from someone else's file, so adding it again is a third-party add. */ thirdParty?: boolean }
export interface StarterView { id: string; name: string; title: string; blurb: string; avatarShape: AvatarShape; avatarColor: string; tools: string[] }
export interface TemplatePreview {
  token: string;
  name: string;
  description: string;
  author?: CatalogAuthor;
  facts: string[];                  // "Facts it already knows"
  playbooks: string[];              // "Playbooks it can run"
  jobs: string[];                   // "Jobs that run on their own"
  apps: { name: string; needsConnecting: boolean }[];  // "Apps it can use"
  thirdParty: boolean;
  /** P5 review I10: playbooks install into the shared skills folder, so every Bot can use them (disclosed). */
  playbooksShared?: boolean;
  /** Bot sharing: a Bot from a share link or the website (always third-party; its skills stay with it). */
  share?: boolean;
  /** Bot sharing: the full instructions, shown as plain text. */
  instructions?: string;
  /** Bot sharing: each skill, and whether it can run code. */
  skills?: { name: string; runsCode: boolean }[];
  /** Bot sharing: fields that read like instructions to an AI ("Instructions", "Skill: notes"), and hidden characters removed. */
  flags?: string[];
  /** Bot sharing: a Bot with the same content is already here ("Add a copy"). */
  alreadyAdded?: boolean;
  face?: { shape: AvatarShape; color: string };
}
/** Bot sharing: which of a Bot's skills and tools go into its share link (ids and catalog ids). Absent = all. */
export interface ShareSelection { skills: string[]; tools: string[] }
/** Bot sharing: what the Share sheet shows and copies. */
export interface SharePreview {
  name: string; title: string; instructions: string; face: { shape: AvatarShape; color: string };
  skills: { id: string; name: string; description: string; runsCode: boolean; included: boolean }[];
  tools: { catalogId: string; name: string; included: boolean }[];
  /** The "b1.…" fragment, or null when the Bot is too big for a link (Save .botpack instead). */
  fragment: string | null;
  length: number;
  /** Personal details hidden from the link ("1 key"), or "". */
  hidden: string;
  /** This exact link was copied before and the Bot hasn't changed since (the menu's one-click Copy link). */
  sameAsLastShare: boolean;
  selection: ShareSelection;
}

// ---------- Voice (BOT-24, ORIG-15) ----------
export const SPEECH_RATES = [0.75, 1, 1.25, 1.5, 2] as const;
export interface VoiceSettingsPatch { voice?: string | null; speechRate?: number; spokenLanguage?: string | null }
/** Bug 108: a live voice call. `anchorId` is the Bot the call started with (it can't be removed; null for a group). */
export interface VoiceCallView {
  callId: string; chatId: string; anchorId: string | null; participantIds: string[];
  /** Bug 142: the Bot's voice answers on this call (1:1, fast path on): only its lines are spoken; utterances may start early. */
  fastPath?: boolean;
}

// ---------- Coding agent (TOOL-20) ----------
export type CodingAgentStatus = "running" | "done" | "error" | "cancelled" | "timed-out";
export interface CodingAgentView { id: string; botId: string; title: string; repo: string; branch: string; worktree: string; status: CodingAgentStatus; startedAt: number; endedAt: number | null; prUrl: string | null; summary: string | null; /** Set when origin couldn't be fetched: what the agent started from instead. */ note?: string | null }

// ---------- Transcript cards (CHAT-16 kinds added by Phase 5) ----------
export interface ConnectCardView { kind: "connect"; serverId: string | null; catalogId: string | null; name: string; logo: string | null; toolCount: number; state: "available" | "added" | "waiting-auth" | "connected" }
/** fix-fullauto-adoption: `adopt` makes it the Mac-side adoption card ("<Bot> is set to Full auto. Allow it … on this
 *  Mac?"); its answer writes (or declines) the Mac's own record of this Bot's mode, never the host. */
export interface LocalToolCardView { kind: "local-tool-permission"; askId: string; action: LocalAction; target: string; description: string | null; status: LocalAskStatus; createdAt: number; expiresAt: number; adopt?: "accept-edits" | "full-auto" }
export interface CodingAgentCardView { kind: "coding-agent"; agent: CodingAgentView }
export interface EngineeringOfferCardView { kind: "engineering-offer" }
export type CardPayload = ConnectCardView | LocalToolCardView | CodingAgentCardView | EngineeringOfferCardView | BrowserSessionCardView;

// ---------- Host settings extras (SET-17 keys added by Phase 5) ----------
export interface Phase5SettingsView { memoryMode: "standard" | "dreaming"; hasSeenOnboarding: boolean; advancedEnabled: boolean }

export type Phase5SseEvent =
  | { channel: "usage"; payload: UsageView }
  | { channel: "mcp-servers"; payload: { servers: McpServerView[] } }
  | { channel: "catalog"; payload: { changedAt: number } }
  | { channel: "local-exec"; payload: LocalExecRequest }
  | { channel: "phase5-settings"; payload: Phase5SettingsView };

declare module "./gateway" {
  interface GatewayCommands {
    // Usage (USE-*)
    getUsage: { args: None; result: UsageView };
    // Marketplace, plugins, MCP (§4.5 MCP/plugins + PLG-*)
    getMarketplace: { args: None; result: MarketplaceView };
    searchCatalog: { args: { query: string; limit?: number }; result: CatalogSearchResult };
    getCatalogEntry: { args: { id: string }; result: { entry: CatalogEntry; detail: CatalogDetail } };
    listPlugins: { args: None; result: { entries: CatalogEntry[] } };
    installPlugin: { args: { id: string }; result: { entry: CatalogEntry; serverIds: string[]; needsAuth: boolean; openUrl: string | null } };
    uninstallPlugin: { args: { id: string }; result: None };
    listMcpServers: { args: None; result: { servers: McpServerView[] } };
    addMcpServer: { args: AddMcpServerArgs; result: { server: McpServerView } };
    removeMcpServer: { args: { serverId: string }; result: None };
    renameMcpAccount: { args: { serverId: string; label: string }; result: { server: McpServerView } };
    setMcpToolEnabled: { args: { serverId: string; tool: string; enabled: boolean }; result: { server: McpServerView } };
    setMcpServerEnabled: { args: { serverId: string; enabled: boolean }; result: { server: McpServerView } };
    setMcpInstructions: { args: { serverId: string; instructions: string }; result: { server: McpServerView } };
    setMcpServerTrusted: { args: { serverId: string; trusted: boolean }; result: { server: McpServerView } };
    /** Set, replace or (value: null) remove one request header on a remote server. The value is sealed
     *  on arrival and never comes back out to this process; the result carries the redacted view. */
    setMcpServerHeader: { args: { serverId: string; name: string; value: string | null }; result: { server: McpServerView } };
    restartMcpServers: { args: { serverId?: string }; result: None };
    startMcpAuth: { args: { serverId: string }; result: { authorizationUrl: string } };
    completeMcpOAuth: { args: { state: string; code?: string; error?: string }; result: { serverId: string; status: McpServerStatus } };
    setOAuthLoopbackPort: { args: { port: number }; result: None };
    listPluginMarketplaces: { args: None; result: { marketplaces: PluginMarketplaceView[] } };
    addPluginMarketplace: { args: { source: string }; result: { marketplace: PluginMarketplaceView } };
    removePluginMarketplace: { args: { name: string }; result: None };
    // Templates (TPL-*)
    draftTemplate: { args: { id: string }; result: { draft: TemplateManifest } };
    exportTemplate: { args: { id: string; manifest: TemplateManifest }; result: { template: TemplateRecord; fileName: string; bytesBase64: string } };
    getTemplate: { args: { id: string }; result: { template: TemplateRecord | null } };
    deleteTemplate: { args: { templateId: string }; result: None };
    previewTemplateImport: { args: { bytesBase64?: string; starterId?: string; templateId?: string }; result: TemplatePreview };
    importTemplate: { args: { token: string }; result: { id: string } };
    /** Bot sharing: a share link's "b1.…" fragment, decoded, checked and scanned by the host. Saves nothing. */
    previewShareImport: { args: { payload: string }; result: TemplatePreview };
    /** Bot sharing: the Bot's share link for a selection; `remember` marks it copied (the menu's Copy link). */
    sharePayload: { args: { id: string; selection?: ShareSelection; remember?: boolean }; result: SharePreview };
    listStarterTemplates: { args: None; result: { starters: StarterView[] } };
    // Local execution (LOC-*)
    // Served by the Electron coordinator (LOC-05: the Mac keeps its own policy); never forwarded to the host.
    getLocalComputer: { args: None; result: { computer: LocalComputer } };
    /** Bug 225: whether this Mac's permission key file can be trusted (else Settings offers Reset permissions). */
    getLocalPolicyStatus: { args: None; result: { ok: boolean; reason?: string } };
    /** Bug 225: Reset permissions — a new key file and fresh permission files on this Mac. */
    resetLocalPolicy: { args: None; result: { ok: boolean } };
    setLocalComputer: { args: { label?: string; executionPolicy?: ExecutionPolicy; localRoot?: string; addAutoRunRoot?: string; removeAutoRunRoot?: string }; result: { computer: LocalComputer } };
    registerLocalComputer: { args: { computer: LocalComputer }; result: None };
    /** register: the host doesn't know this computer (bug-log 129); the Mac registers again. */
    localExecHeartbeat: { args: { computerId: string }; result: { pending: LocalExecRequest[]; register?: true } };
    localExecOutput: { args: { execId: string; stream: "stdout" | "stderr"; chunk: string }; result: None };
    localExecDone: { args: { execId: string; exitCode: number | null; result?: string; error?: string }; result: None };
    localExecUpload: { args: { execId: string; offset: number; bytesBase64: string; final: boolean }; result: None };
    readLocalFile: { args: { path: string; offset: number; length: number }; result: { bytesBase64: string; eof: boolean; size: number } };
    /** action/target: the card as the user saw it; the Mac coordinator binds a once-approval to them (the host ignores them). */
    resolveLocalToolPermission: { args: { id: string; askId: string; choice: LocalAskChoice; action?: LocalAction; target?: string; adopt?: "accept-edits" | "full-auto" }; result: { status: LocalAskStatus } };
    /** Bug 256: whether this Mac's permissions were reset, and which of the given Bots' chosen modes it lacks
     *  (answered by the coordinator, never the host). */
    getLocalPolicyReset: { args: { bots: { id: string; mode: PermMode }[] }; result: { reset: boolean; missing: { id: string; mode: PermMode }[] } };
    /** Bug 256: the one "Turn Full auto back on" button: records those Bots' modes on this Mac. */
    restoreLocalBotModes: { args: { bots: { id: string; mode: PermMode }[] }; result: { restored: string[] } };
    /** Bug 256: "Not now" — records "Keep asking" on this Mac for each listed Bot, so the banner doesn't come back. */
    dismissLocalPolicyReset: { args: { bots: { id: string; mode: PermMode }[] }; result: None };
    /** fix-fullauto-adoption: the Mac's own record of this Bot's mode (answered by the coordinator, never the host). */
    getLocalBotMode: { args: { id: string }; result: { mode: PermMode } };
    /** mac-browser: "May use the browser on your Mac" for this Bot (the Mac's own record; answered by the coordinator). */
    getLocalBrowserAllowed: { args: { id: string }; result: { allowed: boolean } };
    setLocalBrowserAllowed: { args: { id: string; allowed: boolean }; result: { allowed: boolean } };
    getLocalMacAppAllowed: { args: { id: string }; result: { allowed: boolean } };
    setLocalMacAppAllowed: { args: { id: string; allowed: boolean }; result: { allowed: boolean } };
    /** mac-browser: browser actions, screenshots (counted separately) and outline chars sent to Bots, this week. */
    getBrowserUsage: { args: None; result: BrowserUsageView };
    getNetworkStats: { args: None; result: { routedThisSession: number } };
    // Avatars (BOT-18)
    generateAgentAvatar: { args: { id: string; prompt: string }; result: { svg: string } };
    setAgentAvatarBytes: { args: { id: string; mime: string; bytesBase64: string }; result: { agent: BotSummary } };
    getAgentAvatar: { args: { id: string }; result: { mime: string; bytesBase64: string } | { mime: null; bytesBase64: null } };
    clearAgentAvatar: { args: { id: string }; result: { agent: BotSummary } };
    // Voice (BOT-24)
    setAgentVoice: { args: { id: string } & VoiceSettingsPatch; result: { agent: BotSummary } };
    // Voice calls: "Voice call started" / "Voice call ended · 3m 12s" markers in the chat.
    noteVoiceCall: { args: { id: string; phase: "started" | "ended"; durationMs?: number }; result: None };
    // Bug 108: the host owns who is on a call (any call, 1:1 or group; at most LIMITS5.callMaxBots Bots).
    startCall: { args: { id: string }; result: VoiceCallView };
    addToCall: { args: { callId: string; botId: string }; result: VoiceCallView };
    removeFromCall: { args: { callId: string; botId: string }; result: VoiceCallView };
    endCall: { args: { callId: string; durationMs?: number }; result: None };
    // Onboarding (ONB-*)
    getOnboarding: { args: None; result: { hasSeenOnboarding: boolean; tokenConfigured: boolean } };
    completeOnboarding: { args: None; result: None };
    // Coding agent (TOOL-20)
    listCodingAgents: { args: { id: string }; result: { agents: CodingAgentView[] } };
    /** 0.1.4 first-run: the coding-agent card's Stop. */
    cancelCodingAgent: { args: { id: string }; result: { agent: CodingAgentView } };
    // Memory, follow-ups, extras
    getPhase5Settings: { args: None; result: Phase5SettingsView };
    setMemoryMode: { args: { mode: "standard" | "dreaming" }; result: Phase5SettingsView };
    setAgentFollowups: { args: { id: string; enabled: boolean }; result: { agent: BotSummary } };
    setAgentEngineeringMode: { args: { id: string; enabled: boolean }; result: { agent: BotSummary } };
    setAgentPermMode: { args: { id: string; mode: PermMode }; result: { agent: BotSummary } };
    /** Bug 258: No limits on top of Full auto. Turning it on needs `confirm: NO_LIMITS_CONFIRM` (sent only by the app's
     *  own confirm dialog); turning it off never does. */
    setAgentNoLimits: { args: { id: string; enabled: boolean; confirm?: string }; result: { agent: BotSummary } };
    // cost-diet-2 lever 1: this Bot's "Save usage" switch; null clears it back to the account's setting.
    setAgentSaveUsage: { args: { id: string; enabled: boolean | null }; result: { agent: BotSummary } };
    // "Computer perception" for this Bot's computerUse subagents; null clears it back to the account's setting.
    setAgentComputerPerception: { args: { id: string; mode: ComputerPerception | null }; result: { agent: BotSummary } };
  }
}
/** fix-mac-gate-and-approval-expiry: a Mac refusal the host can turn into a card (and retry with its approval id).
 *  The Mac prefixes its reason with this; the text after it is what the Bot and the user read. */
export const LOCAL_NEEDS_APPROVAL = "needs-approval:";
/** fix-fullauto-adoption: the Mac refused only because the host's mode for this Bot (Full auto / Auto-accept edits) is
 *  not yet recorded on the Mac. The host raises ONE adoption card per Bot for it, never a card per command. */
export const LOCAL_ADOPT_MODE = "adopt-mode:";

/** The fixed-rules engine's view of one Mac request (the same mapping on the host and on the Mac). `base` is where a
 *  relative path or command runs (the Mac's local root). Null for kill / revoke-grants. */
export function localPermAction(r: { op: string; command?: string; path?: string; cwd?: string }, base: string, home: string): PermAction | null {
  const at = (p: string | undefined): string => {
    if (p === "~" || p?.startsWith("~/")) return `${home.replace(/\/$/, "")}${p.slice(1)}`;
    if (p?.startsWith("/")) return p;
    const rel = (p ?? "").replace(/^\.\/?/, "");
    return rel ? `${base.replace(/\/$/, "")}/${rel}` : base;
  };
  switch (r.op) {
    case "run-command": case "send-input": return { side: "mac", kind: "command", command: r.command ?? "", cwd: r.cwd ? at(r.cwd) : base };
    case "read-file": case "list-directory": case "copy-to-box": case "glob": case "grep": return { side: "mac", kind: "read", path: at(r.path), cwd: base };
    case "write-file": case "copy-from-box": return { side: "mac", kind: "write", path: at(r.path), cwd: base };
    case "edit-file": return { side: "mac", kind: "edit", path: at(r.path), cwd: base };
    default: return null;
  }
}

/** The card action a local request falls under (a per-Bot "Always" grant and a once-approval are keyed by it). */
export function localActionOf(op: LocalExecRequest["op"]): LocalAction | null {
  if (op === "run-command" || op === "send-input") return "run-command";
  if (op === "read-file" || op === "list-directory" || op === "copy-to-box" || op === "glob" || op === "grep") return "read-file";
  if (op === "write-file" || op === "copy-from-box" || op === "edit-file") return "write-file";
  if (op === "browser") return "browser";
  if (op === "mac-app") return "mac-app";
  return null;
}

/** P5 review minor: the exact target a card shows and a once-approval is bound to (hash(action + target) on the Mac). */
export function localBindTarget(r: { op: string; command?: string; path?: string; boxPath?: string; cwd?: string; pattern?: string; oldString?: string; browser?: Partial<BrowserArgs>; macapp?: Partial<MacAppArgs> }): string {
  switch (r.op) {
    case "browser": return browserBindTarget(r.browser ?? {});
    case "mac-app": return macAppBindTarget(r.macapp ?? {});
    case "run-command": return `${r.command ?? ""}${r.cwd ? `  (in ${r.cwd})` : ""}`;
    case "copy-to-box": return `${r.path ?? ""} → ${r.boxPath ?? ""}`;
    case "copy-from-box": return `${r.boxPath ?? ""} → ${r.path ?? ""}`;
    case "edit-file": return `edit ${r.path ?? ""}`;
    case "glob": return `glob ${r.pattern ?? ""}${r.path ? ` in ${r.path}` : ""}`;
    case "grep": return `grep ${r.pattern ?? ""}${r.path ? ` in ${r.path}` : ""}`;
    default: return r.path ?? r.command ?? "";
  }
}
