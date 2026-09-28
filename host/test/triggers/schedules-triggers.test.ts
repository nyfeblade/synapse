import path from "node:path";
import { describe, expect, it } from "vitest";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { SchedulerEngine } from "../../routines/engine";
import type { FireConsumer, FireRequest } from "../../routines/fire-consumer";
import { RoutineService } from "../../routines/routine-service";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb } from "../../routines/scheduler-db";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { describeTrigger, matchesTrigger, triggerSources, validateTrigger } from "../../triggers/match";
import type { TriggerEvent } from "../../triggers/types";
import { tmpConfig } from "../helpers";

const NOW = Date.UTC(2026, 8, 21, 12, 5, 0);

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const clock = { now: NOW };
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  settings.update({ userTimeZone: "America/New_York" });
  const bots = new BotService({ cfg, hub, settings, now: () => clock.now });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const other = bots.create({ origin: "user", kickstart: false, name: "Rex" });
  const store = new RoutineStore({ cfg, now: () => clock.now });
  const db = new SchedulerDb(":memory:");
  const engine = new SchedulerEngine({ db, store, botTz: () => settings.timeZone(), now: () => clock.now, mono: () => 0, setTimer: () => 0, clearTimer: () => {}, onClaim: () => {}, onOfflineSkips: () => {} });
  engine.boot();
  const submitted: FireRequest[] = [];
  const consumer = { submit: (r: FireRequest) => { submitted.push(r); return { accepted: true, runId: r.runId }; } } as unknown as FireConsumer;
  const routines = new RoutineService({ cfg, store, db, engine, consumer, bots, settings, hub, model: null, now: () => clock.now, publicBaseUrl: () => "http://box.local:47801" });
  return { cfg, clock, bots, id, other, store, routines };
}

const cal = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  source: "calendar", eventId: "e1@2026-09-21T13:00:00Z", occurredAt: NOW, subject: "Design review with Ana", text: "", raw: { calendarId: "primary", minutesBefore: 10 }, ...over,
});

describe("calendar trigger", () => {
  const t = { calendar: { minutesBefore: 10, match: "design review" } };
  it("matches an event in the same calendar and lead time whose title has every word", () => {
    expect(matchesTrigger(t, cal(), { savedAt: 0 })).toBe(true);
    expect(matchesTrigger(t, cal({ subject: "Standup" }), { savedAt: 0 })).toBe(false);
    expect(matchesTrigger(t, cal({ raw: { calendarId: "primary", minutesBefore: 30 } }), { savedAt: 0 })).toBe(false);
    expect(matchesTrigger({ calendar: { minutesBefore: 10, calendarId: "work" } }, cal(), { savedAt: 0 })).toBe(false);
  });
  it("is a trigger source with a description and bounds", () => {
    expect(triggerSources(t)).toEqual(["calendar"]);
    expect(describeTrigger(t)).toBe("10 minutes before a calendar event matching “design review”");
    expect(validateTrigger({ calendar: { minutesBefore: 0 } })).toMatch(/1 to 1440/);
    expect(validateTrigger({ calendar: { minutesBefore: 5000 } })).toMatch(/1 to 1440/);
  });
});

describe("Mac folder file trigger", () => {
  const t = { file: { paths: ["mac:~/Downloads"], events: ["created" as const] } };
  const ev = (p: string): TriggerEvent => ({ source: "file", eventId: p, occurredAt: NOW, kind: "created", path: p, text: "", raw: {} });
  it("matches files directly in the watched Mac folder only", () => {
    expect(matchesTrigger(t, ev("mac:~/Downloads/report.pdf"), { savedAt: 0, workspace: "/workspace" })).toBe(true);
    expect(matchesTrigger(t, ev("mac:~/Documents/report.pdf"), { savedAt: 0, workspace: "/workspace" })).toBe(false);
    expect(matchesTrigger(t, ev("/workspace/Downloads/report.pdf"), { savedAt: 0, workspace: "/workspace" })).toBe(false);
  });
  it("validates: Mac paths are allowed, other outside paths are not", () => {
    expect(validateTrigger(t)).toBeNull();
    expect(validateTrigger({ file: { paths: ["/etc"], events: ["created"] } })).toMatch(/inside \/workspace/);
  });
});

describe("routine service: schedules extensions", () => {
  it("saves quiet hours, catch-up (on by default for schedules) and a daily cap", async () => {
    const s = setup();
    const r = await s.routines.create(s.id, { name: "Inbox", prompt: "summarize my inbox", schedule: "every hour", quietHours: "10pm-7am" });
    expect(r.view.quietHours).toBe("22:00-07:00");
    expect(r.view.catchUp).toBe(true);
    const t = await s.routines.create(s.id, { name: "Mail", prompt: "triage", trigger: { webhook: {} }, dailyCap: 5 });
    expect(t.view.dailyCap).toBe(5);
    await expect(s.routines.create(s.id, { name: "Bad", prompt: "p", schedule: "every hour", quietHours: "soon" })).rejects.toThrow(/quiet hours/i);
    await expect(s.routines.create(s.id, { name: "Cap", prompt: "p", trigger: { webhook: {} }, dailyCap: 0 })).rejects.toThrow(/cap/i);
  });

  it("accepts a calendar trigger and describes it", async () => {
    const s = setup();
    const r = await s.routines.create(s.id, { name: "Prep", prompt: "prep me", trigger: { calendar: { minutesBefore: 15 } } });
    expect(r.view.triggerKind).toBe("calendar");
    expect(r.view.description).toBe("15 minutes before a calendar event");
  });

  it("a Bot only sees its own schedules", async () => {
    const s = setup();
    await s.routines.create(s.other, { name: "Theirs", prompt: "p", schedule: "every hour" });
    expect(s.routines.list(s.id)).toEqual([]);
    expect(() => s.routines.view(s.id, "theirs")).toThrow(/No routine/);
  });

  it("the first schedule a Bot saves is recorded, so the confirmation card is asked only once", async () => {
    const s = setup();
    expect(s.store.confirmed(s.id)).toBe(false);
    await s.routines.create(s.id, { name: "One", prompt: "p", schedule: "every hour" });
    expect(s.store.confirmed(s.id)).toBe(true);
    s.routines.remove(s.id, "one");
    expect(s.store.confirmed(s.id)).toBe(true);
  });
});
