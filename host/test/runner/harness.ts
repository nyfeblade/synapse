import path from "node:path";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain, type FakeScript } from "../../brain/fake-brain";
import type { BrainWiring, PermissionDecision, PreToolDecision, SupervisedBrain } from "../../brain/types";
import { BotService } from "../../bots/bot-service";
import type { HostConfig } from "../../config";
import { SseHub } from "../../gateway/sse-hub";
import { PresenceTracker } from "../../presence/presence";
import { AckLedger } from "../../runner/ack-ledger";
import type { TurnHooks } from "../../runner/hooks";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import type { BotToolExtensions } from "../../tools/registry";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

export async function makeRunnerHarness(o: {
  script: FakeScript;
  hooks?: TurnHooks;
  hooksFactory?: (bots: BotService, cfg: HostConfig) => TurnHooks;
  toolExtensions?: BotToolExtensions;
  toolExtensionsFactory?: (bots: BotService, cfg: HostConfig) => BotToolExtensions;
  /** Phase 5 seam: the host modules' system-prompt extras, appended by TurnRunner.systemAppend. */
  systemAppendExtras?: (botId: string) => string;
  /** Replaces the FakeBrain for a brain that misbehaves on purpose (a runTurn that throws, an
   *  interrupt() that rejects). `brain(id)` then returns whatever this built. */
  brainFactory?: (id: string, wiring: BrainWiring) => SupervisedBrain;
  timings?: { ackRedriveIdleMs?: number; retryBaseMs?: number };
}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker(() => {});
  bots.setRuntimeView((id) => presence.view(id));
  const trays = new TrayService(hub);
  const hp = (f: string) => path.join(cfg.hostPrivate, f);
  const acks = new AckLedger(hp("acks.json"));
  const gate = {
    preToolUse: async (): Promise<PreToolDecision> => ({ decision: "allow" }),
    canUseTool: async (): Promise<PermissionDecision> => ({ behavior: "allow" }),
    expireAll: () => {}, forgetBot: () => {},
  };
  const brains = new Map<string, SupervisedBrain>();
  /** One host "process": a fresh TurnRunner + Supervisor over the same on-disk ledgers and BotService.
   *  Calling it again is what a restart looks like from the runner's point of view (empty `rt`). */
  const boot = () => {
    const runner = new TurnRunner({
      cfg, bots, trays, presence, settings, flags: () => DEFAULT_FLAGS, acks,
      hooks: o.hooks ?? o.hooksFactory?.(bots, cfg), toolExtensions: o.toolExtensions ?? o.toolExtensionsFactory?.(bots, cfg),
      sendAcceptance: new SendAcceptanceLedger(hp("send.json")), resume: new ResumeLedger(hp("resume.json")),
      timings: { ackRedriveIdleMs: 60_000, ...o.timings },
      ...(o.systemAppendExtras ? { systemAppendExtras: o.systemAppendExtras } : {}),
    });
    const supervisor = new Supervisor({
      caps: { maxLive: 4, maxRunning: 4, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 }, now: Date.now, onPreempt: () => {}, onCrashBackoff: () => {},
      brainFactory: (id) => {
        const b = o.brainFactory ? o.brainFactory(id, runner.wiring(id)) : new FakeBrain(id, runner.wiring(id), o.script);
        brains.set(id, b);
        return b;
      },
    });
    runner.attach(supervisor, gate);
    const untilIdle = async (id: string, ms = 3000) => {
      const t = Date.now() + ms;
      await new Promise((r) => setTimeout(r, 10));
      while (!runner.isIdle(id) || runner.maintenanceActive(id)) {
        if (Date.now() > t) throw new Error("timeout waiting for idle");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    return { runner, supervisor, untilIdle };
  };
  const first = boot();
  return {
    cfg, hub, settings, bots, trays, acks, boot,
    runner: first.runner, supervisor: first.supervisor, untilIdle: first.untilIdle,
    brain: (id: string) => brains.get(id) as FakeBrain,
  };
}
