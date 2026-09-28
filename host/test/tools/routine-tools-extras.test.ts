import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EventEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { SchedulerEngine } from "../../routines/engine";
import type { FireConsumer, FireRequest } from "../../routines/fire-consumer";
import { RoutineService } from "../../routines/routine-service";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb } from "../../routines/scheduler-db";
import { emptyContext } from "../../runner/turn-context";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { routineStateTarget } from "../../tools/routine-tools";
import { tmpConfig } from "../helpers";

const NOW = Date.UTC(2026, 8, 21, 12, 5, 0);

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  settings.update({ userTimeZone: "America/New_York" });
  const bots = new BotService({ cfg, hub, settings, now: () => NOW });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const other = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const store = new RoutineStore({ cfg, now: () => NOW });
  const db = new SchedulerDb(":memory:");
  const engine = new SchedulerEngine({ db, store, botTz: () => settings.timeZone(), now: () => NOW, mono: () => 0, setTimer: () => 0, clearTimer: () => {}, onClaim: () => {}, onOfflineSkips: () => {} });
  engine.boot();
  const submitted: FireRequest[] = [];
  const consumer = { submit: (r: FireRequest) => { submitted.push(r); return { accepted: true, runId: r.runId }; } } as unknown as FireConsumer;
  const routines = new RoutineService({ cfg, store, db, engine, consumer, bots, settings, hub, model: null, now: () => NOW, publicBaseUrl: () => "http://box.local:47801" });
  const handle = routineStateTarget({ routines, bots, now: () => NOW });
  const slot = newSlot({ botId: id, requestId: "req_1", turnNo: 4, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: NOW, context: emptyContext() });
  const events = (bot = id) => bots.tail(bot, 50).filter((e): e is EventEntry => e.kind === "event").map((e) => e.event);
  return { bots, id, other, store, routines, handle, slot, submitted, events };
}

describe("update_state routine: quiet hours, catch-up, daily cap, list", () => {
  it("quiet hours ride in the schedule text; 'quiet none' clears them; list shows state and the next run", async () => {
    const s = setup();
    const r = await s.handle(s.id, s.slot, { target: "routine", action: "create", name: "Inbox digest", prompt: "Summarize my inbox.", schedule: "every 2 hours, quiet 10pm-7am" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("Quiet hours: 22:00-07:00");
    expect(s.routines.view(s.id, "inbox-digest").quietHours).toBe("22:00-07:00");
    expect(s.routines.view(s.id, "inbox-digest").catchUp).toBe(true);
    const u = await s.handle(s.id, s.slot, { target: "routine", action: "update", id: "inbox-digest", schedule: "every 2 hours quiet none" });
    expect(u.isError).toBeFalsy();
    expect(s.routines.view(s.id, "inbox-digest").quietHours).toBeNull();
    const l = await s.handle(s.id, s.slot, { target: "routine", action: "list" });
    expect(l.text).toContain('- "Inbox digest" (id inbox-digest):');
    expect(l.text).toMatch(/— active, next \w{3} \w{3} \d+ \d+:\d{2} [AP]M/);
  });

  it("a one-shot 'in 2 hours' saves and reports its single run", async () => {
    const s = setup();
    const r = await s.handle(s.id, s.slot, { target: "routine", action: "create", name: "Remind", prompt: "Remind me to call Ana.", schedule: "in 2 hours" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("Schedule: @once 2026-09-21T14:05:00Z");
  });
});
