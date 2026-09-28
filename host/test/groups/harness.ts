import path from "node:path";
import type { SseEvent } from "@synapse/shared";
import { ChainStore } from "../../b2b/chains";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain, type FakeScript } from "../../brain/fake-brain";
import type { ModelMessage } from "../../brain/types";
import type { HostConfig } from "../../config";
import { SseHub } from "../../gateway/sse-hub";
import type { FloorManager } from "../../groups/floor";
import { GroupOrchestrator } from "../../groups/orchestrator";
import { GroupService } from "../../groups/group-service";
import { CallRegistry } from "../../voice/calls";
import { RuntimeMetrics } from "../../metrics/runtime-metrics";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

export const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now() + ms;
  while (!f()) {
    if (Date.now() > t) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

export const say = (content: string) => ({ tool: "mcp__bot__SendMessage", input: { content } });
// Strict TS: TurnInput.prompt is ModelMessage[] (text or image parts). Callers pass a live TurnInput, so this
// accepts that broader type and reads only the text parts (same behavior as the brief's narrower signature).
export const promptText = (input: { prompt: ModelMessage[] }) => input.prompt.map((p) => ("text" in p ? p.text : "")).join("\n");

export interface HarnessOpts {
  floor?: FloorManager;
  gate?(h: { cfg: HostConfig; bots: BotService; settings: HostSettingsStore; runner: TurnRunner }): ApprovalGateLike;
  toolRunner?(botId: string, name: string, input: Record<string, unknown>): Promise<string>;
}

/** An in-process host slice: BotService, TurnRunner on FakeBrains, GroupService, ChainStore, GroupOrchestrator. */
export function groupHarness(scriptFor: (botId: string, name: string) => FakeScript, opts: HarnessOpts = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
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
  const brains = new Map<string, FakeBrain>();
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => {
      const b = new FakeBrain(id, runner.wiring(id), scriptFor(id, bots.summary(id).profile.name), {
        toolRunner: opts.toolRunner ? (name, input) => opts.toolRunner!(id, name, input) : undefined,
      });
      brains.set(id, b);
      return b;
    },
  });
  const allow: ApprovalGateLike = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), expireAll: () => {}, forgetBot: () => {} };
  runner.attach(supervisor, opts.gate ? opts.gate({ cfg, bots, settings, runner }) : allow);
  const groups = new GroupService({ bots, cfg });
  const chains = new ChainStore(path.join(cfg.hostPrivate, "chains.json"));
  // Bug 108: voice calls own their roster (Bots added to any call); removing one stops its turn.
  const calls: CallRegistry = new CallRegistry({ bots, now: Date.now, onRemoved: (chatId, ids) => orch.cancelRoom(chatId, ids) });
  const orch = new GroupOrchestrator({ groups, bots, runner, chains, floor: opts.floor ?? null, smartTurns: () => Boolean(opts.floor), now: Date.now, metrics, calls });
  const mk = (name: string) => bots.create({ origin: "user", kickstart: false, name });
  const groupEntries = (groupId: string) => bots.tail(groupId, 200);
  return { cfg, hub, events, settings, bots, runner, brains, groups, chains, orch, calls, metrics, trays, mk, groupEntries };
}
