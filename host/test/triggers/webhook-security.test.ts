import { createHmac } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import type { RoutineService } from "../../routines/routine-service";
import { hashKey, keyPreview, newWebhookKey } from "../../routines/webhook-keys";
import type { EventQueue } from "../../triggers/event-queue";
import type { TriggerEvent } from "../../triggers/types";
import { createWebhookServer, type SigningProvider } from "../../triggers/webhook-server";
import { log } from "../../util/log";

const UUID = "3f2a9c1e-0000-4000-8000-000000000002";
let server: http.Server;
let base: string;
let key: string;
let rec: RoutineRecord | null;
let ingested: TriggerEvent[];
let eventsDir: string;
let now: number;
let signing: { provider: SigningProvider; secret: string } | null;

beforeEach(async () => {
  now = 1_700_000_000_000;
  key = newWebhookKey();
  rec = { botId: "b1", id: "hook", defHash: "h", def: { name: "Hook", prompt: "p", trigger: { webhook: {} }, enabled: true, createdAt: 0, webhook: { routineUuid: UUID, keyHash: hashKey(key), keyPreview: keyPreview(key) } } };
  ingested = [];
  signing = null;
  eventsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hooks-sec-")), "events");
  const seen = new Set<string>();
  const queue = {
    ingest: (ev: TriggerEvent) => {
      const dup = seen.has(ev.eventId);
      seen.add(ev.eventId);
      if (!dup) ingested.push(ev);
      return [{ botId: "b1", routineId: "hook", runId: `run-${ingested.length}`, duplicate: dup }];
    },
  } as unknown as EventQueue;
  server = createWebhookServer({
    routines: { byWebhookUuid: (u: string) => (u === UUID ? rec : null) } as unknown as RoutineService,
    store: { get: () => rec } as unknown as RoutineStore,
    queue, eventsDir, now: () => now, signingSecret: () => signing,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const post = (p: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  fetch(`${base}${p}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
const bearer = (k = key) => ({ authorization: `Bearer ${k}` });
const ghSig = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("I4: provider webhooks require a signing secret", () => {
  it("a GitHub routine with no signing secret refuses even a valid key (401)", async () => {
    rec!.def.trigger = { github: { repo: "o/r", events: ["prOpened"] } };
    const res = await post(`/hooks/${UUID}?key=${key}`, "{}", { "x-github-event": "pull_request", "x-github-delivery": "d1" });
    expect(res.status).toBe(401);
    expect(ingested).toHaveLength(0);
  });
  it("unsigned or badly signed → 401; correctly signed → 200 (?key= is allowed where the provider can't send a header)", async () => {
    rec!.def.trigger = { github: { repo: "o/r", events: ["prOpened"] } };
    signing = { provider: "github", secret: "gh-secret" };
    const body = '{"zen":"x"}';
    expect((await post(`/hooks/${UUID}?key=${key}`, body, { "x-github-delivery": "d1" })).status).toBe(401);
    expect((await post(`/hooks/${UUID}?key=${key}`, body, { "x-github-delivery": "d2", "x-hub-signature-256": ghSig("wrong", body) })).status).toBe(401);
    expect((await post(`/hooks/${UUID}?key=${key}`, body, { "x-github-delivery": "d3", "x-hub-signature-256": ghSig("gh-secret", body) })).status).toBe(200);
  });
  it("Linear and Sentry routines need their signature too", async () => {
    for (const trigger of [{ linear: { event: "issueCreated" } }, { sentry: { event: "issue.created" } }] as const) {
      rec!.def.trigger = trigger;
      signing = null;
      expect((await post(`/hooks/${UUID}`, "{}", bearer())).status).toBe(401);
    }
  });
});

describe("I4: generic webhooks", () => {
  it("reject ?key= in the URL (a header is possible) and never log the query string", async () => {
    const spies = (["info", "warn", "error"] as const).map((l) => vi.spyOn(log, l));
    const res = await post(`/hooks/${UUID}?key=${key}`, "{}", { "idempotency-key": "q1" });
    expect(res.status).toBe(401);
    expect(ingested).toHaveLength(0);
    for (const s of spies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toContain(key);
    for (const s of spies) s.mockRestore();
  });
  it("dedupes the same body for 24 hours when the sender gives no id", async () => {
    expect(await (await post(`/hooks/${UUID}`, '{"n":1}', bearer())).json()).toMatchObject({ accepted: true });
    now += 2 * 3_600_000;
    expect(await (await post(`/hooks/${UUID}`, '{"n":1}', bearer())).json()).toEqual({ accepted: true, duplicate: true });
  });
});

describe("Minor: webhook-server hardening", () => {
  it("authenticates before revealing whether a routine exists (uniform 401)", async () => {
    const unknown = await post("/hooks/00000000-0000-4000-8000-00000000dead", "{}", bearer());
    const wrong = await post(`/hooks/${UUID}`, "{}", bearer("bot_wrong"));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    rec!.def.webhook = undefined;
    expect((await post(`/hooks/${UUID}`, "{}", bearer())).status).toBe(401);
  });
  it("an oversized body is saved with O_EXCL|O_NOFOLLOW under a host-owned directory, never through a symlink", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
    fs.mkdirSync(path.dirname(eventsDir), { recursive: true });
    fs.symlinkSync(elsewhere, eventsDir); // the Bot swapped the events dir for a link
    const big = JSON.stringify({ blob: "x".repeat(20_000) });
    const res = await post(`/hooks/${UUID}`, big, { ...bearer(), "idempotency-key": "big1" });
    expect(res.status).toBe(200);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(ingested[0]!.text).toContain("chars omitted");
    expect(ingested[0]!.text).not.toContain("Full body saved");
  });
  it("a planted file at the target name is never overwritten", async () => {
    fs.mkdirSync(eventsDir, { recursive: true, mode: 0o755 });
    const big = JSON.stringify({ blob: "y".repeat(20_000) });
    await post(`/hooks/${UUID}`, big, { ...bearer(), "idempotency-key": "big2" });
    const [name] = fs.readdirSync(path.join(eventsDir, "b1"));
    const file = path.join(eventsDir, "b1", name!);
    expect(fs.readFileSync(file, "utf8")).toBe(big);
    const target = path.join(os.tmpdir(), `victim-${process.pid}-${Date.now()}`);
    fs.writeFileSync(target, "keep");
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    rec!.def.enabled = true;
    // the same event id again: a duplicate in the queue, and in any case the planted link is not followed
    await post(`/hooks/${UUID}`, big, { ...bearer(), "idempotency-key": "big2" });
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  });
});

describe("I5: the listener binds to 127.0.0.1 by default", () => {
  it("defaults to 127.0.0.1:47801; LAN only by an explicit setting", () => {
    expect(loadConfig({})).toMatchObject({ webhookBind: "127.0.0.1", webhookPort: 47801 });
    expect(loadConfig({ WEBHOOK_BIND: "0.0.0.0" })).toMatchObject({ webhookBind: "0.0.0.0" });
  });
});

describe("I5: LAN exposure is an explicit setting", () => {
  it("the host setting defaults off; the bind address follows it", async () => {
    const { HostSettingsStore } = await import("../../store/host-settings");
    const { webhookBindAddress } = await import("../../phase4");
    const s = new HostSettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lan-")), "settings.json"));
    expect(s.view().webhookLan).toBe(false);
    expect(webhookBindAddress("127.0.0.1", s.get().webhookLan)).toBe("127.0.0.1");
    expect(s.update({ webhookLan: true }).webhookLan).toBe(true);
    expect(webhookBindAddress("127.0.0.1", s.get().webhookLan)).toBe("0.0.0.0");
  });
});
