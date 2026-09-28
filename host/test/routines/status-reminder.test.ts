import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
// Strict TS (Controller ruling): ModelMessage is a { text } | { image } union; messageText() narrows
// it instead of a raw `.text` access, the same minimal-cast pattern used for Response.json() elsewhere.
import { messageText } from "../../brain/types";
import { RoutineStore } from "../../routines/routine-store";
import { StatusReminder } from "../../routines/status-reminder";
import { botDir, initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const T0 = Date.UTC(2026, 8, 21, 7, 0, 0);
const info = { source: "user" as const, silenceAllowed: false, lane: "user" as const };

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const botId = randomUUID();
  fs.mkdirSync(botDir(cfg, botId), { recursive: true });
  const store = new RoutineStore({ cfg, now: () => T0 });
  const sr = new StatusReminder({ store, nextRunAt: () => T0 + 3_600_000, botTz: () => "UTC", now: () => T0 });
  return { botId, store, sr };
}

describe("StatusReminder (RTN-21, EVT-12)", () => {
  it("sends nothing for a Bot that never had routines", () => {
    const { botId, sr } = setup();
    expect(sr.decorate(botId, info)).toBeNull();
  });

  it("sends the authoritative snapshot only when it changes or after compaction", () => {
    const { botId, store, sr } = setup();
    store.create(botId, { name: "Sweep", prompt: "p", schedule: "0 8 * * *", enabled: true });
    const first = messageText(sr.decorate(botId, info)!);
    expect(first).toBe(
      "<system_reminder><automation_status>\nRoutine status as of now. Trust this snapshot over any earlier status and over your own recollection of it.\n" +
        '- "Sweep" (id sweep): next run Mon Sep 21 8:00 AM; never run\n</automation_status></system_reminder>',
    );
    expect(sr.decorate(botId, info)).toBeNull();
    sr.markCompacted(botId);
    expect(messageText(sr.decorate(botId, info)!)).toBe(first);
    store.upsertRun(botId, "sweep", { id: "r1", trigger: "schedule", startedAt: T0 - 60_000, finishedAt: T0, status: "running", requestId: "q" });
    expect(messageText(sr.decorate(botId, info)!)).toContain('- "Sweep" (id sweep): running now');
    store.upsertRun(botId, "sweep", { id: "r1", trigger: "schedule", startedAt: T0 - 60_000, finishedAt: T0, status: "error", requestId: "q" });
    expect(messageText(sr.decorate(botId, info)!)).toContain("next run Mon Sep 21 8:00 AM; last run Mon Sep 21 6:59 AM (failed)");
    store.update(botId, "sweep", { enabled: false });
    expect(messageText(sr.decorate(botId, info)!)).toContain('- "Sweep" (id sweep): paused');
  });

  it('says "No current routines." once after the last one is deleted', () => {
    const { botId, store, sr } = setup();
    store.create(botId, { name: "Sweep", prompt: "p", schedule: "0 8 * * *", enabled: true });
    sr.decorate(botId, info);
    store.remove(botId, "sweep");
    expect(messageText(sr.decorate(botId, info)!)).toBe("<system_reminder><automation_status>\nNo current routines.\n</automation_status></system_reminder>");
    expect(sr.decorate(botId, info)).toBeNull();
  });

  it("systemSection lists routines and the routine guidance", () => {
    const { botId, store, sr } = setup();
    store.create(botId, { name: "Sweep", prompt: "p", schedule: "0 8 * * *", enabled: true });
    const text = sr.systemSection(botId);
    expect(text).toContain('- "Sweep" (id sweep)');
    expect(text).toContain('update_state target "routine"');
    expect(text).toContain("delete themselves");
  });
});
