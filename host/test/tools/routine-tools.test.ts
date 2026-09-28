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

describe('update_state target:"routine" (TOOL-15, RTN-02, RTN-22)', () => {
  it("create returns the normalized schedule, description and next runs, and posts the Created Routine row", async () => {
    const s = setup();
    const r = await s.handle(s.id, s.slot, { target: "routine", action: "create", name: "Pay-period check", prompt: "Check the pay stub.", schedule: "weekdays at 9:30" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Saved routine "Pay-period check" (active).');
    expect(r.text).toContain("Schedule: 30 9 * * 1-5");
    expect(r.text).toContain("Next runs: ");
    expect(s.events().at(-1)).toMatchObject({ type: "routine-created", routineId: "pay-period-check", name: "Pay-period check", nextRunAt: Date.UTC(2026, 8, 21, 13, 30, 0) }); // 9:30 AM New York today (it is 8:05 AM)
    expect(s.slot.nextActK).toBe(1);
  });

  it("create with a webhook trigger shows the URL and a masked key, never the raw key (I5)", async () => {
    const s = setup();
    const r = await s.handle(s.id, s.slot, { target: "routine", action: "create", name: "Hook", prompt: "p", trigger: { webhook: {} } });
    expect(r.text).toMatch(/POST to: http:\/\/box\.local:47801\/hooks\/[0-9a-f-]{36}\nKey: bot_…[0-9A-Za-z]{4} \(masked/);
    expect(r.text).not.toMatch(/bot_[0-9A-Za-z]{32}/);
    expect(r.text).toContain("the user copies the full key from the routine's page in the app");
  });

  it("pause/resume/delete aggregate same-type rows within one turn (CHAT-03)", async () => {
    const s = setup();
    for (const name of ["A", "B", "C"]) s.store.create(s.id, { name, prompt: "p", schedule: "0 8 * * *", enabled: true });
    await s.handle(s.id, s.slot, { target: "routine", action: "pause", id: "a" });
    await s.handle(s.id, s.slot, { target: "routine", action: "pause", id: "b" });
    await s.handle(s.id, s.slot, { target: "routine", action: "delete", id: "c" });
    const ev = s.events().filter((e) => e.type.startsWith("routine-"));
    expect(ev).toEqual([
      { type: "routine-disabled", routineId: "a", name: "A", count: 2, turnKey: "req_1" },
      { type: "routine-deleted", routineId: "c", name: "C", count: 1, turnKey: "req_1" },
    ]);
    const r = await s.handle(s.id, s.slot, { target: "routine", action: "resume", id: "a" });
    expect(r.text).toBe('Resumed routine "A". Next run: Tue Sep 22 8:00 AM.');
  });

  it("a Bot can manage only its own routines (RTN-22)", async () => {
    const s = setup();
    s.store.create(s.id, { name: "Mine", prompt: "p", schedule: "0 8 * * *", enabled: true });
    const r = await s.handle(s.other, null, { target: "routine", action: "pause", id: "mine" });
    expect(r).toEqual({ isError: true, text: 'No routine "mine". You can only manage your own routines; ask the Bot that owns it to change it.' });
    expect(s.store.get(s.id, "mine")!.def.enabled).toBe(true);
  });

  it("run starts a real, reviewed bot-run (C1: not Run now semantics) and list shows every routine", async () => {
    const s = setup();
    s.store.create(s.id, { name: "Mine", prompt: "p", schedule: "0 8 * * *", enabled: true });
    const run = await s.handle(s.id, s.slot, { target: "routine", action: "run", id: "mine" });
    expect(run.text).toMatch(/^Started a run of "Mine" \(run [0-9a-f-]{36}\)\. It does real work/);
    expect(s.submitted[0]).toMatchObject({ trigger: "bot-run" });
    expect(s.submitted[0]!.bypassGate).toBeFalsy();
    const list = await s.handle(s.id, s.slot, { target: "routine", action: "list" });
    expect(list.text).toBe('- "Mine" (id mine): Every day at 8:00 AM — active');
  });

  it("update surfaces a fresh key once when the trigger newly needs a webhook (ORIG-04 §04.2)", async () => {
    const s = setup();
    s.store.create(s.id, { name: "Plain", prompt: "p", schedule: "0 8 * * *", enabled: true });
    const r = await s.handle(s.id, s.slot, { target: "routine", action: "update", id: "plain", trigger: { webhook: {} } });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/POST to: http:\/\/box\.local:47801\/hooks\/[0-9a-f-]{36}\nKey: bot_…[0-9A-Za-z]{4} \(masked/);
    expect(r.text).not.toMatch(/bot_[0-9A-Za-z]{32}/);
  });

  it("own() rethrows a non-not-found error from view() instead of masking it as ownership (RTN-22)", async () => {
    const s = setup();
    s.store.create(s.id, { name: "Mine", prompt: "p", schedule: "0 8 * * *", enabled: true });
    const boom = new Error("listenerConnected blew up");
    const orig = s.routines.view.bind(s.routines);
    s.routines.view = (botId: string, id: string) => {
      if (id === "mine") throw boom;
      return orig(botId, id);
    };
    await expect(s.handle(s.id, s.slot, { target: "routine", action: "pause", id: "mine" })).rejects.toThrow("listenerConnected blew up");
  });

  it("errors are tool errors, never thrown", async () => {
    const s = setup();
    expect(await s.handle(s.id, s.slot, { target: "routine", action: "create", name: "X", prompt: "p", schedule: "every minute" })).toEqual({ isError: true, text: "Leave 5 minutes or more between a routine's runs" });
    expect((await s.handle(s.id, s.slot, { target: "routine", action: "fly" })).text).toBe('Unknown routine action "fly". Use create, update, pause, resume, delete, run or list.');
    expect((await s.handle(s.id, s.slot, { target: "routine", action: "update", id: "nope", name: "x" })).isError).toBe(true);
  });
});
