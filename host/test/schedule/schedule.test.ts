import { describe, expect, it } from "vitest";
import { cronMatches, parseCron } from "../../schedule/cron";
import { describeSchedule, effectiveZone, nextRunAfter, nextRuns, parseSchedule, rawSchedule } from "../../schedule/schedule";
import { checkGroupSpacing, checkSpacing } from "../../schedule/spacing";
import { localParts } from "../../schedule/zone";

const NY = "America/New_York";
const NOW = Date.UTC(2026, 8, 19, 16, 0); // Sat 2026-09-19 12:00 EDT
const P = (s: string, tz = NY, nowMs = NOW) => parseSchedule(s, { tz, nowMs });

describe("parseSchedule (RTN-05)", () => {
  it("reads cron, aliases, @every, RRULE and a pinned zone", () => {
    expect(P("0 8 * * *")).toMatchObject({ kind: "cron", tz: null, expr: "0 8 * * *" });
    expect(P("@daily")).toMatchObject({ kind: "cron", expr: "@daily" });
    expect(P("@every 90m")).toEqual({ kind: "every", everyMs: 90 * 60_000, expr: "@every 90m" });
    expect(P("CRON_TZ=Asia/Tokyo 0 9 * * 1-5")).toMatchObject({ kind: "cron", tz: "Asia/Tokyo", expr: "0 9 * * 1-5" });
    expect(P("TZ=Europe/London 0 9 * * *")).toMatchObject({ tz: "Europe/London" });
    expect(P("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0").expr).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0;X-DTSTART=2026-09-22T09:00");
  });
  it.each(["", "@sometimes", "@every 0m", "@every 5x", "CRON_TZ=Mars/Base 0 8 * * *", "every day"])("rejects %j", (s) => expect(() => P(s)).toThrow("Enter a valid schedule"));
  it("pins beat the Bot zone; @every has none", () => {
    expect(effectiveZone(P("CRON_TZ=Asia/Tokyo 0 9 * * *"), NY)).toBe("Asia/Tokyo");
    expect(effectiveZone(P("0 9 * * *"), NY)).toBe(NY);
    expect(effectiveZone(P("@every 2h"), NY)).toBe(NY);
  });
});

describe("nextRunAfter (RTN-07)", () => {
  it("never runs on save: saving 'every day at 8:00' at 8:05 first runs tomorrow (RTN-06)", () => {
    const at805 = Date.UTC(2026, 8, 19, 12, 5);
    expect(nextRunAfter(P("0 8 * * *"), at805, NY)).toBe(Date.UTC(2026, 8, 20, 12, 0));
  });
  it("uses a pinned zone", () => {
    expect(nextRunAfter(P("CRON_TZ=Asia/Tokyo 0 9 * * 1-5"), NOW, NY)).toBe(Date.UTC(2026, 8, 21, 0, 0)); // Mon 09:00 JST
  });
  it("steps @every from its anchor and ignores zones", () => {
    const anchor = Date.UTC(2026, 8, 19, 10, 0);
    expect(nextRunAfter(P("@every 90m"), NOW, NY, anchor)).toBe(anchor + 5 * 90 * 60_000);
    expect(nextRunAfter(P("@every 90m"), NOW, NY)).toBe(NOW + 90 * 60_000);
  });
  it("returns null when nothing matches within 366 days", () => {
    expect(nextRunAfter(P("0 0 30 2 *"), NOW, NY)).toBeNull();
  });
  it("DST spring-forward: 0 2 * * * runs once, at 03:00 (ORIG-02 §02.9)", () => {
    const runs = nextRuns(P("0 2 * * *"), Date.UTC(2027, 2, 13, 12, 0), NY, 3);
    expect(runs.map((t) => localParts(t, NY))).toEqual([
      { y: 2027, mo: 3, d: 14, h: 3, mi: 0, dow: 0 },
      { y: 2027, mo: 3, d: 15, h: 2, mi: 0, dow: 1 },
      { y: 2027, mo: 3, d: 16, h: 2, mi: 0, dow: 2 },
    ]);
  });
  it("DST spring-forward: 0 2,3 * * * collapses the two into one 03:00 run", () => {
    const runs = nextRuns(P("0 2,3 * * *"), Date.UTC(2027, 2, 14, 5, 0), NY, 2);
    expect(runs).toEqual([Date.UTC(2027, 2, 14, 7, 0), Date.UTC(2027, 2, 15, 6, 0)]);
  });
  it("DST fall-back: 30 1 * * * runs once, at the first 01:30", () => {
    const runs = nextRuns(P("30 1 * * *"), Date.UTC(2026, 9, 31, 12, 0), NY, 2);
    expect(runs).toEqual([Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 2, 6, 30)]);
  });
  it("RRULE: last weekday of each month at 5 PM (Los Angeles)", () => {
    const la = "America/Los_Angeles";
    const runs = nextRuns(P("RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0", la), NOW, la, 3);
    expect(runs.map((t) => localParts(t, la)).map((l) => `${l.mo}/${l.d} ${l.h}:${l.mi}`)).toEqual(["9/30 17:0", "10/30 17:0", "11/30 17:0"]);
  });
  it("RRULE: COUNT and UNTIL end the series", () => {
    const counted = P("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=2;X-DTSTART=2026-09-20T09:00");
    expect(nextRuns(counted, NOW, NY, 5)).toHaveLength(2);
    const until = P("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260922T000000Z;X-DTSTART=2026-09-20T09:00");
    expect(nextRuns(until, NOW, NY, 5)).toHaveLength(2);
  });
  it("property: 2,000 random crons in 5 fixed-offset zones give strictly increasing runs that match the cron", () => {
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const zones = ["UTC", "Asia/Tokyo", "Asia/Kolkata", "Asia/Singapore", "America/Phoenix"];
    for (let i = 0; i < 2000; i++) {
      const minute = rnd(3) === 0 ? `${rnd(60)},${(rnd(60) + 30) % 60}` : String(rnd(60));
      const hour = rnd(4) === 0 ? "*" : rnd(2) === 0 ? String(rnd(24)) : `${rnd(12)}-${12 + rnd(12)}/${1 + rnd(4)}`;
      const dom = rnd(4) === 0 ? String(1 + rnd(28)) : "*";
      const dow = rnd(3) === 0 ? `${rnd(7)},${rnd(7)}` : "*";
      const expr = `${minute} ${hour} ${dom} * ${dow}`;
      const tz = zones[i % zones.length] as string;
      const from = NOW + rnd(400) * 3_600_000;
      const runs = nextRuns(P(expr, tz), from, tz, 5);
      expect(runs.length, expr).toBeGreaterThan(0);
      let prev = from;
      for (const t of runs) {
        expect(t, expr).toBeGreaterThan(prev);
        expect(cronMatches(parseCron(expr), localParts(t, tz)), `${expr} @ ${new Date(t).toISOString()} ${tz}`).toBe(true);
        prev = t;
      }
    }
  });
  it("property: in DST zones runs stay strictly increasing and never repeat", () => {
    for (const tz of [NY, "Europe/London", "Australia/Sydney"]) {
      const runs = nextRuns(P("*/30 0-3 * * *", tz), Date.UTC(2026, 0, 1), tz, 3000);
      for (let i = 1; i < runs.length; i++) expect(runs[i]).toBeGreaterThan(runs[i - 1] as number);
    }
  });
});

describe("describeSchedule and rawSchedule (RTN-05, C4)", () => {
  it.each([
    ["0 8 * * *", "Every day at 8:00 AM"],
    ["0 9 * * 1-5", "Weekdays at 9:00 AM"],
    ["32 * * * *", "Every hour at :32"],
    ["0 9-17/2 * * 1-5", "Every 2 hours, 9:00 AM – 5:00 PM on weekdays"],
    ["CRON_TZ=Asia/Tokyo 0 9 * * 1-5", "Weekdays at 9:00 AM (Asia/Tokyo)"],
    ["@every 90m", "Every 90 minutes"],
    ["@every 2h", "Every 2 hours"],
    ["@daily", "Every day at 12:00 AM"],
    ["RRULE:FREQ=MONTHLY;BYDAY=1MO;BYHOUR=10;BYMINUTE=0", "First Monday of each month at 10:00 AM"],
  ])("%s → %s", (s, text) => expect(describeSchedule(P(s), NY)).toBe(text));
  it("shows the raw expression with the effective zone", () => {
    expect(rawSchedule(P("0 8 * * *"), NY)).toBe("CRON_TZ=America/New_York 0 8 * * *");
    expect(rawSchedule(P("CRON_TZ=Asia/Tokyo 0 9 * * 1-5"), NY)).toBe("CRON_TZ=Asia/Tokyo 0 9 * * 1-5");
    expect(rawSchedule(P("@every 90m"), NY)).toBe("@every 90m");
    expect(rawSchedule(P("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0"), NY)).toBe("CRON_TZ=America/New_York RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0");
  });
});

describe("the 5-minute check (RTN-06, ORIG-03 §03.6)", () => {
  const from = Date.UTC(2027, 0, 1);
  it.each(["* * * * *", "*/2 * * * *", "0,3 * * * *", "58,1 * * * *", "@every 4m", "@every 299s"])("rejects %s", (s) =>
    expect(() => checkSpacing(P(s), NY, from)).toThrow("Leave 5 minutes or more between a routine's runs"),
  );
  it("rejects a pair that only DST brings together (1:59 EST → 3:00 EDT on 2027-03-14)", () => {
    expect(() => checkSpacing(P("0,59 1,3 * * *"), "UTC", from)).not.toThrow();
    expect(() => checkSpacing(P("0,59 1,3 * * *"), NY, from)).toThrow("Leave 5 minutes or more between a routine's runs");
  });
  it.each(["*/5 * * * *", "0 * * * *", "58,3 9 * * *", "@every 5m", "0 8 * * *", "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0,5"])("accepts %s", (s) =>
    expect(() => checkSpacing(P(s), NY, from)).not.toThrow(),
  );
  it("checks the merged stream of a group's schedule listeners", () => {
    expect(() => checkGroupSpacing([P("0 9 * * *"), P("0 17 * * *")], NY, from)).not.toThrow();
    expect(() => checkGroupSpacing([P("0 9 * * *"), P("2 9 * * *")], NY, from)).toThrow("Leave 5 minutes or more between a routine's runs");
    expect(() => checkGroupSpacing([P("0 9 * * *"), P("0 9 * * 1-5")], NY, from)).not.toThrow();
  });
});
