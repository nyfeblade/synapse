// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CALL_FEEL, STRV } from "@synapse/shared";
import { ShuffleBag, drawnGreetings, phraseBags, pickGreeting, recentGreetings, takeGreeting } from "../../src/renderer/voice/call-phrases";

// Bug 134: greetings rotate (never one of the last 3), vary by time of day, and a joining Bot says a
// short one; fillers and the other stock lines come out of shuffle bags (no repeat back to back).

const SET = [
  { text: "Hey!" }, { text: "Hey Alex, what's up?" }, { text: "Nova here. Go." }, { text: "Alex! Talk to me." }, { text: "Hi, I'm all ears." },
  { text: "Yo, what's the plan today?" }, { text: "What's cooking?" }, { text: "Oh hey, Alex." }, { text: "Hi there, go ahead." },
  { text: "Morning, Alex! Coffee yet?", when: "morning" as const }, { text: "Early start, huh?", when: "morning" as const },
  { text: "Afternoon! What's up?", when: "afternoon" as const }, { text: "Hey Alex, good afternoon.", when: "afternoon" as const },
  { text: "Evening, Alex.", when: "evening" as const }, { text: "Working late? I'm here.", when: "evening" as const },
];

describe("pick-up greetings", () => {
  afterEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });

  it("only this time of day's (or any-time ones), never one of the last 3", () => {
    for (let i = 0; i < 200; i++) {
      const t = pickGreeting(SET, { hour: 9, recent: ["Hey!", "What's cooking?", "Nova here. Go."] })!;
      expect(["Hey!", "What's cooking?", "Nova here. Go."]).not.toContain(t);
      expect(SET.find((g) => g.text === t)!.when ?? "morning").toBe("morning");
    }
    const evening = new Set(Array.from({ length: 300 }, () => pickGreeting(SET, { hour: 21, recent: [] })));
    expect(evening.has("Evening, Alex.")).toBe(true);
    expect(evening.has("Morning, Alex! Coffee yet?")).toBe(false);
  });

  it("a shuffle bag (bug 151): every greeting for this hour is said once before any comes back, never within 3 calls", () => {
    const seen: string[] = [];
    const pool = SET.filter((g) => !g.when || g.when === "afternoon").map((g) => g.text);
    for (let i = 0; i < 60; i++) {
      const t = takeGreeting("nova", SET, { now: new Date(2026, 8, 22, 14, 0) })!;
      expect(seen.slice(-CALL_FEEL.greetingNoRepeat)).not.toContain(t);
      seen.push(t);
    }
    // The whole afternoon pool is used, and each pass through the bag says each one once.
    expect(new Set(seen).size).toBe(pool.length);
    for (const t of seen) expect(pool).toContain(t);
    const counts = pool.map((t) => seen.filter((x) => x === t).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(recentGreetings("nova")).toEqual(seen.slice(-3));
  });

  it("each time of day keeps its own bag: the morning greetings still come back in turn", () => {
    for (let i = 0; i < 6; i++) takeGreeting("nova", SET, { now: new Date(2026, 8, 22, 14, 0) });
    const pool = SET.filter((g) => !g.when || g.when === "morning").map((g) => g.text);
    const morning = Array.from({ length: pool.length }, () => takeGreeting("nova", SET, { now: new Date(2026, 8, 22, 9, 0) })!);
    expect(morning).toContain("Morning, Alex! Coffee yet?");
    expect(morning).toContain("Early start, huh?");
    expect(morning.every((t) => pool.includes(t))).toBe(true); // never an afternoon or evening one
    // …and the afternoon bag picked up where it left off: its 6 spent greetings are still spent.
    const afternoon = Array.from({ length: 5 }, () => takeGreeting("nova", SET, { now: new Date(2026, 8, 22, 14, 0) })!);
    expect(new Set(afternoon).size).toBe(5);
  });

  it("the bag survives a restart: the greeting drawn last is not the first one back", () => {
    const first = takeGreeting("nova", SET, { now: new Date(2026, 8, 22, 14, 0) })!;
    expect(drawnGreetings("nova")).toEqual([first]);
    const next = Array.from({ length: 3 }, () => takeGreeting("nova", SET, { now: new Date(2026, 8, 22, 14, 0) })!);
    expect(next).not.toContain(first);
  });

  it("a Bot joining mid-call says a short any-time one", () => {
    for (let i = 0; i < 50; i++) {
      const t = pickGreeting(SET, { hour: 9, recent: [], joining: true })!;
      expect(t.split(" ").length).toBeLessThanOrEqual(4);
      expect(SET.find((g) => g.text === t)!.when).toBeUndefined();
    }
  });

  it("the stock set works the same way (a Bot that hasn't authored its own yet)", () => {
    const t = pickGreeting(STRV.stockGreetings("Alex"), { hour: 8, recent: [] });
    expect(t).toBeTruthy();
  });
});

describe("shuffle bags", () => {
  it("every item once before any repeats, never twice in a row across refills", () => {
    const bag = new ShuffleBag(["a", "b", "c", "d"]);
    const out = Array.from({ length: 40 }, () => bag.next()!);
    for (let i = 0; i < 40; i += 4) expect(new Set(out.slice(i, i + 4)).size).toBe(4);
    for (let i = 1; i < 40; i++) expect(out[i]).not.toBe(out[i - 1]);
  });

  it("per kind and per Bot", () => {
    const b = phraseBags();
    const f = Array.from({ length: STRV.fillers.length }, () => b.next("filler", "nova"));
    expect(new Set(f).size).toBe(STRV.fillers.length);
    expect(STRV.sorryLines).toContain(b.next("sorry", "nova"));
    expect(STRV.longTaskLines).toContain(b.next("long-task", "ledger"));
  });
});
