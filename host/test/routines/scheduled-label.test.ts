import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EventEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain, type FakeScript } from "../../brain/fake-brain";
import { SseHub } from "../../gateway/sse-hub";
import { PresenceTracker } from "../../presence/presence";
import { renderRoutineWake } from "../../routines/routine-turn";
import { AckLedger } from "../../runner/ack-ledger";
import { ResumeLedger } from "../../runner/resume-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";
import { TurnRunner, type ApprovalGateLike } from "../../runner/turn-runner";
import { installWakeOrigin } from "../../runner/wake-origin";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { Supervisor } from "../../supervisor/supervisor";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

const until = async (f: () => boolean, ms = 3000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

function setup(script: FakeScript) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const presence = new PresenceTracker((id) => bots.has(id) && bots.publish(id));
  bots.setRuntimeView((id) => presence.view(id));
  const runner = new TurnRunner({
    cfg, bots, presence, settings, trays: new TrayService(hub),
    acks: new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json")),
    sendAcceptance: new SendAcceptanceLedger(path.join(cfg.hostPrivate, "send-acceptance.json")),
    resume: new ResumeLedger(path.join(cfg.hostPrivate, "host-restart-resume.json")),
    flags: () => DEFAULT_FLAGS, timings: { ackRedriveIdleMs: 20, retryBaseMs: 1 },
  });
  const supervisor = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 },
    brainFactory: (id) => new FakeBrain(id, runner.wiring(id), script),
  });
  const gate: ApprovalGateLike = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), expireAll: () => {}, forgetBot: () => {} };
  runner.attach(supervisor, gate);
  installWakeOrigin(runner, bots);
  const piper = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const origins = () => bots.tail(piper, 100).filter((e): e is EventEntry => e.kind === "event" && e.event.type === "wake-origin");
  return { bots, runner, piper, origins };
}

const routineWake = (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}, onSettle?: () => void) =>
  s.runner.enqueueWake(s.piper, {
    source: "routine", lane: "background", silenceAllowed: true, hidden: true,
    context: { wake: { kind: "routine", routineId: "inbox", routineName: "Inbox digest", via: "schedule", ...extra }, routineRun: { routineId: "inbox", runId: "r1", startedAt: Date.now() } },
    prompt: () => [{ text: "[routine]" }], onSettle,
  });

describe("scheduled runs in chat", () => {
  it("the row says Scheduled · <name>, and caught up when it was a catch-up run", async () => {
    const s = setup(() => [{ tool: "mcp__bot__SendMessage", input: { content: "3 new emails." } }]);
    routineWake(s, { caughtUp: true });
    await until(() => s.origins().length === 1);
    expect(s.origins()[0]!.event).toEqual({ type: "wake-origin", source: "routine", routineId: "inbox", routineName: "Inbox digest", via: "schedule", caughtUp: true });
  });

  it("a message from a scheduled run is quiet unless the Bot passes notify: true", async () => {
    const s = setup(() => [{ tool: "mcp__bot__SendMessage", input: { content: "Nothing urgent." } }]);
    let done = false;
    routineWake(s, {}, () => { done = true; });
    await until(() => done);
    expect(s.bots.summary(s.piper).lastBotMessageQuiet).toBe(true);

    const s2 = setup(() => [{ tool: "mcp__bot__SendMessage", input: { content: "Your flight moved!", notify: true } }]);
    let done2 = false;
    routineWake(s2, {}, () => { done2 = true; });
    await until(() => done2);
    expect(s2.bots.summary(s2.piper).lastBotMessageQuiet).toBe(false);
  });

  it("the catch-up wake tells the Bot it is the one catch-up run", () => {
    const routine = { botId: "b", id: "inbox", defHash: "h", def: { name: "Inbox digest", prompt: "Summarize my inbox.", enabled: true, createdAt: 0 } };
    const w = renderRoutineWake({ routine, description: "Every day at 8:00 AM", expr: "0 8 * * *", firedAt: 0, scheduledFor: 0, trigger: "schedule", events: [], lateByMs: 3 * 3_600_000, tz: "UTC", caughtUp: 4 });
    expect(w.text).toContain("caught up: the computer was asleep or off at the scheduled time, and 4 runs were missed");
    expect(w.text).not.toContain("late because you were busy");
    expect(w.text).toContain("notify: true");
  });
});
