import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { LIMITS } from "@synapse/shared";
import { eventRunId } from "../routines/engine";
import type { RoutineRecord, RoutineStore } from "../routines/routine-store";
import type { RoutineService } from "../routines/routine-service";
import { verifyKey } from "../routines/webhook-keys";
import { writeHostOwnedFile } from "../util/host-owned-file";
import { log } from "../util/log";
import type { EventQueue } from "./event-queue";
import { TokenBucket } from "./rate-limit";
import { verifyProviderSignature } from "./signatures";
import type { TriggerEvent } from "./types";
import type { Trigger } from "@synapse/shared";

export type SigningProvider = "github" | "slack" | "linear" | "sentry";
export type WebhookAdapt = (r: RoutineRecord, headers: http.IncomingHttpHeaders, body: Buffer) => { event: TriggerEvent } | { respond: { status: number; body: unknown } } | null;

export interface WebhookServerDeps {
  routines: RoutineService;
  store: RoutineStore;
  queue: EventQueue;
  eventsDir: string;
  now(): number;
  signingSecret?(botId: string, routineId: string): { provider: SigningProvider; secret: string } | null;
  adapt?: WebhookAdapt;
  /** Minor ruling: oversized bodies go under eventsDir only when every directory from this root down is real (no links). Default: eventsDir's parent. */
  eventsRoot?: string;
  /** I10: secret values are redacted from the event text before it is stored or rendered. */
  redact?(botId: string, text: string): string;
}

const SIGNED = ["github", "slack", "linear", "sentry"] as const;
const leavesOf = (t: Trigger | undefined): Trigger[] => (!t ? [] : "group" in t ? t.group.listeners.flatMap(leavesOf) : [t]);
/** I4: providers that sign their deliveries and can't send an Authorization header. */
const signedProviders = (t: Trigger | undefined): SigningProvider[] => SIGNED.filter((p) => leavesOf(t).some((l) => p in l));
const acceptsHeader = (t: Trigger | undefined): boolean => leavesOf(t).some((l) => "webhook" in l || "pagerduty" in l);
const DUMMY_HASH = "0".repeat(64);

const one = (h: http.IncomingHttpHeaders, n: string) => { const v = h[n]; return Array.isArray(v) ? v[0] : v; };

export function webhookEventId(h: http.IncomingHttpHeaders, body: Buffer, nowMs: number): string {
  // I4: with no sender id, the body hash alone is the id, so the queue's 24 h dedupe window applies to it.
  void nowMs;
  return one(h, "idempotency-key") ?? one(h, "x-request-id") ?? createHash("sha256").update(body).digest("hex").slice(0, 32);
}

export function headTail(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor((max - 64) / 2);
  return { text: `${text.slice(0, half)}\n… [${text.length - 2 * half} chars omitted] …\n${text.slice(-half)}`, truncated: true };
}

type BodyKind = "json" | "text" | "form";
function kindOf(contentType: string | undefined, empty: boolean): BodyKind | null {
  const t = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (t === "application/json" || t.endsWith("+json")) return "json";
  if (t === "text/plain") return "text";
  if (t === "application/x-www-form-urlencoded") return "form";
  return empty && !t ? "text" : null;
}

function render(kind: BodyKind, body: Buffer): { text: string; json: unknown } {
  const s = body.toString("utf8");
  if (kind === "form") { const v = Object.fromEntries(new URLSearchParams(s)); return { text: JSON.stringify(v, null, 2), json: v }; }
  if (kind === "json") {
    try { const v: unknown = JSON.parse(s); return { text: JSON.stringify(v, null, 2), json: v }; } catch { return { text: s, json: null }; }
  }
  return { text: s, json: null };
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** RTN-11 webhook listener (port 47801 in the box; reachable from the Mac/LAN, or the internet through the optional tunnel). */
export function createWebhookServer(d: WebhookServerDeps): http.Server {
  const perRoutine = new TokenBucket(LIMITS.webhookRatePerRoutinePerMin, LIMITS.webhookBurstPerRoutine, d.now);
  const account = new TokenBucket(LIMITS.webhookRatePerAccountPerMin, LIMITS.webhookRatePerAccountPerMin, d.now);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://hooks.local");
    const m = /^\/hooks\/([A-Za-z0-9-]{8,64})$/.exec(url.pathname);
    const early = (status: number, body: unknown, headers?: Record<string, string>) => { req.resume(); send(res, status, body, headers); };
    if (!m) return early(404, { accepted: false, reason: "not_found" });
    if (req.method !== "POST") return early(405, { accepted: false, reason: "method_not_allowed" }, { allow: "POST" });
    // Minor ruling: authenticate before revealing whether a routine exists — unknown, keyless and wrong key all get the same 401.
    const found = d.routines.byWebhookUuid(m[1]!);
    const r = found ? d.store.get(found.botId, found.id) : null;
    const bearer = /^Bearer\s+(\S+)$/i.exec(one(req.headers, "authorization") ?? "")?.[1];
    const providers = signedProviders(r?.def.trigger);
    // I4: ?key= only where the sender can't set a header (signed provider deliveries); never logged.
    const key = bearer ?? (providers.length ? url.searchParams.get("key") : null);
    const keyOk = verifyKey(key ?? "", r?.def.webhook?.keyHash ?? DUMMY_HASH);
    if (!r?.def.webhook || !key || !keyOk) return early(401, { accepted: false, reason: "unauthorized" });

    for (const [bucket, k] of [[perRoutine, r.def.webhook.routineUuid], [account, "account"]] as const) {
      const t = bucket.take(k);
      if (!t.ok) return early(429, { accepted: false, reason: "rate_limited" }, { "retry-after": String(t.retryAfterS) });
    }

    if (Number(one(req.headers, "content-length") ?? 0) > LIMITS.webhookBodyMax) return early(413, { accepted: false, reason: "too_large" });
    const body = await readBody(req, LIMITS.webhookBodyMax);
    if (!body) return send(res, 413, { accepted: false, reason: "too_large" });
    if (!r.def.enabled) return send(res, 409, { accepted: false, reason: "routine_paused" });
    const kind = kindOf(one(req.headers, "content-type"), body.length === 0);
    if (!kind) return send(res, 415, { accepted: false, reason: "unsupported_media_type" });
    const now = d.now();
    const sig = d.signingSecret?.(r.botId, r.id) ?? null;
    // I4: a provider routine REQUIRES its signing secret (unless a generic listener in the group got a Bearer header).
    if (providers.length && !(bearer && acceptsHeader(r.def.trigger))) {
      if (!sig) return send(res, 401, { accepted: false, reason: "signing_secret_required" });
      if (!verifyProviderSignature(sig.provider, sig.secret, req.headers, body, now)) return send(res, 401, { accepted: false, reason: "bad_signature" });
    } else if (sig && !verifyProviderSignature(sig.provider, sig.secret, req.headers, body, now)) return send(res, 401, { accepted: false, reason: "bad_signature" });

    const adapted = d.adapt?.(r, req.headers, body) ?? null;
    if (adapted && "respond" in adapted) return send(res, adapted.respond.status, adapted.respond.body);
    const ev = adapted?.event ?? toWebhookEvent(r, req.headers, body, kind, now, { dir: d.eventsDir, root: d.eventsRoot ?? path.dirname(d.eventsDir), redact: (t) => d.redact?.(r.botId, t) ?? t });
    const hit = d.queue.ingest(ev, { botId: r.botId, routineId: r.id })[0];
    if (!hit) return send(res, 409, { accepted: false, reason: "trigger_no_longer_matches" });
    if (hit.duplicate) return send(res, 200, { accepted: true, duplicate: true });
    send(res, 200, { accepted: true, runId: hit.runId });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error("webhook failed", { error: String(e) });
      if (!res.headersSent) send(res, 500, { accepted: false, reason: "internal_error" });
    });
  });
}

function toWebhookEvent(r: RoutineRecord, h: http.IncomingHttpHeaders, body: Buffer, kind: BodyKind, now: number, o: { dir: string; root: string; redact(t: string): string }): TriggerEvent {
  const eventId = webhookEventId(h, body, now);
  const rendered = render(kind, body);
  const text = o.redact(rendered.text);
  const cut = headTail(text, LIMITS.webhookInlineMax);
  let shown = cut.text;
  if (cut.truncated) {
    // I7: one folder per Bot, so deleting the Bot removes its event bodies
    // Final secfix round 3 (ruling 4): 0640 under /workspace/.host-out/events, so the Bot can read the file it is told about.
    const file = writeHostOwnedFile(o.root, path.join(o.dir, r.botId), `${eventRunId(r.botId, r.id, "webhook", eventId)}.json`, o.redact(body.toString("utf8")), 0o640);
    shown += file ? `\n(Full body saved to ${file})` : "\n(The full body was not saved.)";
  }
  const json = rendered.json;
  const redactJson = (v: unknown): unknown => { try { return JSON.parse(o.redact(JSON.stringify(v))) as unknown; } catch { return o.redact(JSON.stringify(v)); } };
  const rawBody = json !== null && JSON.stringify(json).length <= 32 * 1024 ? redactJson(json) : o.redact(body.toString("utf8").slice(0, 32 * 1024));
  return {
    source: "webhook", eventId, occurredAt: now, text: shown, routineUuid: r.def.webhook?.routineUuid,
    raw: { contentType: kind, body: rawBody, userAgent: one(h, "user-agent") ?? null },
  };
}
