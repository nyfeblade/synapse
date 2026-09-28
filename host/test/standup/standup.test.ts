import path from "node:path";
import { describe, expect, it } from "vitest";
import { STRS, type SseEvent, type StandupCard, type StandupView } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import type { OneShotModel, OneShotRequest } from "../../helper-model/one-shot";
import { loadPrompt } from "../../prompts/index";
import { digestFor, estimateTokens } from "../../standup/digest";
import { StandupService, standupHandlers } from "../../standup/standup-service";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// Mon 2026-09-21 08:50 in New York
const T0 = Date.UTC(2026, 8, 21, 12, 50);
const H = 3_600_000;

/** The fake model: a deterministic line from the digest, and a record of every call's size. */
function fakeModel() {
  const calls: { req: OneShotRequest; inChars: number }[] = [];
  const model: OneShotModel = {
    run: async <T>(req: OneShotRequest): Promise<T> => {
      calls.push({ req, inChars: loadPrompt(req.prompt).length + JSON.stringify(req.input).length });
      const digest = String((req.input as { digest: string }).digest);
      const first = /bot said: ([^\n]{0,60})/.exec(digest)?.[1] ?? "worked";
      return { did: `sent: ${first}`.slice(0, 80), blocked: digest.includes("waiting on") ? "your approval" : "nothing", needs: digest.includes("waiting on") ? "an approval" : "nothing" } as T;
    },
  };
  return { model, calls };
}

function setup(nBots = 4) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const clock = { now: T0 };
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  settings.update({ userTimeZone: "America/New_York" });
  const bots = new BotService({ cfg, hub, settings, now: () => clock.now });
  const names = ["Courier", "Scout", "Ledger", "Planner", "Idle Ivy"].slice(0, nBots + 1);
  const ids = names.map((name) => bots.create({ origin: "user", kickstart: false, name }));
  // Realistic recent activity for the first nBots; the last Bot did nothing.
  ids.slice(0, nBots).forEach((id, i) => {
    bots.appendEntry(id, { kind: "message", id: `u${i}`, role: "user", content: `Please handle task ${i}: sort the invoices from last week and file them`, createdAt: T0 - 5 * H });
    for (let k = 0; k < 6; k++) bots.appendEntry(id, { kind: "tool-call", id: `tc${i}-${k}`, requestId: "r", segmentId: "s", hidden: false, name: "Read", step: `Read invoice-${k}.pdf`, icon: "file", metric: { verb: "Read", noun: "file", nounPlural: "files", count: 1 }, status: "done", startedAt: T0 - 4 * H });
    bots.appendEntry(id, { kind: "send-message", id: `s${i}`, requestId: "r", createdAt: T0 - 4 * H, message: { type: "text", content: `Filed 12 invoices into Finance/2026-09 and flagged 2 duplicates for task ${i}.` } });
  });
  const { model, calls } = fakeModel();
  const timers: { fn: () => void; at: number }[] = [];
  const svc = new StandupService({
    cfg, bots, hub, model, now: () => clock.now, tz: () => settings.timeZone(),
    setTimer: (fn, ms) => { const t = { fn, at: clock.now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
    awaiting: (id) => (id === ids[1] ? "waiting on your approval to send 3 emails" : null),
  });
  const fire = () => { const due = timers.filter((t) => t.at <= clock.now); for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn(); } };
  return { cfg, clock, bots, ids, svc, calls, events, fire, hub, settings };
}

describe("standup digest (no model)", () => {
  it("an idle Bot has no digest; an active one gets a short digest from its own activity", () => {
    const s = setup(1);
    const since = T0 - 24 * H;
    expect(digestFor(s.bots.tail(s.ids[1]!, 200), { since, awaiting: null, runs: [] })).toBeNull();
    const d = digestFor(s.bots.tail(s.ids[0]!, 200), { since, awaiting: null, runs: [{ name: "Inbox digest", status: "ok" }] })!;
    expect(d).toContain("user asked: Please handle task 0");
    expect(d).toContain("bot said: Filed 12 invoices");
    expect(d).toContain("Read 6 files");
    expect(d).toContain("routine Inbox digest: ok");
    expect(d.length).toBeLessThanOrEqual(1200);
  });
});

describe("daily standup", () => {
  it("one short model call per active Bot, none for an idle Bot, one Team standup card; measures the token cost", async () => {
    const s = setup(4);
    const card = await s.svc.runNow();
    expect(s.calls).toHaveLength(4);
    expect(card.lines.map((l) => l.name)).toEqual(["Courier", "Scout", "Ledger", "Planner"]);
    expect(card.idle).toEqual(["Idle Ivy"]);
    expect(card.lines[1]).toMatchObject({ blocked: "your approval", needs: "an approval" });
    expect(card.usage.modelCalls).toBe(4);
    const inTok = s.calls.reduce((n, c) => n + estimateTokens(c.inChars), 0);
    expect(card.usage.inputTokens).toBe(inTok);
    // Cheap: well under 2k input tokens for all four Bots together.
    expect(card.usage.inputTokens).toBeLessThan(2_000);
    expect(s.calls.every((c) => c.req.prompt === "orig/standup-line.md")).toBe(true);
    expect(s.events.some((e) => e.channel === "standup")).toBe(true);
    // The measurement, for the report (fake model; chars / 4).
    console.log(`standup token cost (4 Bots, fake model): ${card.usage.modelCalls} calls, ~${card.usage.inputTokens} input + ~${card.usage.outputTokens} output tokens`);
  });

  it("nothing at all (no model call) when every Bot was idle", async () => {
    const s = setup(0);
    const card = await s.svc.runNow();
    expect(s.calls).toHaveLength(0);
    expect(card.lines).toEqual([]);
    expect(STRS.standupSpokenText(card.lines)).toBe("Team standup. Every Bot was idle.");
  });

  it("is opt-in, runs at 9:00 on weekdays, and after sleep catches up once (never twice a day)", async () => {
    const s = setup(2);
    s.svc.start();
    s.clock.now = T0 + 20 * 60_000; // 9:10
    s.fire();
    expect(s.svc.view().latest).toBeNull(); // off by default
    s.svc.setSettings({ enabled: true });
    expect(s.svc.view().nextAt).toBe(Date.UTC(2026, 8, 22, 13, 0)); // 9:00 tomorrow (Tue)
    s.clock.now = Date.UTC(2026, 8, 22, 13, 0, 5);
    s.fire();
    await new Promise((r) => setImmediate(r));
    expect(s.svc.view().latest).toMatchObject({ scheduledFor: Date.UTC(2026, 8, 22, 13, 0), caughtUp: false });
    // Asleep through Wed 9:00 and Thu 9:00; wakes Thu 11:00 → one catch-up run for Thu only
    s.clock.now = Date.UTC(2026, 8, 24, 15, 0);
    s.svc.onWake();
    await new Promise((r) => setImmediate(r));
    const latest = s.svc.view().latest as StandupCard;
    expect(latest).toMatchObject({ scheduledFor: Date.UTC(2026, 8, 24, 13, 0), caughtUp: true });
    const before = s.calls.length;
    s.svc.onWake();
    await new Promise((r) => setImmediate(r));
    expect(s.calls.length).toBe(before);
    expect(s.svc.history().filter((c) => c.scheduledFor === Date.UTC(2026, 8, 24, 13, 0))).toHaveLength(1);
  });

  it("skips weekends when weekdays only", () => {
    const s = setup(1);
    s.svc.setSettings({ enabled: true });
    s.clock.now = Date.UTC(2026, 8, 25, 14, 0); // Fri 10:00
    expect(s.svc.view().nextAt).toBe(Date.UTC(2026, 8, 28, 13, 0)); // Mon 9:00
  });

  it("handlers validate settings and return the view", async () => {
    const s = setup(1);
    const h = standupHandlers(s.svc);
    expect(() => h.setStandupSettings!({ time: "25:00" })).toThrow(/time/i);
    const v = h.setStandupSettings!({ enabled: true, time: "8:30", spoken: true }) as StandupView;
    expect(v.settings).toMatchObject({ enabled: true, time: "08:30", spoken: true, weekdaysOnly: true });
    const r = await h.runStandupNow!({});
    expect(r.card.lines.map((l) => l.name)).toEqual(["Courier", "Scout"]); // Scout did nothing but waits on the user: it gets a line
    expect((h.getStandup!({}) as StandupView).latest?.id).toBe(r.card.id);
  });

  it("a scheduled standup that fails leaves a card that says it failed, and tells the user (bug 115)", async () => {
    const s = setup(2);
    const failed: string[] = [];
    s.svc.onFailed = (detail) => failed.push(detail);
    s.svc.start();
    s.svc.setSettings({ enabled: true });
    (s.bots as { tail: unknown }).tail = () => { throw new Error("transcript read failed"); };
    s.clock.now = Date.UTC(2026, 8, 22, 13, 0, 5); // Tue 9:00
    s.fire();
    await new Promise((r) => setImmediate(r));
    const card = s.svc.view().latest as StandupCard;
    expect(card, "the morning's slot is claimed, so without a card the user sees yesterday's as if nothing happened").not.toBeNull();
    expect(card).toMatchObject({ scheduledFor: Date.UTC(2026, 8, 22, 13, 0), lines: [], error: STRS.standupFailed });
    expect(failed).toEqual([STRS.standupFailed]);
    expect(s.events.some((e) => e.channel === "standup" && (e.payload as StandupView).latest?.error === STRS.standupFailed)).toBe(true);
  });
});
