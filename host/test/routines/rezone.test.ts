/**
 * 0.1.4 first-run (code audit 6.1 / 6.2): scheduled routines kept the old time zone after the Mac's changed. The index
 * row's next run was computed once, in the zone of that moment, and nothing recomputed it on a zone change (at run
 * time or across a restart); and the host never learned the Mac's zone at all ("Auto" was the box's).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb } from "../../routines/scheduler-db";
import { SchedulerEngine } from "../../routines/engine";
import { HostSettingsStore } from "../../store/host-settings";
import { botDir, initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const T0 = Date.UTC(2026, 8, 21, 6, 0, 0); // 02:00 in New York, 23:00 (the day before) in Los Angeles

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const botId = randomUUID();
  fs.mkdirSync(botDir(cfg, botId), { recursive: true });
  const clock = { now: T0 };
  const zone = { tz: "America/New_York" };
  const store = new RoutineStore({ cfg, now: () => clock.now });
  const db = new SchedulerDb(":memory:");
  const mk = () => new SchedulerEngine({
    db, store, botTz: () => zone.tz, now: () => clock.now, mono: () => 0,
    setTimer: () => 0, clearTimer: () => {}, onClaim: () => {}, onOfflineSkips: () => {},
  });
  return { cfg, botId, clock, zone, store, db, mk };
}

const hourIn = (ms: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(ms).replace(/^0/, "");

describe("routines follow the user's time zone when it changes", () => {
  it("rezone() moves a 9:00 routine to 9:00 in the new zone, and leaves one with its own zone alone", () => {
    const s = setup();
    const engine = s.mk();
    const daily = s.store.create(s.botId, { name: "Morning", prompt: "p", schedule: "0 9 * * *", enabled: true })!;
    const tokyo = s.store.create(s.botId, { name: "Tokyo", prompt: "p", schedule: "CRON_TZ=Asia/Tokyo 0 9 * * *", enabled: true })!;
    engine.boot();
    const before = engine.nextRunAt(s.botId, daily.id)!;
    const tokyoBefore = engine.nextRunAt(s.botId, tokyo.id);
    expect(hourIn(before, "America/New_York")).toBe("9");
    s.zone.tz = "America/Los_Angeles";
    expect(engine.rezone()).toBe(1);
    const after = engine.nextRunAt(s.botId, daily.id)!;
    expect(hourIn(after, "America/Los_Angeles")).toBe("9");
    expect(after - before).toBe(3 * 3_600_000);
    expect(engine.nextRunAt(s.botId, tokyo.id)).toBe(tokyoBefore);
    expect(engine.rezone()).toBe(0); // nothing left to move
  });

  it("a zone change while the host was down is picked up at boot", () => {
    const s = setup();
    const daily = s.store.create(s.botId, { name: "Morning", prompt: "p", schedule: "0 9 * * *", enabled: true })!;
    s.mk().boot();
    s.zone.tz = "Europe/London";
    const engine = s.mk(); // restart, same db
    engine.boot();
    expect(hourIn(engine.nextRunAt(s.botId, daily.id)!, "Europe/London")).toBe("9");
  });

  it("the host takes the Mac's zone for Auto (an explicit choice still wins), saves only on change, refuses a bad name", () => {
    const cfg = tmpConfig();
    const file = path.join(cfg.dataRoot, "settings.json");
    const published: string[] = [];
    const st = new HostSettingsStore(file, (v) => published.push(v.userTimeZone));
    expect(st.setMacTimeZone("Asia/Kolkata")).toBe(true);
    expect(st.timeZone()).toBe("Asia/Kolkata");
    expect(st.setMacTimeZone("Asia/Kolkata")).toBe(false);
    expect(published).toEqual(["Asia/Kolkata"]);
    expect(() => st.setMacTimeZone("Mars/Olympus")).toThrow(/time zone/);
    st.update({ userTimeZone: "Europe/Paris" });
    expect(st.timeZone()).toBe("Europe/Paris");
    expect(new HostSettingsStore(file, () => {}).view().userTimeZone).toBe("Europe/Paris");
    st.update({ userTimeZone: "" });
    expect(new HostSettingsStore(file, () => {}).timeZone()).toBe("Asia/Kolkata");
  });
});

describe("the running host reschedules when the Mac's zone arrives (setMacTimeZone)", () => {
  it("a daily 9:00 routine moves to 9:00 in the Mac's new zone, through the real gateway command", async () => {
    const { createHostApp } = await import("../../app");
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    try {
      await app.services.phase4.start();
      await app.handlers.setMacTimeZone!({ zone: "America/New_York" });
      const { id } = await app.handlers.createAgent!({ name: "Clock", isKickstartRequested: false });
      const { routine } = await app.handlers.createAgentAutomation!({ id, name: "Morning", prompt: "p", schedule: "0 9 * * *" });
      const next = () => app.services.phase4.engine.nextRunAt(id, routine.id)!;
      expect(hourIn(next(), "America/New_York")).toBe("9");
      await app.handlers.setMacTimeZone!({ zone: "Asia/Tokyo" });
      await vi.waitFor(() => expect(hourIn(next(), "Asia/Tokyo")).toBe("9"));
    } finally { await app.close(); }
  });
});
