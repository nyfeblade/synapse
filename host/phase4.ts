import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { LIMITS_SCHED, STRS } from "@synapse/shared";
import { hostOutDir } from "./util/host-out";
import { removeHostOwnedPath } from "./util/host-owned-file";
import type { BotService } from "./bots/bot-service";
import type { HostWidgets } from "./chat/widgets";
import type { HostConfig } from "./config";
import { GatewayError } from "./gateway/errors";
import type { CommandHandlers } from "./gateway/server";
import type { SseHub } from "./gateway/sse-hub";
import type { OneShotModel } from "./helper-model/one-shot";
import type { RuntimeMetrics } from "./metrics/runtime-metrics";
import type { AckLedger } from "./runner/ack-ledger";
import { CreationLedger } from "./runner/creation-ledger";
import { restartResumeText } from "./runner/prompt-collector";
import type { AttachmentInput, TurnRunner } from "./runner/turn-runner";
import { installWakeOrigin } from "./runner/wake-origin";
import type { HostSettingsStore } from "./store/host-settings";
import type { TrayService } from "./trays/trays";
import { webhookLanWatcher } from "./triggers/webhook-rebind";
import { log } from "./util/log";
// routines (Tasks 11–16)
import { SchedulerEngine } from "./routines/engine";
import { FailureThrottle } from "./routines/failure-throttle";
import { FireConsumer, type FireRequest } from "./routines/fire-consumer";
import { onOfflineTrayDismissed, raiseOfflineTrays } from "./routines/offline-tray";
import { RoutineHealth } from "./routines/routine-health";
import { routineHandlers } from "./routines/routine-handlers";
import { RoutineService } from "./routines/routine-service";
import { RoutineStore } from "./routines/routine-store";
import { RoutineTurns, failureTrayOnFinish } from "./routines/routine-turn";
import { SchedulerDb } from "./routines/scheduler-db";
import { SpendGuard } from "./routines/spend-guard";
import { StatusReminder } from "./routines/status-reminder";
import { UsagePause } from "./routines/usage-pause";
import { routineStateTarget } from "./tools/routine-tools";
// triggers (Tasks 17–21)
import { TriggerAdapters, listenerHandlers } from "./triggers/adapters";
import { EmailTriggers } from "./triggers/email/email-triggers";
import { MailboxStore, emailHandlers } from "./triggers/email/mailboxes";
import { EventQueue } from "./triggers/event-queue";
import { CalendarTriggers } from "./triggers/calendar-triggers";
import type { GoogleGet } from "./triggers/email/gmail-history";
import { GOOGLE_MAIL_ACCOUNT } from "./triggers/email/email-triggers";
import { MacFolderWatch } from "./triggers/mac-folder";
import { StandupService, standupHandlers } from "./standup/standup-service";
import { FileTriggerWatcher } from "./triggers/file-watcher";
import { matchesTrigger } from "./triggers/match";
import { WebhookTunnel } from "./triggers/tunnel";
import { createWebhookServer } from "./triggers/webhook-server";
// bot-to-bot (Tasks 25–30)
import { ChainStore } from "./b2b/chains";
import { GateClassifier } from "./b2b/classifier";
import { LoopTracker } from "./b2b/loops";
import { Mailbox, installChainTracking } from "./b2b/mailbox";
import { RequestStore } from "./b2b/requests";
import { ThreadStore } from "./b2b/threads";
import { b2bHandlers, sendToAgentProvider } from "./tools/send-to-agent";
// groups (Tasks 32–37)
import { FloorManager } from "./groups/floor";
import { BotGroupPoster } from "./groups/group-poster";
import { GroupService, groupHandlers } from "./groups/group-service";
import { CallRegistry, callHandlers } from "./voice/calls";
import { CallGreetings } from "./voice/call-greetings";
import { CallWrapUp } from "./voice/call-wrapup";
import { GroupOrchestrator, routeSendPrompt } from "./groups/orchestrator";
import { SideExchangeMirror } from "./groups/side-exchanges";
// control plane (Tasks 38–39)
import { channelProvider } from "./tools/channel-tools";
import { accountSettingsTarget, controlPlaneProvider, settingsTarget } from "./tools/control-plane-tools";
// teach a task (Tasks 42–45)
import { teachAnalyzeProvider } from "./teach/analyze";
import { CdpClient } from "./teach/cdp";
import { TeachRecorder, teachHandlers } from "./teach/recorder";
import { teachReviewProvider } from "./teach/rehearsal";
import { scrubSecrets } from "./teach/redact";
import { startSidecar } from "./teach/sidecar";
import { installManagedSkillOnBoot } from "./teach/skill";
import { spawnXInput } from "./teach/xinput";

export interface Phase4Deps {
  cfg: HostConfig & { webhookBind: string; webhookPort: number };
  hub: SseHub;
  bots: BotService;
  runner: TurnRunner;
  settings: HostSettingsStore;
  trays: TrayService;
  acks: AckLedger;
  metrics: RuntimeMetrics;
  model: OneShotModel;
  /** The canonical Phase 2 widget service's host poster (controller ruling 1); app.ts wires its commands, extension and hooks. */
  widgets: HostWidgets;
  now(): number;
  /** The app's one delete path (I6 order: runner → Phase 3 → memory → sessions → vault); the control plane's DeleteAgent uses it. */
  deleteBot?(botId: string): Promise<void>;
  /** Phase 3's display manager: the Bot's real screen (CMP-04 seat) for Teach a task. */
  displayOf?(botId: string): string | null;
  /** DISPLAY + XAUTHORITY for X clients on that screen (ffmpeg, xinput). */
  displayEnv?(botId: string): Record<string, string>;
  cdpPortOf?(botId: string): number | null;
  /** Phase 5's usage ladder: when a routine may fire again (null = not paused). */
  routinePausedUntil?(routineId: string): number | null;
  /** ORIG-12: the Bot's vault values, scrubbed from teach recordings. */
  secretValues?(botId: string): string[];
  /** I10: the Bot's scanner (vault values, connector secrets, webhook keys) for trigger/event text before it is stored or rendered. */
  redact?(botId: string, text: string): string;
  /** The built-in Google connector's API for triggers (null while not connected); host-side token, never the Bot's. */
  googleGet?(api: "gmail" | "calendar"): GoogleGet | null;
  /** The Bot has the Google connector turned on (per-Bot scoping of mail and calendar triggers). */
  googleAllowed?(botId: string): boolean;
  /** A Mac folder's listing over the local bridge, or null (Mac away, or the folder isn't an auto-run folder). */
  macList?(folder: string, botId: string): Promise<string | null>;
  /** Bug 134: the user's first name from their memory profile (null = not known; the Mac's account name is the fallback). */
  userName?(): string | null;
  /** Bug 126: a group or call-room post's attachmentIds, resolved in the chat they were uploaded to. */
  resolveAttachments?(chatId: string, ids: string[]): AttachmentInput[];
}

export type Phase4Services = ReturnType<typeof build>["services"];
export interface Phase4 {
  handlers: CommandHandlers;
  services: Phase4Services;
  boot(): void;
  start(): Promise<{ webhookPort: number }>;
  stop(): Promise<void>;
  cleanupBot(botId: string): Promise<void>;
  onOpened(botId: string): void;
  onTrayAction(trayId: string, action: "retry" | "resume-routines" | "dismiss"): boolean;
}

/** I5: the listener binds the configured address (127.0.0.1 by default); the explicit LAN setting opens it to the network. */
export function webhookBindAddress(cfgBind: string, lan: boolean): string {
  return lan ? "0.0.0.0" : cfgBind;
}

const setTimer = (fn: () => void, ms: number): unknown => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
const clearTimer = (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>);

function build(d: Phase4Deps) {
  const { cfg, hub, bots, runner, settings, trays, acks, metrics, model, widgets, now } = d;
  const hp = (f: string) => path.join(cfg.hostPrivate, f);
  const botTz = () => settings.timeZone();
  const nameOf = (id: string) => (bots.has(id) ? bots.summary(id).profile.name : id);

  // ---- wake origin (Task 41). Widgets: Phase 2's service is canonical (controller ruling 1); only its host poster is used here. ----
  installWakeOrigin(runner, bots);

  // ---- bot-to-bot stores (Task 25) ----
  const chains = new ChainStore(hp("chains.json"), now);
  const requests = new RequestStore(hp("b2b-requests.json"), now);
  const threads = new ThreadStore(hp("b2b-threads"), now);
  installChainTracking(runner, chains);

  // ---- groups (Tasks 32–37) ----
  const groups = new GroupService({ bots, cfg, now });
  const floor = new FloorManager({ model });
  // Bug 108: voice calls own their roster (Bots added to any call, cap 6); removing one stops its turn.
  const calls: CallRegistry = new CallRegistry({ bots, now, redact: d.redact, onRemoved: (chatId, ids) => orchestrator.cancelRoom(chatId, ids) });
  const orchestrator = new GroupOrchestrator({ groups, bots, runner, chains, floor, smartTurns: () => settings.get().smartGroupTurns, now, metrics, calls });
  // Bug 134: pick-up greetings (authored once per Bot) and the hang-up wrap-up (one short call per substantial call).
  const greetings = new CallGreetings({ bots, model, file: hp("call-greetings.json"), now, userName: () => d.userName?.() ?? null });
  const wrapUp = new CallWrapUp({ calls, bots, model, now });
  const groupPoster = new BotGroupPoster({ groups, orchestrator, bots, now, metrics });
  const mirror = new SideExchangeMirror({ bots, chains, groups, now });

  // ---- routines (Tasks 11–16) ----
  let engine: SchedulerEngine | null = null;
  let publishRuns: ((botId: string) => void) | null = null;
  // RTN-18: run-history writes publish the automations SSE so an open routine detail shows runs live (Task 48).
  // The prompt's routine section renders only name/id/enabled, so the re-render this triggers is identical: no respawn.
  const store = new RoutineStore({ cfg, now, onChange: (botId, routineId) => engine?.reindex(botId, routineId), onRuns: (botId) => publishRuns?.(botId) });
  const db = new SchedulerDb(hp("scheduler.db"));
  const usagePause = new UsagePause(now);
  const throttle = new FailureThrottle(hp("routine-failures.json"));
  let spendGuard: SpendGuard | null = null;
  let consumer: FireConsumer | null = null;
  const routineTurns = new RoutineTurns({
    runner, store, chains: { start: (k, b) => chains.start(k, b), get: (c) => chains.get(c), addPeerTurn: (c, u) => chains.addPeerTurn(c, u) }, botTz, now, setTimer, clearTimer, nameOf,
    paths: { workspace: cfg.workspace, hostPrivate: cfg.hostPrivate },
    isGroup: (id) => groups.isGroup(id),
    groupSeed: (groupId, routineName, text) => orchestrator.seedRoutine(groupId, routineName, text),
    groupCancel: (groupId) => orchestrator.cancelRoom(groupId), // I6: routine hard limit
    onRunning: (runId) => consumer?.markRunning(runId),
    onUsageLimit: () => { if (!usagePause.paused()) usagePause.pauseUntil(now() + 5 * 3_600_000); return usagePause.hoursLeft(); },
  });
  const failureTray = failureTrayOnFinish({ throttle, trays, store });
  consumer = new FireConsumer({
    db, store, now, setTimer, starter: routineTurns,
    guard: (botId) => spendGuard?.check(botId) ?? "ok",
    usagePaused: (routineId) => {
      if (usagePause.paused()) return true;
      const until = routineId ? d.routinePausedUntil?.(routineId) ?? null : null; // Phase 5 usage ladder (USE-03, USE-04)
      return until !== null && until > now();
    },
    nextSlot: (botId, routineId) => engine?.nextRunAt(botId, routineId) ?? null,
    eventMatches: (r, ev) => (r.def.trigger ? matchesTrigger(r.def.trigger, ev, { savedAt: 0, workspace: cfg.workspace }) : false),
    onFinished: (req: FireRequest, o) => { failureTray(req, o); spendGuard?.noteFire(req.botId); },
    resume: (botId) => runner.enqueueHidden(botId, { source: "restart-resume", lane: "background", silenceAllowed: true, text: restartResumeText() }),
  });
  engine = new SchedulerEngine({
    db, store, botTz, now, mono: () => performance.now(), setTimer, clearTimer,
    onClaim: (fire, extra) => consumer!.submit({ runId: fire.runId, botId: fire.botId, routineId: fire.routineId, trigger: fire.trigger, scheduledFor: fire.scheduledFor, defHash: fire.defHash, ...(extra?.missed ? { caughtUp: extra.missed } : {}) }),
    onOfflineSkips: (botIds) => raiseOfflineTrays({ db, store, trays }, botIds),
  });
  const statusReminder = new StatusReminder({ store, nextRunAt: (b, r) => engine!.nextRunAt(b, r), botTz, now });
  runner.addPromptDecorator(statusReminder.decorate);
  runner.addSystemSection((b) => statusReminder.systemSection(b)); // RTN-21: ≤ 100 routines + guidance in the system prompt
  // OrbStack names a machine's host <machine>.orb.local, and the machine's own hostname is its name (portable
  // install: "synapse-box" for a new install, "box" kept). deploy.sh also sets WEBHOOK_HOST.
  const webhookHost = process.env.WEBHOOK_HOST ?? `${os.hostname().split(".")[0] || "box"}.orb.local`;
  let webhookPort = cfg.webhookPort;
  let adapters: TriggerAdapters | null = null;
  const routines = new RoutineService({
    cfg, store, db, engine, consumer, bots, settings, hub, model, now,
    publicBaseUrl: () => settings.view().publicWebhook?.url ?? `http://${webhookHost}:${webhookPort}`,
    listenerConnected: (botId, platform) => adapters?.isConnected(botId, platform) ?? false,
    chains: { get: (c) => chains.get(c), hop: (c) => chains.hop(c) },
  });
  publishRuns = (botId) => routines.publish(botId);
  runner.registerStateTarget("routine", routineStateTarget({ routines, bots, now }));
  const pauseAll = (botId: string) => store.list(botId).filter((r) => r.def.enabled).map((r) => routines.setEnabled(botId, r.id, false)).length;
  const resumeAll = (botId: string) => { for (const r of store.list(botId)) if (!r.def.enabled) routines.setEnabled(botId, r.id, true); };
  spendGuard = new SpendGuard({
    bots, store, widgets, trays, now, onPauseAll: (b) => { pauseAll(b); }, onResumeAll: resumeAll,
    wake: (botId, text) => runner.enqueueWake(botId, { source: "spend-guard", lane: "background", silenceAllowed: false, prompt: () => [{ text }] }),
  });
  for (const kind of ["spend-guard", "spend-guard-paused"] as const) widgets.registerHostKind(kind, (botId, _entryId, value) => spendGuard!.answer(botId, value));

  // ---- triggers (Tasks 17–21) ----
  const queue = new EventQueue({
    store, db, consumer, metrics, now, setTimer, clearTimer, workspace: cfg.workspace, redact: d.redact,
    onDailyCap: (botId, routineId) => {
      const def = store.get(botId, routineId)?.def;
      if (def) trays.add({ botId, title: `${def.name}: daily limit reached`, detail: STRS.dailyCapReached(def.dailyCap ?? LIMITS_SCHED.triggerDailyCapDefault), dedupeKey: `${botId}:daily-cap:${routineId}` });
    },
  });
  adapters = new TriggerAdapters({ cfg, store, queue, bots, runner, acks, now, setTimer, clearTimer });
  /** ORIG-04 §04.2: per-routine signing secret, stored with the connector credentials (`connector-secrets/<botId>/<provider>.json`, field `signingSecret`). */
  // I4: sealed in the connector-secret store by the listener connect flow (setListenerCredentials … signingSecret).
  const signingSecret = (botId: string, routineId: string) => {
    const t = store.get(botId, routineId)?.def.trigger;
    const leaves = (x: typeof t): NonNullable<typeof t>[] => (!x ? [] : "group" in x ? x.group.listeners.flatMap(leaves) : [x]);
    for (const provider of ["github", "slack", "linear", "sentry"] as const) {
      if (!leaves(t).some((l) => provider in l)) continue;
      const secret = adapters!.signingSecret(botId, provider);
      if (secret) return { provider, secret };
    }
    return null;
  };
  const webhookServer: http.Server = createWebhookServer({
    routines, store, queue, eventsDir: hostOutDir(cfg.workspace, "events"), eventsRoot: cfg.workspace, now, signingSecret, redact: d.redact,
    adapt: (r, h, body) => adapters!.adaptWebhook(r, h, body),
  });
  const tunnel = new WebhookTunnel({ port: cfg.webhookPort, onUrl: (url) => settings.setPublicWebhookUrl(url) });
  const fileWatcher = new FileTriggerWatcher({
    store, queue, workspace: cfg.workspace, now,
    isRunActive: (botId, routineId) => db.fires({ botId, routineId, states: ["running"] }).length > 0,
    lastRunEndedAt: (botId, routineId) => store.runs(botId, routineId)[0]?.finishedAt ?? null,
  });
  const mailboxes = new MailboxStore(cfg);
  const email = new EmailTriggers({ store, queue, mailboxes, model, now, setTimer, clearTimer, googleMail: () => d.googleGet?.("gmail") ?? null, googleAllowed: (b) => d.googleAllowed?.(b) ?? false });
  const calendar = new CalendarTriggers({ store, queue, source: () => d.googleGet?.("calendar") ?? null, allowed: (b) => d.googleAllowed?.(b) ?? false, now, setTimer, clearTimer });
  const macFolders = new MacFolderWatch({ store, queue, list: (f, b) => d.macList?.(f, b) ?? Promise.resolve(null), now, setTimer, clearTimer });
  // Bug 44(a): the arming pass that skips a routine it cannot subscribe now tells the user, on the
  // routine's own row, before the subscribers run — so nothing is left listed as Active that can never fire.
  const health = new RoutineHealth({
    store, now, botTz, hasMailbox: (botId, account) => (account === GOOGLE_MAIL_ACCOUNT ? d.googleAllowed?.(botId) ?? false : mailboxes.secret(botId, account) !== null),
    mailboxReachable: (botId, account) => email.mailboxReachable(botId, account),
    listenerFailing: (botId, platform) => adapters?.listenerFailing(botId, platform) ?? false,
    calendarFailing: (_botId, calendarId) => !calendar.calendarReachable(calendarId),
    macFolderFailing: (folder) => !macFolders.folderReachable(folder),
    onChanged: (botId) => routines.publish(botId),
    // Bug 115: a poller that stopped working is also a tray entry, so the user hears it without opening the routine.
    onProblem: (rec, p) => {
      if (p.key === "calendar" || p.key === "mac-folder") trays.add({ botId: rec.botId, title: `${rec.def.name}: not watching`, detail: p.detail, dedupeKey: `${rec.botId}:routine-problem:${rec.id}` });
    },
  });
  email.onHealthChange = (botIds) => { health.reconcile(); for (const id of botIds) routines.publish(id); };
  adapters.onHealthChange = email.onHealthChange; // bug 51's GitHub / Slack siblings: the row's listenerConnected and reason
  routines.d.mailboxReachable = (botId, account) => email.mailboxReachable(botId, account);
  // Bug 115: the calendar and Mac-folder pollers feed the same row state and health pass as the mail watchers.
  calendar.onHealthChange = email.onHealthChange;
  macFolders.onHealthChange = email.onHealthChange;
  routines.d.calendarReachable = (calendarId) => calendar.calendarReachable(calendarId);
  routines.d.macFolderReachable = (folder) => macFolders.folderReachable(folder);
  // ---- daily standup (schedules-triggers-standup) ----
  const standup = new StandupService({
    cfg, bots, hub, model, now, tz: botTz, setTimer, clearTimer,
    awaiting: (id) => (bots.has(id) ? bots.summary(id).awaiting?.reason ?? null : null),
    runs: (id, since) => store.list(id).flatMap((r) => store.runs(id, r.id).filter((x) => x.startedAt >= since).map((x) => ({ name: r.def.name, status: x.status }))),
  });
  standup.onFailed = (detail) => trays.add({ botId: null, title: STRS.teamStandup, detail, dedupeKey: "standup-failed" });
  const resyncTriggers = () => { health.reconcile(); fileWatcher.sync(); email.sync(); calendar.sync(); macFolders.sync(); adapters?.sync(); };

  // ---- bot-to-bot delivery (Tasks 26–30) ----
  const classifier = new GateClassifier({ model, cacheFile: hp("b2b-gate-cache.json"), metrics, now });
  const loops = new LoopTracker(hp("b2b-loops.json"), now);
  const mailbox = new Mailbox({ runner, bots, chains, requests, threads, metrics, nameOf, now, setTimer, clearTimer, budgetFactor: () => 1 });
  runner.addPromptDecorator(mailbox.decorate);
  runner.registerToolProvider(sendToAgentProvider({ bots, chains, requests, threads, classifier, loops, mailbox, metrics, groups: groupPoster, mirror, budgetFactor: () => 1, now }));

  // ---- control plane (Tasks 38–39) ----
  // I7: everything Phase 4 keeps for a Bot, in the canonical delete (deleteBotFully calls this once).
  const cleanupBot = async (botId: string) => {
    routines.removeBot(botId); // routine folders, scheduler.db rows (fires incl. event_json), automations SSE
    requests.removeBot(botId);
    threads.removeBot(botId);
    groups.onBotRemoved(botId);
    greetings.forget(botId); // bug 134: its authored greetings
    removeHostOwnedPath(cfg.workspace, path.join(hostOutDir(cfg.workspace, "events"), botId)); // secfix round 3: host-owned chain only
    await recorder.forgetBot(botId); // live session, teach-sessions folders and teach-queue entries
    resyncTriggers(); // pollers, sockets, file and email watchers drop the Bot
  };
  runner.registerToolProvider(controlPlaneProvider({
    bots, runner: { deleteBot: d.deleteBot ?? (async (id) => { await cleanupBot(id); await runner.deleteBot(id); }), kickstart: (id) => runner.kickstart(id) },
    settings, now, creations: new CreationLedger(hp("bot-creations.json"), now),
    routines: { removeBot: (b) => routines.removeBot(b), pauseAll, reindexBot: (b) => { engine!.reindex(b, null); routines.publish(b); } },
  }));
  runner.registerStateTarget("settings", settingsTarget(bots, settings));
  runner.registerStateTarget("account_settings", accountSettingsTarget(settings));
  runner.registerToolProvider(channelProvider({ groups, bots, runner, now }));

  // ---- teach a task (Tasks 42–45) ----
  // Phase 3's display manager is the source of truth for the Bot's screen (CMP-04); no display → TEACH_NO_SCREEN.
  const displayOf = d.displayOf ?? (() => null);
  const displayEnv = (botId: string, display: string) => d.displayEnv?.(botId) ?? { DISPLAY: display };
  const recorder = new TeachRecorder({
    cfg, bots, runner, hub, now, displayOf, displayEnv,
    cdpPortOf: (botId) => d.cdpPortOf?.(botId) ?? null,
    sidecar: (s) => {
      if (settings.get().teachSidecar === false) return null; // Advanced: video only
      const started = (async () => startSidecar({
        sessionDir: s.sessionDir, startedAtMs: s.startedAtMs, now, setTimer, clearTimer,
        redact: (t: string) => d.redact?.(s.botId, t) ?? t, // I8: URLs, titles and snapshots through the Bot's scanner
        xinput: await spawnXInput(s.display, displayEnv(s.botId, s.display)),
        cdp: s.cdpPort ? await CdpClient.connect(s.cdpPort).catch(() => null) : null,
      }))();
      // Bug 47: the handle is handed back before `started` settles, so it has to be able to report
      // its own outcome — otherwise session.json records a sidecar that never ran (warn and all).
      const ok = started.then(() => true, (e) => { log.warn("teach sidecar failed; recording video only", { error: String(e) }); return false; });
      return { stop: async () => { const h = await started.catch(() => null); await h?.stop(); }, started: () => ok };
    },
    afterFinalize: async (s) => { scrubSecrets(s.sessionDir, d.secretValues?.(s.botId) ?? []); }, // ORIG-12: the Bot's vault values
  });
  recorder.restoreInterrupted();
  runner.registerToolProvider(teachAnalyzeProvider({ cfg }));
  runner.registerToolProvider(teachReviewProvider({ cfg, recorder }));

  const handlers: CommandHandlers = {
    ...routineHandlers(routines),
    ...standupHandlers(standup),
    ...emailHandlers(mailboxes, (botId) => { email.sync(); adapters!.secrets.changed(botId); }), // I10: the new IMAP password joins the scanner
    ...listenerHandlers(adapters),
    ...groupHandlers(groups),
    ...callHandlers(calls),
    getCallGreetings: (a) => greetings.view(String(a?.id ?? ""), typeof a?.userName === "string" ? a.userName : undefined),
    wrapUpCall: (a) => { if (typeof a?.callId !== "string" || !a.callId) throw new GatewayError("BAD_ARGS", "callId is required."); return wrapUp.wrapUp(a.callId, typeof a.durationMs === "number" ? a.durationMs : undefined); },
    ...b2bHandlers({ runner, bots }),
    ...teachHandlers(recorder),
  };

  const services = { widgets, chains, health, requests, threads, classifier, loops, mailbox, groups, orchestrator, calls, greetings, wrapUp, floor, store, db, engine, consumer, routineTurns, statusReminder, spendGuard, usagePause, routines, queue, fileWatcher, email, calendar, macFolders, standup, adapters, recorder, tunnel, get webhookPort() { return webhookPort; } };
  return {
    services, handlers, cleanupBot, resyncTriggers,
    listenWebhooks: () => new Promise<number>((resolve, reject) => {
      webhookServer.once("error", reject);
      webhookServer.listen(webhookPort || cfg.webhookPort, webhookBindAddress(cfg.webhookBind, settings.get().webhookLan), () => { webhookPort = (webhookServer.address() as AddressInfo).port; resolve(webhookPort); });
    }),
    closeWebhooks: () => new Promise<void>((r) => { webhookServer.closeAllConnections(); webhookServer.close(() => r()); }),
  };
}

export function installPhase4(d: Phase4Deps): Phase4 {
  const b = build(d);
  const s = b.services;
  let spendTicker: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let unwatchStore: (() => void) | null = null;
  let started: Promise<{ webhookPort: number }> | null = null;
  let stopped = false;
  const syncTunnel = () => (d.settings.get().publicWebhook.enabled ? s.tunnel.start() : s.tunnel.stop());
  return {
    handlers: { ...b.handlers, sendPrompt: routeSendPrompt(s.groups, s.orchestrator, d.runner, s.calls, d.resolveAttachments) },
    services: s,
    /** EVT-17 "reconcile routines": recover owed fires, mark interrupted runs, count offline skips, then run. */
    boot: () => {
      installManagedSkillOnBoot(d.cfg);
      const { recovered, interrupted } = s.engine.boot();
      s.consumer.recover(recovered);
      s.consumer.markInterrupted(interrupted);
    },
    /** Idempotent: `listen()` and callers that only need Phase 4 (tests) may both call it. */
    start: () => (started ??= (async () => {
      const webhookPort = await b.listenWebhooks();
      s.engine.start();
      s.standup.start();
      b.resyncTriggers();
      unwatchStore = s.store.watch();
      syncTunnel();
      const lanWatch = webhookLanWatcher({
        lan: () => d.settings.get().webhookLan,
        listen: () => b.listenWebhooks(),
        close: () => b.closeWebhooks(),
        revert: (v) => { d.settings.update({ webhookLan: v }); },
        setError: (m) => d.settings.setWebhookLanError(m), // bug 52: said on the switch's own row
        notify: (err) => {
          log.warn("webhook listener re-bind failed", { error: String(err) });
          d.trays.add({ botId: null, title: "Couldn't open the webhook on your network", detail: String(err), dedupeKey: "webhook-lan" });
        },
      });
      unsubscribe = d.hub.subscribe((e) => {
        if (e.channel === "host-settings") syncTunnel();
        if (e.channel === "host-settings") void lanWatch.changed();
        if (e.channel === "automations") { b.resyncTriggers(); d.bots.invalidatePromptSnapshots(e.payload.botId); } // RTN-21 list is part of the frozen prompt
      });
      spendTicker = setInterval(() => s.spendGuard.tick(), 3_600_000);
      spendTicker.unref();
      return { webhookPort };
    })()),
    /** EVT-19: stop new fires and event intake before the runner quiesces. */
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await started?.catch(() => undefined);
      s.engine.stop();
      if (spendTicker) clearInterval(spendTicker);
      unsubscribe?.();
      unwatchStore?.();
      s.tunnel.stop();
      s.mailbox.stop();
      s.email.stop();
      s.calendar.stop();
      s.standup.stop();
      s.macFolders.stop();
      await s.adapters.stop(); // ends a running `gh auth token` before the data dir can go (bug-log 128)
      await s.fileWatcher.close();
      if (started) await b.closeWebhooks();
      s.db.close();
    },
    cleanupBot: b.cleanupBot,
    onOpened: (botId) => s.spendGuard.onViewed(botId),
    onTrayAction: (trayId, action) => {
      const tray = d.trays.get(trayId);
      if (!tray) return false;
      if (action === "resume-routines" && tray.botId) { s.spendGuard.resumeAll(tray.botId); d.trays.dismiss(trayId); return true; }
      if (action === "dismiss") { onOfflineTrayDismissed(s.db, tray); return false; } // counts reset; the caller still dismisses
      return false;
    },
  };
}
