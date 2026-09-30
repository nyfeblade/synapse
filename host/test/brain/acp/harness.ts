import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SendMessageEntry } from "@synapse/shared";
import { ApprovalGate, type ReviewerLike } from "../../../approvals/approval-gate";
import { BotService } from "../../../bots/bot-service";
import { DEFAULT_FLAGS, type ConformanceFlags } from "../../../brain/conformance/flags";
import { FakeBrain, type FakeStep } from "../../../brain/fake-brain";
import { AcpBrain } from "../../../brain/acp/acp-brain";
import { AcpSessionMap } from "../../../brain/acp/acp-sessions";
import { directAcpSpawn, wrapChild, type AcpSpawn } from "../../../brain/acp/spawn";
import { spawn as nodeSpawn } from "node:child_process";
import { ProviderSessionStore } from "../../../brain/provider/session-store";
import { messageText, type BotToolDef, type SupervisedBrain, type ToolCall, type TurnEvent } from "../../../brain/types";
import { SseHub } from "../../../gateway/sse-hub";
import { PresenceTracker } from "../../../presence/presence";
import type { ReviewOutcome } from "../../../review/types";
import { AckLedger } from "../../../runner/ack-ledger";
import { ResumeLedger } from "../../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../../runner/send-acceptance";
import { TurnRunner } from "../../../runner/turn-runner";
import { HostSettingsStore } from "../../../store/host-settings";
import { initLayout } from "../../../store/layout";
import { Supervisor } from "../../../supervisor/supervisor";
import { TrayService } from "../../../trays/trays";
import { localBotFile } from "../../../walls/bot-file";
import { tmpConfig } from "../../helpers";
import type { HostConfig } from "../../../config";

/**
 * The ACP client's test harness: the REAL TurnRunner, ApprovalGate (with a scripted reviewer), bot-file walls and Shell
 * tool wiring, with either FakeBrain (the reference) or AcpBrain driving the fake ACP agent (fake-acp-agent.mjs) as a
 * real child process over stdio.
 */
export const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-acp-agent.mjs");

export type AgentStep = Record<string, unknown>;
export type AgentPlan = { when: string; steps: AgentStep[] }[];

export const BLOCK: ReviewOutcome = { kind: "block", stage: "model", reason: "Deletes a folder you may need.", proposedRule: "Use the Shell tool to delete scratch folders in /workspace/tmp.", verdict: { decision: "block", risk_tier: 1, floor_category: null, matched_ask_rule_ids: [], matched_allow_rule_ids: [], injection_suspected: false, confidence: 0.8, reason: "Deletes a folder you may need.", proposed_allow_rule: "Use the Shell tool to delete scratch folders in /workspace/tmp." } };
export const ALLOW: ReviewOutcome = { kind: "allow", stage: "model", verdict: null };
export const reviewBy = (req: string): ReviewOutcome => (req.includes("rm -rf") ? BLOCK : ALLOW);

export interface Harness {
  id: string; cfg: HostConfig; runner: TurnRunner; gate: ApprovalGate; bots: BotService; trays: TrayService;
  events: TurnEvent[]; gateLog: string[]; handlerRuns: string[]; sources: string[]; home: string;
  cards(): Record<string, unknown>[];
  replies(): string[];
  agentLog(): Record<string, unknown>[];
  waitCard(): Promise<void>;
  untilIdle(ms?: number): Promise<void>;
  send(text: string): Promise<void>;
  close(): Promise<void>;
}

export async function waitFor(f: () => boolean, ms = 8000): Promise<void> {
  const t = Date.now() + ms;
  while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); }
}

export async function makeHarness(kind: "fake" | "acp", o: {
  plan?: AgentPlan; fakeSteps?: (prompt: string) => FakeStep[]; review?: (req: string) => ReviewOutcome; flags?: Partial<ConformanceFlags>;
  agentEnv?: Record<string, string>; spawn?: AcpSpawn; vendor?: string; consented?: boolean;
}): Promise<Harness> {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker(() => {});
  bots.setRuntimeView((id) => presence.view(id));
  const trays = new TrayService(hub);
  const hp = (f: string) => path.join(cfg.hostPrivate, f);
  const flags = { ...DEFAULT_FLAGS, ...(o.flags ?? {}) };
  const events: TurnEvent[] = [];
  const handlerRuns: string[] = [];
  const sources: string[] = [];
  const shell: BotToolDef = {
    name: "Shell", description: "Run a shell command on your computer.", readOnly: false,
    schema: { command: z.string(), working_directory: z.string().optional(), block_until_ms: z.number().optional() },
    handler: async (a) => { handlerRuns.push(String(a.command)); return { text: `ran: ${String(a.command)}\n[exit code 0 · 1 s · cwd ${String(a.working_directory ?? "")}]` }; },
  };
  const runner = new TurnRunner({
    cfg, bots, trays, presence, settings, flags: () => flags, acks: new AckLedger(hp("acks.json")),
    sendAcceptance: new SendAcceptanceLedger(hp("send.json")), resume: new ResumeLedger(hp("resume.json")),
    timings: { ackRedriveIdleMs: 60_000, retryBaseMs: 1 },
    toolExtensions: { extraTools: () => [shell] },
    observers: [{ onEvent: (_b, e: TurnEvent) => { events.push(e); } }],
  });
  const review = o.review ?? reviewBy;
  const reviewer: ReviewerLike = { review: async (req) => review(JSON.stringify(req)), clearCache: () => {} };
  const real = new ApprovalGate({
    cfg, bots, settings, reviewer, flags: () => flags, slot: (id) => runner.slot(id),
    onDeferredResolution: (botId, text) => runner.enqueueHidden(botId, { source: "approval-resume", lane: "user", head: true, silenceAllowed: false, text }),
  });
  const gateLog: string[] = [];
  const recording = {
    preToolUse: async (b: string, c: ToolCall, ctx?: Parameters<ApprovalGate["preToolUse"]>[2]) => {
      const d = await real.preToolUse(b, c, ctx);
      gateLog.push(`pre ${c.toolName} ${JSON.stringify(c.input)} → ${JSON.stringify(d)}`);
      return d;
    },
    canUseTool: async (b: string, c: ToolCall, s: AbortSignal, ctx?: Parameters<ApprovalGate["canUseTool"]>[3]) => {
      const d = await real.canUseTool(b, c, s, ctx);
      gateLog.push(`can ${c.toolName} → ${JSON.stringify(d)}`);
      return d;
    },
    expireAll: real.expireAll.bind(real), forgetBot: real.forgetBot.bind(real), pendingCount: real.pendingCount.bind(real),
  };
  const dir = fs.mkdtempSync(path.join(path.dirname(cfg.workspace), "acp-"));
  const planFile = path.join(dir, "plan.json");
  const logFile = path.join(dir, "agent.jsonl");
  fs.writeFileSync(planFile, JSON.stringify(o.plan ?? []));
  fs.writeFileSync(logFile, "");
  // The Bot's own home: where the vendor CLI keeps its login (HOME of the child; never read by the host).
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const spawn: AcpSpawn = o.spawn ?? ((a) => {
    const p = directAcpSpawn({ command: process.execPath, args: () => [AGENT, planFile, logFile], home: () => home })(a);
    return p;
  });
  // The fake agent's own switches go in through a wrapper env (never anything of the host's).
  const spawnWithEnv: AcpSpawn = o.agentEnv
    ? () => wrapChild(nodeSpawn(process.execPath, [AGENT, planFile, logFile], { env: { PATH: process.env.PATH ?? "", HOME: home, ...o.agentEnv }, stdio: ["pipe", "pipe", "pipe"] }))
    : spawn;
  const store = new ProviderSessionStore(cfg.hostPrivate);
  const sessions = new AcpSessionMap(cfg.hostPrivate);
  let seq = 0;
  const supervisor = new Supervisor({
    caps: { maxLive: 4, maxRunning: 4, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 }, now: Date.now, onPreempt: () => {}, onCrashBackoff: () => {},
    brainFactory: (id): SupervisedBrain => kind === "fake"
      ? new FakeBrain(id, runner.wiring(id), (input) => o.fakeSteps?.(input.prompt.map(messageText).join("\n")) ?? [], {
        toolRunner: async (name, input) => { handlerRuns.push(`${name} ${JSON.stringify(input)}`); return `(fake) ${name} ok`; },
      })
      : new AcpBrain({
        botId: id, wiring: runner.wiring(id), spawn: spawnWithEnv, store, sessions,
        getSessionId: () => bots.sessionId(id), setSessionId: (s) => bots.setSessionId(id, s),
        model: () => bots.summary(id).profile.model ?? "", cwd: () => cfg.workspace,
        files: localBotFile({ deny: [cfg.hostPrivate] }), consented: () => o.consented ?? true, newId: () => `n${++seq}`, home: () => home,
        timeouts: { startMs: 8_000, cancelGraceMs: 2_000 },
      }),
  });
  runner.attach(supervisor, recording);
  runner.addObserver({ onTurnStart: (_b, slot) => sources.push(slot.source) });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  (bots as unknown as { require(id: string): { profile: { model?: string } } }).require(id).profile.model = kind === "acp" ? `acp:${o.vendor ?? "copilot"}` : "claude-sonnet-5";
  const cards = () => bots.tail(id, 200).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "auto-review-approval")
    .map((e) => (e.message as unknown as { approval: Record<string, unknown> }).approval);
  const replies = () => bots.tail(id, 200).filter((e): e is SendMessageEntry => e.kind === "send-message" && (e.message.type ?? "text") === "text")
    .map((e) => String((e.message as unknown as { content?: string }).content ?? ""));
  const untilIdle = async (ms = 8000) => { await new Promise((r) => setTimeout(r, 20)); await waitFor(() => runner.isIdle(id) && !runner.maintenanceActive(id), ms); };
  let n = 0;
  return {
    id, cfg, runner, gate: real, bots, trays, events, gateLog, handlerRuns, sources, home, cards, replies,
    agentLog: () => fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
    waitCard: async () => waitFor(() => cards().some((c) => c.status === "pending")),
    untilIdle,
    send: async (text) => {
      runner.sendPrompt(id, text, `n${++n}`);
      await new Promise((r) => setTimeout(r, 20));
      await waitFor(() => (runner.isIdle(id) && !runner.maintenanceActive(id)) || cards().some((c) => c.status === "pending"));
    },
    close: async () => { await supervisor.shutdown(); },
  };
}
