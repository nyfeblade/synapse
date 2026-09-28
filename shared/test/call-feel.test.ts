import { describe, expect, it } from "vitest";
import { CALL_FEEL, callSeats, greetingClaimReason, greetingRejectReason, isGenericGreeting, seatAzimuths, STRV, timeOfDay } from "../src/index";

describe("calls feel like calling teammates: shared pieces (bug 134)", () => {
  it("time of day: morning 5–11, afternoon 12–17, evening otherwise (never 'morning' at 2 a.m.)", () => {
    expect([5, 11, 12, 17, 18, 23, 0, 2, 4].map(timeOfDay)).toEqual(["morning", "morning", "afternoon", "afternoon", "evening", "evening", "evening", "evening", "evening"]);
  });

  it("seats (bug 213): 1 Bot centre, 2 at ±30°, 3 at -40/0/+40, spreading to ±60° for 6; order stable, joiner where voices move least", () => {
    expect(seatAzimuths(1)).toEqual([0]);
    expect(seatAzimuths(2)).toEqual([-30, 30]);
    expect(seatAzimuths(3)).toEqual([-40, 0, 40]);
    for (let n = 2; n <= 6; n++) {
      const a = seatAzimuths(n);
      expect(a).toHaveLength(n);
      for (let i = 1; i < n; i++) expect(a[i]!).toBeGreaterThan(a[i - 1]!); // left to right
      expect(a[0]).toBeCloseTo(-a[n - 1]!); // symmetric
      expect(Math.abs(a[0]!)).toBeLessThanOrEqual(60);
    }
    expect(seatAzimuths(6)[0]).toBe(-60);
    // 1 → 2: the joiner sits on the right; 2 → 3: between the two, so each existing voice moves 10°, not 30°.
    const one = callSeats(["a"]);
    expect(one.order).toEqual(["a"]);
    expect(one.azimuth).toEqual({ a: 0 });
    const two = callSeats(["a", "b"], one.order);
    expect(two.order).toEqual(["a", "b"]);
    expect(two.azimuth).toEqual({ a: -30, b: 30 });
    const three = callSeats(["a", "b", "c"], two.order);
    expect(three.order).toEqual(["a", "c", "b"]);
    expect(three.azimuth).toEqual({ a: -40, c: 0, b: 40 });
    // Someone leaves: the others keep their left-to-right order.
    expect(callSeats(["a", "b"], three.order).order).toEqual(["a", "b"]);
    expect(callSeats(["c", "b"], three.order).order).toEqual(["c", "b"]);
    // Every join order to 6: existing Bots never swap sides of each other, and the order holds everyone once.
    const ids = ["a", "b", "c", "d", "e", "f"];
    let order: string[] = [];
    for (let n = 1; n <= 6; n++) {
      const s = callSeats(ids.slice(0, n), order);
      expect([...s.order].sort()).toEqual(ids.slice(0, n));
      const kept = s.order.filter((x) => order.includes(x));
      expect(kept).toEqual(order);
      expect(s.order.map((x) => s.azimuth[x])).toEqual(seatAzimuths(n));
      order = s.order;
    }
    // A call that starts with its whole group: the roster order, left to right.
    expect(callSeats(["x", "y", "z"]).order).toEqual(["x", "y", "z"]);
  });

  it("the stock greetings cover every time of day, use the user's name when known, and are short enough (~2 s)", () => {
    for (const user of ["Alex", null]) {
      const g = STRV.stockGreetings(user);
      expect(g.length).toBeGreaterThanOrEqual(CALL_FEEL.greetingsMin);
      for (const w of ["morning", "afternoon", "evening"] as const) expect(g.some((x) => x.when === w)).toBe(true);
      for (const x of g) {
        expect(x.text.split(/\s+/).length).toBeLessThanOrEqual(CALL_FEEL.greetingMaxWords);
        expect(x.text.length).toBeLessThanOrEqual(CALL_FEEL.greetingMaxChars);
      }
      expect(g.some((x) => x.text.includes("Alex"))).toBe(user !== null);
    }
  });
});

// Bug 151: a call opened with "Hi, I've drafted three replies for you." — a claim about work, not a
// greeting. The prompt asks for greetings only; this is the check that makes sure of it in code.
describe("a greeting is a greeting (bug 151)", () => {
  const BAD: [string, RegExp][] = [
    ["Hi, I've drafted three replies for you.", /work|count|I've/i], // the user's exact line
    ["Hey Alex, I finished the report.", /work/],
    ["Morning! I sent those emails.", /work/],
    ["Hi, your inbox is quiet today.", /user's things/],
    ["Hey, I found 2 things.", /count|number/],
    ["Hi! Here's where we left off.", /here's/],
    ["Hey, main.ts is failing.", /file/],
    ["Morning, check ~/Downloads first.", /path/],
    ["Hi, I have news.", /I have/],
    ["Hey, I ran the tests.", /work/],
    ["Hi, I've updated it.", /work|I've/i],
    ["Hey, I booked that for 3pm.", /work|count|number/],
    ["Hi, I'm your AI assistant.", /AI/],
    ["Hey 👋", /emoji/],
    ["Hello there, it is truly wonderful to hear from you again today", /long|words/],
  ];

  it("rejects claims about work, counts, files, paths, status and memory — with the reason", () => {
    for (const [text, why] of BAD) {
      const reason = greetingRejectReason(text);
      expect(reason, `should have rejected: ${text}`).toBeTruthy();
      expect(reason!, `wrong reason for: ${text}`).toMatch(why);
      expect(isGenericGreeting(text)).toBe(false);
    }
    expect(greetingRejectReason("")).toBe("empty");
    expect(greetingRejectReason(undefined)).toBe("not text");
  });

  it("keeps plain greetings: a hello, the name, the time of day, a short open question", () => {
    const GOOD = [
      "Hey!", "Hi there!", "Hey Alex, what's up?", "Oh hey, good to hear you.", "Morning! What are we doing?",
      "Evening, Alex.", "Hi, go ahead.", "Yo! What's up?", "Hey, I'm listening.", "Afternoon! How's it going?",
      "Nova here. Go.", "Alex! Talk to me.", "Hey, what do you need?",
    ];
    for (const text of GOOD) expect(greetingRejectReason(text), `should have kept: ${text}`).toBeNull();
  });

  it("the built-in set the app falls back to passes its own check", () => {
    for (const user of ["Alex", null]) for (const g of STRV.stockGreetings(user)) expect(greetingRejectReason(g.text), g.text).toBeNull();
  });

  // The user's own style target: warm human small talk, a little personality, no status.
  it("the style the user asked for passes: ordinary greetings, a light aside, a generic open question", () => {
    const STYLE = [
      "Hello!", "Good morning", "You called?", "What can I do for you?", "Did you get your coffee this morning?",
      "How are you today?", "Ready to tackle your next project?", "I'd make you breakfast, but I can't.",
      "How's your day treating you?", "I'd wave, but you'd never see it.",
    ];
    for (const text of STYLE) expect(greetingRejectReason(text), text).toBeNull();
  });

  it("the built-in set is that style: a hello, an open question, an aside, and short ones for a Bot joining mid-call", () => {
    const g = STRV.stockGreetings("Alex");
    expect(g.length).toBeGreaterThanOrEqual(CALL_FEEL.greetingsMin);
    expect(g.some((x) => x.text === "Hello!")).toBe(true);
    expect(g.some((x) => x.text.endsWith("?") && !x.when)).toBe(true);
    expect(g.some((x) => /breakfast/.test(x.text))).toBe(true); // a little humour, no status
    // A Bot added mid-call says a short any-time one: there have to be some.
    expect(g.filter((x) => !x.when && x.text.split(/\s+/).length <= 4).length).toBeGreaterThanOrEqual(3);
  });

  it("every other line a call says by itself is left alone by the claim check (the Mac purges by it)", () => {
    for (const line of [...STRV.fillers, ...STRV.sorryLines, ...STRV.longTaskLines, ...STRV.goodbyes]) {
      expect(greetingClaimReason(line), line).toBeNull();
    }
  });
});
