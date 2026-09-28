import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FireConsumer, type FireRequest } from "../../routines/fire-consumer";
import { renderRoutineWake } from "../../routines/routine-turn";
import { RoutineStore } from "../../routines/routine-store";
import type { RoutineService } from "../../routines/routine-service";
import { SchedulerDb } from "../../routines/scheduler-db";
import { hashKey, keyPreview, newWebhookKey } from "../../routines/webhook-keys";
import { botDir, initLayout } from "../../store/layout";
import { ConnectorSecrets } from "../../triggers/connector-secrets";
import { EventQueue } from "../../triggers/event-queue";
import type { TriggerEvent } from "../../triggers/types";
import { createWebhookServer } from "../../triggers/webhook-server";
import { tmpConfig } from "../helpers";

const SECRET = "xoxb-SEKRET-9988776655";
const redact = (_botId: string, t: string) => t.split(SECRET).join("[secret:SLACK_BOT_TOKEN]");

describe("I10: trigger/event text is redacted before it is stored or rendered", () => {
  it("scheduler.db event_json, runs.json and the wake prompt never carry a secret value", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const botId = randomUUID();
    fs.mkdirSync(botDir(cfg, botId), { recursive: true });
    const now = Date.now();
    const store = new RoutineStore({ cfg, now: () => now });
    const rec = store.create(botId, { name: "Watch", prompt: "p", trigger: { webhook: {} }, enabled: true })!;
    const db = new SchedulerDb(":memory:");
    const started: FireRequest[] = [];
    const consumer = new FireConsumer({
      db, store, now: () => now, setTimer: () => 0, starter: { start: (req) => { started.push(req); } },
      guard: () => "ok", usagePaused: () => false, nextSlot: () => null, eventMatches: () => true,
    });
    const timers: (() => void)[] = [];
    const q = new EventQueue({ store, db, consumer, metrics: null, now: () => now + 1, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, redact });
    const ev: TriggerEvent = { source: "webhook", eventId: "e1", occurredAt: now + 1, subject: `token ${SECRET}`, text: `leaked ${SECRET} here`, raw: { body: { t: SECRET } } };
    q.ingest(ev, { botId, routineId: rec.id });
    timers.shift()!();
    expect(started).toHaveLength(1);
    const all = JSON.stringify(db.fires({ botId }));
    expect(all).not.toContain(SECRET);
    expect(all).toContain("[secret:SLACK_BOT_TOKEN]");
    expect(JSON.stringify(store.runs(botId, rec.id))).not.toContain(SECRET);
    const wake = renderRoutineWake({ routine: rec, description: "", expr: null, firedAt: now, scheduledFor: now, trigger: "event", events: started[0]!.events!, lateByMs: 0, tz: "UTC" });
    expect(wake.text).not.toContain(SECRET);
  });

  it("the webhook body saved to .bot/events and the event text are redacted", async () => {
    const key = newWebhookKey();
    const UUID = "3f2a9c1e-0000-4000-8000-000000000003";
    const rec = { botId: "b1", id: "hook", defHash: "h", def: { name: "Hook", prompt: "p", trigger: { webhook: {} }, enabled: true, createdAt: 0, webhook: { routineUuid: UUID, keyHash: hashKey(key), keyPreview: keyPreview(key) } } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "redact-ws-"));
    const eventsDir = path.join(root, ".bot", "events");
    const got: TriggerEvent[] = [];
    const server: http.Server = createWebhookServer({
      routines: { byWebhookUuid: () => rec } as unknown as RoutineService, store: { get: () => rec } as unknown as RoutineStore,
      queue: { ingest: (ev: TriggerEvent) => { got.push(ev); return [{ botId: "b1", routineId: "hook", runId: "r1", duplicate: false }]; } } as unknown as EventQueue,
      eventsDir, eventsRoot: root, now: () => 1, redact,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const big = JSON.stringify({ t: SECRET, blob: "x".repeat(20_000) });
    await fetch(`${base}/hooks/${UUID}`, { method: "POST", body: big, headers: { "content-type": "application/json", authorization: `Bearer ${key}` } });
    await new Promise<void>((r) => server.close(() => r()));
    expect(JSON.stringify(got)).not.toContain(SECRET);
    const [f] = fs.readdirSync(path.join(eventsDir, "b1"));
    expect(fs.readFileSync(path.join(eventsDir, "b1", f!), "utf8")).not.toContain(SECRET);
  });

  it("the connector-secret store lists Slack/GitHub tokens, signing secrets and IMAP passwords for the scanner", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const s = new ConnectorSecrets(cfg.hostPrivate);
    s.set("b1", "slack", { appToken: "xapp-111111111", botToken: SECRET, signingSecret: "slack-sign-123456" });
    fs.writeFileSync(path.join(s.dir("b1"), "imap-work.json"), JSON.stringify({ label: "work", host: "h", port: 993, user: "u", appPassword: "imap-pass-99887766" }));
    const names = s.values("b1").map((v) => `${v.name}=${v.value}`).sort();
    expect(names).toEqual([`IMAP_PASSWORD=imap-pass-99887766`, `SLACK_APP_TOKEN=xapp-111111111`, `SLACK_BOT_TOKEN=${SECRET}`, "WEBHOOK_SIGNING_SECRET=slack-sign-123456"]);
  });
});
