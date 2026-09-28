import { describe, expect, it } from "vitest";
import { describeRRule, formatRRule, parseRRule, rruleDayMatches, rruleOccurrencesOnDay } from "../../schedule/rrule";
import { instantOf, isValidZone, localParts, zoneLabel } from "../../schedule/zone";

const NY = "America/New_York";
const NOW = Date.UTC(2026, 8, 19, 16, 0); // Sat 2026-09-19 12:00 EDT
const day = (y: number, mo: number, d: number) => ({ y, mo, d });

describe("zone math (ORIG-03 §03.5)", () => {
  it("reads wall-clock parts in a zone", () => {
    expect(localParts(NOW, NY)).toEqual({ y: 2026, mo: 9, d: 19, h: 12, mi: 0, dow: 6 });
    expect(localParts(NOW, "Asia/Kolkata")).toEqual({ y: 2026, mo: 9, d: 19, h: 21, mi: 30, dow: 6 });
  });
  it("maps a normal local time to its instant", () => {
    expect(instantOf({ y: 2026, mo: 9, d: 19, h: 8, mi: 0 }, NY)).toBe(Date.UTC(2026, 8, 19, 12, 0));
    expect(instantOf({ y: 2026, mo: 9, d: 19, h: 21, mi: 30 }, "Asia/Kolkata")).toBe(NOW);
  });
  it("moves a time in the spring-forward gap to the first valid minute (02:30 → 03:00)", () => {
    expect(instantOf({ y: 2027, mo: 3, d: 14, h: 2, mi: 30 }, NY)).toBe(Date.UTC(2027, 2, 14, 7, 0));
    expect(instantOf({ y: 2027, mo: 3, d: 14, h: 2, mi: 0 }, NY)).toBe(Date.UTC(2027, 2, 14, 7, 0));
  });
  it("takes the first occurrence of a fall-back time", () => {
    expect(instantOf({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, NY)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });
  it("validates zones and labels them", () => {
    expect(isValidZone("Asia/Tokyo")).toBe(true);
    expect(isValidZone("Mars/Base")).toBe(false);
    expect(zoneLabel("Asia/Tokyo")).toBe("Asia/Tokyo");
  });
});

describe("RRULE subset (ORIG-03 §03.4)", () => {
  it("anchors DTSTART at the first matching time after now (every other Tuesday → next Tuesday)", () => {
    const r = parseRRule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0", NY, NOW);
    expect(r.dtstart).toEqual({ y: 2026, mo: 9, d: 22, h: 9, mi: 0, dow: 2 });
    expect(formatRRule(r)).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0;X-DTSTART=2026-09-22T09:00");
    expect(rruleDayMatches(r, day(2026, 9, 22))).toBe(true);
    expect(rruleDayMatches(r, day(2026, 9, 29))).toBe(false);
    expect(rruleDayMatches(r, day(2026, 10, 6))).toBe(true);
    expect(rruleDayMatches(r, day(2026, 9, 15))).toBe(false); // before DTSTART
  });
  it("round-trips the stored X-DTSTART form", () => {
    const text = "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0;X-DTSTART=2026-09-22T09:00";
    const r = parseRRule(text, NY, Date.UTC(2030, 0, 1));
    expect(r.dtstart).toEqual({ y: 2026, mo: 9, d: 22, h: 9, mi: 0, dow: 2 });
    expect(formatRRule(r)).toBe(text);
  });
  it("last weekday of the month uses BYSETPOS=-1", () => {
    const r = parseRRule("RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0", "America/Los_Angeles", NOW);
    expect(r.dtstart).toMatchObject({ y: 2026, mo: 9, d: 30, h: 17, mi: 0 });
    expect(rruleDayMatches(r, day(2026, 10, 30))).toBe(true);
    expect(rruleDayMatches(r, day(2026, 10, 31))).toBe(false);
    expect(rruleDayMatches(r, day(2027, 1, 29))).toBe(true);
    expect(describeRRule(r)).toBe("Last weekday of each month at 5:00 PM");
  });
  it("ordinal weekdays, negative month days and daily intervals", () => {
    const first = parseRRule("RRULE:FREQ=MONTHLY;BYDAY=1MO;BYHOUR=10;BYMINUTE=0", NY, NOW);
    expect(rruleDayMatches(first, day(2026, 10, 5))).toBe(true);
    expect(rruleDayMatches(first, day(2026, 10, 12))).toBe(false);
    expect(describeRRule(first)).toBe("First Monday of each month at 10:00 AM");
    const twoFour = parseRRule("RRULE:FREQ=MONTHLY;BYDAY=2TU,4TU;BYHOUR=12;BYMINUTE=0", NY, NOW);
    expect(rruleDayMatches(twoFour, day(2026, 10, 13))).toBe(true);
    expect(rruleDayMatches(twoFour, day(2026, 10, 27))).toBe(true);
    expect(rruleDayMatches(twoFour, day(2026, 10, 20))).toBe(false);
    expect(describeRRule(twoFour)).toBe("Second Tuesday and fourth Tuesday of each month at 12:00 PM");
    const last = parseRRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=23;BYMINUTE=0", NY, NOW);
    expect(rruleDayMatches(last, day(2027, 2, 28))).toBe(true);
    expect(rruleDayMatches(last, day(2026, 9, 30))).toBe(true);
    expect(describeRRule(last)).toBe("Last day of each month at 11:00 PM");
    const three = parseRRule("RRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=12;BYMINUTE=0", NY, NOW);
    expect(three.dtstart).toMatchObject({ y: 2026, mo: 9, d: 20, h: 12, mi: 0 }); // NOW is exactly noon: strictly after, so tomorrow (RTN-06: saving never runs it)
  });
  it("lists the day's times, never before DTSTART", () => {
    const r = parseRRule("RRULE:FREQ=DAILY;BYHOUR=9,18;BYMINUTE=0;X-DTSTART=2026-09-19T18:00", NY, NOW);
    expect(rruleOccurrencesOnDay(r, day(2026, 9, 19))).toEqual([{ h: 18, mi: 0 }]);
    expect(rruleOccurrencesOnDay(r, day(2026, 9, 20))).toEqual([{ h: 9, mi: 0 }, { h: 18, mi: 0 }]);
    expect(describeRRule(r)).toBe("Every day at 9:00 AM and 6:00 PM");
  });
  it("describes the §03.4 phrases", () => {
    const d = (s: string) => describeRRule(parseRRule(s, NY, NOW));
    expect(d("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0")).toBe("Every other Tuesday at 9:00 AM");
    expect(d("RRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=12;BYMINUTE=0")).toBe("Every 3 days at 12:00 PM");
    expect(d("RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=FR;BYHOUR=15;BYMINUTE=30")).toBe("Every 3 weeks on Friday at 3:30 PM");
    expect(d("RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0")).toBe("Every year on January 1 at 9:00 AM");
  });
  it.each([
    "RRULE:FREQ=HOURLY;BYHOUR=9;BYMINUTE=0",
    "RRULE:FREQ=DAILY;BYMINUTE=0",
    "RRULE:FREQ=WEEKLY;BYDAY=1MO;BYHOUR=9;BYMINUTE=0",
    "RRULE:FREQ=DAILY;BYWEEKNO=2;BYHOUR=9;BYMINUTE=0",
    "RRULE:FREQ=DAILY;BYHOUR=24;BYMINUTE=0",
    "RRULE:FREQ=MONTHLY;BYMONTHDAY=0;BYHOUR=9;BYMINUTE=0",
    "RRULE:FREQ=DAILY;INTERVAL=0;BYHOUR=9;BYMINUTE=0",
    "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;X-DTSTART=tomorrow",
  ])("rejects %s", (s) => expect(() => parseRRule(s, NY, NOW)).toThrow("Enter a valid schedule"));
});
