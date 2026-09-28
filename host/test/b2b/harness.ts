import path from "node:path";
import { ChainStore } from "../../b2b/chains";
import { LoopTracker } from "../../b2b/loops";
import { installChainTracking, Mailbox } from "../../b2b/mailbox";
import { RequestStore } from "../../b2b/requests";
import { ThreadStore } from "../../b2b/threads";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain, type FakeScript } from "../../brain/fake-brain";
import { messageText, type BrainWiring, type ModelMessage } from "../../brain/types";
import { SseHub } from "../../gateway/sse-hub";
import { RuntimeMetrics } from "../../metrics/runtime-metrics";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { sendToAgentProvider } from "../../tools/send-to-agent";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

export interface ToolCallLog { botId: string; tool: string; args: Record<string, unknown>; text: string; isError: boolean }

export const sta = (input: Record<string, unknown>) => ({ tool: "mcp__bot__SendToAgent", input });
export const say = (content: string) => ({ tool: "mcp__bot__SendMessage", input: { content } });
export const ridsIn = (text: string) => [...text.matchAll(/(?:id|in_reply_to)="(r_[a-z2-7]{8})"/g)].map((m) => m[1] as string);
// Strict TS (Controller ruling, matches mailbox.test.ts's textOf): ModelMessage is a { text } | { image }
// union; messageText() narrows it through the `{ prompt: ModelMessage[] }` shape (TurnInput), without
// changing any assertion — every prompt entry these tests build is always a { text } message.
export const promptText = (i: { prompt: ModelMessage[] }) => i.prompt.map((p) => messageText(p)).join("\n");

/** A real TurnRunner + Supervisor + FakeBrain per Bot, with the whole bot-to-bot stack installed. Scripts are "stub brains". */
export function b2bHarness(names: string[], o: { coalesceMs?: number } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker((id) => bots.has(id) && bots.publish(id));
  bots.setRuntimeView((id) => presence.view(id));
  const trays = new TrayService(hub);
  const metrics = new RuntimeMetrics(path.join(cfg.hostPrivate, "runtime-metrics.db"), { timeZone: () => "UTC" });
  const runner = new TurnRunner({
    cfg, bots, trays, presence, settings, metrics,
    acks: new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json")),
    sendAcceptance: new SendAcceptanceLedger(path.join(cfg.hostPrivate, "send-acceptance.json")),
    resume: new ResumeLedger(path.join(cfg.hostPrivate, "host-restart-resume.json")),
    flags: () => DEFAULT_FLAGS,
    timings: { ackRedriveIdleMs: 60_000, retryBaseMs: 1 },
  });
  const scripts = new Map<string, FakeScript>();
  const brains = new Map<string, FakeBrain>();
  const log: ToolCallLog[] = [];
  const cards: string[] = [];
  const logged = (id: string, w: BrainWiring): BrainWiring => Object.assign(Object.create(w) as BrainWiring, {
    botTools: () => w.botTools().map((t) => ({
      ...t,
      handler: async (a: Record<string, unknown>) => {
        const r = await t.handler(a);
        log.push({ botId: id, tool: t.name, args: a, text: r.text, isError: Boolean(r.isError) });
        return r;
      },
    })),
  });
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => {
      const b = new FakeBrain(id, logged(id, runner.wiring(id)), (input, ctx) => (scripts.get(id) ?? (() => []))(input, ctx));
      brains.set(id, b);
      return b;
    },
  });
  const gate: ApprovalGateLike = {
    preToolUse: async () => ({ decision: "allow" }),
    canUseTool: async () => { cards.push("card"); return { behavior: "allow" }; },
    expireAll: () => {},
    forgetBot: () => {},
  };
  runner.attach(supervisor, gate);
  const chains = new ChainStore(path.join(cfg.hostPrivate, "chains.json"));
  const requests = new RequestStore(path.join(cfg.hostPrivate, "b2b-requests.json"));
  const threads = new ThreadStore(path.join(cfg.hostPrivate, "b2b-threads"));
  const loops = new LoopTracker(path.join(cfg.hostPrivate, "b2b-loops.json"));
  const nameOf = (id: string) => (bots.has(id) ? bots.summary(id).profile.name : id);
  const mailbox = new Mailbox({
    runner, bots, chains, requests, threads, metrics, nameOf, now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), coalesceMs: o.coalesceMs ?? 25,
  });
  runner.addPromptDecorator(mailbox.decorate);
  installChainTracking(runner, chains);
  runner.registerToolProvider(sendToAgentProvider({ bots, chains, requests, threads, classifier: null, loops, mailbox, metrics, groups: null, mirror: null, budgetFactor: () => 1, now: Date.now }));
  const ids: Record<string, string> = {};
  for (const n of names) ids[n] = bots.create({ origin: "user", kickstart: false, name: n });
  const id = (name: string) => ids[name] as string;
  const inputs = (name: string) => brains.get(id(name))?.inputs ?? [];
  const settle = async (quietMs = 150, maxMs = 8000) => {
    const end = Date.now() + maxMs;
    let quietSince = Date.now();
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 10));
      // An armed coalesce timer (or messages still waiting to be folded into one) leaves every bot's
      // scheduler looking idle for the whole window — mailbox.hasPendingWork() closes that gap so a
      // slow-to-fire real timer (under load, or a large coalesceMs) can't make this return too early.
      if (Object.values(ids).some((x) => !runner.isIdle(x)) || mailbox.hasPendingWork()) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) return;
    }
    throw new Error("harness did not settle");
  };
  return {
    cfg, bots, runner, mailbox, metrics, chains, requests, threads, loops, trays, log, cards, ids, id, inputs, settle,
    script: (name: string, s: FakeScript) => scripts.set(id(name), s),
    agentWakes: (name: string) => inputs(name).filter((i) => i.source === "agent"),
    user: (name: string, text: string) => runner.sendPrompt(id(name), text, `n-${Math.random()}`),
    toolLog: (name: string, tool = "SendToAgent") => log.filter((l) => l.botId === id(name) && l.tool === tool),
    approvalCards: () => cards.length + Object.values(ids).flatMap((x) => bots.tail(x, 500)).filter((e) => e.kind === "send-message" && e.message.type !== "text").length,
    stop: () => mailbox.stop(),
  };
}
