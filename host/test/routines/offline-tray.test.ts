import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SseHub } from "../../gateway/sse-hub";
import { onOfflineTrayDismissed, raiseOfflineTrays } from "../../routines/offline-tray";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb } from "../../routines/scheduler-db";
import { UsagePause } from "../../routines/usage-pause";
import { botDir, initLayout } from "../../store/layout";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

describe("skipped-while-off tray (RTN-08, D5-A)", () => {
  it("raises one tray per Bot naming up to 5 routines with counts, and clears counts on dismiss", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const botId = randomUUID();
    fs.mkdirSync(botDir(cfg, botId), { recursive: true });
    const store = new RoutineStore({ cfg });
    const db = new SchedulerDb(":memory:");
    const trays = new TrayService(new SseHub());
    for (const [i, name] of ["Sweep", "Digest", "Standup", "Backup", "Report", "Ping"].entries()) {
      const r = store.create(botId, { name, prompt: "p", schedule: "0 8 * * *", enabled: true })!;
      for (let k = 0; k <= 5 - i; k++) db.addOfflineSkip(botId, r.id, 1_000 + k);
    }
    raiseOfflineTrays({ db, store, trays }, [botId, botId]);
    raiseOfflineTrays({ db, store, trays }, [botId]);
    expect(trays.list()).toHaveLength(1);
    const t = trays.list()[0]!;
    expect(t.title).toBe("21 routine runs were skipped while Bots' computer was off");
    expect(t.detail).toBe("Sweep (6), Digest (5), Standup (4), Backup (3), Report (2), and 1 more");
    expect(store.runs(botId, "sweep")).toEqual([]);
    onOfflineTrayDismissed(db, t);
    expect(db.offlineSkips(botId)).toEqual([]);
  });
});

describe("UsagePause (USE-04, ORIG-14 subset)", () => {
  it("pauses routine fires until the reset and says when it resets", () => {
    const clock = { now: 0 };
    const u = new UsagePause(() => clock.now);
    expect(u.paused()).toBe(false);
    u.pauseUntil(3 * 3_600_000 + 1);
    expect(u.paused()).toBe(true);
    expect(u.hoursLeft()).toBe(4);
    expect(u.resetsInText()).toBe("It resets in 4 hours");
    clock.now = 3 * 3_600_000 + 2;
    expect(u.paused()).toBe(false);
  });
});
