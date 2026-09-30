import { BudgetGate } from "./usage/budget-gate";
import { composioSentTo, resolveComposioSend } from "./composio/recipients";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DEFAULT_BOT_MODEL, DEFAULT_EFFORT, DEFAULT_HISTORY_KEEP, LONG_CONTEXT_ESCALATE_TOKENS, isModelId, modelLabel, spawnModelId, STR, STR5, STRG, STRV, STR_AUTH, type HealthInfo } from "@synapse/shared";
import { ApprovalGate } from "./approvals/approval-gate";
import { BotService } from "./bots/bot-service";
import { ClaudeBrain } from "./brain/claude-brain";
import { ALL_CHECKS } from "./brain/conformance/checks/index";
import { DEFAULT_FLAGS, withFlagOverrides, type ConformanceFlags } from "./brain/conformance/flags";
import { ensureConformance, loadConformance } from "./brain/conformance/runner";
import { readSessionFile, removeBoxSession, writeSessionFile } from "./brain/conformance/session-file";
import { demoScriptFor } from "./brain/demo-script";
import { FakeBrain } from "./brain/fake-brain";
import { SdkOneShot, StubOneShot, type OneShotModel } from "./brain/one-shot";
import { buildBotEnv, buildBotQueryOptions, GIT_BUILTIN_DIFF, systemPromptModeFor } from "./brain/spawn-options";
import { ensureGitShim } from "./brain/git-shim";
import { createBotAdminCommands } from "./bots/commands";
import { createSettingsToolExtension } from "./bots/settings-tool";
import { createReactionCommands, createReactionToolExtension } from "./chat/reactions";
import { createThreadCommands, createThreadHooks, validateReplyTo } from "./chat/threads";
import { createWidgetCommands } from "./chat/widget-commands";
import { HostWidgets, createWidgetExtension, createWidgetHooks } from "./chat/widgets";
import { compactQueryOptions, runCompactQuery } from "./context/compact-query";
import { Compactor } from "./context/compactor";
import { createContextCommands } from "./context/context-commands";
import { applyHistoryEnv } from "./context/history-env";
import { compactInstructions, createContextMeterHooks, readCtx } from "./context/context-meter";
import { LongContextChats } from "./brain/long-context";
import { ModelRouter, saveUsageOn } from "./brain/model-router";
import { createRestoreHooks } from "./context/restore";
import { Rollover } from "./context/rollover";
import { startTranscriptMirror } from "./context/transcript-mirror";
import { HistoryArchive } from "./history/archive";
import { createHistoryCommands } from "./history/history-commands";
import { createHistoryToolExtension } from "./history/history-tool";
import { HistoryIndexer } from "./history/indexer";
import { createAttachmentHooks } from "./files/attachment-hooks";
import { createAttachmentSendExtension } from "./files/attachment-send";
import { AttachmentStore, createAttachmentCommands } from "./files/attachments";
import { createFileCommands } from "./files/file-access";
import { createMemoryEngineHooks, type PendingExchange } from "./memory/engine";
import { leanMemoryGate, leanSpawnFields } from "./engineering/lean-profile";
import { EpisodeWriter } from "./memory/episodes";
import { MemoryExtractor } from "./memory/extractor";
import { MemoryStore } from "./memory/memory-store";
import { userNameFromFacts } from "./voice/call-greetings";
import { dropFromCall } from "./voice/calls";
import { createMemoryCommands } from "./memory/memory-commands";
import { createMemoryToolExtension } from "./memory/memory-tool";
import { createMemoryPromptHooks, frozenFactIds } from "./memory/prompt-hooks";
import { createRecallHooks, recallFor } from "./memory/recall";
import { VoiceFronts } from "./voice/front";
import { demoFrontScript, ScriptedFrontSession, SdkFrontSession } from "./voice/front-session";
import { RecallIndex } from "./memory/recall-index";
import { FactLedger } from "./memory/ledger";
import { migrateMemoryToLedger } from "./memory/ledger-migrate";
import { reindexAll, startRecallSync } from "./memory/recall-sync";
import { composeHooks, type TurnHooks } from "./runner/hooks";
import { createSearchCommands } from "./search/search-commands";
import { reindexSearch, SearchIndex, startSearchSync } from "./search/search-index";
import { SkillLibrary } from "./skills/library";
import { createSkillOptOutHooks } from "./skills/optout-hooks";
import { createSkillCommands, publishSkills } from "./skills/skill-commands";
import { createSkillHooks } from "./skills/skill-hooks";
import { createSkillToolExtension } from "./skills/skill-tool";
import { mergeExtensions, type BotToolExtensions } from "./tools/registry";
import { claudeExecutableFor } from "./brain/tool-policy";
import type { BrainWiring, SpawnConfig, SupervisedBrain } from "./brain/types";
import { mergeCommands } from "./commands";
import { McpBridge } from "./mcp-server/bridge";
import type { HostConfig } from "./config";
import { createPhase3Services, type Phase3Services } from "./computer/phase3-services";
import { GatewayError } from "./gateway/errors";
import { acquireHostLock } from "./gateway/host-lock";
import { createGateway, type CommandHandlers } from "./gateway/server";
import { AUTH_DIR, authStoreFor, retireClaudeLogin } from "./auth/auth-store";
import { ModelAccess } from "./auth/model-access";
import { KeyCheck, type KeyCheckSpend } from "./auth/key-check";
import { credentialsReady, releaseAuthSource, requireAuthProxy, setAuthProxy, setAuthSource } from "./auth/auth-env";
import { AuthProxy } from "./auth/proxy";
import { createAuthCommands } from "./auth/module";
import { loadOrCreateBoxKeyPair } from "./secrets/crypto";
import { SseHub } from "./gateway/sse-hub";
import { SdkOneShot as HelperSdkOneShot, StubOneShot as HelperStubOneShot, type OneShotModel as HelperOneShotModel } from "./helper-model/one-shot";
import { RuntimeMetrics } from "./metrics/runtime-metrics";
import { installPhase4, type Phase4, type Phase4Services } from "./phase4";
import { isCallRoomPost } from "./groups/orchestrator";
import { loadOrCreateGatewayToken, writeGatewayInfo } from "./gateway/token";
import { PresenceTracker } from "./presence/presence";
import { VerdictCache } from "./review/cache";
import { CircuitBreaker } from "./review/circuit";
import { ReviewLog } from "./review/log";
import { SdkModelReviewer, StubModelReviewer } from "./review/model-reviewer";
import { Reviewer } from "./review/reviewer";
import { compileAll, sdkCompilerCall } from "./review/rules";
import { AckLedger } from "./runner/ack-ledger";
import { envValuesHash, spawnKeyOf } from "./runner/prompt-collector";
import { ResumeLedger } from "./runner/resume-ledger";
import { SendAcceptanceLedger } from "./runner/send-acceptance";
import { TurnRunner } from "./runner/turn-runner";
import { HostSettingsStore } from "./store/host-settings";
import { initLayout } from "./store/layout";
import { migrateLegacyStaging } from "./walls/migrate";
import { sudoBotAccounts } from "./walls/bot-accounts";
import { relocateSessionRecords } from "./walls/migration-plan";
import { defaultCaps } from "./supervisor/caps";
import { bootSweep, reapWithSudo, SupervisorLedger } from "./supervisor/ledger";
import { treeRss } from "./supervisor/rss";
import { Supervisor } from "./supervisor/supervisor";
import { RehearsalRegistry } from "./teach/rehearsal-registry";
import { TrayService } from "./trays/trays";
import { log } from "./util/log";
import { applyPendingRestore, readLastRestore } from "./backup/host-backup";
import { createBackupRaw } from "./backup/routes";
import { hostBuildId, recordRunEnd, recordRunStart } from "./backup/run-state";
import { wirePhase5, type Phase5 } from "./phase5/wire";
import type { ReviewerLike } from "./approvals/approval-gate";
import { sudoFsQuery } from "./walls/home-fs";
import { execBuf } from "./computer/x-exec";
import { BoxFirewallCheck, sudoFirewallCheck } from "./net/firewall-check";

export const HOST_VERSION = "0.1.0";

export interface HostAppOptions {
  now?: () => number;
  /** Test seam: builds each Bot's brain in place of FakeBrain/ClaudeBrain (e.g. a real CLI against a fake Messages API). */
  brainFactory?: (botId: string, d: { wiring: BrainWiring; spawnConfig: () => SpawnConfig; getSessionId(): string | null; setSessionId(id: string): void }) => SupervisedBrain;
}

/** Tray built when a Bot crashes 3 times in 10 minutes and backs off (ORIG-16). Copy from STR, never a literal (preflight F1). */
/** Free bytes on the volume holding `p` (/health; one statfs, microseconds). Null when it can't be read. */
export function diskFreeBytes(p: string): number | null {
  try { const s = fs.statfsSync(p); return s.bavail * s.bsize; } catch { return null; }
}

export function crashBackoffTray(botId: string): { botId: string; title: string; detail: string; dedupeKey: string } {
  return { botId, title: STR.trayBotFailed, detail: STR.trayBotCrashedDetail, dedupeKey: `${botId}:crash` };
}

/** Tray built when auto-review goes degraded (ORIG-01). Copy from STR, never a literal (preflight F1). */
export function reviewerDegradedTray(err: string | null): { botId: null; title: string; detail?: string; dedupeKey: string } {
  return { botId: null, title: STR.trayReviewerDown, detail: err ?? undefined, dedupeKey: "reviewer" };
}

/**
 * H-2: boot order for the real brain. The bot-reap sweep SIGKILLs box `claude` processes, so it must
 * finish before boot conformance starts (else it kills the `--version` probe and the probes). A
 * failed reap still lets conformance run; `ready` never rejects (turns await it).
 */
export function startBootConformance(o: { reap: () => Promise<void>; ensure: () => Promise<void> }): { swept: Promise<void>; ready: Promise<void> } {
  const swept = o.reap();
  const ready = swept.catch(() => undefined).then(() => o.ensure()).catch((e) => log.error("conformance failed", { error: String(e) }));
  return { swept, ready };
}

/** Keeps the services' live getters (webhookPort) instead of snapshotting them the way a spread would. */
function withStart<T extends object>(services: T, start: () => Promise<{ webhookPort: number }>): T & { start(): Promise<{ webhookPort: number }> } {
  return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(services), start: { value: start, enumerable: true } }) as T & { start(): Promise<{ webhookPort: number }> };
}

export interface HostApp {
  hub: SseHub;
  token: string;
  bootId: string;
  handlers: CommandHandlers;
  settings: HostSettingsStore;
  services: {
    bots: BotService; runner: TurnRunner; gate: ApprovalGate; supervisor: Supervisor; reviewer: Reviewer; trays: TrayService; phase3: Phase3Services;
    memory: MemoryStore; memoryEngine: ReturnType<typeof createMemoryEngineHooks>; recallIndex: RecallIndex; skills: SkillLibrary; attachments: AttachmentStore; searchIndex: SearchIndex; compactor: Compactor; rollover: Rollover;
    historyArchive: HistoryArchive; historyIndexer: HistoryIndexer;
    rehearsals: RehearsalRegistry;
    /** Bug 142: the voice fast path (per-call stats; null-safe for callers that predate it). */
    voiceFronts: VoiceFronts;
    phase4: Phase4Services & { start(): Promise<{ webhookPort: number }> };
    phase5: Phase5;
    /** What a Bot's next CLI spawn would be given (prompt mode, append, spawn key); read-only. */
    spawnConfig(botId: string): SpawnConfig;
  };
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

export async function createHostApp(cfg: HostConfig, opts: HostAppOptions = {}): Promise<HostApp> {
  const now = opts.now ?? Date.now;
  initLayout(cfg);
  migrateLegacyStaging(cfg); // bug #61: flat pre-wall staging into the per-Bot layout (idempotent)
  const releaseLock = await acquireHostLock(path.join(cfg.hostPrivate, "host.lock"));
  // Settings → Backups: a restore the Mac staged is applied here, under the lock, before any store opens.
  if (await applyPendingRestore(cfg, now)) initLayout(cfg);
  const token = loadOrCreateGatewayToken(cfg.hostPrivate);
  const bootId = randomUUID();
  const previousRun = recordRunStart(cfg, bootId, now);
  const buildId = hostBuildId();
  const hub = new SseHub();
  const hp = (f: string) => path.join(cfg.hostPrivate, f);
  // Settings → Account: the Anthropic API key, for every model call from here on (auth/auth-env.ts). There is no other
  // way in (synapse-public): with no key saved, Bots don't run and the app asks for one. An old install's Claude login
  // token on the box goes now, so nothing can pick it up; its old sign-in mode is ignored (auth-store.ts).
  if (retireClaudeLogin(cfg)) log.info("removed the box's old Claude login token: Bots use the Anthropic API key only");
  // A key saved while the key proxy is down puts up its tray (proxyTray, set once trays exist); a key saved after boot
  // runs conformance (onKeySaved, below).
  let onAuthChange = (): void => {};
  const auth = authStoreFor(cfg, { now, onChange: () => onAuthChange() });
  setAuthSource(auth);
  // Review round 2 (P4): which models the key reaches, probed (free count_tokens, straight to Anthropic) after a key is
  // saved and on demand. Only with the real brain: a test host never makes a network call.
  const modelAccess = new ModelAccess({ dir: hp(AUTH_DIR), key: () => auth.apiKey(), now, onChange: (v) => hub.publish({ channel: "model-access", payload: v }) });
  const probeModels = (): void => { if (cfg.brain === "claude" && auth.apiKey()) void modelAccess.probe().catch(() => {}); };
  let lastKeyPart = auth.spawnKeyPart();
  const onKeyMaybeChanged = (): void => {
    const part = auth.spawnKeyPart();
    if (part === lastKeyPart) return;
    lastKeyPart = part;
    modelAccess.clear();
    keyCheck.clear();
    // Bug 281: a new key is checked at once (the free probe, then one tiny metered message); only with the real brain.
    if (cfg.brain === "claude" && auth.apiKey()) void keyCheck.run().catch(() => {});
  };
  if (modelAccess.view().checkedAt === null) probeModels();
  // Bug 117: the real key stays in this process; Claude processes get a proxy token (auth/proxy.ts).
  // Review round 2 (P2): the budget is asked before each model call and unreported spend is recorded, once Phase 5 exists.
  // Bug 296: until Phase 5 wires the budget, every model call through the proxy is refused and unreported spend waits.
  const budgetGate = new BudgetGate();
  const authProxy = cfg.brain === "claude" && cfg.authProxy.enabled
    ? new AuthProxy({ upstream: cfg.authProxy.upstream, port: cfg.authProxy.port, credential: () => auth.apiKey(), allow: (b) => budgetGate.allow(b), onUnreported: (b, m, u) => budgetGate.unreported(b, m, u) })
    : null;
  // Fail closed (security review minor 2): with the real brain the proxy is required. If it can't start, every spawn
  // is refused (AuthProxyDownError, a tray with Retry once the tray service exists below) rather than given the key in
  // its env. Only a test run may turn the proxy off (config.ts).
  requireAuthProxy(cfg.brain === "claude" && cfg.authProxy.enabled);
  let authProxyUp = !authProxy;
  // Bug 281: the API-key check (Settings → Account → Check, and after a key is saved): the free probe, then ONE tiny
  // message through the key proxy, asked of the budget and recorded in usage like any other spend.
  let keyCheckRecord: (model: string, u: KeyCheckSpend) => void = () => {};
  const keyCheck = new KeyCheck({
    dir: hp(AUTH_DIR), key: () => auth.apiKey(), models: () => modelAccess.probe(), now,
    proxy: () => (authProxy && authProxyUp ? authProxy : null),
    allow: () => budgetGate.allow(null),
    record: (m, u) => keyCheckRecord(m, u),
    onChange: (v) => hub.publish({ channel: "key-check", payload: v }),
  });
  const startAuthProxy = async (): Promise<boolean> => {
    if (!authProxy) return true;
    try {
      await authProxy.start();
      setAuthProxy(authProxy);
      authProxyUp = true;
    } catch (e) {
      log.error("auth proxy could not start; Claude processes are refused until it does", { port: cfg.authProxy.port, error: String(e) });
      authProxyUp = false;
    }
    return authProxyUp;
  };
  await startAuthProxy();

  // ---- conformance flags (§13.1): fake brain → defaults; real brain → saved results, first boot runs the fast suite ----
  // The boot reap (EVT-17 sweep) runs first; conformance starts only after it (H-2).
  let flags: ConformanceFlags = cfg.brain === "fake" ? DEFAULT_FLAGS : loadConformance(cfg.hostPrivate)?.flags ?? DEFAULT_FLAGS;
  const boot = startBootConformance({
    reap: () => bootSweep({ brain: cfg.brain, reap: reapWithSudo }),
    ensure: async () => {
      await budgetGate.ready; // bug 296: its real model calls go through the budget
      if (cfg.brain === "fake" || !credentialsReady()) return;
      flags = await ensureConformance(cfg, { checks: ALL_CHECKS });
    },
  });
  // A key saved after boot (a new install, or an old one that had no key): conformance runs then, one run at a time.
  let conformanceAfterKey: Promise<void> | null = null;
  const onKeySaved = (): void => {
    if (cfg.brain === "fake" || !credentialsReady() || conformanceAfterKey) return;
    conformanceAfterKey = boot.ready.then(() => ensureConformance(cfg, { checks: ALL_CHECKS })).then((f) => { flags = f; })
      .catch((e) => log.warn("conformance after the API key was saved failed", { error: String(e) }))
      .finally(() => { conformanceAfterKey = null; });
  };
  const conformanceReady: Promise<void> = boot.ready;
  // Kill switch: SYNAPSE_WARM_SESSIONS / SYNAPSE_PREWARM override the saved flags on every read (flags.ts withFlagOverrides).
  const flagsFn = () => withFlagOverrides(flags);

  // ---- services ----
  let phase3: Phase3Services | null = null;
  let gate: ApprovalGate | null = null;
  let p4Ref: Phase4 | null = null; // I2: the gate reads routine prompts from Phase 4, built later
  /** Bug 158: SendMessage call: "drop <Bot>" — wired once the call registry and the voice fronts exist. */
  let dropCall: ReturnType<typeof dropFromCall> | null = null;
  let reviewer: Reviewer | null = null;
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"), (view) => hub.publish({ channel: "host-settings", payload: view }));
  const bots = new BotService({ cfg, hub, settings, now, deleteSession: cfg.brain === "claude" ? (f) => { removeBoxSession(f); } : undefined, accounts: sudoBotAccounts(cfg) });
  bots.loadAll();
  relocateSessionRecords(cfg, bots); // bug #66: recorded session paths follow the Bot into (or out of) its own account
  const presence = new PresenceTracker((id) => { if (bots.has(id)) bots.publish(id); }, now);
  bots.setRuntimeView((id) => presence.view(id));
  const trays = new TrayService(hub, now);
  // Bug 364: on the box (the production service), no Bot turn runs without the box firewall; checked now and every minute.
  const firewall = new BoxFirewallCheck({
    enabled: process.platform === "linux" && process.env.NODE_ENV === "production" && process.env.VITEST === undefined,
    run: sudoFirewallCheck, log: (m) => console.warn(m),
    onChange: (ok) => { if (ok) for (const t of trays.list()) if (t.dedupeKey === "box-firewall") trays.dismiss(t.id); },
  });
  firewall.start();
  /** 0.1.4: set by the app (setNetworkPause) while the box's Local network state differs from the owner's choice. */
  let networkPaused = false;
  const proxyTray = (): void => {
    if (!authProxyUp && auth.apiKey()) trays.add({ botId: null, title: STR_AUTH.proxyDownTitle, detail: STR_AUTH.proxyDownDetail, retry: true, dedupeKey: "auth-proxy" });
  };
  proxyTray();
  onAuthChange = () => { proxyTray(); onKeySaved(); onKeyMaybeChanged(); };
  // Bug 44's class: an unreadable settings.json used to become the defaults with only a log line.
  if (settings.quarantined) trays.add({ botId: null, title: STR.traySettingsReset, detail: STR.traySettingsResetDetail(settings.quarantined), dedupeKey: "settings-quarantined" });
  const acks = new AckLedger(hp("ack-obligations.json"), now);
  // Phase 4 runtime metrics feed Phase 5's Usage view (USE-05 efficiency tiles); Phase 5 owns the "usage" channel.
  let phase5: Phase5 | null = null;
  const metrics = new RuntimeMetrics(hp("runtime-metrics.db"), { now, timeZone: () => settings.timeZone(), onChange: () => phase5?.publishUsage() });
  const rehearsals = new RehearsalRegistry();
  // Phase 2 composition targets: TurnRunner reads them at call time, so they are filled below, after construction.
  // Phase 2 widgets are canonical (controller ruling 1); Phase 4's host-posted widgets ride on HostWidgets.
  const hooks: TurnHooks = {};
  const ext: BotToolExtensions = {};
  const hostWidgets = new HostWidgets({ bots, now });
  // Phase 5 is wired after the runner, gate and supervisor exist; these late-bound hooks read it lazily.
  const circuit = new CircuitBreaker(now);
  // saving-settings, "Call replies": whether a call this Bot is on is live. Late-bound: the call registry is built with Phase 4.
  let botOnCall = (_botId: string): boolean => false;
  const runner = new TurnRunner({
    cfg, bots, acks, trays, presence, settings, flags: flagsFn, now, hooks, toolExtensions: ext, metrics,
    sendAcceptance: new SendAcceptanceLedger(hp("send-acceptance.json")), resume: new ResumeLedger(hp("host-restart-resume.json")),
    beforeTurn: () => conformanceReady,
    turnBlocked: async () => (networkPaused ? STR5.localNetworkPaused : firewall.blocked()),
    extraSystemAppend: (botId) => phase3?.promptSection(botId) ?? "",
    extraTools: (botId) => phase3?.botTools(botId) ?? [],
    extraSendHandlers: (botId) => phase3?.sendHandlers(botId),
    wrapWiring: (botId, wiring) => (phase3 ? phase3.wrapWiring(botId, wiring) : wiring),
    // bug 198 fix round 1: a tool-call step's own body (Read/Write/Edit/Bash content) is redacted with
    // the same scanner as everything else Bot-visible, before it is ever stored. fix round 2, finding 1:
    // fail closed like historyArchive's own redactor below (`: null`, not `: text`) — before phase3
    // exists there is no scanner to redact WITH, so bodyFor must get no body at all, never a raw one.
    redact: (botId, text) => (phase3 ? phase3.scanners.redact(botId, text) : null),
    observers: [{ onEvent: (b, e) => phase5?.observers().forEach((x) => x.onEvent?.(b, e)), onSettled: (t) => phase5?.observers().forEach((x) => x.onSettled?.(t)) }],
    systemAppendExtras: (botId) => phase5?.systemAppendExtra(botId) ?? "",
    extraBotTools: (botId, slot, base) => phase5?.botTools(botId, slot, base) ?? [],
    // cost-diet-2 lever 1: "Save usage" (per Bot, else the account's; default off) routes simple turns to Haiku 4.5.
    callLive: (bid) => botOnCall(bid),
    router: new ModelRouter({
      enabled: (bid) => saveUsageOn(bots.summary(bid).settings, settings.get().saveUsage),
      engineering: (bid) => !!bots.summary(bid).settings.engineeringMode,
      contextTokens: (bid) => readCtx(bots, bid).ctxTokens,
      now,
    }),
  });

  // saving-settings, "Long-context model: Only when needed": the chats that escalated to [1m] (one switch per chat).
  const longChats = new LongContextChats(hp("long-context-chats.json"), { sessionId: (bid) => bots.sessionId(bid), ctxTokens: (bid) => readCtx(bots, bid).ctxTokens });
  /** The Bot's spawn model under the Savings setting, and its [1m] id (history caps, the context meter, the escalation). */
  const botModels = (botId: string): { model: string; long: string } => {
    const chosen = bots.summary(botId).profile.model ?? DEFAULT_BOT_MODEL;
    // Review round 2 (P4): a model the key can't use falls back to one it can, with a plain message; no [1m] where the
    // key has no 1M context.
    const r = modelAccess.resolve(chosen);
    if (r.from) {
      trays.add({ botId, title: STR_AUTH.modelFallbackTitle, detail: STR_AUTH.modelFallback(isModelId(r.from) ? modelLabel(r.from) : r.from, isModelId(r.model) ? modelLabel(r.model) : r.model), dedupeKey: `model-fallback:${botId}:${r.from}` });
    }
    const base = r.model;
    if (!modelAccess.longContextOk(base)) return { model: base, long: base };
    const mode = settings.savings().longContext;
    return { model: spawnModelId(base, { longContext: mode, escalated: mode === "when-needed" && longChats.escalated(botId) }), long: spawnModelId(base) };
  };
  /** Everything a Bot's CLI is spawned with that can change between turns; a changed spawnKey respawns a warm process. */
  const spawnConfigFor = (botId: string): SpawnConfig => {
    ensureGitShim(cfg, GIT_BUILTIN_DIFF); // bug-log 121: first on every Bot's PATH (buildBotEnv)
    const systemAppend = runner.systemAppend(botId);
    // Phase 5 connector/plugin MCP servers: their tools reach the gate (classify: mcp surface) like any other call.
    const mcpServers = phase5?.mcpServers(botId) ?? {};
    const extraDisallowed = phase5?.disallowedTools() ?? [];
    // Ruling B: managed skills (bothost-owned tree) reach the CLI through --plugin-dir; a change respawns.
    const plugins = phase5?.cliPlugins() ?? [];
    const { profile, settings: botSettings } = bots.summary(botId);
    // saving-settings: read here, when the next turn's spawn config is built, so a turn already running keeps what it has.
    // The TTL is an env value (in the key's envHash: a warm process respawns on its next turn); the model is not in the
    // key (a warm process switches with setModel, ClaudeBrain.runTurn).
    const { model, long: longModel } = botModels(botId);
    const env = buildBotEnv({ cfg, botId, ...phase3!.envInputs(botId), promptCacheTtl: settings.savings().promptCacheTtl });
    // Token diet (2): the CLI's mid-task compaction cap; its value is in the key, so a change respawns. Always the [1m]
    // id's cap: on standard context the CLI clamps it to the 200k window, and after an escalation it is exactly as before.
    const historyKeep = botSettings.advanced?.historyKeep ?? DEFAULT_HISTORY_KEEP;
    applyHistoryEnv(env, historyKeep, longModel);
    const effort = profile.effort ?? DEFAULT_EFFORT;
    // Engineering mode ON = the preset; OFF = standalone (unless the box owner forced the preset).
    const systemPromptMode = systemPromptModeFor(cfg, botId, !!botSettings.engineeringMode);
    // S1 lean engineering profile (engineering mode ON) or the everyday profile (cost-diet-2 levers 2 + 3).
    const lean = leanSpawnFields(botSettings);
    return {
      model, effort, systemAppend, systemPromptMode, env, mcpServers, extraDisallowed, plugins, ...lean,
      ...(model !== longModel ? { longContext: { model: longModel, atTokens: LONG_CONTEXT_ESCALATE_TOKENS } } : {}),
      spawnKey: spawnKeyOf({
        systemAppend, systemPromptMode, envKeys: [...Object.keys(env).sort(), phase3!.spawnKeyPart(botId), `history:${historyKeep}`],
        mcpNames: ["bot", ...Object.keys(mcpServers).sort(), ...extraDisallowed.map((d) => `-${d}`).sort(), ...plugins.map((p) => `plugin:${p}`)],
        // The tool set is capability-gated, so it can change between turns; a warm CLI keeps the
        // tools it spawned with, so a changed set must cool the process (see spawnKeyOf).
        toolNames: [...runner.wiring(botId).botTools().map((t) => t.name), ...(lean.upFrontBotTools ?? []).map((n) => `upfront:${n}`),
          ...Object.entries(lean.skillOverrides ?? {}).map(([k, v]) => `skill:${k}=${v}`), ...(lean.builtinTools ?? []).map((n) => `builtin:${n}`)],
        tokenHash: auth.spawnKeyPart(), // a new API key respawns on the next turn
        effort,
        // Review fix round 1: env VALUES too, hashed (a rotated secret with the same name must reach a warm Bot).
        envHash: envValuesHash(env),
      }),
    };
  };
  const brainFactory = (botId: string): SupervisedBrain => {
    if (opts.brainFactory) {
      return opts.brainFactory(botId, { wiring: runner.wiring(botId), spawnConfig: () => spawnConfigFor(botId), getSessionId: () => bots.sessionId(botId), setSessionId: (sid) => bots.setSessionId(botId, sid) });
    }
    if (cfg.brain === "fake") {
      return new FakeBrain(botId, runner.wiring(botId), demoScriptFor(cfg.workspace), {
        sessionId: bots.sessionId(botId), now,
        // FUZZ/E2E: mcp__google__ calls reach the built-in connector (against the local fake Google); others stay canned.
        toolRunner: async (name, input) => (await phase5?.runFakeTool(botId, name, input)) ?? `(fake) ${name} ok`,
      });
    }
    return new ClaudeBrain({
      botId, cfg, wiring: runner.wiring(botId), now, log: (m, f) => log.info(m, f),
      getSessionId: () => bots.sessionId(botId), setSessionId: (sid) => bots.setSessionId(botId, sid),
      spawnConfig: () => spawnConfigFor(botId),
    });
  };
  const ledger = new SupervisorLedger(hp("supervisor.json"), bootId);
  // TTFT war room: while a voice call is live, keep one idle warm Bot process and no reviewer prewarm (RAM headroom
  // for the call). Late-bound: the call registry is built with Phase 4, below.
  let callLive = (): boolean => false;
  let reviewerWarm = (): number => 0;
  const supervisor = new Supervisor({
    caps: defaultCaps(), brainFactory, now,
    warmLimit: () => (callLive() ? 1 : Number.POSITIVE_INFINITY),
    externalWarm: () => reviewerWarm(),
    onPreempt: (id) => runner.preempt(id),
    onCrashBackoff: (id) => trays.add(crashBackoffTray(id)),
  });
  if (cfg.brain === "claude") supervisor.setRssSampler((pid) => treeRss(pid));

  const model = cfg.reviewer === "stub"
    ? new StubModelReviewer()
    : new SdkModelReviewer({ env: buildBotEnv({ cfg, botId: "reviewer" }), cwd: cfg.workspace, pathToClaudeCodeExecutable: claudeExecutableFor(flags.runAs, cfg),
      // One pooled process (it counts against the warm budget), read live: the CT-10 flag, SYNAPSE_PREWARM, and 0 on a call.
      prewarm: () => (flagsFn().prewarm && !callLive() ? 1 : 0) });
  if (model instanceof SdkModelReviewer) reviewerWarm = () => model.warmCount();
  reviewer = new Reviewer({
    settings, model, cache: new VerdictCache(now), circuit, log: new ReviewLog(hp("reviewer.log.jsonl"), now), now,
    timeZone: () => settings.timeZone(), workspace: cfg.workspace,
    // Item 9: the Bot's secrets never reach the reviewer model's input (enrichment included) or reviewer.log.jsonl.
    redact: (bid, text) => (phase3 ? phase3.scanners.redact(bid, text) : text),
    onDegraded: (on, err) => (on ? trays.add(reviewerDegradedTray(err)) : trays.list().filter((t) => t.dedupeKey === "reviewer").forEach((t) => trays.dismiss(t.id))),
  });
  // The gate needs its reviewer before phase5 exists, so the Phase 5 reviewer rules are a lazy decorator.
  const inner = reviewer;
  const phase5Reviewer: ReviewerLike = {
    review: (req) => (phase5 ? phase5.wrapReviewer(inner).review(req) : inner.review(req)),
    clearCache: () => inner.clearCache(),
  };
  gate = new ApprovalGate({
    cfg, bots, settings, reviewer: phase5Reviewer, now, flags: flagsFn, slot: (id) => runner.slot(id), rehearsals,
    // Bug 231 round 1: the fast path judges ~/code trees as the Bot (bothost can't enter the 0700 homes).
    homeFs: cfg.perBotUid && cfg.brain !== "fake" && process.env.FUZZ !== "1" ? sudoFsQuery(cfg, execBuf, { log: (m) => console.warn(m) }) : undefined,
    // fix-mac-gate-and-approval-expiry (Bug B): pending cards survive a host restart and stay answerable.
    persistFile: path.join(cfg.hostPrivate, "pending-approvals.json"),
    // I2: the routine's saved instruction (trusted) for the reviewer's wake block; Phase 4 is built later.
    routinePrompt: (botId, routineId) => p4Ref?.services.store.get(botId, routineId)?.def.prompt ?? null,
    onDeferredResolution: (botId, text) => runner.enqueueHidden(botId, { source: "approval-resume", lane: "user", head: true, silenceAllowed: false, text }),
    displayIdentity: (botId) => (phase3 ? phase3.browser.identity(botId).catch(() => null) : Promise.resolve(null)),
    shellLastCwd: (botId, childId) => phase3?.shells.lastCwdFor(botId, childId) ?? null,
    mcpReadOnly: (serverId, tool) => phase5?.mcpReadOnly(serverId, tool) ?? false,
    mcpServerHost: (serverId) => phase5?.mcpServerHost(serverId) ?? null,
    mcpServerComposio: (serverId) => phase5?.mcpServerComposio(serverId) ?? false,
    mcpToolInfo: (serverId, tool) => phase5?.mcpToolInfo(serverId, tool) ?? { known: false, description: null },
    composioBuiltin: (botId) => phase5?.composioBuiltin(botId) ?? false,
    // Bug 413: who a Composio send reaches, read through the Bot's own granted connection (a read-listed tool).
    // Bug 420: known contacts — the owner's Gmail Sent folder, through Google if connected, else Composio's Gmail.
    sentTo: async (botId, address) => {
      const g = phase5 ? await phase5.google.sentTo(address) : null;
      if (g !== null) return g;
      return phase5 ? (await composioSentTo((s, a) => phase5!.composio.hostLookup(botId, s, a), address)) === true : false;
    },
    composioRecipients: (botId, slug, args) => (phase5 ? resolveComposioSend((s, a) => phase5!.composio.hostLookup(botId, s, a), slug, args) : Promise.resolve({ error: "Composio isn't set up." })),
    // feat-mac-access-parity: the per-Bot permission mode and the connected Mac, for the fixed-rules layer.
    permMode: (botId) => (bots.has(botId) ? bots.summary(botId).settings.permMode ?? "ask" : "ask"),
    noLimits: (botId) => bots.has(botId) && bots.summary(botId).settings.noLimits === true,
    macEnv: () => phase5?.macEnv() ?? null,
    googleEmail: () => phase5?.googleEmail() ?? null,
    googleBuiltin: (botId) => phase5?.googleBuiltin(botId) ?? false,
    googleClientReplace: (botId) => (phase5 ? phase5.google.setup.cardFor(botId, phase5.google.status().state === "connected") : null),
    googleDraftPreview: (draftId) => (phase5 ? phase5.googleDraftPreview(draftId) : Promise.resolve({ error: STRG.toolNotConnected })),
    googleCardFacts: (tool, input) => (phase5 ? phase5.googleCardFacts(tool, input) : Promise.resolve({ error: STRG.toolNotConnected })),
    // Item 9: the Bot's secrets never reach the approval card the user sees (the draft-send preview included).
    redact: (bid, text) => (phase3 ? phase3.scanners.redact(bid, text) : text),
  });

  // ---- Phase 2 (Tasks 5–35) ----
  const nameOf = (bid: string) => (bots.has(bid) ? bots.summary(bid).profile.name : "a deleted Bot");
  const sizeOf = (p: string): number | null => { try { return fs.statSync(p).size; } catch { return null; } };
  // Memory provenance: the bi-temporal ledger (host-private, in every backup); the boot migration imports what predates it.
  const memoryLedger = new FactLedger(hp("memory-ledger.db"), now);
  const memory = new MemoryStore({ cfg, now, ledger: memoryLedger });
  const recallIndex = new RecallIndex(hp("memory-index.db"));
  reindexAll({ index: recallIndex, store: memory, botIds: bots.ids() });
  migrateMemoryToLedger({ store: memory, ledger: memoryLedger, botIds: bots.ids() });
  const stopRecall = startRecallSync({ index: recallIndex, store: memory });
  const helper: OneShotModel = cfg.brain === "fake"
    ? new StubOneShot(() => "NONE")
    : new SdkOneShot({ env: buildBotEnv({ cfg, botId: "memory" }), cwd: cfg.workspace, pathToClaudeCodeExecutable: claudeExecutableFor(flags.runAs, cfg) });
  // §05.1: memory never stores a Bot's secrets — the Phase 3 vault's values feed the extractor's redaction and guard.
  const secretValues = (bid: string): string[] => (phase3 ? phase3.vault.values(bid).map((v) => v.value) : []);
  // I5: Phase 2 stores (memory, search index, transcript mirror, rollover copy/handoff) go through the scanner's redact.
  const redactFor = (bid: string, text: string): string => (phase3 ? phase3.scanners.redact(bid, text) : text);
  const extractor = new MemoryExtractor({ store: memory, model: helper, secrets: secretValues, timeZone: () => settings.timeZone(), nameOf, now });
  const episodes = new EpisodeWriter({ bots, store: memory, model: helper, secrets: secretValues, timeZone: () => settings.timeZone(), nameOf, now });
  const memoryEngine = createMemoryEngineHooks({
    extractor, episodes, redact: redactFor, secrets: secretValues, settings, lean: leanMemoryGate(bots),
    // cost-diet-2 lever 4: the pending extraction batch (redacted exchanges only, never secret values) in the Bot's store.
    pending: {
      get: (bid) => (bots.has(bid) ? bots.require(bid).store.getKv<PendingExchange[]>("extractPending", []) : []),
      set: (bid, list) => { if (bots.has(bid)) bots.require(bid).store.setKv("extractPending", list); },
    },
  });
  const skills: SkillLibrary = new SkillLibrary({ cfg, now, onChange: () => publishSkills(hub, skills, bots.ids()) });
  const attachments = new AttachmentStore({ cfg, now });
  const searchIndex = new SearchIndex(hp("search-index.db"), { redact: redactFor });
  const stopSearch = startSearchSync({ hub, index: searchIndex });
  const stopMirror = startTranscriptMirror({ hub, dataRoot: cfg.dataRoot, redact: redactFor });
  // History archive (designed): one bothost-only file, since every Bot runs as uid box
  // and can read agent-data. Redacted on write by the scanner plus the vault's values; until Phase 3
  // exists the redactor answers null and writes wait. Searched only by the calling Bot's own tool.
  const historyArchive = new HistoryArchive(hp("history-archive.db"), {
    redact: (bid, text) => (phase3 ? phase3.scanners.redact(bid, text) : null),
    secrets: secretValues,
  });
  const historyIndexer = new HistoryIndexer({
    archive: historyArchive, hub, nameOf, timeZone: () => settings.timeZone(),
    botIds: () => bots.ids(), exists: (bid) => bots.has(bid),
    entries: (bid) => bots.tail(bid, Number.MAX_SAFE_INTEGER),
    sessionFiles: (bid) => {
      const rolled = bots.brainKv<{ file: string }[]>(bid, "rolledSessionFiles", []).map((r) => r.file);
      return [...new Set([...rolled, bots.sessionFilePath(bid)])].filter((f): f is string => Boolean(f) && sizeOf(f!) !== null);
    },
    readSession: (p) => (cfg.brain === "fake" ? fs.readFileSync(p) : readSessionFile(p)).toString("utf8"),
  });
  historyIndexer.start();
  const compactFn = cfg.brain === "fake"
    ? async () => true
    : async (bid: string, signal: AbortSignal) => {
        const sid = bots.sessionId(bid);
        if (!sid) return false;
        const env = buildBotEnv({ cfg, botId: bid, ...(phase3 ? phase3.envInputs(bid) : {}), promptCacheTtl: settings.savings().promptCacheTtl });
        const base = buildBotQueryOptions({
          // Compaction keeps the preset it has always run under (config.ts: "compaction stays on the preset regardless").
          cfg, flags, resumeSessionId: sid, newSessionId: null, systemAppend: runner.systemAppend(bid), systemPromptMode: "preset", model: botModels(bid).model, env,
          mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async () => ({ behavior: "deny", message: "No tools during compaction." }), abortController: new AbortController(),
        });
        return runCompactQuery({ options: compactQueryOptions(base, sid), instructions: compactInstructions({ botName: nameOf(bid), botId: bid }), signal, botId: bid });
      };
  // Session files are root-owned in the box: the real brain goes through the root helpers (Task 15G).
  const rollover = new Rollover({
    cfg, bots, runner, trays, flags: flagsFn, now, newId: randomUUID,
    readSession: (p) => (cfg.brain === "fake" ? fs.readFileSync(p) : readSessionFile(p)),
    writeSession: (p, data) => (cfg.brain === "fake" ? fs.writeFileSync(p, data) : writeSessionFile(p, data.toString("utf8"))),
    sizeOf,
    deleteSession: cfg.brain === "claude" ? (f) => { removeBoxSession(f); } : undefined,
    redact: redactFor,
  });
  // A finished compaction hands its summary to the history archive (async; never on the turn).
  const compactAndArchive = async (bid: string, signal: AbortSignal) => { const ok = await compactFn(bid, signal); if (ok) historyIndexer.compacted(bid); return ok; };
  const compactor = new Compactor({
    bots, runner, trays, flags: flagsFn, now, compact: compactAndArchive, onOverflowAgain: (bid) => void rollover.rollNow(bid, "overflow", { retry: true }),
    // S1: an engineering-mode Bot writes its episode when the session compacts.
    onCompacted: (bid) => memoryEngine.compacted(bid),
  });
  // Composition order is the prompt order (EVT-12).
  Object.assign(hooks, composeHooks([
    createWidgetHooks({ bots }),
    createThreadHooks({ bots }),
    createSkillHooks({ library: skills }),
    createAttachmentHooks({ bots }),
    createRecallHooks({ index: recallIndex, store: memory, ledger: memoryLedger, frozen: (bid) => frozenFactIds(bots, bid), nameOf, now, enabled: () => settings.memoryRecallOn() }),
    createRestoreHooks({ bots, dataRoot: cfg.dataRoot }),
    createMemoryPromptHooks({ store: memory, bots, dataRoot: cfg.dataRoot }),
    createSkillOptOutHooks({ library: skills }),
    createContextMeterHooks({ bots, modelOf: (bid) => botModels(bid).long, now }),
    { onEvent: (bid, e) => longChats.onEvent(bid, e) }, // saving-settings: a chat past the line stays on [1m]
    compactor.hooks(),
    rollover.hooks(),
    memoryEngine,
  ]));
  Object.assign(ext, mergeExtensions([
    createSettingsToolExtension({ bots }),
    createWidgetExtension({ bots, now }),
    createMemoryToolExtension({ store: memory }),
    createSkillToolExtension({ library: skills, bots, now }),
    createAttachmentSendExtension({ cfg }),
    createReactionToolExtension({ bots, acks }),
    createHistoryToolExtension({ archive: historyArchive, memory }),
  ]));

  // ---- Phase 5 (marketplace, connectors, local exec, templates, voice, usage, avatars, dreaming, follow-ups) ----
  const p5 = wirePhase5({
    cfg, hub, settings, bots, trays, now, flags: flagsFn,
    enqueueHidden: (b, sp) => runner.enqueueHidden(b, sp), isIdle: (b) => runner.isIdle(b), slot: (b) => runner.slot(b),
    sendPrompt: (b, t, n, meta) => runner.sendPrompt(b, t, n, meta), ladder: () => p5.ladder,
  }, { fake: cfg.brain === "fake", circuit, kickstart: (b) => runner.kickstart(b), efficiency: () => metrics.efficiency(), redact: redactFor, gate,
    widgets: hostWidgets, // cost-dashboard: budget approval cards for held routine fires
    // Screen share: a Bot on a live 1:1 call may ask for one snapshot; the app sends it only if the user is sharing.
    onLook: (b) => {
      const roster = p4Ref?.services.calls.roster(b);
      if (!roster || roster.length !== 1) return false;
      hub.publish({ channel: "call-look", payload: { botId: b } });
      return true;
    },
    // Bug 158: a Bot on a call may take another Bot off it; dropFromCall (wired once the call registry exists) decides.
    onDrop: (b, name) => dropCall?.(b, name) ?? { text: "Calls aren't running on this host.", isError: true },
    // Bug 44(b): the caller decides what to do about a fact that did not land — it used to be told nothing.
    remember: (bid, fact) => { try { memory.add({ kind: "agent", botId: bid }, { content: fact, tier: "profile", kind: "fact" }); return true; } catch (e) { log.warn("template fact not saved", { error: String(e) }); return false; } } });
  phase5 = p5;
  // Phase 5's gate decorator (disabled MCP tools, local asks expiry) wraps the one ApprovalGate; the ctx (cwd binding) passes through.
  runner.attach(supervisor, p5.wrapGate(gate));
  phase3 = await createPhase3Services({
    cfg, hub, bots, acks, settings, supervisor, gate, runner,
    fuzz: process.env.FUZZ === "1" || cfg.brain === "fake", brainKind: cfg.brain,
    flags: flagsFn, now, rehearsals, // I3
  });
  budgetGate.wire({ allow: (b) => p5.budgetAllow(b), unreported: (b, m, u) => p5.recordUnreported(b, m, u) });
  keyCheckRecord = (m, u) => p5.recordUnreported(null, m, u, "key-check");
  // Bug 195 S2: a Bot's turn starting cancels its pending GitHub sign-in (Shell and subagent starts are wired in phase3).
  runner.addObserver({ onTurnStart: (botId) => phase3?.github.botStartedWorking(botId) });
  reindexSearch({ index: searchIndex, bots }); // I5: after Phase 3, so the rebuilt index is scanner-redacted
  historyIndexer.backfill(); // after Phase 3 too: the archive refuses to write until the scanner exists

  // ---- Phase 4 (routines, bot-to-bot, groups, control plane, teach) ----
  const helperModel: HelperOneShotModel = cfg.reviewer === "stub" || cfg.brain === "fake"
    ? new HelperStubOneShot({
        "orig/b2b-gate.md": () => ({ verdict: "inbox", kind_suggestion: null, reason: "fuzz stub" }),
        "orig/group-floor.md": () => { throw new Error("floor manager stubbed off"); }, // falls back to round-robin (ORIG-10 §10.1 step 5)
        "orig/schedule-parser.md": () => ({ schedule: "", timezone: null, confidence: 0, ambiguity: "What time of day should it run?" }),
        // The fake standup line: the Bot's last message from its digest, no model.
        // Bug 134: fake greetings (the stock set's shape) and a fake wrap-up, no model.
        "orig/call-greetings.md": (input) => ({ greetings: STRV.stockGreetings((input as { user?: string | null }).user ?? null).map((g) => ({ text: g.text, when: g.when ?? "any" })) }),
        "orig/call-wrapup.md": (input) => ({ line: "Okay, that's the plan. Talk soon.", summary: `A ${(input as { minutes?: number }).minutes ?? 0} minute call.`, actions: [] }),
        "orig/standup-line.md": (input) => {
          const d = String((input as { digest?: string }).digest ?? "");
          return { did: (/bot said: (.*)/.exec(d)?.[1] ?? "worked on recent requests").slice(0, 80), blocked: /waiting on: (.*)/.exec(d)?.[1]?.slice(0, 80) ?? "nothing", needs: "nothing" };
        },
      })
    : new HelperSdkOneShot({ env: buildBotEnv({ cfg, botId: "helper" }), cwd: cfg.workspace, pathToClaudeCodeExecutable: claudeExecutableFor(flags.runAs, cfg) });
  const p3 = phase3;
  // I6 (06:45 ruling) order, shared by the UI and the control plane's DeleteAgent: mark deleted + interrupt →
  // Phase 4 stores (routines, requests, threads, group seats, teach) → Phase 5 removeBot → Phase 3 cleanup → drain/drop memory →
  // clear memory (recall purge) → session files (child sessions included) → the vault and connector secrets.
  const deleteBotFully = async (id: string): Promise<void> => {
    await runner.beginDelete(id);
    await p4.cleanupBot(id); // routines/triggers/fires/teach, recorder.forgetBot
    await p5.removeBot(id); // P5 review I12: coding agents, local asks + Mac execs, follow-ups, dreaming, cards
    await p3.deleteBot(id); // shells, subagents, displays
    await memoryEngine.dropBot(id);
    memory.clearBot(id);
    await runner.finishDelete(id);
    p3.forgetSecrets(id);
  };
  const p4 = (p4Ref = installPhase4({
    cfg, hub, bots, runner, settings, trays, acks, metrics, model: helperModel, widgets: hostWidgets, now,
    deleteBot: deleteBotFully,
    resolveAttachments: (chatId, ids) => attachments.resolve(chatId, ids),
    // Teach a task records the Bot's real Phase 3 screen (CMP-04 seat), never a guessed display.
    // Only a running seat counts (x11grab needs a live X server); indexFor() would hand out a fresh seat.
    displayOf: (botId) => { const i = p3.displays.info(botId); return i?.running ? i.display : null; },
    displayEnv: (botId): Record<string, string> => {
      const i = p3.displays.info(botId);
      if (!i) return {};
      const x = p3.displays.xenv(i.index);
      return { DISPLAY: x.display, XAUTHORITY: x.xauthority };
    },
    cdpPortOf: (botId) => p3.displays.info(botId)?.cdpPort ?? null,
    secretValues: (botId) => p3.vault.values(botId).map((v) => v.value),
    redact: (botId, text) => p3.scanners.redact(botId, text), // I10
    // Phase 5: the usage ladder, then the routine's Bot's budgets (cost-dashboard). Scheduled and triggered runs alike.
    routinePausedUntil: (routineId) => p5.routinePausedUntil(routineId, (id) => { const r = p4Ref?.services.store.all().find((x) => x.id === id); return r ? { botId: r.botId, name: r.def.name } : null; }),
    // Mail and calendar triggers read through the built-in Google connector, host-side (no model call to poll).
    googleGet: (api) => {
      const g = p5.google;
      if (!g.auth.isConnected()) return null;
      return <T>(p: string, query?: Record<string, string | number | undefined>) => g.api.call<T>(`${api === "gmail" ? g.api.endpoints.gmail : g.api.endpoints.calendar}${p}`, { query });
    },
    googleAllowed: (botId) => p5.google.enabledFor(botId) && p5.google.auth.isConnected(),
    macList: (folder, botId) => p5.macList(folder, botId),
    // Bug 134: the pick-up greetings use the user's first name from their memory profile, when it holds one.
    userName: () => userNameFromFacts(memory.userShardOwners().flatMap((o) => memory.profile({ kind: "user", botId: o }).map((f) => f.content))),
  }));
  // I10: connector secrets (Slack/GitHub tokens, signing secrets, IMAP passwords) are scanner values too.
  p3.scanners.addSource((botId) => p4.services.adapters.secrets.values(botId));
  p4.services.adapters.secrets.onChange((botId) => p3.scanners.invalidate(botId));
  // google-setup: the Google client secret (saved, or captured off a page by the setup task) is redacted everywhere.
  p3.scanners.addSource(() => {
    const saved = p5.google.auth.clientSecret();
    return [...(saved ? [{ name: "GOOGLE_CLIENT_SECRET", value: saved }] : []), ...p5.google.setup.secrets()];
  });
  const rescan = () => { for (const id of bots.ids()) p3.scanners.invalidate(id); };
  p5.google.onChange(rescan);
  p5.google.setup.onSecrets(rescan);
  const { sendPrompt: p4Send, ...p4Rest } = p4.handlers as Required<Pick<CommandHandlers, "sendPrompt">> & CommandHandlers;

  // ---- Bug 142: the voice fast path. On a 1:1 call the Bot's voice (a warm, lean front session on the Bot's
  // own model, low effort, one tool: delegate) answers each utterance; real work is a voice-delegate wake on the
  // full session, whose report the voice speaks. Everything lands in the chat. SYNAPSE_VOICE_FAST_PATH=off disables it.
  const fronts = new VoiceFronts({
    bots, runner,
    gate: { pending: (b) => gate?.pending(b) ?? [], resolve: (b, id, c, n) => { if (!gate) throw new GatewayError("STALE_APPROVAL", "No approvals here.", 409); return gate.resolve(b, id, c, n); } },
    calls: p4.services.calls,
    factory: cfg.brain === "fake"
      ? (spec) => new ScriptedFrontSession(spec, demoFrontScript)
      : (spec) => new SdkFrontSession(spec, { env: buildBotEnv({ cfg, botId: "voice-front" }), cwd: cfg.workspace, pathToClaudeCodeExecutable: claudeExecutableFor(flags.runAs, cfg) }),
    enabled: () => cfg.voiceFastPath,
    recall: (b, t) => (settings.memoryRecallOn() ? recallFor({ index: recallIndex, store: memory, ledger: memoryLedger, frozen: (bid) => frozenFactIds(bots, bid), nameOf, now }, b, t).block : null),
    userName: () => userNameFromFacts(memory.userShardOwners().flatMap((o) => memory.profile({ kind: "user", botId: o }).map((f) => f.content))),
    quiet: (b) => hub.publish({ channel: "call-quiet", payload: { botId: b } }),
    now, log: (m, f) => log.info(m, f),
  });
  // Only the voice speaks on a fast-path call: the full session's stream stays unpublished (its messages still land).
  runner.setQuietPartials((b) => fronts.onCall(b));
  // What the voice and the user said on the call rides the full session's next turn, once.
  runner.addPromptDecorator((b) => { const t = fronts.takeUnsynced(b); return t ? { text: t } : null; });
  const withFastPath = <T extends { chatId: string }>(v: T) => ({ ...v, fastPath: fronts.onCall(v.chatId) });
  // Bug 158: "drop Otto" said to a Bot ON the call (SendMessage call: "drop <Bot>"). The rules — its own
  // call only, never the call's own Bot, never the user — are in dropFromCall, on the host, not in a prompt.
  dropCall = dropFromCall({
    calls: p4.services.calls,
    name: (id) => (bots.has(id) ? bots.summary(id).profile.name : id),
    changed: (view) => { fronts.callChanged(view.chatId); hub.publish({ channel: "call-roster", payload: withFastPath(view) }); },
  });
  callLive = () => p4.services.calls.liveCount() > 0;
  botOnCall = (bid) => p4.services.calls.callFor(bid) !== null;
  // A call starting or ending re-sizes the reviewer's prewarm pool at once; idle Bot processes follow on the next tick.
  const callsChanged = () => { if (model instanceof SdkModelReviewer) model.resize(); };
  const callWrap: CommandHandlers = {
    startCall: async (a) => { const v = await p4Rest.startCall!(a); fronts.callChanged(v.chatId); callsChanged(); return withFastPath(v); },
    addToCall: async (a) => { const v = await p4Rest.addToCall!(a); fronts.callChanged(v.chatId); return withFastPath(v); },
    removeFromCall: async (a) => { const v = await p4Rest.removeFromCall!(a); fronts.callChanged(v.chatId); return withFastPath(v); },
    endCall: async (a) => { const info = typeof a?.callId === "string" ? p4.services.calls.info(a.callId) : null; const r = await p4Rest.endCall!(a); if (info) fronts.callEnded(info.chatId); callsChanged(); return r; },
    voiceSpeculate: (a) => {
      if (typeof a?.id !== "string" || typeof a.specId !== "string" || typeof a.text !== "string") throw new GatewayError("BAD_ARGS", "id, specId and text are required.");
      return fronts.speculate(a.id, a.specId.slice(0, 80), a.text.slice(0, 4_000));
    },
    voiceSpeculateCancel: (a) => { if (typeof a?.id === "string" && typeof a.specId === "string") fronts.cancelSpeculation(a.id, a.specId); return {}; },
  };
  const compile = () => {
    if (cfg.reviewer === "stub") return;
    void compileAll(settings, sdkCompilerCall({ env: buildBotEnv({ cfg, botId: "rule-compiler" }), cwd: cfg.workspace, pathToClaudeCodeExecutable: claudeExecutableFor(flags.runAs, cfg) }))
      .catch((e) => log.warn("rule compile failed", { error: String(e) }));
  };

  // ---- boot (EVT-17 order) ----
  await boot.swept;
  ledger.write([]);
  gate.expirePersistedCards();
  p4.boot(); // EVT-17: reconcile routines before resuming interrupted turns
  runner.resumeAtBoot();
  await p5.start();
  compile();
  await phase3.boot();
  let ticks = 0;
  const ticker = setInterval(() => {
    void supervisor.tick();
    if (++ticks % 3600 === 0) {
      try { attachments.sweepParts(); rollover.sweepOldSessions(); } catch (e) { log.warn("hourly sweep failed", { error: String(e) }); }
    }
    void reviewer?.runProbe();
    ledger.write(bots.ids().flatMap((id) => {
      const b = supervisor.brainFor(id);
      return b.pid ? [{ pid: b.pid, botId: id, kind: "bot" as const, sessionId: b.sessionId, startedAt: b.lastActiveAt }] : [];
    }));
  }, 1000);
  ticker.unref();
  const phase3Ticker = setInterval(() => void phase3!.tick(), 5000);
  phase3Ticker.unref();

  const health = (): HealthInfo => {
    const r = loadConformance(cfg.hostPrivate);
    return {
      ok: true, hostVersion: HOST_VERSION, bootId, brain: cfg.brain, cliVersion: r?.cliVersion ?? null, tokenConfigured: credentialsReady(),
      conformance: { ranAt: r?.ranAt ?? null, failed: Object.entries(r?.results ?? {}).filter(([, v]) => v.status === "fail").map(([k]) => k) },
      hostBuild: buildId, previousRun, lastRestore: readLastRestore(cfg),
      diskFreeBytes: diskFreeBytes(cfg.workspace),
    };
  };

  const core: CommandHandlers = {
    getHealth: () => health(),
    listAgents: () => ({ agents: bots.list(), activeAgentId: bots.activeAgentId() }),
    createAgent: (a) => {
      const id = bots.create({ ...a, origin: "user", kickstart: a.isKickstartRequested !== false });
      runner.kickstart(id);
      return { id };
    },
    updateAgent: (a) => ({ agent: bots.update(a.id, a) }),
    deleteAgent: async (a) => { await deleteBotFully(a.id); return { activeAgentId: bots.activeAgentId() }; },
    openAgent: (a) => { const agent = bots.open(a.id); p4.onOpened(a.id); return { agent }; },
    dismissTray: async (a) => {
      if (a.action === "retry" && trays.get(a.trayId)?.dedupeKey === "auth-proxy") {
        trays.dismiss(a.trayId);
        if (!(await startAuthProxy())) proxyTray();
        return {};
      }
      if (a.action === "retry") runner.retryTray(a.trayId);
      else if (!p4.onTrayAction(a.trayId, a.action ?? "dismiss")) trays.dismiss(a.trayId);
      return {};
    },
    setAgentPinned: (a) => ({ pinnedAgentIds: bots.setPinned(a.id, a.pinned) }),
    getAgentTranscriptTail: (a) => ({ entries: bots.tail(a.id, Math.min(a.limit ?? 200, 1000)) }),
    sendPrompt: (a) => {
      if (typeof a.text !== "string" || typeof a.clientNonce !== "string") throw new GatewayError("BAD_ARGS", "That message couldn't be sent. Try again.");
      // Phase 4 routeSendPrompt: a group id goes to the orchestrator; a Bot keeps Phase 2's attachments, replies and skills
      // plus Phase 5's voice tag and @-mention hints (connectors-module passes `hints` through here).
      // Bug 108: a spoken post in a 1:1 chat whose call has more than one Bot goes to the call room too.
      if (p4.services.groups.isGroup(a.id) || isCallRoomPost(p4.services.calls, a)) return p4Send(a);
      // Bug 142: a spoken post on a 1:1 fast-path call is answered by the Bot's voice (a shared screen still goes
      // to the full session, which can see it).
      if (fronts.handles(a.id, a.voice) && !a.attachmentIds?.length) {
        return fronts.userPost(a.id, a.text, a.clientNonce, { durationMs: a.voice?.durationMs, ...(typeof a.voice?.speculationId === "string" ? { speculationId: a.voice.speculationId } : {}), ...(a.voice?.continues === true ? { continues: true } : {}) });
      }
      const hints = (a as typeof a & { hints?: string[] }).hints;
      return runner.sendPrompt(a.id, a.text, a.clientNonce, {
        attachmentEntries: a.attachmentIds?.length ? attachments.resolve(a.id, a.attachmentIds) : undefined,
        replyToId: a.replyToId ? validateReplyTo(bots, a.id, a.replyToId) : undefined,
        skillIds: a.skillIds?.filter((s) => skills.read(s) && !skills.disabledFor(a.id).includes(s)),
        voiceDurationMs: a.voice?.durationMs,
        voiceCall: a.voice?.call === true,
        hints,
      });
    },
    interruptAgent: async (a) => { await runner.interruptAgent(a.id); return {}; },
    resolveAutoReviewApproval: (a) => ({ status: gate!.resolve(a.id, a.approvalId, a.choice, typeof a.note === "string" ? a.note : undefined) }),
    getHostSettings: () => settings.view(),
    setHostSettings: (a) => {
      const before = settings.rulesVersion();
      const wasOn = settings.get().autoReviewEnabled;
      const view = settings.update(a);
      if (settings.rulesVersion() !== before || view.autoReviewEnabled !== wasOn) { gate!.settingsChanged(); compile(); }
      return view;
    },
    setMacTimeZone: (a) => { settings.setMacTimeZone(a.zone); return settings.view(); },
    // 0.1.4: the app saw the box's Local network state differ from the owner's choice (tampering, or a failed apply).
    // No Bot turn starts until the app says it matches again; a tray says why.
    setNetworkPause: (a) => {
      networkPaused = a.on === true;
      if (networkPaused) trays.add({ botId: null, title: STR5.localNetworkPaused, dedupeKey: "local-network" });
      else for (const t of trays.list()) if (t.dedupeKey === "local-network") trays.dismiss(t.id);
      return { on: networkPaused };
    },
    getTrays: () => ({ trays: trays.list() }),
    clearTrays: (a) => { trays.clear(a.botId); return {}; },
  };

  // Phase 5 modules add their own commands (a name clash with the base set is a wiring bug) and wrap base ones.
  const handlers = p5.composeHandlers(mergeCommands(
    core,
    phase3.handlers,
    { ...p4Rest, ...callWrap },
    createBotAdminCommands({ bots }),
    // 0.1.4: Synapse's MCP server — an approved outside app's request runs as an outside wake (host/mcp-server).
    new McpBridge({ runner, bots, redact: redactFor, now }).commands(),
    createWidgetCommands({
      bots, acks, now, host: hostWidgets,
      wake: (bid, text) => runner.enqueueHidden(bid, { source: "widget-answer", lane: "user", silenceAllowed: false, text, ackToken: acks.token(bid), userSeqMax: bots.latestUserSeq(bid) }),
    }),
    createAttachmentCommands({ store: attachments }),
    createFileCommands({ cfg }),
    createThreadCommands({ bots }),
    createReactionCommands({ bots, wake: (bid, text) => runner.enqueueHidden(bid, { source: "reaction", lane: "background", silenceAllowed: true, text }) }),
    createSkillCommands({ library: skills, botIds: () => bots.ids() }),
    createSearchCommands({ index: searchIndex, bots }),
    createContextCommands({ bots, compactor, rollover, sizeOf }),
    createMemoryCommands({ store: memory, botExists: (id) => bots.has(id), nameOf, secrets: secretValues, redact: redactFor }),
    createHistoryCommands({ archive: historyArchive, bots }),
    createAuthCommands({ store: auth, keyPair: () => loadOrCreateBoxKeyPair(cfg.hostPrivate), fake: process.env.FUZZ === "1" || cfg.brain === "fake" }),
    {
      // Review round 2 (P4): `refresh` re-probes now (real brain only); otherwise the last answer.
      getModelAccess: async (a) => {
        if (a?.refresh === true && cfg.brain === "claude" && auth.apiKey()) return modelAccess.probe();
        return modelAccess.view();
      },
      // Bug 281: `refresh` runs the API-key check now (real brain only: a test host never makes a network call).
      checkApiKey: async (a) => {
        if (a?.refresh === true && cfg.brain === "claude") return keyCheck.run();
        return keyCheck.view();
      },
    },
  ));
  const backupRaw = createBackupRaw({ cfg, hostVersion: HOST_VERSION, now, bots: () => bots.ids().map((id) => ({ id, name: nameOf(id) })) });
  const server: http.Server = createGateway({
    token, hub, handlers, health, raw: async (req, res, url) => (await backupRaw(req, res, url)) || phase3.raw(req, res, url), upgrade: phase3.upgrade, bodyLimits: p5.bodyLimits,
    onSseClients: (n) => p4.services.recorder.noteViewers(n),
  });

  return {
    hub, token, bootId, handlers, settings,
    services: {
      bots, runner, gate, supervisor, reviewer, trays, phase3, memory, memoryEngine, recallIndex, skills, attachments, searchIndex, compactor, rollover,
      voiceFronts: fronts,
      historyArchive, historyIndexer,
      rehearsals, phase4: withStart(p4.services, () => p4.start()), phase5: p5, spawnConfig: spawnConfigFor,
    },
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, cfg.bind, () => {
          const port = (server.address() as AddressInfo).port;
          writeGatewayInfo(cfg.hostPrivate, { port, pid: process.pid, startedAt: now(), scheme: "http", host: cfg.bind, token, hello: 1 });
          p4.start().then(() => resolve({ port }), reject);
        });
      }),
    close: async () => {
      firewall.stop();
      await p4.stop(); // EVT-19: scheduler, webhook listener and watchers stop first
      clearInterval(ticker);
      clearInterval(phase3Ticker);
      runner.quiesce(); // §16.9 step 1: markers first
      await p5.stop();
      await supervisor.shutdown();
      metrics.close(); // after the brains stop, so a settling turn can't bump a closed database
      if (model instanceof SdkModelReviewer) model.dispose();
      compactor.dispose(); stopRecall(); stopSearch(); stopMirror(); historyIndexer.stop();
      await memoryEngine.drain();
      recallIndex.close(); memoryLedger.dispose(); searchIndex.close(); historyArchive.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      recordRunEnd(cfg, bootId);
      releaseAuthSource(auth);
      requireAuthProxy(false);
      if (authProxy) { setAuthProxy(null); await authProxy.stop(); }
      releaseLock();
    },
  };
}
