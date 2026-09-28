import { describe, expect, it } from "vitest";
import { ALIASES, cronMatches, describeCron, formatTime, parseCron } from "../../schedule/cron";
import type { LocalTime } from "../../schedule/types";

const at = (y: number, mo: number, d: number, h: number, mi: number): LocalTime => ({ y, mo, d, h, mi, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() });

describe("parseCron (RTN-05)", () => {
  it("expands lists, ranges, steps and names; DOW 7 is Sunday", () => {
    const c = parseCron("0,30 9-17/2 1,15 jan-mar 5-7");
    expect(c.minutes).toEqual([0, 30]);
    expect(c.hours).toEqual([9, 11, 13, 15, 17]);
    expect(c.doms).toEqual([1, 15]);
    expect(c.months).toEqual([1, 2, 3]);
    expect(c.dows).toEqual([0, 5, 6]);
    expect(c.domStar).toBe(false);
    expect(c.dowStar).toBe(false);
    expect(parseCron("*/15 * * * mon-fri").minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron("*/15 * * * mon-fri").dows).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
    const star = parseCron("0 8 * * *");
    expect(star.domStar && star.dowStar).toBe(true);
    expect(star.doms).toHaveLength(31);
  });

  it.each(["61 * * * *", "* * *", "* * * * * *", "1- * * * *", "a * * * *", "*/0 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "5-1 * * * *", "0 0 * * 8", ",1 * * * *"])(
    "rejects %s with the RTN-06 message",
    (expr) => expect(() => parseCron(expr)).toThrow("Enter a valid schedule"),
  );

  it("keeps the RTN-05 aliases", () => {
    expect(ALIASES["@hourly"]).toBe("0 * * * *");
    expect(ALIASES["@daily"]).toBe("0 0 * * *");
    expect(ALIASES["@midnight"]).toBe("0 0 * * *");
    expect(ALIASES["@weekly"]).toBe("0 0 * * 0");
    expect(ALIASES["@monthly"]).toBe("0 0 1 * *");
    expect(ALIASES["@yearly"]).toBe("0 0 1 1 *");
    expect(ALIASES["@annually"]).toBe("0 0 1 1 *");
  });
});

describe("cronMatches", () => {
  it("uses Vixie OR when both day fields are restricted", () => {
    const c = parseCron("0 9 1 * 1");
    expect(cronMatches(c, at(2026, 9, 7, 9, 0))).toBe(true); // Monday the 7th
    expect(cronMatches(c, at(2026, 10, 1, 9, 0))).toBe(true); // Thursday the 1st
    expect(cronMatches(c, at(2026, 10, 2, 9, 0))).toBe(false);
  });
  it("uses AND when either day field is a star", () => {
    const c = parseCron("0 9 * * 1");
    expect(cronMatches(c, at(2026, 9, 7, 9, 0))).toBe(true);
    expect(cronMatches(c, at(2026, 10, 1, 9, 0))).toBe(false);
    expect(cronMatches(c, at(2026, 9, 7, 9, 1))).toBe(false);
  });
});

describe("describeCron (RTN-05 prose)", () => {
  it.each([
    ["0 8 * * *", "Every day at 8:00 AM"],
    ["0 9 * * 1-5", "Weekdays at 9:00 AM"],
    ["30 9 * * 1-5", "Weekdays at 9:30 AM"],
    ["0 10 * * 0,6", "Weekends at 10:00 AM"],
    ["0 18 * * 1,4", "Every Monday and Thursday at 6:00 PM"],
    ["0 7 * * 1,3,5", "Every Monday, Wednesday and Friday at 7:00 AM"],
    ["32 * * * *", "Every hour at :32"],
    ["0 * * * *", "Every hour"],
    ["0 9-17/2 * * 1-5", "Every 2 hours, 9:00 AM – 5:00 PM on weekdays"],
    ["0 9-17 * * 1-5", "Every hour, 9:00 AM – 5:00 PM on weekdays"],
    ["0 9,17 * * *", "Every day at 9:00 AM and 5:00 PM"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["0 9 1 * *", "On the 1st of every month at 9:00 AM"],
    ["0 8 1,15 * *", "On the 1st and 15th of every month at 8:00 AM"],
    ["0 9 1 1 *", "Every year on January 1 at 9:00 AM"],
    ["0 0 * * *", "Every day at 12:00 AM"],
    ["0 12 * * *", "Every day at 12:00 PM"],
    ["0 9 1 * 1", "Custom schedule"],
  ])("%s → %s", (expr, text) => expect(describeCron(parseCron(expr))).toBe(text));

  it("formats times in 12-hour clock", () => {
    expect(formatTime(0, 5)).toBe("12:05 AM");
    expect(formatTime(12, 0)).toBe("12:00 PM");
    expect(formatTime(23, 59)).toBe("11:59 PM");
  });
});
