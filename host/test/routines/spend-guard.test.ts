import path from "node:path";
import { describe, expect, it } from "vitest";
import { STR, type WidgetSpec } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { RoutineStore } from "../../routines/routine-store";
import { SpendGuard } from "../../routines/spend-guard";
import type { HostWidgets } from "../../chat/widgets";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { TrayService } from "../../trays/trays";
import { tmpConfig } from "../helpers";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 21, 8, 0, 0);

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const clock = { now: T0 };
  const hub = new SseHub();
  const bots = new BotService({ cfg, hub, settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")), now: () => clock.now });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const store = new RoutineStore({ cfg, now: () => clock.now });
  store.create(id, { name: "A", prompt: "p", schedule: "0 8 * * *", enabled: true });
  store.create(id, { name: "B", prompt: "p", schedule: "0 9 * * *", enabled: true });
  store.create(id, { name: "C", prompt: "p", schedule: "0 10 * * *", enabled: false });
  const posts: { spec: WidgetSpec; answer: (v: string) => void }[] = [];
  const widgets = { hostPost: (_b: string, spec: WidgetSpec, answer: (v: string) => void) => { posts.push({ spec, answer }); return `t9a${posts.length}`; } } as unknown as HostWidgets;
  const trays = new TrayService(hub, () => clock.now);
  const paused: string[] = [];
  const resumed: string[] = [];
  const wakes: string[] = [];
  const guard = new SpendGuard({ bots, store, widgets, trays, now: () => clock.now, onPauseAll: (b) => paused.push(b), onResumeAll: (b) => resumed.push(b), wake: (_b, t) => wakes.push(t) });
  const setUnread = (lastViewedAt: number, unreadCount: number) =>
    bots.require(id).store.setKv("unreadState", { lastActivityAt: 0, lastViewedAt, isManuallyUnread: false, unreadCount });
  return { clock, bots, id, store, guard, posts, trays, paused, resumed, wakes, setUnread };
}
const enabled = (s: ReturnType<typeof setup>) => s.store.list(s.id).filter((r) => r.def.enabled).map((r) => r.id);

describe("SpendGuard (RTN-20)", () => {
  it("never nudges a user who viewed the Bot within 3 days", () => {
    const s = setup();
    s.setUnread(T0, 40);
    s.clock.now = T0 + 2 * DAY;
    for (let i = 0; i < 25; i++) s.guard.noteFire(s.id);
    expect(s.guard.check(s.id)).toBe("ok");
    expect(s.posts).toEqual([]);
  });

  it("nudges once when idle and ≥ 15 unread, with the exact question and options", () => {
    const s = setup();
    s.setUnread(T0, 15);
    s.clock.now = T0 + 3 * DAY;
    expect(s.guard.check(s.id)).toBe("ok");
    expect(s.guard.check(s.id)).toBe("ok");
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.spec).toMatchObject({
      question: "You've been gone a while — should my routines keep running?", hostKind: "spend-guard",
      options: [{ label: "Keep them running", value: "keep" }, { label: "Pause them all", value: "pause" }, { label: "Keep running, don't ask again", value: "optout" }],
    });
  });

  it("nudges when ≥ 20 fires happened since the last view", () => {
    const s = setup();
    s.setUnread(T0, 0);
    s.clock.now = T0 + 4 * DAY;
    for (let i = 0; i < 19; i++) s.guard.noteFire(s.id);
    s.guard.check(s.id);
    expect(s.posts).toHaveLength(0);
    s.guard.noteFire(s.id);
    s.guard.check(s.id);
    expect(s.posts).toHaveLength(1);
  });

  it("pauses everything 3 days after an unanswered nudge: drop, post, tray; resume undoes it", () => {
    const s = setup();
    s.setUnread(T0, 20);
    s.clock.now = T0 + 3 * DAY;
    s.guard.check(s.id);
    s.clock.now = T0 + 6 * DAY;
    expect(s.guard.check(s.id)).toBe("paused");
    expect(enabled(s)).toEqual([]);
    expect(s.paused).toEqual([s.id]);
    expect(s.posts[1]!.spec).toMatchObject({ question: STR.spendGuardPausedPost, options: [{ label: "Resume routines", value: "resume" }, { label: "Keep them paused", value: "keep-paused" }] });
    const tray = s.trays.list()[0]!;
    expect(tray).toMatchObject({ botId: s.id, title: "Routines on hold while you were away", buttons: [{ label: "Resume routines", action: "resume-routines" }] });
    s.posts[1]!.answer("resume");
    expect(enabled(s)).toEqual(["a", "b"]); // C was already paused and stays paused
    expect(s.resumed).toEqual([s.id]);
    expect(s.trays.list()).toEqual([]);
    expect(s.wakes[0]).toContain('They chose to "Resume routines", and the app has ALREADY applied that. Acknowledge in one short line.');
  });

  it("the hourly tick pauses too, and the tray button resumes", () => {
    const s = setup();
    s.setUnread(T0, 20);
    s.clock.now = T0 + 3 * DAY;
    s.guard.check(s.id);
    s.clock.now = T0 + 6 * DAY + 1;
    s.guard.tick();
    expect(enabled(s)).toEqual([]);
    s.guard.resumeAll(s.id);
    expect(enabled(s)).toEqual(["a", "b"]);
  });

  it("'Keep them running' snoozes 30 days; 'don't ask again' opts out; 'Pause them all' pauses without a tray", () => {
    const s = setup();
    s.setUnread(T0, 20);
    s.clock.now = T0 + 3 * DAY;
    s.guard.check(s.id);
    s.posts[0]!.answer("keep");
    s.clock.now = T0 + 30 * DAY;
    s.guard.check(s.id);
    expect(s.posts).toHaveLength(1);
    s.clock.now = T0 + 34 * DAY;
    s.guard.check(s.id);
    expect(s.posts).toHaveLength(2);
    s.posts[1]!.answer("optout");
    s.clock.now = T0 + 400 * DAY;
    s.guard.check(s.id);
    expect(s.posts).toHaveLength(2);

    const p = setup();
    p.setUnread(T0, 20);
    p.clock.now = T0 + 3 * DAY;
    p.guard.check(p.id);
    p.posts[0]!.answer("pause");
    expect(enabled(p)).toEqual([]);
    expect(p.trays.list()).toEqual([]);
    expect(p.wakes[0]).toContain('They chose to "Pause them all"');
  });

  it("viewing the Bot clears the nudge and the fire counter", () => {
    const s = setup();
    s.setUnread(T0, 20);
    s.clock.now = T0 + 3 * DAY;
    s.guard.check(s.id);
    s.guard.onViewed(s.id);
    s.setUnread(T0 + 3 * DAY, 0);
    s.clock.now = T0 + 6 * DAY + 1;
    expect(s.guard.check(s.id)).toBe("ok");
    expect(enabled(s)).toEqual(["a", "b"]);
  });
});
