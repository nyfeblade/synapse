import path from "node:path";
import { credentialsReady } from "../auth/auth-env";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { CommandName } from "@synapse/shared";
import type { ApprovalGateLike } from "../runner/bot-wiring";
import type { ReviewerLike } from "../approvals/approval-gate";
import { createAvatarModule } from "../avatar/module";
import { SdkAvatarGenerator, StubAvatarGenerator } from "../avatar/generate";
import { buildBotEnv } from "../brain/spawn-options";
import { claudeExecutableFor } from "../brain/tool-policy";
import type { BotToolDef } from "../brain/types";
import { CodingAgents, boxGit, umaskGit } from "../coding/coding-agents";
import { codingHooks, createCodingModule } from "../coding/module";
import { gateForCoding, sdkChildFactory } from "../coding/sdk-child";
import { homeWorktreePrep, shellRunAsBot } from "../coding/home-worktree";
import { botPathInfo, sudoFsQuery } from "../walls/home-fs";
import { SudoShellSpawner } from "../background/shell-spawner";
import { execBuf } from "../computer/x-exec";
import type { CommandHandlers } from "../gateway/server";
import { Heartbeat } from "../followups/heartbeat";
import { createEngineeringModule } from "../engineering/module";
import { createFollowupsModule } from "../followups/module";
import { FollowupStore } from "../followups/store";
import { LocalAsks } from "../local/asks";
import { BrowserCards } from "../local/browser-cards";
import { LocalBridge } from "../local/bridge";
import { EgressCounter } from "../local/egress";
import { createLocalModule } from "../local/module";
import { Catalog, loadCurated } from "../marketplace/catalog";
import { CatalogIndex } from "../marketplace/catalog-index";
import { createConnectorToolsModule } from "../marketplace/connectors-module";
import { createMarketplaceModule } from "../marketplace/module";
import { PluginMarketplaces } from "../marketplace/plugin-marketplaces";
import { createPluginMarketplacesModule } from "../marketplace/plugins-module";
import { createMcpModule, createMcpServices } from "../mcp/module";
import { mcpReadOnly } from "../mcp/registry";
import { mergeMcpServers } from "../mcp/reserved";
import { createGoogleModule, createGoogleServices, runGoogleToolForFake, type GoogleDraftFetchResult, type GoogleServices } from "../google/module";
import { Dreamer } from "../memory/dreaming/dreamer";
import { DreamMemoryPort } from "../memory/dreaming/port";
import { SdkDreamLlm } from "../memory/dreaming/sdk-llm";
import { createOnboardingModule } from "../onboarding/module";
import { codingAgentRule } from "../coding/review-rule";
import { ForceAskReviewer, pluginInstallRule } from "../review/force-ask";
import { firstScheduleRule } from "../routines/first-schedule-rule";
import { RoutineStore } from "../routines/routine-store";
import type { TurnObserver } from "../runner/observers";
import type { TurnSlot } from "../runner/turn-slot";
import { importHandlers, loadStarters, TemplateImporter } from "../templates/importer";
import { createTemplatesModule } from "../templates/module";
import { TemplatePackager } from "../templates/packager";
import { SdkTemplateDrafter, StubTemplateDrafter } from "../templates/drafter";
import { UsageLadder } from "../usage/ladder";
import { createUsageModule } from "../usage/module";
import { setUsageSink } from "../usage/metered-query";
import { UsageStore } from "../usage/usage-store";
import { createBudgetModule } from "../usage/budget-module";
import { Budgets } from "../usage/budgets";
import { UsageDashboard } from "../usage/dashboard";
import type { HostWidgets } from "../chat/widgets";
import type { WidgetSpec } from "@synapse/shared";
import { createVoiceModule } from "../voice/module";
import { createBotCallsModule } from "../voice/bot-calls";
import { fakeAuth, fakeCodingChild, fakeConnector, StubDreamLlm } from "./fuzz";
import { removeBotPhase5 } from "./remove-bot";
import { createPhase5SettingsModule } from "./settings-module";
import type { HostModule, ModuleContext } from "./types";
import { listCostUsd } from "../usage/list-price";
import { STR_COST } from "@synapse/shared";

export interface Phase5 {
  modules: HostModule[]; ladder: UsageLadder;
  /** Per-Bot and account budgets. The interface for other tracks: `budgets.check(botId, estimate)` and `budgets.onSpend(fn)`. */
  budgets: Budgets;
  /** The routine fire consumer's question: the usage ladder first, then this routine's Bot's budgets (null = may fire). */
  routinePausedUntil(routineId: string, owner: (routineId: string) => { botId: string; name: string } | null): number | null;
  composeHandlers(base: CommandHandlers): CommandHandlers; observers(): TurnObserver[];
  botTools(botId: string, slot: () => TurnSlot | null, base: BotToolDef[]): BotToolDef[];
  mcpServers(botId: string): Record<string, McpServerConfig>; disallowedTools(): string[];
  /** Final secfix round 2 (ruling B): managed skills plugin dirs the Bot CLI loads (SDK `plugins`). */
  cliPlugins(): string[]; systemAppendExtra(botId: string): string;
  wrapReviewer(r: ReviewerLike): ReviewerLike; wrapGate(g: ApprovalGateLike): ApprovalGateLike;
  /** P5 review I6: whether a connector tool may skip Auto-review as read-only. */
  mcpReadOnly(serverId: string, tool: string): boolean;
  /** feat-mac-access-parity: the connected Mac's home and project dirs (auto-run roots) for the fixed-rules engine. */
  macEnv(): { home: string; projectDirs: readonly string[] } | null;
  /** I12: Phase 5's step in the canonical delete order. */
  removeBot(botId: string): Promise<void>;
  bodyLimits: Partial<Record<CommandName, number>>; start(): Promise<void>; stop(): Promise<void>;
  /** Re-publishes the Usage view (Phase 4's runtime metrics call this when an efficiency counter moves). */
  publishUsage(): void;
  /** Review round 2 (P2): the box key proxy's answer before each model call (the budget, on the Mac key proxy's terms). */
  budgetAllow(botId: string | null): { ok: boolean; message: string | null };
  /** Review round 2 (P2): proxy-metered tokens no CLI reported, priced at list price into usage.db. */
  recordUnreported(botId: string | null, model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number; webSearchRequests: number }, source?: string): void;
  /** ORIG-GOOGLE: the app-level Google account and its per-Bot tools. */
  google: GoogleServices;
  /** The connected Google address (the gate lets a Gmail draft only to the user through without a card). */
  googleEmail(): string | null;
  /** Final secfix item 4: the built-in Google server is mounted for this Bot (the merge never mounts another under "google"). */
  googleBuiltin(botId: string): boolean;
  /** ORIG-GOOGLE draft-send card: the gate's route to the draft's current contents, host-side. */
  googleDraftPreview(draftId: string): Promise<GoogleDraftFetchResult>;
  /** Final secfix item 9: host-side facts for a Google write's card. */
  googleCardFacts(tool: string, input: Record<string, unknown>): ReturnType<GoogleServices["cardFacts"]>;
  /** FUZZ/E2E: the FakeBrain runs mcp__google__ calls through the real per-Bot tools; null = not handled here. */
  runFakeTool(botId: string, toolName: string, input: Record<string, unknown>): Promise<string | null>;
  /** A Mac folder trigger's listing (names), only for a folder inside the Mac's auto-run roots; null otherwise or when the Mac is away. */
  macList(folder: string, botId: string): Promise<string | null>;
}

export function wirePhase5(ctx: ModuleContext, o: {
  fake: boolean; circuit: { enterDegraded(untilMs?: number): void }; kickstart(botId: string): void;
  /** USE-05 tiles from Phase 4's RuntimeMetrics (the source of truth for efficiency_week). */
  efficiency?(): { messagesDropped: number; wakesAvoided: number; burstsCoalesced: number; loopsEnded: number };
  /** I5: the Phase 3 secret scanner's redact, for everything Phase 5 writes into a Bot's memory (dreaming). */
  redact?(botId: string, text: string): string;
  /**
   * I10: MemoryStore.add for a Bot made from a template (its facts land through the memory store).
   * Bug 44(b): it reports whether the fact landed — a caller that cannot tell has to pretend it did.
   */
  remember?(botId: string, fact: string): boolean;
  /** C2: the one ApprovalGate; a coding agent's Bash is decided by it like any Shell. */
  gate?: ApprovalGateLike;
  /** Host-posted approval cards (budget asks for held routine fires). */
  widgets?: Pick<HostWidgets, "hostPost" | "registerHostKind">;
  /** SendMessage call: "look" — ask the app for one snapshot of the shared screen; false = no 1:1 call to look through. */
  onLook?(botId: string): boolean;
  /** Bug 158: SendMessage call: "drop <Bot>" — take that Bot off the call this one is on (the host decides whether it may). */
  onDrop?(botId: string, name: string): { text: string; isError?: boolean };
}): Phase5 {
  const hp = (f: string) => path.join(ctx.cfg.hostPrivate, f);
  const helperEnv = (id: string) => ({ env: buildBotEnv({ cfg: ctx.cfg, botId: id }), cwd: ctx.cfg.workspace, pathToClaudeCodeExecutable: claudeExecutableFor(ctx.flags().runAs, ctx.cfg) });

  // Usage (Tasks 4–5)
  let publishUsage = () => {};
  let flushCodingWakes = () => {}; // ruling (c): a usage/ladder change may release deferred coding done-wakes
  const efficiency = o.efficiency;
  const usage = new UsageStore({
    file: hp("usage.db"), metricsFile: hp("runtime-metrics.db"), bots: ctx.bots, settings: ctx.settings, flags: ctx.flags, now: ctx.now, onChange: () => { publishUsage(); flushCodingWakes(); },
    ...(efficiency ? { efficiency: () => { const e = efficiency(); return { dropped: e.messagesDropped, wakesAvoided: e.wakesAvoided, burstsCoalesced: e.burstsCoalesced, loopsEnded: e.loopsEnded }; } } : {}),
  });
  // Every model call the host makes from here on is recorded here (usage/metered-query.ts).
  setUsageSink(usage);
  const ladder = new UsageLadder({ usage, trays: ctx.trays, now: ctx.now, onReviewerDegraded: (until) => o.circuit.enterDegraded(until), onChange: () => { publishUsage(); flushCodingWakes(); },
    monthBudgetPct: () => budgets.accountMonthPct() });
  const usageModule = createUsageModule(ctx, { usage, ladder });
  publishUsage = () => usageModule.handlers.getUsage && ctx.hub.publish({ channel: "usage", payload: usageModule.handlers.getUsage({}) as never });
  const fullCtx: ModuleContext = { ...ctx, ladder: () => ladder };
  // Cost dashboard + budgets: per Bot / account, daily / monthly, $ or tokens (usage/budgets.ts).
  const tz = () => ctx.settings.timeZone();
  const dashboard = new UsageDashboard({ usage, bots: ctx.bots, tz, now: ctx.now });
  const budgets = new Budgets({
    usage, query: dashboard, settings: ctx.settings, bots: ctx.bots, trays: ctx.trays, now: ctx.now, tz,
    ...(o.widgets ? { post: (botId: string, spec: WidgetSpec, onAnswer: (v: string) => void) => { o.widgets!.hostPost(botId, spec, onAnswer); } } : {}),
  });
  o.widgets?.registerHostKind("budget-ask", (botId, _entryId, value) => budgets.answer(botId, value));

  // Connectors and Marketplace (Tasks 7–12)
  const mcp = createMcpServices(fullCtx, o.fake ? { connect: fakeConnector, authFn: fakeAuth as never } : {});
  // Final secfix item 5: the Google redirect follows the loopback port the Mac actually bound (like OAUTH_REDIRECT).
  const google = createGoogleServices(fullCtx, { fake: o.fake, redirectUri: () => mcp.oauth.redirectUrl });
  google.onChange(() => catalog.refresh());
  const packager = new TemplatePackager({ cfg: ctx.cfg, bots: ctx.bots, drafter: o.fake ? new StubTemplateDrafter() : new SdkTemplateDrafter(helperEnv("template-draft")), now: ctx.now,
    plugins: () => catalog.entries().filter((e) => e.kind === "plugin" && e.state !== "available" && e.source !== "marketplace").map((e) => ({ catalogId: e.id, name: e.name })), author: () => undefined,
    onChange: () => catalog.refresh(), ladder: () => ladder });
  const importer = new TemplateImporter({ cfg: ctx.cfg, bots: ctx.bots, packager, starters: loadStarters(), kickstart: o.kickstart, selfName: () => null, now: ctx.now,
    ...(o.remember ? { remember: o.remember } : {}), ...(o.redact ? { redact: o.redact } : {}),
    // Bug 44(b): a fact that could not be saved anywhere becomes a notification in the new Bot's own chat.
    notify: (t) => { ctx.trays.add({ botId: t.botId, title: t.title, detail: t.detail, dedupeKey: `template-facts:${t.botId}` }); },
    installedCatalogIds: () => new Set(catalog.entries().filter((e) => e.kind === "plugin" && e.state !== "available").map((e) => e.id)) });
  // Final secfix round 2 (ruling B): installs happen only in the bothost-owned managed tree (never in ~/.claude).
  const plugins = new PluginMarketplaces({ dir: hp("marketplaces"), managedDir: ctx.cfg.ccManagedDir ?? hp("cc-managed"), registry: mcp.registry, now: ctx.now });
  const catalog: Catalog = new Catalog({ curated: loadCurated(), mcp, plugins: () => plugins, templates: () => importer, index: new CatalogIndex(hp("catalog-index.db")), onChange: () => ctx.hub.publish({ channel: "catalog", payload: { changedAt: ctx.now() } }), google: () => google.status() });

  // Local execution, coding agent, dreaming, follow-ups (Tasks 16, 24, 26, 28)
  // Bug-log 129: the last registered Mac survives a host restart (its tools stay in every Bot's list).
  const bridge = new LocalBridge({ hub: ctx.hub, now: ctx.now, workspace: ctx.cfg.workspace, file: hp("local-computer.json") });
  // fix-mac-gate-and-approval-expiry (Bug B): Mac cards wait for the answer, survive a restart (persisted), and a late
  // answer wakes the Bot with the decision (the same hidden resume the Auto-review card uses).
  const asks = new LocalAsks({ bots: ctx.bots, now: ctx.now, file: hp("local-asks.json"),
    wake: (botId, text) => { if (ctx.bots.has(botId)) ctx.enqueueHidden(botId, { source: "approval-resume", lane: "user", head: true, silenceAllowed: false, text }); } });
  // mac-browser: the per-session chat card and the week's browser usage (screenshots counted apart).
  const browserCards = new BrowserCards({ bots: ctx.bots, now: ctx.now, file: hp("browser-usage.json"), log: (l) => console.log(l) });
  const cardIds = new Map<string, { botId: string; entryId: string }>();
  const cHooks = codingHooks(fullCtx, cardIds, () => agents);
  flushCodingWakes = () => cHooks.flushDeferred();
  const agents: CodingAgents = new CodingAgents({ workspace: ctx.cfg.workspace, registryFile: hp("coding-agents.json"), now: ctx.now,
    // C2: all coding-agent git runs as box (root helper) with the minimal env; FUZZ keeps the local safe git.
    git: o.fake ? umaskGit : boxGit({ cfg: ctx.cfg, get runAs() { return ctx.flags().runAs; } }),
    // Bug 231: once the box runs per-Bot accounts, the agent's worktree is the Bot's own, in its private ~/code.
    prepare: o.fake ? undefined : homeWorktreePrep({ cfg: ctx.cfg, run: shellRunAsBot({ cfg: ctx.cfg, spawner: new SudoShellSpawner(execBuf) }) }),
    child: o.fake ? fakeCodingChild : sdkChildFactory({ cfg: ctx.cfg, flags: ctx.flags, gate: o.gate ? gateForCoding(o.gate) : null,
      // Bug 231 round 1: Write/Edit are checked by real path, resolved as the Bot inside its home.
      realpaths: ctx.cfg.perBotUid ? botPathInfo(ctx.cfg, sudoFsQuery(ctx.cfg, execBuf)) : undefined }), model: (id) => ctx.bots.summary(id).profile.model ?? "claude-sonnet-5",
    // I13: coding agents follow the usage ladder and count toward the Bot's spend.
    // A real coding child is a metered query and is recorded as it runs (usage/metered-query.ts); only the
    // FUZZ/E2E stand-in, which never calls Claude, reports its pretend usage here.
    ladder: () => ladder, onUsage: o.fake ? (botId, model, u) => usage.recordHelper(botId, "coding", model, u) : undefined,
    onChange: cHooks.onChange, onDone: cHooks.onDone });
  const lastUserTurn = new Map<string, number>();
  const dreamer = new Dreamer({ port: new DreamMemoryPort(ctx.cfg.dataRoot, ctx.now, o.redact), llm: o.fake ? new StubDreamLlm() : new SdkDreamLlm(helperEnv("dreaming")), now: ctx.now,
    mode: () => ctx.settings.extra("memoryMode", "standard"), ladder: () => ladder, botName: (id) => ctx.bots.summary(id).profile.name, botIds: () => ctx.bots.ids(),
    busy: (id) => !ctx.isIdle(id) || ctx.now() - (lastUserTurn.get(id) ?? 0) < 120_000, onHelper: () => {} });
  const followStore = new FollowupStore(ctx.cfg.dataRoot, ctx.now, (id) => ctx.bots.has(id) && ctx.bots.summary(id).settings.advanced?.followups === true);
  const heartbeat = new Heartbeat({ store: followStore, botIds: () => ctx.bots.ids(), optedIn: (id) => ctx.bots.summary(id).settings.advanced?.followups === true, tz: () => ctx.settings.timeZone(), now: ctx.now, isIdle: ctx.isIdle, ladder: () => ladder, enqueueHidden: ctx.enqueueHidden });

  const modules: HostModule[] = [
    usageModule,
    createBudgetModule(fullCtx, { usage, budgets, dashboard }),
    createMcpModule(fullCtx, mcp),
    createGoogleModule(fullCtx, google),
    createMarketplaceModule(fullCtx, catalog),
    createPluginMarketplacesModule(fullCtx, plugins, catalog),
    createConnectorToolsModule(fullCtx, { catalog, mcp, google }),
    createLocalModule(fullCtx, { bridge, asks, egress: new EgressCounter(), browserCards }),
    createPhase5SettingsModule(fullCtx),
    createTemplatesModule(fullCtx, packager, importHandlers(importer)),
    createOnboardingModule(fullCtx, { tokenConfigured: () => credentialsReady() }),
    createVoiceModule(fullCtx),
    createBotCallsModule(fullCtx, { onLook: o.onLook, onDrop: o.onDrop }),
    createAvatarModule(fullCtx, o.fake ? new StubAvatarGenerator() : new SdkAvatarGenerator(helperEnv("avatar"))),
    createCodingModule(fullCtx, agents, cardIds, cHooks),
    { name: "dreaming", handlers: {}, observers: [dreamer, { onSettled: (t) => { if (t.source === "user") lastUserTurn.set(t.botId, t.endedAt); } }], start: () => dreamer.start(), stop: () => dreamer.stop() },
    createFollowupsModule(fullCtx, { store: followStore, heartbeat }),
    createEngineeringModule(fullCtx),
  ];

  return {
    modules, ladder, budgets,
    routinePausedUntil: (routineId, owner) => {
      const ladderSays = ladder.routinePausedUntil(routineId);
      if (ladderSays !== null) return ladderSays;
      const r = owner(routineId);
      return r ? budgets.routinePausedUntil(r.botId, routineId, r.name) : null;
    },
    composeHandlers: (base) => {
      let merged: CommandHandlers = { ...base };
      for (const m of modules) {
        // Integration: a module extends a base command only through wrapHandlers; a same-name handler is a wiring bug.
        for (const k of Object.keys(m.handlers)) if (k in merged) throw new Error(`duplicate gateway command ${k} (Phase 5 module ${m.name})`);
        merged = { ...merged, ...m.handlers };
      }
      for (const m of modules) if (m.wrapHandlers) merged = { ...merged, ...m.wrapHandlers(merged) };
      return merged;
    },
    observers: () => modules.flatMap((m) => m.observers ?? []),
    botTools: (botId, slot, base) => {
      let tools = base;
      for (const m of modules) {
        const extra = m.botTools?.(botId, slot, tools) ?? [];
        tools = [...tools.filter((t) => !extra.some((x) => x.name === t.name)), ...extra];
      }
      return tools.filter((t) => !base.includes(t));
    },
    // Final secfix item 4: under a reserved id (google, bot, computer, probe, claude_ai_*) only the built-in is mounted.
    mcpServers: (botId) => mergeMcpServers(modules.map((m) => m.mcpServers?.(botId) ?? {})),
    disallowedTools: () => modules.flatMap((m) => m.disallowedTools?.() ?? []),
    cliPlugins: () => plugins.cliPlugins(),
    systemAppendExtra: (botId) => modules.map((m) => m.systemAppendExtra?.(botId) ?? "").filter(Boolean).join("\n\n"),
    mcpReadOnly: (() => { const ro = mcpReadOnly(mcp.registry, (sid, t) => mcp.pool.readOnlyHint(sid, t)); return (sid: string, t: string) => ro(sid, t); })(),
    macEnv: () => { const c = bridge.computer(); return c ? { home: c.home ?? c.localRoot, projectDirs: c.autoRunRoots ?? [] } : null; },
    removeBot: (botId) => {
      budgets.forgetBot(botId);
      return removeBotPhase5(botId, { agents, asks, bridge, followups: followStore, dreamer, cardIds });
    },
    wrapReviewer: (r) => {
      const routineFiles = new RoutineStore({ cfg: ctx.cfg });
      return new ForceAskReviewer(r, [pluginInstallRule((id) => plugins.hasCommandServer(id)), codingAgentRule, firstScheduleRule((id) => routineFiles.confirmed(id))]);
    },
    wrapGate: (g) => ({
      ...g,
      preToolUse: async (botId, call, gctx) => {
        const off = mcp.registry.guardTool(call.toolName);
        return off ? { decision: "deny", reason: off } : g.preToolUse(botId, call, gctx);
      },
      canUseTool: (botId, call, signal, gctx) => g.canUseTool(botId, call, signal, gctx),
      expireAll: (botId, cause) => { asks.expireAll(botId); g.expireAll(botId, cause); },
      forgetBot: (botId) => g.forgetBot(botId),
    }),
    bodyLimits: { previewTemplateImport: 24 * 1024 * 1024, setAgentAvatarBytes: 7 * 1024 * 1024 },
    start: async () => {
      for (const m of modules) await m.start?.();
    },
    stop: async () => { for (const m of modules) await m.stop?.(); setUsageSink(null); usage.close(); },
    publishUsage: () => publishUsage(),
    budgetAllow: (botId) => {
      const d = budgets.check(botId && ctx.bots.has(botId) ? botId : "host");
      const ok = d.verdict === "ok" || d.verdict === "warn";
      return { ok, message: ok ? null : d.message ?? STR_COST.macSpendRefused };
    },
    recordUnreported: (botId, model, u, source = "proxy-unreported") => {
      const { cacheWrite1hTokens: _w, webSearchRequests: _s, ...tokens } = u;
      usage.recordHelper(botId && ctx.bots.has(botId) ? botId : "host", source, model, { ...tokens, costUsd: listCostUsd(model, u) });
    },
    google,
    googleEmail: () => google.auth.email(),
    googleBuiltin: (botId) => google.enabledFor(botId) && google.auth.isConnected(),
    googleDraftPreview: (draftId) => google.draftPreview(draftId),
    googleCardFacts: (tool, input) => google.cardFacts(tool, input),
    runFakeTool: (botId, toolName, input) => runGoogleToolForFake(google, botId, toolName, input),
    macList: async (folder, botId) => {
      const c = bridge.computer();
      if (!c || !bridge.available()) return null;
      const home = c.home ?? c.localRoot;
      const abs = path.posix.normalize(folder.startsWith("~/") ? path.posix.join(home, folder.slice(2)) : folder);
      // Never a new prompt on the Mac every minute: only folders the user already made auto-run are listed.
      // Bug 115: a folder it may not list, or a listing that fails, is a failure the routine's row reports (null is
      // only "the Mac is away").
      if (!(c.autoRunRoots ?? []).some((r) => abs === r || abs.startsWith(r.endsWith("/") ? r : `${r}/`))) throw new Error("not an auto-run folder");
      const r = await bridge.request({ botId, approvalId: null, op: "list-directory", path: abs }).done;
      if (r.exitCode !== 0) throw new Error(`list-directory exited ${r.exitCode}`);
      return r.result ?? "";
    },
  };
}
