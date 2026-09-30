import { describe, expect, it } from "vitest";
import { HEALTH_LIMITS, type SseEvent, type WorkNotify } from "@synapse/shared";
import type { WakeSource } from "../../brain/types";
import type { SettledTurn } from "../../runner/observers";
import { WorkFinished, summarize } from "../../health/work-finished";

function setup(o: { mode?: WorkNotify; telegram?: boolean; notify?: boolean } = {}) {
  let t = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const sent: Extract<SseEvent, { channel: "work-finished" }>["payload"][] = [];
  const busy = new Set<string>();
  let mode: WorkNotify = o.mode ?? "on";
  const w = new WorkFinished({
    publish: (e) => { if (e.channel === "work-finished") sent.push(e.payload); },
    now: () => t, isIdle: (b) => !busy.has(b), setting: () => ({ mode, telegram: o.telegram ?? false }),
    bot: (id) => ({ name: id === "b1" ? "Courier" : "Nova", notify: o.notify ?? true }),
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
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
  const turn = (over: Partial<SettledTurn> & { source: WakeSource }, ms = 5_000): SettledTurn => {
    const s: SettledTurn = { botId: "b1", requestId: "r", lane: "user", hidden: false, startedAt: t, endedAt: t + ms, model: "m", userText: null, sentTexts: [], result: {} as never, ...over };
    t += ms;
    return s;
  };
  return { w, sent, busy, advance, turn, setMode: (m: WorkNotify) => { mode = m; } };
}

describe("work finished (4.4)", () => {
  it("a task the owner started notifies once it settles: '<Bot> finished: <short summary>'", () => {
    const s = setup();
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, sentTexts: ["**Sent all 5** emails.\nDetails below."] }));
    expect(s.sent).toHaveLength(0); // not yet: a nudge or a shell may follow
    s.advance(HEALTH_LIMITS.taskSettleMs);
    expect(s.sent).toEqual([{ botId: "b1", name: "Courier", summary: "Sent all 5 emails.", startedAt: 1_000_000, endedAt: 1_005_000, telegram: false }]);
  });

  it("never for heartbeats, routines that didn't ask, other Bots or silent wakes", () => {
    const s = setup();
    for (const source of ["heartbeat", "routine", "agent", "maintenance", "shell-done", "kickstart", "mcp", "group-member"] as WakeSource[]) {
      s.w.onSettled(s.turn({ source, ownerTask: false, sentTexts: ["Did a thing."] }));
    }
    s.advance(60_000);
    expect(s.sent).toEqual([]);
  });

  it("a scheduled run whose Bot asked to notify does notify", () => {
    const s = setup();
    s.w.onSettled(s.turn({ source: "routine", ownerTask: false, notifyRequested: true, sentTexts: ["Your flight moved to 9:40."] }));
    s.advance(HEALTH_LIMITS.taskSettleMs);
    expect(s.sent.map((x) => x.summary)).toEqual(["Your flight moved to 9:40."]);
  });

  it("one task across its turns: the reply nudge and the shell it waited on join it, and the last word is the summary", () => {
    const s = setup();
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, sentTexts: ["Starting the build."] }));
    s.advance(1_000);
    s.w.onEvent("b1"); // the Bot is working again
    s.advance(HEALTH_LIMITS.taskSettleMs * 3);
    s.w.onSettled(s.turn({ source: "shell-done", ownerTask: false, sentTexts: ["Build passed."] }, 90_000));
    s.advance(HEALTH_LIMITS.taskSettleMs);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.summary).toBe("Build passed.");
    expect(s.sent[0]!.endedAt - s.sent[0]!.startedAt).toBeGreaterThan(HEALTH_LIMITS.longTaskMs);
  });

  it("a heartbeat in the middle of a task doesn't become its summary", () => {
    const s = setup();
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, sentTexts: ["Done: report sent."] }));
    s.w.onSettled(s.turn({ source: "heartbeat", ownerTask: false, sentTexts: ["Checking in."] }));
    s.advance(HEALTH_LIMITS.taskSettleMs);
    expect(s.sent.map((x) => x.summary)).toEqual(["Done: report sent."]);
  });

  it("waits while the Bot is still busy", () => {
    const s = setup();
    s.busy.add("b1");
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, sentTexts: ["Half way."] }));
    s.advance(HEALTH_LIMITS.taskSettleMs * 4);
    expect(s.sent).toHaveLength(0);
    s.busy.delete("b1");
    s.advance(HEALTH_LIMITS.taskSettleMs);
    expect(s.sent).toHaveLength(1);
  });

  it("nothing for a task the owner stopped, or one where the Bot said nothing", () => {
    const s = setup();
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, sentTexts: ["On it."] }));
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, stopped: true }));
    s.w.onSettled(s.turn({ botId: "b2", source: "user", ownerTask: true, sentTexts: [] }));
    s.advance(60_000);
    expect(s.sent).toEqual([]);
  });

  it("the setting: Only long tasks (over a minute) and Off", () => {
    const s = setup({ mode: "long" });
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, sentTexts: ["Quick one."] }, 20_000));
    s.advance(HEALTH_LIMITS.taskSettleMs);
    expect(s.sent).toHaveLength(0);
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, sentTexts: ["Long one."] }, 70_000));
    s.advance(HEALTH_LIMITS.taskSettleMs);
    expect(s.sent.map((x) => x.summary)).toEqual(["Long one."]);
    s.setMode("off");
    s.w.onSettled(s.turn({ source: "user", ownerTask: true, sentTexts: ["Another long one."] }, 90_000));
    s.advance(HEALTH_LIMITS.taskSettleMs);
    expect(s.sent).toHaveLength(1);
  });

  it("a Bot with notifications off (or hidden) stays quiet; Telegram is flagged when the owner opted in", () => {
    const quiet = setup({ notify: false });
    quiet.w.onSettled(quiet.turn({ source: "user", ownerTask: true, sentTexts: ["x"] }));
    quiet.advance(HEALTH_LIMITS.taskSettleMs);
    expect(quiet.sent).toHaveLength(0);
    const tg = setup({ telegram: true });
    tg.w.onSettled(tg.turn({ source: "user", ownerTask: true, sentTexts: ["x"] }));
    tg.advance(HEALTH_LIMITS.taskSettleMs);
    expect(tg.sent[0]!.telegram).toBe(true);
  });

  it("summaries are one plain line, capped", () => {
    expect(summarize("# Title\n\nbody")).toBe("Title");
    expect(summarize("See [the doc](https://x.y) now")).toBe("See the doc now");
    expect(summarize("x".repeat(300))).toHaveLength(HEALTH_LIMITS.summaryMax);
  });
});
