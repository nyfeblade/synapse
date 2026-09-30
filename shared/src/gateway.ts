import type { AvatarMaterial, AvatarMotion, AvatarShape, BotSummary, EffortLevel } from "./bots";
import type { HistoryKeep } from "./history-budget";
import type { CallReplies, LongContextMode, PromptCacheTtl } from "./savings";
import type {
  AsyncTaskView, BoxHelpView, ComputerActionEvent, DiskPressureView, DisplayInfo, ForeverBoxStatus,
  FormCardView, SecretRequestView, SecretStatusEntry, SnapshotInfo, SnapshotReason,
} from "./computer";
import type { ModelId } from "./models";
import type { ProviderModelRef } from "./providers";
import type { AcpModelRef } from "./acp-vendors";
import type { ComputerPerception } from "./computer";
import type { MailboxInfo, RoutineView, Trigger } from "./routines";
import type { StandupCard, StandupSettings, StandupView } from "./schedules";
import type { TeachStatus } from "./teach";
import type { HistoryArchiveStatsView, MemoryFactView, MemoryListView, MemoryScopeRef, MemoryTierChoice } from "./memory";
import type { Phase5SseEvent } from "./phase5";
import type { GoogleSseEvent } from "./google";
import type { ComposioSseEvent } from "./composio";
import type { GitHubSseEvent } from "./github";
import type { HealthSseEvent, WorkNotify } from "./health";
import type { VoiceCallsSseEvent } from "./voice-calls";
import type { ApprovalStatus, Reaction, TranscriptEntry, WidgetStatus } from "./transcript";

export interface HealthInfo {
  ok: true;
  hostVersion: string;
  bootId: string;
  brain: "claude" | "fake";
  cliVersion: string | null;
  tokenConfigured: boolean;
  conformance: { ranAt: number | null; failed: string[] };
  /** A hash of the running host.mjs (host/build.mjs); null in development. The app redeploys when its bundled host differs. */
  hostBuild?: string | null;
  /** The host process before this one; `clean: false` means it died instead of stopping (Settings → Diagnostics). */
  previousRun?: { bootId: string; startedAt: number; clean: boolean } | null;
  /** The last staged restore the host applied at start-up (Settings → Backups). */
  lastRestore?: { at: number; ok: boolean; message?: string; bots?: number; sealed?: "applied" | "skipped" | "none" } | null;
  /** Free bytes on the box's disk (the workspace volume); null when it can't be read (Settings → Diagnostics). */
  diskFreeBytes?: number | null;
}

export type ThemePreference = "system" | "light" | "dark";

/** CHAT-09: a stored attachment, returned by the final uploadAttachment chunk. */
export interface AttachmentRef { attachmentId: string; name: string; size: number; mime: string; storePath: string; boxPath: string | null }

/** SKL-05 row. `disabledFor` lists Bot ids that opted out (enabled-workflows.json). */
export interface SkillView { id: string; name: string; description: string; source: string | null; managed: boolean; bodyChars: number; disabledFor: string[]; updatedAt: number }

/** PAL-02 results. `snippet` marks matches with SNIPPET_OPEN … SNIPPET_CLOSE. */
export type SearchResult =
  | { kind: "bot"; botId: string; title: string; subtitle: string }
  | { kind: "message"; botId: string; entryId: string; snippet: string; createdAt: number }
  | { kind: "file"; botId: string; entryId: string; name: string; snippet: string; createdAt: number }
  | { kind: "link"; botId: string; entryId: string; url: string; snippet: string; createdAt: number };

/** ORIG-07 §07.1 / CTX-05 context meter. */
export interface AgentContextView { ctxTokens: number; window: number; ratio: number; compactionEpoch: number; compactions: number; sessionBytes: number | null }

export interface HostSettingsView {
  autoReviewEnabled: boolean;
  allowInstructions: string[];
  blockInstructions: string[];
  userTimeZone: string;                 // the effective zone
  userTimeZoneOverride: string | null;  // SET-05: null = Auto-detect
  pinnedAgentIds: string[];
  themePreference: ThemePreference;     // SET-02 / PAL-04
  memoryRecall: boolean;                // ORIG-05 §05.3 parity switch (default on)
  advancedEnabled: boolean;             // D14 (default off)
  smartGroupTurns?: boolean;                           // ORIG-10, default false
  teachSidecar?: boolean;                              // ORIG-08 §08.1, default true
  publicWebhook?: { enabled: boolean; url: string | null }; // RTN-11 tunnel
  webhookLan?: boolean;                                // I5: webhook listener on the local network (default off: 127.0.0.1)
  webhookLanError?: string | null;                     // bug 52: why the last webhookLan change did not take effect (not saved)
  saveUsage?: boolean;                                 // cost-diet-2 lever 1: account-wide "Save usage" (model routing), default off
  computerPerception?: ComputerPerception;             // "Computer perception": screenshots (default) | live (beta)
  promptCacheTtl?: PromptCacheTtl;                     // saving-settings "Keep conversations ready": 1h (default) | 5m
  callReplies?: CallReplies;                           // saving-settings "Call replies": default | fast | match
  longContext?: LongContextMode;                       // saving-settings "Long-context model": on (default) | when-needed
  trustedRecipients?: string[];                        // smarter approvals: sends to only these (and the owner) skip the card
  workNotify?: WorkNotify;                             // 4.4 "Work finished": on (default) | long (> 1 min) | off
  workNotifyTelegram?: boolean;                        // 4.4: also send it through Telegram (paired only), default off
  /** settings-persist: bumped on every saved change, so the app can tell a stale answer from a newer one. */
  rev?: number;
  /** settings-persist: this settings store's load id; changes on every host start (and so on a quarantined, reset file). */
  epoch?: string;
}

/** `target`: the connector id a "fix-connector" button fixes (4.4). */
export interface TrayButton { label: string; action: "retry" | "dismiss" | "resume-routines" | "reconnect-google" | "reconnect-google-bot" | "loop-continue" | "loop-stop" | "fix-connector"; target?: string }
export interface Tray {
  id: string;
  botId: string | null;
  title: string;
  detail: string | null;
  requestId: string | null;
  buttons: TrayButton[];
  dedupeKey: string | null;
  count: number;
  createdAt: number;
}

export type ApprovalChoice = "once" | "always" | "deny";
type NoArgs = Record<string, never>;

export interface GatewayCommands {
  getHealth: { args: NoArgs; result: HealthInfo };
  listAgents: { args: NoArgs; result: { agents: BotSummary[]; activeAgentId: string | null } };
  createAgent: {
    args: { name?: string; description?: string; avatarShape?: AvatarShape; avatarColor?: string; avatarMaterial?: AvatarMaterial; avatarMotion?: AvatarMotion; effort?: EffortLevel; model?: ModelId; isKickstartRequested?: boolean };
    result: { id: string };
  };
  updateAgent: {
    args: { id: string; name?: string; description?: string; model?: ModelId | ProviderModelRef | AcpModelRef; avatarShape?: AvatarShape; avatarColor?: string; avatarMaterial?: AvatarMaterial; avatarMotion?: AvatarMotion; effort?: EffortLevel };
    result: { agent: BotSummary };
  };
  deleteAgent: { args: { id: string }; result: { activeAgentId: string | null } };
  openAgent: { args: { id: string }; result: { agent: BotSummary } };
  setAgentPinned: { args: { id: string; pinned: boolean }; result: { pinnedAgentIds: string[] } };
  getAgentTranscriptTail: { args: { id: string; limit?: number }; result: { entries: TranscriptEntry[] } };
  sendPrompt: { args: { id: string; text: string; clientNonce: string; attachmentIds?: string[]; replyToId?: string; skillIds?: string[]; voice?: { durationMs: number; call?: boolean; speculationId?: string; continues?: boolean }; mentions?: string[] }; result: { entryId: string; ready?: boolean } };
  interruptAgent: { args: { id: string }; result: NoArgs };
  /** `note` (deny only): the change the user asked for by voice on a call; the Bot redoes the action with it (bug 142). */
  resolveAutoReviewApproval: { args: { id: string; approvalId: string; choice: ApprovalChoice; note?: string }; result: { status: ApprovalStatus } };
  getHostSettings: { args: NoArgs; result: HostSettingsView };
  setHostSettings: { args: Partial<Omit<HostSettingsView, "pinnedAgentIds" | "userTimeZoneOverride">>; result: HostSettingsView };
  /** 0.1.4 first-run: the Mac's own time zone (what "Auto" follows); sent at connect and when the Mac's zone changes. */
  setMacTimeZone: { args: { zone: string }; result: HostSettingsView };
  /** 0.1.4: the app found the box's Local network state differs from the owner's choice: no Bot turn runs until it matches. */
  setNetworkPause: { args: { on: boolean }; result: { on: boolean } };
  getTrays: { args: NoArgs; result: { trays: Tray[] } };
  dismissTray: { args: { trayId: string; action?: "retry" | "resume-routines" | "loop-continue" | "loop-stop" }; result: NoArgs };
  clearTrays: { args: { botId?: string }; result: NoArgs };
  // Phase 3 · computer (CMP-*, §4.5 Box/computer)
  getForeverBoxStatus: { args: NoArgs; result: ForeverBoxStatus };
  getDisplays: { args: NoArgs; result: { displays: DisplayInfo[]; waiting: string[] } };
  ensureDisplay: { args: { id: string }; result: { display: DisplayInfo } };
  handBackForeverBox: { args: { id: string; requestId: string; outcome: "done" | "skip" | "viewer_closed" }; result: { request: BoxHelpView } };
  setTakeoverActive: { args: { id: string; requestId: string; active: boolean }; result: { request: BoxHelpView } };
  openComputerApp: { args: { id: string; app: "terminal" | "files" | "browser" }; result: NoArgs };
  getAsyncTasks: { args: { id: string }; result: { tasks: AsyncTaskView[] } };
  // Phase 3 · secrets (SEC-*, ORIG-12). `sealed` = base64 crypto_box_seal to the box public key; never a plaintext value.
  setBotSecrets: { args: { botId: string; upserts: { name: string; description: string; sealed: string; valueHash: string }[]; removes: string[] }; result: { status: SecretStatusEntry[] } };
  getBotSecretsStatus: { args: { botId: string }; result: { status: SecretStatusEntry[]; boxPublicKey: string } };
  submitSecret: { args: { id: string; entryId: string; sealed: string; valueHash: string }; result: { status: SecretRequestView["status"] } };
  submitForm: { args: { id: string; entryId: string; answers: Record<string, string>; sealed: Record<string, string> }; result: { status: FormCardView["status"] } };
  // Phase 3 · disk (CMP-15, BOT-16)
  getDiskPressure: { args: NoArgs; result: DiskPressureView };
  openDiskSaver: { args: NoArgs; result: { id: string } };
  // Phase 3 · snapshots and restarts (CMP-11, CMP-12, EVT-19)
  snapshotBoxStoreNow: { args: { reason?: SnapshotReason }; result: { snapshot: SnapshotInfo } };
  getBoxStoreStatus: { args: NoArgs; result: { latest: SnapshotInfo | null; running: boolean } };
  listSnapshots: { args: NoArgs; result: { snapshots: SnapshotInfo[] } };
  restoreSnapshot: { args: { id: string; parts: SnapshotInfo["parts"] }; result: NoArgs };
  deleteSnapshot: { args: { id: string }; result: NoArgs };
  prepareBoxRestart: { args: { reason: "update" | "recover" | "reset"; force: boolean }; result: { ok: boolean; busyBotIds: string[] } };
  /** Portable install: hold (or release) new turns while the Mac re-provisions the box; lists Bots still running a turn. */
  /** Bug 258: with `quietMs` the host takes no hold (`deferred: true`) while a user message came in the last quietMs. */
  setBoxMaintenance: { args: { on: boolean; ttlMs?: number; quietMs?: number }; result: { runningBotIds: string[]; deferred?: boolean } };
  getAgentAutomations: { args: { id: string }; result: { routines: RoutineView[] } };
  listAllAutomations: { args: NoArgs; result: { routines: RoutineView[] } };
  getStandup: { args: NoArgs; result: StandupView };
  setStandupSettings: { args: Partial<StandupSettings>; result: StandupView };
  runStandupNow: { args: NoArgs; result: { card: StandupCard } };
  setAgentAutomationEnabled: { args: { id: string; routineId: string; enabled: boolean }; result: { routine: RoutineView } };
  createAgentAutomation: { args: { id: string; name: string; prompt: string; schedule?: string; trigger?: Trigger; enabled?: boolean; quietHours?: string | null; catchUp?: boolean; dailyCap?: number | null }; result: { routine: RoutineView; key: string | null } };
  updateAgentAutomation: { args: { id: string; routineId: string; name?: string; prompt?: string; schedule?: string; trigger?: Trigger; quietHours?: string | null; catchUp?: boolean; dailyCap?: number | null }; result: { routine: RoutineView } };
  deleteAgentAutomation: { args: { id: string; routineId: string }; result: NoArgs };
  runAgentAutomationNow: { args: { id: string; routineId: string }; result: { runId: string } };
  getAutomationWebhook: { args: { id: string; routineId: string }; result: { url: string; keyPreview: string; header: string } };
  rotateAutomationWebhookKey: { args: { id: string; routineId: string }; result: { url: string; key: string; header: string } };
  setListenerCredentials: { args: { id: string; platform: "slack" | "github" | "linear" | "sentry"; fields: Record<string, string> }; result: { connected: boolean } };
  addMailbox: { args: { id: string; label: string; host: string; port: number; user: string; appPassword: string }; result: { mailboxes: MailboxInfo[] } };
  createGroup: { args: { memberIds: string[]; name?: string }; result: { id: string; reused: boolean } };
  setGroupMembers: { args: { id: string; memberIds: string[] }; result: { agent: BotSummary } };
  broadcastToAgents: { args: { text: string }; result: { count: number } };
  // getUsage is Phase 5's (UsageView, efficiency tiles included): shared/src/phase5.ts.
  startTeachRecording: { args: { id: string; goal: string }; result: { status: TeachStatus } };
  stopTeachRecording: { args: { id: string }; result: { status: TeachStatus } };
  pauseTeachRecording: { args: { id: string }; result: { status: TeachStatus } };
  resumeTeachRecording: { args: { id: string }; result: { status: TeachStatus } };
  discardTeachRecording: { args: { id: string }; result: { status: TeachStatus } };
  getTeachRecordingStatus: { args: NoArgs; result: { status: TeachStatus } };
  setAgentHiddenFromSidebar: { args: { id: string; hidden: boolean }; result: { agent: BotSummary } };
  duplicateAgent: { args: { id: string }; result: { id: string } };
  setAgentUnread: { args: { id: string; unread: boolean }; result: { agent: BotSummary } };
  setAgentNotificationsEnabled: { args: { id: string; enabled: boolean }; result: { agent: BotSummary } };
  respondToWidget: { args: { id: string; entryId: string; value: string; formValues?: Record<string, string> }; result: { status: WidgetStatus } };
  dismissWidget: { args: { id: string; entryId: string }; result: { status: WidgetStatus } };
  uploadAttachment: { args: { id: string; uploadId: string; name: string; mime: string; size: number; offset: number; chunkBase64: string; final: boolean }; result: { received: number; attachment: AttachmentRef | null } };
  readAttachmentChunk: { args: { id: string; attachmentId: string; offset: number; length: number }; result: { chunkBase64: string; size: number; eof: boolean } };
  readWorkspaceFile: { args: { path: string; offset: number; length: number }; result: { chunkBase64: string; size: number; mime: string; eof: boolean } };
  getAgentThread: { args: { id: string; entryId: string }; result: { root: TranscriptEntry | null; replies: TranscriptEntry[] } };
  reactToMessage: { args: { id: string; entryId: string; emoji: string }; result: { reactions: Reaction[] } };
  getAgentTranscriptPage: { args: { id: string; aroundEntryId: string; before?: number; after?: number }; result: { entries: TranscriptEntry[]; hasOlder: boolean; hasNewer: boolean } };
  search: { args: { query: string }; result: { results: SearchResult[] } };
  getAgentContext: { args: { id: string }; result: AgentContextView };
  compactAgentNow: { args: { id: string }; result: { scheduled: boolean } };
  newAgentSession: { args: { id: string }; result: { scheduled: boolean } };
  /** Token diet (2): Advanced "Keep more history". Takes effect on the next turn (respawn). */
  setAgentHistoryKeep: { args: { id: string; keep: HistoryKeep }; result: { agent: BotSummary } };
  // MEM-09, designed: the memory screen. `scope` omitted = only the Bot's project list. `owner` names the Bot whose "about you" shard holds a line.
  getAgentMemories: { args: { id: string; scope?: MemoryScopeRef }; result: MemoryListView };
  addAgentMemory: { args: { id: string; scope: MemoryScopeRef; content: string; tier: MemoryTierChoice }; result: { added: boolean; fact: MemoryFactView } };
  updateAgentMemory: { args: { id: string; scope: MemoryScopeRef; factId: string; owner?: string; content: string }; result: { fact: MemoryFactView } };
  deleteAgentMemory: { args: { id: string; scope: MemoryScopeRef; factId: string; owner?: string }; result: { removed: boolean } };
  clearAgentMemories: { args: { id: string; scope: MemoryScopeRef }; result: { removed: number } };
  // Designed: the history archive's size for one Bot (the memory screen can show it).
  getHistoryArchiveStats: { args: { id: string }; result: HistoryArchiveStatsView };
  getWorkflows: { args: NoArgs; result: { workflows: SkillView[] } };
  getWorkflow: { args: { workflowId: string }; result: { workflow: SkillView; body: string } };
  createWorkflow: { args: { name: string; description: string; body: string }; result: { workflow: SkillView } };
  updateWorkflow: { args: { workflowId: string; name?: string; description?: string; body?: string }; result: { workflow: SkillView } };
  deleteWorkflow: { args: { workflowId: string }; result: NoArgs };
  setAgentWorkflowEnabled: { args: { id: string; workflowId: string; enabled: boolean }; result: { disabled: string[] } };
  importWorkflowText: { args: { markdown: string; name?: string }; result: { workflow: SkillView } };
  importWorkflowUrl: { args: { url: string }; result: { workflow: SkillView } };
  importWorkflowFolder: { args: { name: string; files: { path: string; text: string }[] }; result: { workflow: SkillView } };
}
export type CommandName = keyof GatewayCommands;

export type TranscriptEvent =
  | { botId: string; op: "append" | "update"; entry: TranscriptEntry }
  | { botId: string; op: "typing"; typing: boolean; partialText: string | null };

export type SseEvent =
  | { channel: "agent-upserted"; payload: { agent: BotSummary } }
  | { channel: "agents"; payload: { removedId: string; activeAgentId: string | null } }
  | { channel: "transcript"; payload: TranscriptEvent }
  | { channel: "tray"; payload: { trays: Tray[] } }
  | { channel: "host-settings"; payload: HostSettingsView }
  | { channel: "computer-action"; payload: ComputerActionEvent }
  | { channel: "forever-box"; payload: ForeverBoxStatus }
  | { channel: "box-disk-pressure"; payload: DiskPressureView }
  | { channel: "async-tasks"; payload: { botId: string; tasks: AsyncTaskView[] } }
  | { channel: "displays"; payload: { displays: DisplayInfo[]; waiting: string[] } }
  | { channel: "box-help"; payload: { request: BoxHelpView } }
  | { channel: "skills"; payload: { workflows: SkillView[] } }
  | { channel: "automations"; payload: { botId: string; routines: RoutineView[] } }
  | { channel: "standup"; payload: StandupView }
  | { channel: "teach-recording"; payload: TeachStatus }
  // Review round 2 (P4): which models the saved API key can reach (getModelAccess).
  | { channel: "model-access"; payload: import("./auth").ModelAccessView }
  // Bug 281: the API-key check (checkApiKey).
  | { channel: "key-check"; payload: import("./auth").KeyCheckView }
  // 5.7: the header's spend meter (at most a few updates a second, only when a shown cent changes).
  | { channel: "spend-meter"; payload: import("./cost").SpendMeterView }
  /** Spec §7a: the background safety check's progress (and the reviewer's state once it ends). */
  | { channel: "safety-check"; payload: import("./providers").SafetyReviewerView }
  // Phase 5 owns "usage" (UsageView, which carries Phase 4's efficiency tiles).
  | Phase5SseEvent
  // Built-in Google connector status (Connect Google sheet, Settings → Connected accounts).
  | GoogleSseEvent
  // Apps through Composio (Settings → Connected accounts → Composio, Marketplace).
  | ComposioSseEvent
  // Per-Bot GitHub sign-in (Bot settings → GitHub).
  | GitHubSseEvent
  // Voice wave 3: Bots calling the user, and a Bot asking to see a shared screen.
  | VoiceCallsSseEvent
  // 4.4: connector health and work-finished notifications.
  | HealthSseEvent;

export interface GatewayErrorBody { code: string; message: string }
export type GatewayResponse<T> = { ok: true; result: T } | { ok: false; error: GatewayErrorBody };

export class GatewayCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
