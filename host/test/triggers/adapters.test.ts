import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import type { BotService } from "../../bots/bot-service";
import type { TurnRunner } from "../../runner/turn-runner";
import { TriggerAdapters, listenerHandlers } from "../../triggers/adapters";
import type { EventQueue } from "../../triggers/event-queue";
import type { TriggerEvent } from "../../triggers/types";
import { tmpConfig } from "../helpers";

function make(recs: RoutineRecord[]) {
  const cfg = tmpConfig();
  const a = new TriggerAdapters({
    cfg, store: { all: () => recs } as unknown as RoutineStore, queue: { ingest: () => [] } as unknown as EventQueue,
    bots: { auxEntryIds: () => ["t9a1"], appendEntry: () => {}, getEntry: () => null, updateEntry: () => {} } as unknown as BotService,
    runner: { enqueueWake: () => "t" } as unknown as TurnRunner, acks: null, now: () => 1000,
    setTimer: () => 0, clearTimer: () => {}, exec: async () => { throw new Error("gh not signed in"); }, fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
  });
  return { a, cfg };
}
const rec = (trigger: RoutineRecord["def"]["trigger"]): RoutineRecord => ({ botId: "b1", id: "r1", defHash: "h", def: { name: "R", prompt: "p", trigger, enabled: true, createdAt: 0, webhook: { routineUuid: "u", keyHash: "k", keyPreview: "abcd" } } });
const recFor = (botId: string, id: string, trigger: RoutineRecord["def"]["trigger"]): RoutineRecord => ({ ...rec(trigger), botId, id });
const B = (o: unknown) => Buffer.from(JSON.stringify(o));

describe("TriggerAdapters", () => {
  it("stores listener credentials 0600 and reports connection", async () => {
    const { a, cfg } = make([]);
    const h = listenerHandlers(a);
    expect(() => h.setListenerCredentials!({ id: "b1", platform: "slack", fields: { appToken: "nope", botToken: "xoxb-1" } })).toThrow("Slack needs an app-level token (xapp-…) and a bot token (xoxb-…).");
    expect(await h.setListenerCredentials!({ id: "b1", platform: "slack", fields: { appToken: "xapp-1", botToken: "xoxb-1" } })).toEqual({ connected: true });
    const file = path.join(cfg.hostPrivate, "connector-secrets", "b1", "slack.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(a.isConnected("b1", "github")).toBe(false);
    a.setCredentials("b1", "github", { token: "ghp_abc" });
    expect(a.isConnected("b1", "github")).toBe(true);
    a.stop();
  });

  it("adapts provider webhooks: GitHub ping and events, Slack challenge, Linear, PagerDuty; generic webhooks pass through", () => {
    const gh = make([]).a.adaptWebhook;
    const r = rec({ github: { repo: "a/b", events: ["prOpened"] } });
    expect(gh(r, { "x-github-event": "ping" }, B({ zen: "x" }))).toEqual({ respond: { status: 200, body: { ok: true } } });
    const e = gh(r, { "x-github-event": "pull_request", "x-github-delivery": "d-1" }, B({ action: "opened", pull_request: { number: 1, title: "T", head: { ref: "f" } }, repository: { full_name: "a/b" }, sender: { login: "octo" } }));
    expect(e).toMatchObject({ event: { source: "github", eventId: "d-1", kind: "prOpened", repo: "a/b", actor: "octo" } });
    expect(gh(rec({ slack: { channel: "*", match: "mention" } }), {}, B({ type: "url_verification", challenge: "abc" }))).toEqual({ respond: { status: 200, body: { challenge: "abc" } } });
    expect(gh(rec({ linear: { event: "issueCreated" } }), { "linear-delivery": "L1" }, B({ type: "Issue", action: "create", data: { title: "Bug", teamId: "T1" }, url: "https://linear.app/x" }))).toMatchObject({ event: { source: "linear", eventId: "L1", kind: "issueCreated", raw: { teamId: "T1" } } });
    expect(gh(rec({ pagerduty: { event: "incident.triggered" } }), {}, B({ event: { id: "P1", event_type: "incident.triggered", data: { title: "DB down", service: { id: "S1" } } } }))).toMatchObject({ event: { source: "pagerduty", eventId: "P1", kind: "incident.triggered", raw: { serviceId: "S1" } } });
    expect(gh(rec({ webhook: {} }), {}, B({ any: 1 }))).toBeNull();
  });

  it("posts a connect card for a new Slack routine that isn't connected", () => {
    const appended: unknown[] = [];
    const { a } = make([rec({ slack: { channel: "#ops", match: "mention" } })]);
    (a as unknown as { d: { bots: { appendEntry: (id: string, e: unknown) => void } } }).d.bots.appendEntry = (_id, e) => appended.push(e);
    a.sync();
    expect(appended).toHaveLength(1);
    a.sync();
    expect(appended).toHaveLength(1);
    a.stop();
  });

  it("I9: GitHub pollers are keyed by (botId, repo) and use only that Bot's credentials", () => {
    let recs: RoutineRecord[] = [recFor("bot1", "r1", { github: { repo: "a/b", events: ["prOpened"] } })];
    const cfg = tmpConfig();
    const ingested: { botId: string; routineId: string }[] = [];
    const envs: Record<string, string>[] = [];
    const a = new TriggerAdapters({
      cfg, store: { all: () => recs } as unknown as RoutineStore,
      queue: { ingest: (_ev: TriggerEvent, only?: { botId: string; routineId: string }) => { if (only) ingested.push(only); return []; } } as unknown as EventQueue,
      bots: { auxEntryIds: () => ["t9a1"], appendEntry: () => {}, getEntry: () => null, updateEntry: () => {} } as unknown as BotService,
      runner: { enqueueWake: () => "t" } as unknown as TurnRunner, acks: null, now: () => 1000,
      setTimer: () => 0, clearTimer: () => {}, exec: async (_c, _a, env) => { envs.push(env); throw new Error("gh not signed in"); },
      fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
    });
    a.sync();
    recs = [...recs, recFor("bot2", "r2", { github: { repo: "a/b", events: ["prOpened"] } }), recFor("bot1", "r3", { github: { repo: "a/b", events: ["prMerged"] } })];
    a.setCredentials("bot2", "github", { token: "ghp_bot2" });
    const pollers = (a as unknown as { github: Map<string, { d: { token(): string | null; onEvent(ev: TriggerEvent): void } }> }).github;
    expect(pollers.size).toBe(2);
    const p1 = [...pollers.entries()].find(([k]) => k.startsWith("bot1"))![1];
    const p2 = [...pollers.entries()].find(([k]) => k.startsWith("bot2"))![1];
    expect(p1.d.token()).toBeNull(); // never bot2's token
    expect(p2.d.token()).toBe("ghp_bot2");
    p1.d.onEvent({ source: "github", eventId: "E1", occurredAt: 1, text: "x", raw: {}, kind: "prOpened", repo: "a/b" });
    expect(ingested).toEqual([{ botId: "bot1", routineId: "r1" }, { botId: "bot1", routineId: "r3" }]);
    // gh auth token: a minimal env and a host-owned GH_CONFIG_DIR
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(Object.keys(env).sort()).toEqual(["GH_CONFIG_DIR", "HOME", "PATH", "TMPDIR"]);
      expect(env.GH_CONFIG_DIR!.startsWith(cfg.hostPrivate)).toBe(true);
      // bug-log 128: gh's own temp and state files stay under the host's gh dir too
      expect(env.HOME!.startsWith(cfg.hostPrivate)).toBe(true);
      expect(env.TMPDIR!.startsWith(cfg.hostPrivate)).toBe(true);
    }
    a.stop();
  });

  it("a Slack socket's onEvent delivers to a routine added for the bot after the socket already exists (no stale closure)", () => {
    let recs: RoutineRecord[] = [recFor("bot1", "r1", { slack: { channel: "#ops", match: "mention" } })];
    const cfg = tmpConfig();
    const ingested: { botId: string; routineId: string }[] = [];
    const a = new TriggerAdapters({
      cfg, store: { all: () => recs } as unknown as RoutineStore,
      queue: { ingest: (_ev: TriggerEvent, only?: { botId: string; routineId: string }) => { if (only) ingested.push(only); return []; } } as unknown as EventQueue,
      bots: { auxEntryIds: () => ["t9a1"], appendEntry: () => {}, getEntry: () => null, updateEntry: () => {} } as unknown as BotService,
      runner: { enqueueWake: () => "t" } as unknown as TurnRunner, acks: null, now: () => 1000,
      setTimer: () => 0, clearTimer: () => {}, exec: async () => { throw new Error("gh not signed in"); },
      fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
    });
    a.setCredentials("bot1", "slack", { appToken: "xapp-1", botToken: "xoxb-1" }); // sync() creates the socket for bot1 with routines=[r1]
    recs = [...recs, recFor("bot1", "r2", { slack: { channel: "#dev", match: "mention" } })];
    a.sync(); // socket for bot1 already exists so isn't recreated
    const socket = (a as unknown as { slack: Map<string, { d: { onEvent(ev: TriggerEvent): void } }> }).slack.get("bot1")!;
    socket.d.onEvent({ source: "slack", eventId: "E1", occurredAt: 1, text: "hi", raw: {}, kind: "mention" });
    expect(ingested.map((x) => x.routineId).sort()).toEqual(["r1", "r2"]);
    a.stop();
  });

  it("bug-log 128: stop() ends an in-flight `gh auth token` and waits for it; nothing runs gh after stop", async () => {
    const cfg = tmpConfig();
    const calls: (AbortSignal | undefined)[] = [];
    let settled = false;
    const a = new TriggerAdapters({
      cfg, store: { all: () => [] } as unknown as RoutineStore, queue: { ingest: () => [] } as unknown as EventQueue,
      bots: { auxEntryIds: () => [], appendEntry: () => {}, getEntry: () => null, updateEntry: () => {} } as unknown as BotService,
      runner: { enqueueWake: () => "t" } as unknown as TurnRunner, acks: null, now: () => 1000, setTimer: () => 0, clearTimer: () => {},
      // gh that only ends when it is told to (a slow start under load outlived the test file and wrote its
      // device-id into a temp root that had already been removed)
      exec: (_c, _a, _env, signal) => new Promise((_resolve, reject) => {
        calls.push(signal);
        signal?.addEventListener("abort", () => setTimeout(() => { settled = true; reject(new Error("killed")); }, 20));
      }),
    });
    a.sync();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(AbortSignal);
    await a.stop();
    expect(calls[0]!.aborted).toBe(true);
    expect(settled).toBe(true); // stop() returned only once gh had ended
    a.sync();
    await a.refreshGhToken();
    expect(calls).toHaveLength(1);
  });
});

describe("I4: provider signing secrets through the listener connect flow", () => {
  it("stores a signing secret sealed (never plaintext on disk) and hands it to the webhook server", () => {
    const { a, cfg } = make([]);
    const h = listenerHandlers(a);
    h.setListenerCredentials!({ id: "b1", platform: "linear", fields: { signingSecret: "lin-signing-secret-1" } });
    const file = path.join(cfg.hostPrivate, "connector-secrets", "b1", "linear.json");
    expect(fs.readFileSync(file, "utf8")).not.toContain("lin-signing-secret-1");
    expect(a.signingSecret("b1", "linear")).toBe("lin-signing-secret-1");
    expect(a.signingSecret("b1", "sentry")).toBeNull();
    expect(() => h.setListenerCredentials!({ id: "b1", platform: "sentry", fields: {} })).toThrow(/signing secret/);
    // GitHub: a signing secret alone is enough for webhook delivery, and tokens stay sealed too
    a.setCredentials("b1", "github", { token: "ghp_sealed_token", signingSecret: "gh-sign" });
    const gh = fs.readFileSync(path.join(cfg.hostPrivate, "connector-secrets", "b1", "github.json"), "utf8");
    expect(gh).not.toContain("ghp_sealed_token");
    expect(a.credentials("b1", "github")).toMatchObject({ token: "ghp_sealed_token", signingSecret: "gh-sign" });
    a.stop();
  });
});

/**
 * Bug 51's siblings, found by its sweep. `isConnected()` answered "are credentials saved?", so a
 * GitHub token that was revoked (every poll: 401) or a Slack app token that no longer opens a socket
 * kept `listenerConnected: true` — RoutineDetail hides Connect listener, the routine reads Active, and
 * the only trace was `log.warn("github events request failed")` / `("slack socket failed to start")`.
 */
describe("a listener whose saved credentials keep failing stops reading as connected (bug 51, the GitHub and Slack siblings)", () => {
  function live(fetchFn: (url: string) => Response, recs: RoutineRecord[]) {
    const timers: (() => void)[] = [];
    const health: string[][] = [];
    const a = new TriggerAdapters({
      cfg: tmpConfig(), store: { all: () => recs } as unknown as RoutineStore, queue: { ingest: () => [] } as unknown as EventQueue,
      bots: { auxEntryIds: () => ["t9a1"], appendEntry: () => {}, getEntry: () => null, updateEntry: () => {} } as unknown as BotService,
      runner: { enqueueWake: () => "t" } as unknown as TurnRunner, acks: null, now: () => 1000,
      setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
      exec: async () => { throw new Error("gh not signed in"); },
      fetch: (async (u: string) => fetchFn(String(u))) as unknown as typeof fetch,
      ws: () => ({ addEventListener: () => {}, send: () => {}, close: () => {} }) as never,
      onHealthChange: (ids) => health.push(ids),
    });
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
    const tick = async () => { const fns = timers.splice(0); for (const f of fns) f(); await settle(); };
    return { a, health, settle, tick };
  }
  const gh = (id: string) => recFor("b1", id, { github: { repo: "a/b", events: ["prOpened"] } });
  const slack = (id: string) => recFor("b1", id, { slack: { channel: "#ops", match: "mention" } });

  it("GitHub: after N refused polls the routine offers Connect listener again, and a new token clears it", async () => {
    let status = 401;
    const t = live(() => new Response("{}", { status }), [gh("r1")]);
    t.a.setCredentials("b1", "github", { token: "ghp_revoked" });
    await t.settle();
    expect(t.a.isConnected("b1", "github"), "one refused poll is a retry, not a broken listener").toBe(true);
    await t.tick(); await t.tick();
    expect(t.a.isConnected("b1", "github"), "a revoked token polled forever while the row claimed it was connected").toBe(false);
    expect(t.health, "the routine's row is never republished, so it keeps showing the stale state").toContainEqual(["b1"]);
    status = 304;
    t.a.setCredentials("b1", "github", { token: "ghp_new" });
    expect(t.a.isConnected("b1", "github"), "entering a new token is the action; it has to take effect").toBe(true);
    t.a.stop();
  });

  it("Slack: a socket that keeps failing to open stops reading as connected", async () => {
    const t = live((u) => new Response(JSON.stringify(u.includes("apps.connections.open") ? { ok: false, error: "invalid_auth" } : { ok: true, user_id: "U1" })), [slack("r1")]);
    t.a.setCredentials("b1", "slack", { appToken: "xapp-revoked", botToken: "xoxb-1" });
    await t.settle();
    expect(t.a.isConnected("b1", "slack")).toBe(true);
    await t.tick(); await t.tick();
    expect(t.a.isConnected("b1", "slack"), "invalid_auth on every reconnect, and the row still said connected").toBe(false);
    t.a.stop();
  });

  it("healthy polls and a socket that opens never flip the row (must not fire)", async () => {
    const t = live((u) => (u.includes("slack.com") ? new Response(JSON.stringify({ ok: true, user_id: "U1", url: "wss://x" })) : new Response(null, { status: 304 })), [gh("r1"), slack("r2")]);
    t.a.setCredentials("b1", "github", { token: "ghp_ok" });
    t.a.setCredentials("b1", "slack", { appToken: "xapp-1", botToken: "xoxb-1" });
    for (let i = 0; i < 5; i++) await t.tick();
    expect(t.a.isConnected("b1", "github")).toBe(true);
    expect(t.a.isConnected("b1", "slack")).toBe(true);
    expect(t.health).toEqual([]);
    t.a.stop();
  });
});
