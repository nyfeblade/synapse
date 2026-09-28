import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, STR, type RoutineView } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { SchedulerEngine } from "../../routines/engine";
import type { FireConsumer, FireRequest } from "../../routines/fire-consumer";
import { RoutineHealth, type RoutineProblem } from "../../routines/routine-health";
import { RoutineService } from "../../routines/routine-service";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb } from "../../routines/scheduler-db";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { CalendarTriggers } from "../../triggers/calendar-triggers";
import type { EventQueue } from "../../triggers/event-queue";
import { MacFolderWatch } from "../../triggers/mac-folder";
import { tmpConfig } from "../helpers";

// Bug 115: a calendar or Mac-folder trigger whose poll keeps failing must not go on looking Active and fine:
// after N failures in a row the routine's own row says it is not watching (and names what fixes it), the row's
// listenerConnected turns false, and the user gets a tray entry. A poll that works again clears the state.

const NOW = Date.UTC(2026, 8, 21, 12, 5, 0);
const N = LIMITS.imapFailHealthAfter;

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const clock = { now: NOW };
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  settings.update({ userTimeZone: "America/New_York" });
  const bots = new BotService({ cfg, hub, settings, now: () => clock.now });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const store = new RoutineStore({ cfg, now: () => clock.now, onChange: (b, r) => engine.reindex(b, r) });
  const db = new SchedulerDb(":memory:");
  const engine = new SchedulerEngine({ db, store, botTz: () => settings.timeZone(), now: () => clock.now, mono: () => 0, setTimer: () => 0, clearTimer: () => {}, onClaim: () => {}, onOfflineSkips: () => {} });
  engine.boot();
  const consumer = { submit: (r: FireRequest) => ({ accepted: true, runId: r.runId }) } as unknown as FireConsumer;
  const routines = new RoutineService({ cfg, store, db, engine, consumer, bots, settings, hub, model: null, now: () => clock.now, publicBaseUrl: () => "http://box.local:47801" });
  const queue = { ingest: () => {} } as unknown as EventQueue;
  let calFails = true;
  const calendar = new CalendarTriggers({
    store, queue, now: () => clock.now, setTimer: () => 0, clearTimer: () => {},
    source: () => (async () => { if (calFails) throw new Error("403 calendar access revoked"); return { items: [] }; }) as never,
  });
  let macFails: "throw" | "away" | "ok" = "throw";
  const mac = new MacFolderWatch({
    store, queue, now: () => clock.now, setTimer: () => 0, clearTimer: () => {},
    list: async () => { if (macFails === "throw") throw new Error("list-directory failed: No such file or directory"); return macFails === "away" ? null : "a.txt\n"; },
  });
  const trays: { botId: string | null; title: string; detail?: string; dedupeKey?: string }[] = [];
  const problems: RoutineProblem[] = [];
  const health = new RoutineHealth({
    store, now: () => clock.now, botTz: () => settings.timeZone(), hasMailbox: () => false,
    calendarFailing: (_b, cal) => !calendar.calendarReachable(cal),
    macFolderFailing: (folder) => !mac.folderReachable(folder),
    onChanged: (botId) => routines.publish(botId),
    onProblem: (rec, p) => { problems.push(p); trays.push({ botId: rec.botId, title: rec.def.name, detail: p.detail, dedupeKey: `x:${rec.id}` }); },
  });
  routines.d.calendarReachable = (cal) => calendar.calendarReachable(cal);
  routines.d.macFolderReachable = (folder) => mac.folderReachable(folder);
  const resync = () => { health.reconcile(); calendar.sync(); mac.sync(); };
  calendar.onHealthChange = () => health.reconcile();
  mac.onHealthChange = () => health.reconcile();
  const view = (routineId: string): RoutineView => routines.list(id).find((r) => r.id === routineId)!;
  return { id, store, calendar, mac, resync, view, trays, problems, setCal: (f: boolean) => { calFails = f; }, setMac: (m: typeof macFails) => { macFails = m; } };
}

describe("calendar and Mac-folder trigger polls that keep failing reach the user (bug 115)", () => {
  it("a calendar poll that keeps failing: the row says it can't read the calendar, stays on, and a tray entry says so", async () => {
    const s = setup();
    s.store.create(s.id, { name: "Meeting prep", prompt: "Prep me.", trigger: { calendar: { minutesBefore: 10 } }, enabled: true });
    s.resync();
    for (let i = 0; i < N - 1; i++) await s.calendar.pollOnce();
    expect(s.view("meeting-prep").runs).toHaveLength(0); // one or two blips are retried quietly
    expect(s.view("meeting-prep").listenerConnected).toBe(true);
    await s.calendar.pollOnce();
    const v = s.view("meeting-prep");
    expect(v.enabled, "recoverable: the next poll that works resumes it").toBe(true);
    expect(v.listenerConnected).toBe(false);
    expect(v.runs[0]).toMatchObject({ status: "error", detail: STR.routineCalendarFailing("primary") });
    expect(s.trays).toHaveLength(1);
    expect(s.trays[0]).toMatchObject({ botId: s.id, title: "Meeting prep", detail: STR.routineCalendarFailing("primary") });
    // More failures: no pile of rows or trays.
    await s.calendar.pollOnce();
    s.resync();
    expect(s.view("meeting-prep").runs).toHaveLength(1);
    expect(s.trays).toHaveLength(1);
    // It works again: the row's live state says so.
    s.setCal(false);
    await s.calendar.pollOnce();
    expect(s.view("meeting-prep").listenerConnected).toBe(true);
  });

  it("a Mac folder whose listing keeps failing: the row says it isn't watching the folder, and a tray entry says so", async () => {
    const s = setup();
    s.store.create(s.id, { name: "New downloads", prompt: "Sort it.", trigger: { file: { paths: ["mac:~/Downloads/"], events: ["created"] } }, enabled: true });
    s.resync();
    for (let i = 0; i < N; i++) await s.mac.pollOnce();
    const v = s.view("new-downloads");
    expect(v.enabled).toBe(true);
    expect(v.listenerConnected).toBe(false);
    expect(v.runs[0]).toMatchObject({ status: "error", detail: STR.routineMacFolderFailing("~/Downloads") });
    expect(s.trays.map((t) => t.detail)).toEqual([STR.routineMacFolderFailing("~/Downloads")]);
    s.setMac("ok");
    await s.mac.pollOnce();
    expect(s.view("new-downloads").listenerConnected).toBe(true);
  });

  it("a Mac that is merely away (asleep, not connected) is not a failure", async () => {
    const s = setup();
    s.setMac("away");
    s.store.create(s.id, { name: "New downloads", prompt: "Sort it.", trigger: { file: { paths: ["mac:~/Downloads"], events: ["created"] } }, enabled: true });
    s.resync();
    for (let i = 0; i < N + 2; i++) await s.mac.pollOnce();
    expect(s.view("new-downloads")).toMatchObject({ enabled: true, runs: [] });
    expect(s.trays).toHaveLength(0);
  });

  it("a workspace file trigger is not a Mac folder: its row has no listener state", () => {
    const s = setup();
    s.store.create(s.id, { name: "Inbox files", prompt: "p", trigger: { file: { paths: ["/workspace/inbox"], events: ["created"] } }, enabled: true });
    s.resync();
    expect(s.view("inbox-files").listenerConnected).toBeNull();
  });
});
