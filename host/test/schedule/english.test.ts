import { describe, expect, it } from "vitest";
import { StubOneShot } from "../../helper-model/one-shot";
import { parseEnglish } from "../../schedule/english";
import { formatSavedResult, normalizeSchedule } from "../../schedule/normalize";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const NOW = Date.UTC(2026, 8, 19, 19, 0); // Sat 2026-09-19 12:00 PDT / 15:00 EDT
const o = { tz: NY, nowMs: NOW };
const MONTHLY_LAST_WEEKDAY = "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0";

// ORIG-03 §03.2 table (rows 1–16) followed by 44 more grammar phrasings = the 60 grammar cases of the §03.7 golden corpus.
const GRAMMAR: [string, string][] = [
  ["every day at 8am", "0 8 * * *"],
  ["weekdays at 9:30", "30 9 * * 1-5"],
  ["every monday and thursday at 6pm", "0 18 * * 1,4"],
  ["every hour", "0 * * * *"],
  ["every hour at :32", "32 * * * *"],
  ["every 15 minutes", "*/15 * * * *"],
  ["every 2 hours from 9 to 5 on weekdays", "0 9-17/2 * * 1-5"],
  ["every 90 minutes", "@every 90m"],
  ["on the 1st of every month at 9am", "0 9 1 * *"],
  ["every other tuesday at 9am", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=9;BYMINUTE=0"],
  ["last weekday of the month at 5pm", MONTHLY_LAST_WEEKDAY],
  ["first monday of every month at 10", "RRULE:FREQ=MONTHLY;BYDAY=1MO;BYHOUR=10;BYMINUTE=0"],
  ["every 3 days at noon", "RRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=12;BYMINUTE=0"],
  ["on the last day of each month at 23:00", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=23;BYMINUTE=0"],
  ["every weekday at 9am Tokyo time", "CRON_TZ=Asia/Tokyo 0 9 * * 1-5"],
  ["every minute", "* * * * *"],
  ["Every Day At 8 AM", "0 8 * * *"],
  ["daily at 7:15", "15 7 * * *"],
  ["every day at midnight", "0 0 * * *"],
  ["every day at noon", "0 12 * * *"],
  ["every day at 12am", "0 0 * * *"],
  ["every day at 12pm", "0 12 * * *"],
  ["every day at 09:30", "30 9 * * *"],
  ["every day at 9am and 5pm", "0 9,17 * * *"],
  ["every weekday at 8:45am", "45 8 * * 1-5"],
  ["weekends at 10am", "0 10 * * 0,6"],
  ["every saturday at 11pm", "0 23 * * 6"],
  ["every sunday at 6:30pm", "30 18 * * 0"],
  ["mondays at 9am", "0 9 * * 1"],
  ["every mon, wed and fri at 7am", "0 7 * * 1,3,5"],
  ["every tue and thu at 14:00", "0 14 * * 2,4"],
  ["at 9am every day", "0 9 * * *"],
  ["at 6pm on weekdays", "0 18 * * 1-5"],
  ["every 5 minutes", "*/5 * * * *"],
  ["every 30 minutes", "*/30 * * * *"],
  ["every 10 minutes", "*/10 * * * *"],
  ["every 45 minutes", "@every 45m"],
  ["every 2 hours", "0 */2 * * *"],
  ["every 6 hours", "0 */6 * * *"],
  ["every 5 hours", "@every 5h"],
  ["every hour from 9 to 5 on weekdays", "0 9-17 * * 1-5"],
  ["every 3 hours from 8am to 8pm", "0 8-20/3 * * *"],
  ["every 2 hours at :15", "15 */2 * * *"],
  ["every 120 minutes", "0 */2 * * *"],
  ["on the 15th of every month at 9am", "0 9 15 * *"],
  ["the 1st and 15th of each month at 8am", "0 8 1,15 * *"],
  ["on the last day of the month at 6pm", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=18;BYMINUTE=0"],
  ["first weekday of the month at 9am", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;BYHOUR=9;BYMINUTE=0"],
  ["last friday of every month at 4pm", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=16;BYMINUTE=0"],
  ["second tuesday of each month at 10am", "RRULE:FREQ=MONTHLY;BYDAY=2TU;BYHOUR=10;BYMINUTE=0"],
  ["the first day of every month at 9am", "0 9 1 * *"],
  ["every other day at 8am", "RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=8;BYMINUTE=0"],
  ["every 2 weeks on friday at 3pm", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=15;BYMINUTE=0"],
  ["every 1 day at 9am", "0 9 * * *"],
  ["every year on january 1 at 9am", "0 9 1 1 *"],
  ["every december 25 at 8am", "0 8 25 12 *"],
  ["every day at 9am utc", "CRON_TZ=UTC 0 9 * * *"],
  ["weekdays at 9am london time", "CRON_TZ=Europe/London 0 9 * * 1-5"],
  ["every day at 7am in America/Chicago", "CRON_TZ=America/Chicago 0 7 * * *"],
  ["every monday at 9am new york time", "CRON_TZ=America/New_York 0 9 * * 1"],
];

// The 20 must-be-ambiguous phrases of the §03.7 corpus.
const AMBIGUOUS = [
  "every day", "every monday", "weekdays", "daily", "weekly", "monthly", "every other week", "twice a day", "three times a day",
  "every few hours", "every morning", "in the afternoon", "regularly", "sometimes", "at 9", "tomorrow at 9", "on the 1st",
  "a couple of times a week", "every hour or two", "before lunch",
];

describe("parseEnglish grammar (ORIG-03 §03.2)", () => {
  it("has 60 grammar cases", () => expect(GRAMMAR).toHaveLength(60));
  it.each(GRAMMAR)("%s → %s", (text, schedule) => expect(parseEnglish(text, o)).toEqual({ schedule }));
  it("has 20 ambiguous cases", () => expect(AMBIGUOUS).toHaveLength(20));
  it.each(AMBIGUOUS)("%s → a question for the user", (text) => {
    const r = parseEnglish(text, o);
    expect(r && "ambiguity" in r && r.ambiguity.endsWith("?")).toBe(true);
  });
  it("returns null for phrasings it doesn't know (→ model fallback)", () => {
    expect(parseEnglish("every weekday morning at 7:30", o)).toBeNull();
    expect(parseEnglish("quarter past nine on weekdays", o)).toBeNull();
  });
});

describe("normalizeSchedule (ORIG-03 §03.1, RTN-06)", () => {
  it("normalizes cron and reports description, raw form and the next three runs; saving never runs it", async () => {
    const at805 = Date.UTC(2026, 8, 19, 12, 5);
    const n = await normalizeSchedule("every day at 8am", { tz: NY, nowMs: at805, model: null });
    expect(n).toMatchObject({ schedule: "0 8 * * *", description: "Every day at 8:00 AM", raw: "CRON_TZ=America/New_York 0 8 * * *", tz: NY });
    expect(n.nextRuns).toEqual([Date.UTC(2026, 8, 20, 12, 0), Date.UTC(2026, 8, 21, 12, 0), Date.UTC(2026, 8, 22, 12, 0)]);
  });
  it("stores RRULE with the host-set DTSTART and prints the §03.1 block exactly", async () => {
    const n = await normalizeSchedule("last weekday of the month at 5pm", { tz: LA, nowMs: NOW, model: null });
    expect(n.schedule).toBe(`${MONTHLY_LAST_WEEKDAY};X-DTSTART=2026-09-30T17:00`);
    expect(formatSavedResult("Pay-period check", true, n)).toBe(
      [
        'Saved routine "Pay-period check" (active).',
        `Schedule: ${MONTHLY_LAST_WEEKDAY}`,
        "Runs: Last weekday of each month at 5:00 PM (America/Los_Angeles)",
        "Next runs: Wed Sep 30 5:00 PM · Fri Oct 30 5:00 PM · Mon Nov 30 5:00 PM",
      ].join("\n"),
    );
  });
  it("keeps a pinned zone once and says paused for inactive routines", async () => {
    const n = await normalizeSchedule("every weekday at 9am Tokyo time", { tz: NY, nowMs: NOW, model: null });
    expect(n).toMatchObject({ schedule: "CRON_TZ=Asia/Tokyo 0 9 * * 1-5", description: "Weekdays at 9:00 AM (Asia/Tokyo)", tz: "Asia/Tokyo" });
    expect(formatSavedResult("Standup", false, n).split("\n").slice(0, 3)).toEqual([
      'Saved routine "Standup" (paused).', "Schedule: CRON_TZ=Asia/Tokyo 0 9 * * 1-5", "Runs: Weekdays at 9:00 AM (Asia/Tokyo)",
    ]);
  });
  it("accepts machine syntax as-is", async () => {
    expect((await normalizeSchedule("@every 90m", { ...o, model: null })).description).toBe("Every 90 minutes");
    expect((await normalizeSchedule("CRON_TZ=Europe/Paris 30 7 * * 1-5", { ...o, model: null })).raw).toBe("CRON_TZ=Europe/Paris 30 7 * * 1-5");
  });
  it.each(["every minute", "*/2 * * * *", "@every 4m"])("rejects %s with the spacing message", async (s) => {
    await expect(normalizeSchedule(s, { ...o, model: null })).rejects.toThrow("Leave 5 minutes or more between a routine's runs");
  });
  it.each(["", "61 * * * *", "CRON_TZ=Mars/Base 0 8 * * *", "0 0 30 2 *"])("rejects %j as invalid", async (s) => {
    await expect(normalizeSchedule(s, { ...o, model: null })).rejects.toThrow("Enter a valid schedule");
  });
  it("turns an ambiguous phrase into the exact question message and saves nothing", async () => {
    await expect(normalizeSchedule("every day", { ...o, model: null })).rejects.toThrow(
      'Enter a valid schedule — "every day" is ambiguous: it leaves out the time of day. Ask the user: What time of day should it run?',
    );
  });
});

describe("model fallback (ORIG-03 §03.3)", () => {
  const stub = (out: unknown) => new StubOneShot({ "orig/schedule-parser.md": () => out });
  it("uses the model only when the grammar fails, with today and the zone in the input", async () => {
    const model = stub({ schedule: "30 7 * * 1-5", timezone: null, confidence: 0.93, ambiguity: null });
    const n = await normalizeSchedule("every weekday morning at 7:30", { ...o, model });
    expect(n.schedule).toBe("30 7 * * 1-5");
    expect(model.calls).toEqual([{ prompt: "orig/schedule-parser.md", input: { text: "every weekday morning at 7:30", today: "2026-09-19", tz: NY } }]);
    await normalizeSchedule("every day at 8am", { ...o, model });
    expect(model.calls).toHaveLength(1);
  });
  it("pins a zone the model names", async () => {
    const n = await normalizeSchedule("quarter past nine on weekdays in Sydney", { ...o, model: stub({ schedule: "15 9 * * 1-5", timezone: "Australia/Sydney", confidence: 0.9, ambiguity: null }) });
    expect(n.schedule).toBe("CRON_TZ=Australia/Sydney 15 9 * * 1-5");
  });
  it("rejects low confidence, unparseable output, model errors and a missing model", async () => {
    const text = "quarter past nine on weekdays";
    await expect(normalizeSchedule(text, { ...o, model: stub({ schedule: "15 9 * * 1-5", timezone: null, confidence: 0.79, ambiguity: null }) })).rejects.toThrow("Enter a valid schedule");
    await expect(normalizeSchedule(text, { ...o, model: stub({ schedule: "whenever", timezone: null, confidence: 0.99, ambiguity: null }) })).rejects.toThrow("Enter a valid schedule");
    await expect(normalizeSchedule(text, { ...o, model: new StubOneShot({ "orig/schedule-parser.md": () => { throw new Error("timeout"); } }) })).rejects.toThrow("Enter a valid schedule");
    await expect(normalizeSchedule(text, { ...o, model: null })).rejects.toThrow("Enter a valid schedule");
  });
  it("passes the model's question through", async () => {
    const model = stub({ schedule: "", timezone: null, confidence: 0.2, ambiguity: "Which days of the week?" });
    await expect(normalizeSchedule("on paydays at 9", { ...o, model })).rejects.toThrow(
      'Enter a valid schedule — "on paydays at 9" is ambiguous: the wording can be read more than one way. Ask the user: Which days of the week?',
    );
  });
});
