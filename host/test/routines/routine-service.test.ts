import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SseEvent } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { SchedulerEngine } from "../../routines/engine";
import type { FireConsumer, FireRequest } from "../../routines/fire-consumer";
import { routineHandlers } from "../../routines/routine-handlers";
import { RoutineService } from "../../routines/routine-service";
import { RoutineStore } from "../../routines/routine-store";
import { SchedulerDb } from "../../routines/scheduler-db";
import { hashKey, keyPreview, newWebhookKey, verifyKey } from "../../routines/webhook-keys";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const NOW = Date.UTC(2026, 8, 21, 12, 5, 0); // 8:05 AM in New York

function setup(accept = true) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const clock = { now: NOW };
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  settings.update({ userTimeZone: "America/New_York" });
  const bots = new BotService({ cfg, hub, settings, now: () => clock.now });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const store = new RoutineStore({ cfg, now: () => clock.now });
  const db = new SchedulerDb(":memory:");
  const engine = new SchedulerEngine({ db, store, botTz: () => settings.timeZone(), now: () => clock.now, mono: () => 0, setTimer: () => 0, clearTimer: () => {}, onClaim: () => {}, onOfflineSkips: () => {} });
  engine.boot();
  const submitted: FireRequest[] = [];
  const consumer = { submit: (r: FireRequest) => { submitted.push(r); return accept ? { accepted: true, runId: r.runId } : { accepted: false, reason: "disabled", runId: r.runId }; } } as unknown as FireConsumer;
  const routines = new RoutineService({ cfg, store, db, engine, consumer, bots, settings, hub, model: null, now: () => clock.now, publicBaseUrl: () => "http://box.local:47801" });
  return { cfg, clock, bots, id, store, db, engine, routines, submitted, events, consumer };
}

describe("webhook keys (ORIG-04 §04.2)", () => {
  it("makes bot_ + 32 base62 keys, stores only a hash and the last 4", () => {
    const k = newWebhookKey();
    expect(k).toMatch(/^bot_[0-9A-Za-z]{32}$/);
    expect(newWebhookKey()).not.toBe(k);
    expect(hashKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyPreview(k)).toBe(k.slice(-4));
    expect(verifyKey(k, hashKey(k))).toBe(true);
    expect(verifyKey(`${k}x`, hashKey(k))).toBe(false);
    expect(verifyKey(k, "zz")).toBe(false);
  });
});

describe("RoutineService", () => {
  it("creates from plain English in the Bot's zone and never runs on save (RTN-06, C4)", async () => {
    const s = setup();
    const { view, normalized, key } = await s.routines.create(s.id, { name: "Morning inbox sweep", prompt: "Summarize my inbox.", schedule: "every day at 8am" });
    expect(normalized!.schedule).toBe("0 8 * * *");
    expect(key).toBeNull();
    expect(view).toMatchObject({
      id: "morning-inbox-sweep", triggerKind: "schedule", schedule: "0 8 * * *", scheduleRaw: "CRON_TZ=America/New_York 0 8 * * *",
      description: "Every day at 8:00 AM", enabled: true, nextRunAt: Date.UTC(2026, 8, 22, 12, 0, 0), runs: [], webhook: null, listenerConnected: null,
    });
    expect(s.submitted).toEqual([]);
    expect(s.events.some((e) => e.channel === "automations" && e.payload.botId === s.id && e.payload.routines.length === 1)).toBe(true);
  });

  it("rejects invalid schedules, both-or-neither, blank names, Teams triggers and the 51st routine", async () => {
    const s = setup();
    await expect(s.routines.create(s.id, { name: "X", prompt: "p", schedule: "every minute" })).rejects.toThrow("Leave 5 minutes or more between a routine's runs");
    await expect(s.routines.create(s.id, { name: "X", prompt: "p", schedule: "whenever" })).rejects.toThrow("Enter a valid schedule");
    await expect(s.routines.create(s.id, { name: "X", prompt: "p" })).rejects.toThrow("exactly one of a schedule or a trigger");
    await expect(s.routines.create(s.id, { name: "X", prompt: "p", schedule: "0 8 * * *", trigger: { webhook: {} } })).rejects.toThrow("exactly one of a schedule or a trigger");
    await expect(s.routines.create(s.id, { name: "  ", prompt: "p", schedule: "0 8 * * *" })).rejects.toThrow("needs a name");
    await expect(s.routines.create(s.id, { name: "T", prompt: "p", trigger: { microsoftTeams: {} } })).rejects.toThrow("Microsoft Teams");
    await expect(s.routines.create(s.id, { name: "G", prompt: "p", trigger: { group: { listeners: [{ webhook: {} }] } } })).rejects.toThrow("2 to 8 listeners");
    for (let i = 0; i < 50; i++) s.store.create(s.id, { name: `r${i}`, prompt: "p", schedule: "0 8 * * *", enabled: true });
    await expect(s.routines.create(s.id, { name: "one more", prompt: "p", schedule: "0 8 * * *" })).rejects.toThrow("at most 50 routines");
  });

  // Final box verification: a Bot passed trigger {time, timezone, days}; it was saved as a "webhook" routine with no
  // URL and no schedule, so it could never fire. An unknown or malformed trigger is refused with a hint to use schedule.
  it("refuses a trigger that isn't exactly one known kind with the right shape, and points at schedule", async () => {
    const s = setup();
    const bad = [
      { time: "09:00", timezone: "America/New_York", days: "weekdays" },
      {},
      { webhook: {}, slack: { channel: "*", match: "mention" } },
      { slack: { channel: 5, match: "mention" } },
      { github: { repo: "owner/name" } },
      { linear: { event: "issueDeleted" } },
      { file: { paths: "notes" , events: ["created"] } },
      { email: { account: "me@x.com" } },
      { cron: {} },
      { group: { listeners: [{ webhook: {} }, { nope: 1 }] } },
    ];
    for (const t of bad) await expect(s.routines.create(s.id, { name: "T", prompt: "p", trigger: t as never }), JSON.stringify(t)).rejects.toThrow(/Not saved/);
    await expect(s.routines.create(s.id, { name: "T", prompt: "p", trigger: bad[0] as never })).rejects.toThrow(/schedule/);
    expect(s.store.list(s.id)).toEqual([]);
    // the known shapes still save
    await s.routines.create(s.id, { name: "W", prompt: "p", trigger: { webhook: {} } });
    await s.routines.create(s.id, { name: "L", prompt: "p", trigger: { linear: { event: "issueCreated" } } });
    await s.routines.create(s.id, { name: "F", prompt: "p", trigger: { file: { paths: ["notes"], events: ["created"] } } });
  });

  it("gives webhook triggers a key shown once, a hash on disk, and rotation", async () => {
    const s = setup();
    const { view, key } = await s.routines.create(s.id, { name: "Hook", prompt: "Handle it.", trigger: { webhook: {} } });
    expect(key).toMatch(/^bot_[0-9A-Za-z]{32}$/);
    const def = s.store.get(s.id, "hook")!.def;
    expect(verifyKey(key!, def.webhook!.keyHash)).toBe(true);
    expect(JSON.stringify(def)).not.toContain(key!);
    expect(view).toMatchObject({ triggerKind: "webhook", description: "When a webhook is received", nextRunAt: null, schedule: null, scheduleRaw: null });
    expect(view.webhook).toEqual({ url: `http://box.local:47801/hooks/${def.webhook!.routineUuid}`, keyPreview: key!.slice(-4), header: `Authorization: Bearer bot_…${key!.slice(-4)}` });
    expect(s.routines.byWebhookUuid(def.webhook!.routineUuid)!.id).toBe("hook");
    const rotated = s.routines.rotateKey(s.id, "hook");
    expect(rotated.header).toBe(`Authorization: Bearer ${rotated.key}`);
    const after = s.store.get(s.id, "hook")!.def.webhook!;
    expect(after.routineUuid).toBe(def.webhook!.routineUuid);
    expect(verifyKey(key!, after.keyHash)).toBe(false);
    expect(verifyKey(rotated.key, after.keyHash)).toBe(true);
    const plain = await s.routines.create(s.id, { name: "Plain", prompt: "p", schedule: "0 8 * * *" });
    expect(() => s.routines.webhook(s.id, plain.view.id)).toThrow("Save the routine to use this");
  });

  it("pauses, resumes from now, updates, runs now and deletes", async () => {
    const s = setup();
    await s.routines.create(s.id, { name: "Sweep", prompt: "p", schedule: "0 8 * * *" });
    expect(s.routines.setEnabled(s.id, "sweep", false).nextRunAt).toBeNull();
    s.clock.now = Date.UTC(2026, 8, 23, 13, 0, 0);
    expect(s.routines.setEnabled(s.id, "sweep", true).nextRunAt).toBe(Date.UTC(2026, 8, 24, 12, 0, 0));
    const u = await s.routines.update(s.id, "sweep", { schedule: "weekdays at 9:30", name: "Sweep v2" });
    expect(u.view).toMatchObject({ id: "sweep", name: "Sweep v2", schedule: "30 9 * * 1-5", description: "Weekdays at 9:30 AM" });
    const runId = s.routines.runNow(s.id, "sweep");
    expect(s.submitted[0]).toMatchObject({ runId, botId: s.id, routineId: "sweep", trigger: "manual", bypassGate: true, defHash: s.store.get(s.id, "sweep")!.defHash });
    s.routines.remove(s.id, "sweep");
    expect(s.routines.list(s.id)).toEqual([]);
    expect(s.db.index()).toEqual([]);
    expect(() => s.routines.view(s.id, "sweep")).toThrow('No routine "sweep"');
  });

  it("update returns a fresh key once when the trigger newly needs a webhook (ORIG-04 §04.2)", async () => {
    const s = setup();
    await s.routines.create(s.id, { name: "Plain", prompt: "p", schedule: "0 8 * * *" });
    const u = await s.routines.update(s.id, "plain", { trigger: { webhook: {} } });
    expect(u.key).toMatch(/^bot_[0-9A-Za-z]{32}$/);
    const def = s.store.get(s.id, "plain")!.def;
    expect(verifyKey(u.key!, def.webhook!.keyHash)).toBe(true);
    expect(JSON.stringify(def)).not.toContain(u.key!);
    // a further update that doesn't newly need a webhook returns no key
    const u2 = await s.routines.update(s.id, "plain", { name: "Plain v2" });
    expect(u2.key).toBeNull();
  });

  it("runNow surfaces a dropped fire", async () => {
    const s = setup(false);
    await s.routines.create(s.id, { name: "Sweep", prompt: "p", schedule: "0 8 * * *" });
    expect(() => s.routines.runNow(s.id, "sweep")).toThrow("Not run: disabled");
  });

  it("a Test run while one is in flight says so in words, not the raw drop code (Task 50 fuzz: triple-click Test run)", async () => {
    const s = setup();
    await s.routines.create(s.id, { name: "Sweep", prompt: "p", schedule: "0 8 * * *" });
    s.consumer.submit = (r) => ({ accepted: false, reason: "duplicate_in_flight", runId: r.runId });
    expect(() => s.routines.runNow(s.id, "sweep")).toThrow("This routine is already running. Wait for it to finish.");
  });

  it("removeBot deletes every routine of the Bot (RTN-23)", async () => {
    const s = setup();
    await s.routines.create(s.id, { name: "A", prompt: "p", schedule: "0 8 * * *" });
    s.db.addOfflineSkip(s.id, "a", 1);
    s.routines.removeBot(s.id);
    expect(s.store.list(s.id)).toEqual([]);
    expect(s.db.index()).toEqual([]);
    expect(s.db.offlineSkips(s.id)).toEqual([]);
  });

  it("email routines expose mailbox reachability on listenerConnected (bug 51)", () => {
    const s = setup();
    let reachable = true;
    s.routines.d.mailboxReachable = () => reachable;
    s.store.create(s.id, { name: "Invoices", prompt: "p", trigger: { email: { account: "work", query: "from:billing" } }, enabled: true });
    expect(s.routines.list(s.id)[0]!.listenerConnected, "a mailbox that is answering is the same as a connected Slack listener").toBe(true);
    reachable = false;
    expect(s.routines.list(s.id)[0]!.listenerConnected).toBe(false);
  });

  it("gateway handlers post CHAT-03 rows for UI edits", async () => {
    const s = setup();
    const h = routineHandlers(s.routines);
    const created = await h.createAgentAutomation!({ id: s.id, name: "Sweep", prompt: "p", schedule: "0 8 * * *" });
    expect(created.key).toBeNull();
    await h.setAgentAutomationEnabled!({ id: s.id, routineId: "sweep", enabled: false });
    await h.deleteAgentAutomation!({ id: s.id, routineId: "sweep" });
    const rows = s.bots.tail(s.id, 10).filter((e) => e.kind === "event").map((e) => (e as { event: { type: string } }).event.type);
    expect(rows).toEqual(["bot-created", "routine-created", "routine-disabled", "routine-deleted"]);
    expect((await h.getAgentAutomations!({ id: s.id })).routines).toEqual([]);
  });
});
