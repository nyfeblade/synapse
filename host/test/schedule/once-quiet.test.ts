import { describe, expect, it } from "vitest";
import { normalizeSchedule } from "../../schedule/normalize";
import { inQuietHours, nextRunOutsideQuiet, parseQuietHours, splitQuietClause } from "../../schedule/quiet";
import { describeSchedule, nextRunAfter, parseSchedule } from "../../schedule/schedule";

const TZ = "America/New_York";
// Tue 2026-09-22 10:00 in New York (14:00 UTC)
const NOW = Date.UTC(2026, 8, 22, 14, 0);

describe("one-shot schedules (@once)", () => {
  it("'in 2 hours' becomes a single run two hours from now", async () => {
    const n = await normalizeSchedule("in 2 hours", { tz: TZ, nowMs: NOW, model: null });
    expect(n.schedule).toBe("@once 2026-09-22T16:00:00Z");
    expect(n.nextRuns).toEqual([NOW + 2 * 3_600_000]);
  });

  it("'in 30 minutes' and 'in a day' work too", async () => {
    expect((await normalizeSchedule("in 30 minutes", { tz: TZ, nowMs: NOW, model: null })).nextRuns).toEqual([NOW + 30 * 60_000]);
    expect((await normalizeSchedule("in a day", { tz: TZ, nowMs: NOW, model: null })).nextRuns).toEqual([NOW + 86_400_000]);
  });

  it("'once tomorrow at 9am' is one run at 9:00 local tomorrow", async () => {
    const n = await normalizeSchedule("once tomorrow at 9am", { tz: TZ, nowMs: NOW, model: null });
    expect(n.nextRuns).toEqual([Date.UTC(2026, 8, 23, 13, 0)]);
  });

  it("'once at 8am' when 8am has passed means tomorrow", async () => {
    const n = await normalizeSchedule("once at 8am", { tz: TZ, nowMs: NOW, model: null });
    expect(n.nextRuns).toEqual([Date.UTC(2026, 8, 23, 12, 0)]);
  });

  it("a one-shot has no run after it fires, and describes itself", () => {
    const p = parseSchedule("@once 2026-09-22T16:00:00Z", { tz: TZ, nowMs: NOW });
    expect(nextRunAfter(p, NOW, TZ)).toBe(NOW + 2 * 3_600_000);
    expect(nextRunAfter(p, NOW + 2 * 3_600_000, TZ)).toBeNull();
    expect(describeSchedule(p, TZ)).toMatch(/^Once, Tue Sep 22 12:00 PM/);
  });

  it("a one-shot in the past is refused", async () => {
    await expect(normalizeSchedule("@once 2020-01-01T00:00:00Z", { tz: TZ, nowMs: NOW, model: null })).rejects.toThrow();
  });
});

describe("quiet clause in the schedule text", () => {
  it("splits it off, clears with 'quiet none', and leaves day words alone", () => {
    expect(splitQuietClause("every hour, quiet 22:00-07:00")).toEqual({ schedule: "every hour", quiet: "22:00-07:00" });
    expect(splitQuietClause("every 2 hours (quiet 10pm-7am)")).toEqual({ schedule: "every 2 hours", quiet: "10pm-7am" });
    expect(splitQuietClause("every hour not between 10pm and 7am")).toEqual({ schedule: "every hour", quiet: "10pm-7am" });
    expect(splitQuietClause("every hour quiet none")).toEqual({ schedule: "every hour", quiet: null });
    expect(splitQuietClause("every day except weekends")).toEqual({ schedule: "every day except weekends", quiet: undefined });
    expect(splitQuietClause("weekdays at 9")).toEqual({ schedule: "weekdays at 9", quiet: undefined });
  });
});

describe("quiet hours", () => {
  it("parses HH:MM-HH:MM and 10pm-7am forms", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ from: 22 * 60, to: 7 * 60 });
    expect(parseQuietHours("10pm-7am")).toEqual({ from: 22 * 60, to: 7 * 60 });
    expect(() => parseQuietHours("nonsense")).toThrow();
    expect(() => parseQuietHours("09:00-09:00")).toThrow();
  });

  it("wraps midnight", () => {
    const q = parseQuietHours("22:00-07:00");
    expect(inQuietHours(Date.UTC(2026, 8, 23, 3, 0), TZ, q)).toBe(true); // 23:00 NY
    expect(inQuietHours(Date.UTC(2026, 8, 23, 10, 0), TZ, q)).toBe(true); // 06:00 NY
    expect(inQuietHours(Date.UTC(2026, 8, 23, 11, 0), TZ, q)).toBe(false); // 07:00 NY
    expect(inQuietHours(Date.UTC(2026, 8, 22, 14, 0), TZ, q)).toBe(false); // 10:00 NY
  });

  it("an hourly schedule skips the quiet window", () => {
    const p = parseSchedule("0 * * * *", { tz: TZ, nowMs: NOW });
    const q = parseQuietHours("22:00-07:00");
    // after 21:30 NY on Sep 22 the next run is 07:00 NY on Sep 23, not 22:00
    const after = Date.UTC(2026, 8, 23, 1, 30);
    expect(nextRunOutsideQuiet(p, after, TZ, undefined, q)).toBe(Date.UTC(2026, 8, 23, 11, 0));
  });
});
