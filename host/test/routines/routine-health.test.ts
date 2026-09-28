import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STR, type RoutineView, type SseEvent } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { messageText } from "../../brain/types";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { SchedulerEngine } from "../../routines/engine";
import type { FireConsumer, FireRequest } from "../../routines/fire-consumer";
import { RoutineHealth, routineProblem } from "../../routines/routine-health";
import { RoutineService } from "../../routines/routine-service";
import { RoutineStore } from "../../routines/routine-store";
import { StatusReminder } from "../../routines/status-reminder";
import { SchedulerDb } from "../../routines/scheduler-db";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { EmailTriggers } from "../../triggers/email/email-triggers";
import { MailboxStore } from "../../triggers/email/mailboxes";
import type { ImapLike } from "../../triggers/email/imap-idle";
import type { EventQueue } from "../../triggers/event-queue";
import { tmpConfig } from "../helpers";

const NOW = Date.UTC(2026, 8, 21, 12, 5, 0);

class DeadImap implements ImapLike {
  async connect() {}
  async openFolder() { return { uidNext: 1 }; }
  async fetchSince() { return []; }
  idle() { return new Promise<unknown>(() => {}); }
  stopIdle() {}
  onExists() {}
  onClose() {}
  async close() {}
}

function setup() {
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
  const store = new RoutineStore({ cfg, now: () => clock.now, onChange: (b, r) => engine.reindex(b, r) });
  const db = new SchedulerDb(":memory:");
  const engine = new SchedulerEngine({ db, store, botTz: () => settings.timeZone(), now: () => clock.now, mono: () => 0, setTimer: () => 0, clearTimer: () => {}, onClaim: () => {}, onOfflineSkips: () => {} });
  engine.boot();
  const consumer = { submit: (r: FireRequest) => ({ accepted: true, runId: r.runId }) } as unknown as FireConsumer;
  const routines = new RoutineService({ cfg, store, db, engine, consumer, bots, settings, hub, model: null, now: () => clock.now, publicBaseUrl: () => "http://box.local:47801" });
  const mailboxes = new MailboxStore(cfg);
  const email = new EmailTriggers({ store, queue: { ingest: () => {} } as unknown as EventQueue, mailboxes, model: null, now: () => clock.now, setTimer: () => 0, clearTimer: () => {}, imapFactory: () => new DeadImap() });
  const health = new RoutineHealth({
    store, now: () => clock.now, botTz: () => settings.timeZone(),
    hasMailbox: (botId, account) => mailboxes.secret(botId, account) !== null,
    onChanged: (botId) => routines.publish(botId),
  });
  // phase4.ts's resyncTriggers, for the parts that arm routines.
  const resync = () => { health.reconcile(); email.sync(); };
  const view = (routineId: string): RoutineView => routines.list(id).find((r) => r.id === routineId)!;
  return { cfg, clock, bots, id, store, routines, mailboxes, email, resync, view, events };
}

describe("a routine the host cannot arm stops claiming to be Active (bug 44a)", () => {
  it("an email routine whose filter cannot be read is turned off, and its own row says why", () => {
    const s = setup();
    s.mailboxes.add(s.id, { label: "work", host: "imap.example.com", port: 993, user: "me@x.com", appPassword: "pw" });
    s.store.create(s.id, { name: "Starred mail", prompt: "Summarize it.", trigger: { email: { account: "work", query: "is:starred" } }, enabled: true });
    s.resync();
    const v = s.view("starred-mail");
    expect(v.enabled, "an enabled routine the subscriber skipped is still listed as Active").toBe(false);
    expect(v.runs[0]?.status).toBe("error");
    expect(v.runs[0]?.detail).toContain("is:starred");
  });

  it("a routine whose schedule cannot be read is turned off too (the same class, host/routines/engine.ts)", () => {
    const s = setup();
    fs.mkdirSync(path.join(s.cfg.dataRoot, "agents", s.id, "automations", "bad-cron"), { recursive: true });
    fs.writeFileSync(
      path.join(s.cfg.dataRoot, "agents", s.id, "automations", "bad-cron", "automation.json"),
      JSON.stringify({ name: "Bad cron", prompt: "p", schedule: "every other tuesday-ish", enabled: true, createdAt: NOW }),
    );
    s.resync();
    const v = s.view("bad-cron");
    expect(v.enabled).toBe(false);
    expect(v.runs[0]?.detail).toContain("every other tuesday-ish");
  });

  it("a missing mailbox is recoverable, so the routine stays on but its row says it is not watching", () => {
    const s = setup();
    s.store.create(s.id, { name: "Invoices", prompt: "p", trigger: { email: { account: "work", query: "from:billing" } }, enabled: true });
    s.resync();
    const v = s.view("invoices");
    expect(v.enabled, "adding the mailbox arms it again, so turning it off would be wrong").toBe(true);
    expect(v.runs[0]?.detail).toContain("work");
  });

  it("re-checking is idempotent: no pile of identical failed runs, and no publish loop", () => {
    // phase4 calls reconcile() from resyncTriggers, which the `automations` SSE re-triggers — so a
    // pass that always republished would spin forever. The second pass has to be a no-op.
    const s = setup();
    s.store.create(s.id, { name: "Starred mail", prompt: "p", trigger: { email: { account: "work", query: "is:starred" } }, enabled: true });
    for (let i = 0; i < 5; i++) s.resync();
    expect(s.view("starred-mail").runs).toHaveLength(1);
    const after = s.events.length;
    s.resync();
    expect(s.events.length, "a settled problem publishes nothing, so resync -> publish -> resync ends").toBe(after);
  });

  it("switching a still-broken routine back on turns it off again, with the same one row", () => {
    const s = setup();
    s.store.create(s.id, { name: "Starred mail", prompt: "p", trigger: { email: { account: "work", query: "is:starred" } }, enabled: true });
    s.resync();
    s.routines.setEnabled(s.id, "starred-mail", true);
    s.resync();
    expect(s.view("starred-mail")).toMatchObject({ enabled: false });
    expect(s.view("starred-mail").runs).toHaveLength(1);
  });

  it("the Bot's own routine status says why it is off, instead of reading like a routine the user paused", () => {
    const s = setup();
    s.store.create(s.id, { name: "Starred mail", prompt: "p", trigger: { email: { account: "work", query: "is:starred" } }, enabled: true });
    s.resync();
    const reminder = new StatusReminder({ store: s.store, nextRunAt: () => null, botTz: () => "America/New_York", now: () => NOW });
    // The runtime snapshot, which tells the Bot it is authoritative and replaces its own memory of it.
    const text = messageText(reminder.decorate(s.id, { source: "user", silenceAllowed: false, lane: "user" })!);
    // "paused" invites the Bot to switch it back on, unfixed — which is exactly what it would do.
    expect(text).toContain("could never run");
    expect(text).not.toMatch(/\(id starred-mail\): paused/);
  });

  it("a healthy routine is left alone: no problem run, still Active", () => {
    const s = setup();
    s.mailboxes.add(s.id, { label: "work", host: "imap.example.com", port: 993, user: "me@x.com", appPassword: "pw" });
    s.store.create(s.id, { name: "Invoices", prompt: "p", trigger: { email: { account: "work", query: "from:billing has:attachment" } }, enabled: true });
    s.resync();
    expect(s.view("invoices")).toMatchObject({ enabled: true, runs: [] });
  });

  it("consecutive IMAP connect failures are recoverable: the routine stays on and its own row says it is not watching (bug 51)", () => {
    const s = setup();
    s.mailboxes.add(s.id, { label: "work", host: "imap.example.com", port: 993, user: "me@x.com", appPassword: "pw" });
    s.store.create(s.id, { name: "Invoices", prompt: "p", trigger: { email: { account: "work", query: "from:billing" } }, enabled: true });
    const health = new RoutineHealth({
      store: s.store, now: () => s.clock.now, botTz: () => "America/New_York",
      hasMailbox: () => true,
      mailboxReachable: () => false,
      onChanged: (botId) => s.routines.publish(botId),
    });
    health.reconcile();
    const v = s.view("invoices");
    expect(v.enabled, "a mailbox that is merely down will answer again, so turning the routine off would be wrong").toBe(true);
    expect(v.runs[0]?.status).toBe("error");
    expect(v.runs[0]?.detail).toContain("work");
  });

  it("an unreachable mailbox's row names the action that fixes it, and that action is on the same panel (bug 51)", () => {
    const imap = routineProblem({ name: "Invoices", prompt: "p", trigger: { email: { account: "work", query: "from:billing" } }, enabled: true, createdAt: 0 },
      { tz: "America/New_York", hasMailbox: () => true, mailboxReachable: () => false })!;
    // RoutineDetail renders an "Add mailbox" button for every email routine, and adding one under the
    // same name replaces its details (EmailTriggers reconnects with them).
    expect(imap.detail, "a state with no action: the user is told it is down and not what to do").toContain(STR.addMailbox);
    expect(imap.detail).toMatch(/app password/i);
    // synapse-public: an old routine on the claude.ai Gmail connector has no mailbox (claude.ai connectors need a Claude
    // login): the row says so, like any unknown mailbox.
    const gmail = routineProblem({ name: "Receipts", prompt: "p", trigger: { email: { account: "claude-gmail", query: "from:shop" } }, enabled: true, createdAt: 0 },
      { tz: "America/New_York", hasMailbox: (a) => a !== "claude-gmail", mailboxReachable: () => true })!;
    expect(gmail.key).toBe("mailbox");
  });

  it("a GitHub / Slack listener whose saved token keeps being refused says so and names the action; a merely unconnected one does not (bug 51's siblings)", () => {
    const def = { name: "PRs", prompt: "p", trigger: { github: { repo: "a/b", events: ["prOpened" as const] } }, enabled: true, createdAt: 0 };
    const failing = routineProblem(def, { tz: "America/New_York", hasMailbox: () => true, listenerFailing: (p) => p === "github" })!;
    expect(failing).toMatchObject({ key: "listener", fatal: false });
    expect(failing.detail).toContain("GitHub");
    expect(failing.detail, "the action on the row is the token field and its Connect button").toContain(STR.connect);
    // Must not fire: no saved token at all is RTN-12's Connect card, which already says so.
    expect(routineProblem(def, { tz: "America/New_York", hasMailbox: () => true, listenerFailing: () => false })).toBeNull();
  });
});

describe("the running host (gateway level)", () => {
  let app: HostApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  async function start() {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const { port } = await app.listen();
    const api = async <T>(cmd: string, args: unknown): Promise<T> => {
      const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
      const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
      if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
      return j.result as T;
    };
    const { id } = await api<{ id: string }>("createAgent", { name: "Piper", isKickstartRequested: false });
    const routines = async () => (await api<{ routines: RoutineView[] }>("getAgentAutomations", { id })).routines;
    return { cfg, api, id, routines };
  }

  it("refuses to save an email routine with a filter it could never subscribe", async () => {
    const s = await start();
    await expect(s.api("createAgentAutomation", { id: s.id, name: "Starred mail", prompt: "p", trigger: { email: { account: "work", query: "is:starred" } } }))
      .rejects.toThrow(/BAD_ROUTINE/);
    expect(await s.routines()).toEqual([]);
  });

  it("turns off one that arrived another way — a Bot writing automation.json — the next time triggers are armed", async () => {
    const s = await start();
    // A Bot editing its own automations file, the path that has no gateway validation in front of it.
    const dir = path.join(s.cfg.dataRoot, "agents", s.id, "automations", "starred");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "automation.json"), JSON.stringify({ name: "Starred mail", prompt: "p", trigger: { email: { account: "work", query: "is:starred" } }, enabled: true, createdAt: Date.now() }));
    // Any routine edit republishes `automations`, which is what re-arms the triggers (phase4.ts).
    await s.api("createAgentAutomation", { id: s.id, name: "Morning", prompt: "p", schedule: "every day at 8am" });
    const bad = (await s.routines()).find((r) => r.id === "starred")!;
    expect(bad.enabled, "the user was being shown an Active routine that could never fire").toBe(false);
    expect(bad.runs[0]?.detail).toContain("is:starred");
    expect((await s.routines()).find((r) => r.id === "morning")).toMatchObject({ enabled: true, runs: [] });
  });
});
