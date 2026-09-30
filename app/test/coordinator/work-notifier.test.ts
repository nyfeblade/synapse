import { describe, expect, it } from "vitest";
import { HEALTH_LIMITS } from "@synapse/shared";
import { WorkNotifier, type WorkNotice } from "../../src/coordinator/work-notifier";

function setup() {
  let t = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const sent: WorkNotice[] = [];
  const w = new WorkNotifier({
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
    notify: (n) => sent.push(n),
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = end;
  };
  const fin = (botId: string, name: string, summary: string, telegram = false) => w.onFinished({ botId, name, summary, telegram });
  return { w, sent, advance, fin };
}

describe("work-finished notifications in the coordinator (4.4)", () => {
  it("not for the chat the owner is looking at; yes for another chat, or when the app isn't focused", () => {
    const s = setup();
    s.w.setFocused(true);
    s.w.setActiveBot("b1");
    s.fin("b1", "Courier", "Sent all 5.");
    s.advance(HEALTH_LIMITS.workCoalesceMs);
    expect(s.sent).toEqual([]);
    s.fin("b2", "Nova", "Booked it.");
    s.advance(HEALTH_LIMITS.workCoalesceMs);
    expect(s.sent).toEqual([{ botId: "b2", title: "Nova finished", body: "Booked it.", kind: "finished", telegram: null }]);
    s.w.setFocused(false);
    s.advance(HEALTH_LIMITS.workMinGapMs);
    s.fin("b1", "Courier", "Sent all 5.");
    s.advance(HEALTH_LIMITS.workCoalesceMs);
    expect(s.sent.at(-1)).toMatchObject({ botId: "b1", title: "Courier finished", body: "Sent all 5." });
  });

  it("opening the chat before it goes out drops it", () => {
    const s = setup();
    s.w.setFocused(false);
    s.fin("b1", "Courier", "Done.");
    s.w.setFocused(true);
    s.w.setActiveBot("b1");
    s.advance(HEALTH_LIMITS.workCoalesceMs);
    expect(s.sent).toEqual([]);
  });

  it("a burst becomes one notification, and later ones wait for the gap", () => {
    const s = setup();
    s.w.setFocused(false);
    s.fin("b1", "Courier", "A");
    s.fin("b2", "Nova", "B");
    s.fin("b3", "Scout", "C");
    s.fin("b1", "Courier", "A2"); // the same Bot again: its newest word
    s.advance(HEALTH_LIMITS.workCoalesceMs);
    expect(s.sent).toEqual([{ botId: "b1", title: "3 Bots finished", body: "Nova, Scout, Courier", kind: "finished", telegram: null }]);
    for (let i = 0; i < 10; i++) { s.fin(`c${i}`, `C${i}`, "x"); s.advance(500); }
    expect(s.sent).toHaveLength(1);
    s.advance(HEALTH_LIMITS.workMinGapMs);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.title).toBe("10 Bots finished");
  });

  it("carries the Telegram line only for what the owner opted in", () => {
    const s = setup();
    s.w.setFocused(false);
    s.fin("b1", "Courier", "Sent all 5.", true);
    s.advance(HEALTH_LIMITS.workCoalesceMs);
    expect(s.sent[0]!.telegram).toBe("Courier finished: Sent all 5.");
  });

  it("a deleted Bot's pending notice goes with it", () => {
    const s = setup();
    s.w.setFocused(false);
    s.fin("b1", "Courier", "x");
    s.w.remove("b1");
    s.advance(HEALTH_LIMITS.workCoalesceMs);
    expect(s.sent).toEqual([]);
  });
});
