import type net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { APP_NAME, COMPUTER_NAME, LIMITSC, type SubagentType } from "@synapse/shared";
import type { ApprovalGate } from "../approvals/approval-gate";
import { PendingWakes } from "../background/pending-wakes";
import { Revivals } from "../background/revivals";
import { LocalShellSpawner, SudoShellSpawner } from "../background/shell-spawner";
import { ShellService } from "../background/shells";
import { createShellTools } from "../background/shell-tools";
import { FakeGhRunner, ShellGhRunner } from "../github/gh-runner";
import { botRealpaths, sudoFsQuery } from "../walls/home-fs";
import { GitHubSignIn, createGitHubCommands } from "../github/signin";
import { CHILD_BUILTINS, createChildWiring } from "../background/child-wiring";
import { SubagentService, type ChildHooks, type ChildSpec } from "../background/subagents";
import { createSubagentTools } from "../background/subagent-tools";
import type { BotService } from "../bots/bot-service";
import { ClaudeBrain } from "../brain/claude-brain";
import type { ConformanceFlags } from "../brain/conformance/flags";
import { FakeBrain } from "../brain/fake-brain";
import { buildBotEnv } from "../brain/spawn-options";
import { cliConfigDirFor } from "../walls/bot-uid";
import type { BotToolDef, BrainWiring, SupervisedBrain } from "../brain/types";
import type { HostConfig } from "../config";
import type { CommandHandlers, GatewayOptions } from "../gateway/server";
import type { SseHub } from "../gateway/sse-hub";
import { fillTemplate, loadPrompt } from "../prompts";
import type { AckLedger } from "../runner/ack-ledger";
import type { TurnRunner } from "../runner/turn-runner";
import { ScannerRegistry } from "../secrets/scanner";
import { withSecrets } from "../secrets/secret-wiring";
import { SecretRequestService, fillIntoPage } from "../secrets/secret-requests";
import { SecretVault } from "../secrets/vault";
import type { HostSettingsStore } from "../store/host-settings";
import type { BotToolDeps } from "../tools/bot-tools";
import type { Supervisor } from "../supervisor/supervisor";
import { BoxHelpService, createBoxHelpTool } from "./box-help";
import { BoxStatus, WallpaperScheduler, writeReferenceDocs } from "./box-status";
import { createBrowserTools } from "./browser/browser-tools";
import { PlaywrightConnector, type BrowserConnector } from "./browser/connector";
import { CookieSync } from "./browser/cookie-sync";
import { BrowserHub } from "./browser/hub";
import { captureScreen } from "./capture";
import { childMcpServers, computerToolsFor } from "./computer-mcp";
import { createComputerTool } from "./computer-tool";
import { SudoDisplayControl } from "./display-control";
import { DisplayManager } from "./displays";
import { DiskGuard, DiskSaver, withDiskReminder } from "./disk-guard";
import { FakeDisplayControl, FakeSnapshotControl, fakeVncSocket, fakeXExec } from "./fuzz-fakes";
import { createPrepareBoxRestart, createSetBoxMaintenance } from "./restart";
import { createScreenshotTool } from "./screenshot-tool";
import { SnapshotService, SudoSnapshotControl } from "./snapshots";
import { createVncUpgrade, readVncTransport } from "./vnc-bridge";
import { openDesktopApp, type DesktopApp } from "./desktop-apps";
import { execBuf } from "./x-exec";
import { BoxIO, type HelperOut } from "./perception/io";
import { LIVE_PERCEPTION_ENABLED, LIVE_SHELVED_MESSAGE, perceptionMode, registerLabeler } from "./perception/mode";
import { PerceptionService } from "./perception/service";
import { createPerceptionTools } from "./perception/tools";
import { sleep as realSleep } from "../util/sleep";
import { GatewayError } from "../gateway/errors";

export interface Phase3Context {
  cfg: HostConfig; hub: SseHub; bots: BotService; acks: AckLedger; settings: HostSettingsStore;
  supervisor: Supervisor; gate: ApprovalGate; runner: Pick<TurnRunner, "enqueueHidden" | "slot" | "isIdle" | "holdNewTurns" | "isRunning" | "lastUserMessageAt">;
  fuzz: boolean; brainKind: "claude" | "fake"; flags(): ConformanceFlags; now?(): number;
  /** I3: Teach a task rehearsal registry shared with the approval gate. */
  rehearsals?: { start(botId: string, childTaskId: string): void; end(childTaskId: string): void };
}

const nullConnector: BrowserConnector = { connect: async () => { throw new Error("The browser isn't available in this mode."); } };

export async function createPhase3Services(ctx: Phase3Context) {
  const { cfg, hub, bots } = ctx;
  const now = ctx.now ?? Date.now;
  const exec = ctx.fuzz ? fakeXExec : execBuf;
  const hp = (f: string) => path.join(cfg.hostPrivate, f);
  const enqueue = ctx.runner.enqueueHidden.bind(ctx.runner);

  const vault = await SecretVault.open({ hostPrivate: cfg.hostPrivate, now });
  const scanners = new ScannerRegistry(vault);
  const pending = new PendingWakes(hp("host-pending-wakes.json"), now);
  const redactBlock = (botId: string, text: string) => scanners.redact(botId, text);
  const revivals = new Revivals({ enqueueHidden: (botId, spec) => enqueue(botId, { ...spec, text: redactBlock(botId, spec.text) }), pending });

  let wallpaper: WallpaperScheduler;
  let cookies: CookieSync;
  let boxHelp: BoxHelpService;
  // Controller ruling 1: who currently has a VNC socket open (a warm preview thumbnail or the full computer
  // view). Bumped by the /vnc upgrade route below; read here so a Bot with an open view is never reclaimed.
  const openViews = new Map<string, number>();
  const bumpOpenViews = (botId: string, d: 1 | -1) => {
    const n = (openViews.get(botId) ?? 0) + d;
    if (n <= 0) openViews.delete(botId); else openViews.set(botId, n);
  };
  const displays = new DisplayManager({
    cfg, hub, exec, control: ctx.fuzz ? new FakeDisplayControl() : new SudoDisplayControl(execBuf),
    maxScreens: Number(process.env.MAX_SCREENS ?? LIMITSC.maxScreens), now,
    onStarted: (_b, index) => { if (!ctx.fuzz) { void wallpaper.paint(index).catch(() => {}); void cookies.seed(index).catch(() => {}); } },
    // Controller ruling 1: idle = no running turn, no takeover, no open preview/computer view, no pending box-help.
    idle: (botId) => ctx.runner.isIdle(botId) && !boxHelp.pending(botId) && !openViews.has(botId),
  });
  const connector = ctx.fuzz ? nullConnector : new PlaywrightConnector();
  const browser = new BrowserHub({ displays, connector });
  cookies = new CookieSync({ connector, displays });
  wallpaper = new WallpaperScheduler({ exec, displays, timeZone: () => ctx.settings.view().userTimeZone });
  const viewId = (botId: string) => bots.sessionId(botId) ?? botId;
  // C1: every env (CLI, child, Shell, compaction) is built by buildBotEnv from these inputs.
  // Bug #66: asBot = the Bot whose own OS account runs the process (once the box is migrated).
  const envInputs = (botId: string) => ({ display: displays.env(botId), secrets: vault.env(botId), asBot: botId });

  const shells = new ShellService({
    onWork: (id) => github.botStartedWorking(id),
    cfg, pending, revivals, hub, envInputs, enqueueHidden: enqueue, now,
    // Bug 231 round 1: a cwd inside the Bot's 0700 home is resolved as the Bot (bot-fs-query), never used unchecked.
    realAsBot: ctx.fuzz || !cfg.perBotUid ? undefined : botRealpaths(cfg, sudoFsQuery(cfg, execBuf), () => null),
    spawner: ctx.fuzz ? new LocalShellSpawner({ terminalsDir: path.join(cfg.workspace, ".bot", "terminals"), runDir: hp("run") }) : new SudoShellSpawner(execBuf),
  });

  // Bug-log 195: "Sign in to GitHub" per Bot — gh's device flow as the Bot's own account (through bot-shell).
  const ghRunner = ctx.fuzz ? null : new ShellGhRunner({ cfg, spawner: new SudoShellSpawner(execBuf) });
  void ghRunner?.sweep().catch(() => {}); // units and files a previous host left mid-sign-in
  const github = new GitHubSignIn({
    runner: ctx.fuzz ? new FakeGhRunner() : ghRunner!,
    publish: (e) => hub.publish(e),
    busy: (id) => !ctx.runner.isIdle(id) || shells.hasRunning(id) || subagents.hasLive(id),
  });

  const status: BoxStatus = new BoxStatus({ hub, exec, snapshots: () => ({ latestAt: snapshots.status().latest?.createdAt ?? null, running: snapshots.status().running }), busyBotIds: () => busyBotIds(), now });
  const snapshots: SnapshotService = new SnapshotService({
    dir: hp("snapshots"), now, control: ctx.fuzz ? new FakeSnapshotControl(hp("snapshots")) : new SudoSnapshotControl(execBuf),
    beforeRestore: async () => status.setPhase("resetting", "wiping"),
    afterRestore: () => { if (!ctx.fuzz) setTimeout(() => process.kill(process.pid, "SIGTERM"), 200); }, // systemd restarts us on the restored data
  });
  const busyBotIds = () => bots.ids().filter((id) => !ctx.runner.isIdle(id));

  // FUZZ/E2E only: FUZZ_DISK_FREE_FILE holds a free-space percentage, so journeys can drive the disk banner (Task 30).
  const fuzzDisk = ctx.fuzz && process.env.FUZZ_DISK_FREE_FILE ? process.env.FUZZ_DISK_FREE_FILE : null;
  // cfg.diskFreePct is the suite's seam: a host app built from a test config reports a fixed free
  // percentage, so nothing the suite asserts depends on how full the machine running it is. The
  // file form wins where both are set, because only the e2e journeys change it mid-run.
  const statfs = fuzzDisk
    ? () => {
        const pct = Number((() => { try { return fs.readFileSync(fuzzDisk, "utf8"); } catch { return "50"; } })()) || 50;
        return { free: pct * 1e9, total: 100e9 };
      }
    : cfg.diskFreePct !== undefined
      ? () => ({ free: cfg.diskFreePct! * 1e9, total: 100e9 })
      : undefined;
  const disk = new DiskGuard({ path: cfg.workspace, hub, ledgerFile: hp("disk-pressure-reminders.json"), onEpisode: () => diskSaver.ensure(), now, ...(statfs ? { statfs } : {}) });
  const diskSaver = new DiskSaver({ bots, enqueueHidden: enqueue, guard: disk });

  boxHelp = new BoxHelpService({
    bots, acks: ctx.acks, hub, slot: (b) => ctx.runner.slot(b), enqueueHidden: enqueue, now,
    capture: async (botId) => (await captureScreen({ displays, botId, workspace: cfg.workspace, now })).dataUrl,
  });
  const secretRequests = new SecretRequestService({
    bots, acks: ctx.acks, vault, slot: (b) => ctx.runner.slot(b), enqueueHidden: enqueue, connectorDir: hp("connector-secrets"), now,
    fill: (botId, target, url, value) => fillIntoPage({ hub: browser, botId, viewId: viewId(botId), target, url, value }),
  });

  const computerTool = (botId: string) => createComputerTool({ botId, displays, hub, workspace: cfg.workspace, enforce: () => ctx.settings.view().autoReviewEnabled, now });
  const browserTools = (botId: string) => createBrowserTools({ botId, viewId: () => viewId(botId), hub: browser, bus: hub, now });

  // "Computer perception: Live (beta)" (decisions.md 2026-09-21): one live perception service per Bot's display,
  // rebuilt when the display restarts (a new generation means new windows, so old ids must not survive).
  const computerPerception = (botId: string) => perceptionMode(bots.summary(botId).settings, ctx.settings.view().computerPerception);
  const perceptions = new Map<string, { gen: number; svc: PerceptionService }>();
  const atspi = (index: number) => async (): Promise<HelperOut | null> => {
    if (ctx.fuzz) return { windows: [] };
    const r = await execBuf("sudo", ["-n", "/usr/local/libexec/bot-atspi", String(index)], { timeoutMs: 10_000 });
    if (r.code !== 0) return null;
    try { return JSON.parse(r.stdout.toString("utf8")) as HelperOut; } catch { return null; }
  };
  const perceptionFor = async (botId: string): Promise<PerceptionService> => {
    const info = await displays.ensure(botId);
    displays.touch(botId);
    const have = perceptions.get(botId);
    if (have && have.gen === info.generation) return have.svc;
    have?.svc.stop();
    const io = new BoxIO({ exec, xenv: displays.xenv(info.index), index: info.index, browser: () => browser.browser(botId), sleep: (ms) => realSleep(ms), now, atspi: atspi(info.index) });
    const svc = new PerceptionService({ io });
    perceptions.set(botId, { gen: info.generation, svc });
    registerLabeler(botId, (id) => svc.describe(id));
    return svc;
  };
  const liveTools = (botId: string) => createPerceptionTools({ service: () => perceptionFor(botId), botId, hub, now, index: () => displays.info(botId)?.index ?? 0 });

  const subagents: SubagentService = new SubagentService({
    supervisor: ctx.supervisor, revivals, pending, hub, bots, now, rehearsals: ctx.rehearsals, parentSlot: (b) => ctx.runner.slot(b), perception: computerPerception,
    onWork: (b) => github.botStartedWorking(b), // bug 195 S2
    redact: redactBlock, // bug 198 fix round 1: a mirrored child step's body, redacted with the parent's secrets
    activity: { append: (b, e) => { if (bots.has(b)) bots.appendEntry(b, e); }, update: (b, e) => { if (bots.has(b)) bots.updateEntry(b, e); } },
    transcriptPath: (s, parent) => path.join(cliConfigDirFor(cfg, parent), "projects", "-workspace", `${s}.jsonl`),
    onChildSession: (parent, s) => {
      if (!bots.has(parent)) return;
      const file = path.join(cliConfigDirFor(cfg, parent), "projects", "-workspace", `${s}.jsonl`); // bug #66: the parent's own config dir
      const list = bots.brainKv<{ file: string }[]>(parent, "childSessionFiles", []);
      if (!list.some((x) => x.file === file)) bots.setBrainKv(parent, "childSessionFiles", [...list, { file }]);
    },
    makeBrain: (spec: ChildSpec, hooks: ChildHooks): SupervisedBrain => {
      const botTools = createShellTools({ botId: spec.parentBotId, shells, childId: spec.id });
      const computer = computerToolsFor(spec.type as SubagentType, { computer: computerTool(spec.parentBotId), browser: browserTools(spec.parentBotId), live: () => liveTools(spec.parentBotId) }, spec.perception);
      const inner = createChildWiring({ parentBotId: spec.parentBotId, childId: spec.id, slot: hooks.slot, gate: ctx.gate, tools: [...botTools, ...computer], flags: ctx.flags });
      const wiring: BrainWiring = withSecrets({ ...inner, postToolUse: async (call, out) => { const r = await inner.postToolUse(call, out); hooks.onAction(inner.actions.at(-1) ?? call.toolName); return r; } }, { botId: spec.parentBotId, registry: scanners });
      if (ctx.brainKind === "fake") return new FakeBrain(`child:${spec.id}`, wiring, () => [{ text: `Report: finished “${spec.title}”.` }]);
      return new ClaudeBrain({
        botId: `child:${spec.id}`, cfg, wiring, getSessionId: hooks.getSessionId, setSessionId: hooks.setSessionId,
        spawnConfig: () => ({ model: spec.model, systemAppend: spec.systemAppend, env: buildBotEnv({ cfg, botId: spec.parentBotId, ...envInputs(spec.parentBotId) }), spawnKey: `child:${spec.id}` }),
        profile: { tools: CHILD_BUILTINS[spec.type as SubagentType], mcpServers: () => childMcpServers({ bot: botTools, computer }) },
      });
    },
  });

  const secretsLine = (botId: string) => {
    const d = vault.descriptions(botId);
    return d.length ? `Secrets available as environment variables: ${d.map((x) => `$${x.name} — "${x.description}"`).join("; ")}.` : "";
  };
  const transport = ctx.fuzz ? { kind: "unix" as const, dir: hp("no-vnc") } : readVncTransport();

  const handlers: CommandHandlers = {
    getForeverBoxStatus: () => status.view(),
    getDisplays: () => ({ displays: displays.list(), waiting: displays.waitingIds() }),
    ensureDisplay: async ({ id }) => ({ display: await displays.ensure(id) }),
    handBackForeverBox: ({ id, requestId, outcome }) => ({ request: boxHelp.handBack(id, requestId, outcome) }),
    setTakeoverActive: ({ id, requestId, active }) => ({ request: boxHelp.setInControl(id, requestId, active) }),
    openComputerApp: async ({ id, app }) => {
      await openDesktopApp({ botId: id, app: app as DesktopApp, ensure: (botId) => displays.ensure(botId), launch: ctx.fuzz ? async () => {} : (i, a) => new SudoDisplayControl(execBuf).openApp(i, a) });
      return {};
    },
    getAsyncTasks: ({ id }) => ({ tasks: [...shells.list(id), ...subagents.list(id)] }),
    // "Computer perception" per Bot; null clears it back to the account's setting. Takes effect on the next computerUse task.
    setAgentComputerPerception: ({ id, mode }) => {
      if (mode === "live" && !LIVE_PERCEPTION_ENABLED) throw new GatewayError("BAD_PERCEPTION", LIVE_SHELVED_MESSAGE);
      if (mode !== null && mode !== "screenshots" && mode !== "live") throw new GatewayError("BAD_PERCEPTION", "Computer perception must be Screenshots.");
      return { agent: bots.updateSettings(id, { computerPerception: mode ?? undefined }) };
    },
    setBotSecrets: async ({ botId, upserts, removes }) => ({ status: await vault.apply(botId, upserts, removes) }),
    getBotSecretsStatus: async ({ botId }) => ({ status: await vault.status(botId), boxPublicKey: vault.publicKey }),
    submitSecret: async ({ id, entryId, sealed, valueHash }) => ({ status: await secretRequests.submitSecret(id, entryId, sealed, valueHash) }),
    submitForm: async ({ id, entryId, answers, sealed }) => ({ status: await secretRequests.submitForm(id, entryId, answers, sealed) }),
    getDiskPressure: () => disk.view(),
    openDiskSaver: () => ({ id: diskSaver.open() }),
    snapshotBoxStoreNow: async ({ reason }) => { const snapshot = await snapshots.create(reason ?? "manual"); status.refresh(); return { snapshot }; },
    getBoxStoreStatus: () => snapshots.status(),
    listSnapshots: () => ({ snapshots: snapshots.list() }),
    restoreSnapshot: async ({ id, parts }) => { await snapshots.restore(id, parts); return {}; },
    deleteSnapshot: async ({ id }) => { await snapshots.remove(id); return {}; },
    prepareBoxRestart: createPrepareBoxRestart({ busyBotIds, status }),
    setBoxMaintenance: createSetBoxMaintenance({ runner: ctx.runner, runningBotIds: () => bots.ids().filter((id) => ctx.runner.isRunning(id)), status, lastUserMessageAt: () => ctx.runner.lastUserMessageAt() }),
    ...createGitHubCommands({ signIn: github, botExists: (id) => bots.has(id) }),
  };

  return {
    displays, browser, cookies, shells, subagents, github, computerPerception, boxHelp, vault, scanners, secretRequests, disk, diskSaver, status, wallpaper, snapshots, pending, revivals, handlers,
    botTools: (botId: string): BotToolDef[] => [
      createScreenshotTool({ botId, displays, workspace: cfg.workspace, now }),
      createBoxHelpTool({ botId, service: boxHelp }),
      ...createShellTools({ botId, shells }),
      ...createSubagentTools({ botId, subagents }),
    ],
    sendHandlers: (botId: string): BotToolDeps["sendHandlers"] => ({
      "secret-request": (a, c) => secretRequests.sendSecretRequest(botId, a, c),
      card: (a, c) => secretRequests.sendForm(botId, a, c),
    }),
    wrapWiring: (botId: string, w: BrainWiring) => withDiskReminder(withSecrets(w, { botId, registry: scanners }), { botId, guard: disk }),
    envInputs,
    /** The background Shell's env (no OAuth token). */
    spawnEnv: (botId: string) => shells.env(botId),
    spawnKeyPart: (botId: string) => `${vault.version(botId)}:${displays.indexFor(botId) ?? "-"}`,
    promptSection: (botId: string) => fillTemplate(loadPrompt("sections/computer.md"), { COMPUTER_NAME, APP_NAME, DISPLAY: displays.env(botId).DISPLAY ?? "(none free)", SECRETS: secretsLine(botId) }).trimEnd(),
    raw: (req: Parameters<NonNullable<GatewayOptions["raw"]>>[0], res: Parameters<NonNullable<GatewayOptions["raw"]>>[1], url: URL) => snapshots.raw(req, res, url),
    // Task 30 fuzz: FUZZ mode has no x11vnc; a fake RFB server answers so previews connect like on the box.
    upgrade: createVncUpgrade({
      displays, transport, ...(ctx.fuzz ? { connect: () => fakeVncSocket() as unknown as net.Socket } : {}),
      onOpen: (botId) => bumpOpenViews(botId, 1), onClose: (botId) => bumpOpenViews(botId, -1),
    }),
    busyBotIds,
    boot: async () => {
      pending.prune();
      await displays.reconcile();
      shells.rewatchAtBoot();
      subagents.recoverAtBoot();
      if (!ctx.fuzz) {
        writeReferenceDocs(path.join(cfg.boxHome, "reference"));
        cookies.start();
        void status.runDoctor().catch(() => {});
      }
      disk.poll();
    },
    tick: (() => {
      let n = 0;
      return async () => {
        n += 1;
        await shells.tick();
        await subagents.tick();
        status.refresh(); // Task 30: new backups and busy-Bot changes reach Settings → Updates
        if (n % 12 === 0) { await displays.tick(); await wallpaper.tick(); disk.poll(); } // every 60 s at a 5 s tick
      };
    })(),
    /** I6 step 2: stop and retire the Bot's children, shells and screen (no new one can start after this). */
    deleteBot: async (botId: string) => {
      await subagents.forgetBot(botId);
      await shells.forgetBot(botId);
      github.cancel(botId);
      browser.forget(botId, [...new Set([viewId(botId), botId])]);
      perceptions.get(botId)?.svc.stop();
      perceptions.delete(botId);
      registerLabeler(botId, null);
      await displays.retire(botId);
    },
    /** I6 last step (after memory is drained and the session files are gone): the vault and connector secrets. */
    forgetSecrets: (botId: string) => {
      vault.removeBot(botId);
      fs.rmSync(path.join(hp("connector-secrets"), botId), { recursive: true, force: true });
    },
  };
}
export type Phase3Services = Awaited<ReturnType<typeof createPhase3Services>>;
