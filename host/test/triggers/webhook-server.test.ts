import { createHmac } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import type { RoutineService } from "../../routines/routine-service";
import { hashKey, keyPreview, newWebhookKey } from "../../routines/webhook-keys";
import { HostSettingsStore } from "../../store/host-settings";
import type { EventQueue } from "../../triggers/event-queue";
import { TokenBucket } from "../../triggers/rate-limit";
import { verifyGithubSignature, verifySlackSignature } from "../../triggers/signatures";
import type { TriggerEvent } from "../../triggers/types";
import { createWebhookServer, type SigningProvider } from "../../triggers/webhook-server";

const UUID = "3f2a9c1e-0000-4000-8000-000000000001";
let server: http.Server;
let base: string;
let key: string;
let rec: RoutineRecord;
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
  eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-"));
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

describe("webhook endpoint (RTN-11, ORIG-04 §04.2)", () => {
  it("auth matrix: missing, wrong, bearer, ?key= (refused for a generic webhook, I4), rotated", async () => {
    expect((await post(`/hooks/${UUID}`, "{}")).status).toBe(401);
    expect((await post(`/hooks/${UUID}`, "{}", bearer("bot_wrong"))).status).toBe(401);
    const ok = await post(`/hooks/${UUID}`, "{}", { ...bearer(), "idempotency-key": "a" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accepted: true, runId: "run-1" });
    expect((await post(`/hooks/${UUID}?key=${key}`, "{}", { "idempotency-key": "b" })).status).toBe(401);
    const fresh = newWebhookKey();
    rec.def.webhook = { routineUuid: UUID, keyHash: hashKey(fresh), keyPreview: keyPreview(fresh) };
    expect((await post(`/hooks/${UUID}`, "{}", bearer())).status).toBe(401);
    expect((await post(`/hooks/${UUID}`, "{}", { ...bearer(fresh), "idempotency-key": "c" })).status).toBe(200);
  });

  it("401 unknown routine (no existence oracle), 409 paused, 413 too big, 415 wrong type", async () => {
    expect((await post("/hooks/00000000-0000-4000-8000-00000000dead", "{}", bearer())).status).toBe(401);
    expect((await fetch(`${base}/other`, { method: "POST" })).status).toBe(404);
    rec.def.enabled = false;
    const paused = await post(`/hooks/${UUID}`, "{}", bearer());
    expect(paused.status).toBe(409);
    expect(await paused.json()).toEqual({ accepted: false, reason: "routine_paused" });
    rec.def.enabled = true;
    expect((await post(`/hooks/${UUID}`, Buffer.alloc(300 * 1024, 97), bearer())).status).toBe(413);
    expect((await post(`/hooks/${UUID}`, "x", { ...bearer(), "content-type": "image/png" })).status).toBe(415);
    expect(ingested).toHaveLength(0);
  });

  it("rate limit: burst 10 per routine, then 429 with Retry-After", async () => {
    for (let i = 0; i < 10; i++) expect((await post(`/hooks/${UUID}`, "{}", { ...bearer(), "idempotency-key": `r${i}` })).status).toBe(200);
    const res = await post(`/hooks/${UUID}`, "{}", { ...bearer(), "idempotency-key": "r10" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    now += 4000; // 30/min refills one token every 2 s
    expect((await post(`/hooks/${UUID}`, "{}", { ...bearer(), "idempotency-key": "r11" })).status).toBe(200);
  });

  it("dedupes by Idempotency-Key, X-Request-Id, else body hash (24 h, I4)", async () => {
    await post(`/hooks/${UUID}`, "{}", { ...bearer(), "idempotency-key": "same" });
    expect(await (await post(`/hooks/${UUID}`, "{}", { ...bearer(), "idempotency-key": "same" })).json()).toEqual({ accepted: true, duplicate: true });
    await post(`/hooks/${UUID}`, "{}", { ...bearer(), "x-request-id": "rq1" });
    expect(ingested.at(-1)!.eventId).toBe("rq1");
    await post(`/hooks/${UUID}`, '{"n":1}', bearer());
    expect(await (await post(`/hooks/${UUID}`, '{"n":1}', bearer())).json()).toEqual({ accepted: true, duplicate: true });
    now += 60_000;
    expect(await (await post(`/hooks/${UUID}`, '{"n":1}', bearer())).json()).toEqual({ accepted: true, duplicate: true });
  });

  it("pretty-prints JSON, converts forms, truncates head+tail at 8 KB and saves the full body", async () => {
    await post(`/hooks/${UUID}`, '{"a":1,"b":[2]}', { ...bearer(), "idempotency-key": "j" });
    expect(ingested[0]!.text).toBe(JSON.stringify({ a: 1, b: [2] }, null, 2));
    expect(ingested[0]).toMatchObject({ source: "webhook", eventId: "j", routineUuid: UUID, occurredAt: now });
    await post(`/hooks/${UUID}`, "a=1&b=two", { ...bearer(), "idempotency-key": "f", "content-type": "application/x-www-form-urlencoded" });
    expect(JSON.parse(ingested[1]!.text)).toEqual({ a: "1", b: "two" });
    const big = JSON.stringify({ blob: "x".repeat(20_000), tail: "END" });
    await post(`/hooks/${UUID}`, big, { ...bearer(), "idempotency-key": "big" });
    const t = ingested[2]!.text;
    expect(t.length).toBeLessThan(8 * 1024 + 300);
    expect(t).toContain("chars omitted");
    expect(t).toContain('"END"');
    const botEvents = path.join(eventsDir, "b1"); // I7: one folder per Bot
    const files = fs.readdirSync(botEvents);
    expect(files).toHaveLength(1);
    expect(t).toContain(path.join(botEvents, files[0]!));
    const savedPath = path.join(botEvents, files[0]!);
    expect(fs.readFileSync(savedPath, "utf8")).toBe(big);
    // RTN-11 fix round 1 (Task 18 finding 1): oversized-webhook-body file must be written
    // atomically (tmp + fsync + rename, same convention as writeTextAtomic/writeJsonAtomic)
    // and must not be world- or group-readable (third-party payloads can carry secrets).
    expect(fs.statSync(savedPath).mode & 0o777).toBe(0o640); // secfix round 3: the Bot reads the body it is pointed at (group bots)
  });

  it("verifies provider signatures when a signing secret is set", async () => {
    signing = { provider: "linear", secret: "lin-secret" };
    const body = '{"type":"Issue","action":"create"}';
    const good = createHmac("sha256", "lin-secret").update(body).digest("hex");
    expect((await post(`/hooks/${UUID}`, body, { ...bearer(), "linear-signature": "00" })).status).toBe(401);
    expect((await post(`/hooks/${UUID}`, body, { ...bearer(), "linear-signature": good })).status).toBe(200);
    signing = { provider: "sentry", secret: "sen" };
    const sbody = '{"action":"created"}';
    expect((await post(`/hooks/${UUID}`, sbody, { ...bearer(), "sentry-hook-signature": createHmac("sha256", "sen").update(sbody).digest("hex") })).status).toBe(200);
  });
});

describe("signature fixtures", () => {
  it("GitHub's documented X-Hub-Signature-256 vector", () => {
    const sig = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(verifyGithubSignature("It's a Secret to Everybody", Buffer.from("Hello, World!"), sig)).toBe(true);
    expect(verifyGithubSignature("wrong", Buffer.from("Hello, World!"), sig)).toBe(false);
    expect(verifyGithubSignature("It's a Secret to Everybody", Buffer.from("Hello, World!"), undefined)).toBe(false);
  });
  it("Slack's documented v0 vector and the 5-minute window", () => {
    const body = Buffer.from("token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c");
    const sig = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
    expect(verifySlackSignature("8f742231b10e8888abcd99yyyzzz85a5", body, "1531420618", sig, 1531420618_000)).toBe(true);
    expect(verifySlackSignature("8f742231b10e8888abcd99yyyzzz85a5", body, "1531420618", sig, 1531420618_000 + 301_000)).toBe(false);
  });
});

describe("TokenBucket", () => {
  it("account bucket: 120 per minute, then Retry-After, then refills at 2/s", () => {
    let t = 0;
    const b = new TokenBucket(120, 120, () => t);
    for (let i = 0; i < 120; i++) expect(b.take("account").ok).toBe(true);
    expect(b.take("account")).toEqual({ ok: false, retryAfterS: 1 });
    t = 30_000;
    let n = 0;
    while (b.take("account").ok) n++;
    expect(n).toBe(60);
  });
});

describe("config and settings", () => {
  it("webhook listener defaults to 127.0.0.1:47801 (I5)", () => {
    expect(loadConfig({})).toMatchObject({ webhookBind: "127.0.0.1", webhookPort: 47801 });
    expect(loadConfig({ WEBHOOK_PORT: "0", WEBHOOK_BIND: "127.0.0.1" })).toMatchObject({ webhookBind: "127.0.0.1", webhookPort: 0 });
  });
  it("persists the public webhook toggle and the tunnel URL", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hs-")), "settings.json");
    const s = new HostSettingsStore(file);
    expect(s.view().publicWebhook).toEqual({ enabled: false, url: null });
    s.update({ publicWebhook: { enabled: true, url: null } });
    s.setPublicWebhookUrl("https://calm-river.trycloudflare.com");
    expect(new HostSettingsStore(file).view().publicWebhook).toEqual({ enabled: true, url: "https://calm-river.trycloudflare.com" });
  });
});
