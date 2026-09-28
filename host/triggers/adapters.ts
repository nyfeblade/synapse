import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { LIMITS, type Trigger } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import type { RoutineStore } from "../routines/routine-store";
import type { TurnRunner } from "../runner/turn-runner";
import { ListenerConnectWatcher } from "./connect-watch";
import { ConnectorSecrets, type ConnectorPlatform } from "./connector-secrets";
import type { EventQueue } from "./event-queue";
import { GithubPoller, githubEvent, mapGithubEvent } from "./github";
import { SlackSocket, mapSlackEvent, type WsLike } from "./slack";
import type { TriggerEvent } from "./types";
import { log } from "../util/log";
import { obj, str, type O } from "./util";
import type { WebhookAdapt } from "./webhook-server";

type Platform = "slack" | "github";
const one = (h: http.IncomingHttpHeaders, n: string) => { const v = h[n]; return Array.isArray(v) ? v[0] : v; };
const leaves = (t: Trigger): Trigger[] => ("group" in t ? t.group.listeners.flatMap(leaves) : [t]);

export interface TriggerAdaptersDeps {
  cfg: HostConfig;
  store: RoutineStore;
  queue: EventQueue;
  bots: BotService;
  runner: TurnRunner;
  acks: { record(botId: string): unknown; token(botId: string): string | null } | null;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  fetch?: typeof fetch;
  ws?(url: string): WsLike;
  /** Runs gh. `signal` aborts it (stop()); the promise settles only once the process has ended. */
  exec?(cmd: string, args: string[], env: Record<string, string>, signal?: AbortSignal): Promise<string>;
  /** I4: the sealed connector-secret store (defaults to one over cfg.hostPrivate). */
  secrets?: ConnectorSecrets;
  onHealthChange?(botIds: string[]): void;
}

/**
 * I9: exactly the env given (never the host's own env with its token and secrets).
 * Settles when the process has EXITED, not when an abort is requested: execFile's callback fires on
 * abort while gh may still be running, and a gh that outlived its caller wrote its state files into a
 * directory that had already been removed (bug-log 128).
 */
const defaultExec = (cmd: string, args: string[], env: Record<string, string>, signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    let result: { e: Error | null; out: string } | null = null;
    let exited = false;
    const finish = () => { if (result && exited) (result.e ? reject(result.e) : resolve(result.out)); };
    const c = execFile(cmd, args, { env, timeout: 5000, signal }, (e, out) => { result = { e, out: String(out) }; if (c.pid === undefined) exited = true; finish(); });
    c.once("exit", () => { exited = true; finish(); });
  });

/**
 * I9: `gh auth token` runs with a minimal env and a host-owned GH_CONFIG_DIR (not the Bot-writable box home).
 * HOME (gh's ~/.local/state/gh) and TMPDIR sit under the same dir, so nothing gh writes lands elsewhere.
 */
export function ghEnv(hostPrivate: string): Record<string, string> {
  const dir = path.join(hostPrivate, "gh");
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir, GH_CONFIG_DIR: dir, TMPDIR: path.join(dir, "tmp") };
}

/** RTN-10 delivery adapters: GitHub polling, Slack Socket Mode, provider webhooks, RTN-12 connect cards. */
export class TriggerAdapters {
  private github = new Map<string, GithubPoller>(); // I9: keyed `${botId}\0${repo}`, one poller per Bot and repo
  private slack = new Map<string, SlackSocket>();
  private pollRoutines = new Map<string, string[]>(); // poller key → that Bot's routine ids on the repo, kept live across sync()s
  private botRoutines = new Map<string, { routineId: string }[]>(); // botId → routines, kept live for a running socket's onEvent
  private ghToken: string | null = null;
  /** In-flight `gh auth token` runs: stop() aborts them and waits for them to end. */
  private ghRuns = new Set<{ abort: AbortController; done: Promise<unknown> }>();
  private stopped = false;
  private seen = new Set<string>();
  readonly connect: ListenerConnectWatcher;
  readonly secrets: ConnectorSecrets;
  /** A listener's health changed: the Bot's routine rows are republished (phase4). */
  onHealthChange: ((botIds: string[]) => void) | undefined;

  constructor(private d: TriggerAdaptersDeps) {
    this.onHealthChange = d.onHealthChange;
    this.secrets = d.secrets ?? new ConnectorSecrets(d.cfg.hostPrivate);
    this.connect = new ListenerConnectWatcher({
      runner: d.runner, bots: d.bots, acks: d.acks, isConnected: (b, p) => this.isConnected(b, p), refresh: () => this.refreshGhToken(),
      now: d.now, setTimer: d.setTimer, clearTimer: d.clearTimer,
    });
  }

  credentials(botId: string, platform: ConnectorPlatform): Record<string, string> | null {
    return this.secrets.get(botId, platform);
  }

  /** I4: the provider's webhook signing secret, set through the listener connect flow (null = not set → unsigned deliveries are refused). */
  signingSecret(botId: string, provider: ConnectorPlatform): string | null {
    return this.credentials(botId, provider)?.signingSecret || null;
  }

  setCredentials(botId: string, platform: ConnectorPlatform, fields: Record<string, string>): boolean {
    const cur = this.credentials(botId, platform) ?? {};
    const sign = (fields.signingSecret ?? "").trim();
    const next: Record<string, string> = { ...cur };
    if (platform === "slack" && (fields.appToken || fields.botToken || !sign)) {
      if (!/^xapp-/.test(fields.appToken ?? "") || !/^xoxb-/.test(fields.botToken ?? "")) throw new GatewayError("BAD_CREDENTIALS", "Slack needs an app-level token (xapp-…) and a bot token (xoxb-…).");
      Object.assign(next, { appToken: fields.appToken!, botToken: fields.botToken! }, fields.userId ? { userId: fields.userId } : {});
    }
    if (platform === "github" && ((fields.token ?? "").trim() || !sign)) {
      if (!(fields.token ?? "").trim()) throw new GatewayError("BAD_CREDENTIALS", "GitHub needs a token.");
      next.token = fields.token!.trim();
    }
    if ((platform === "linear" || platform === "sentry") && !sign) throw new GatewayError("BAD_CREDENTIALS", `${platform === "linear" ? "Linear" : "Sentry"} needs the webhook signing secret.`);
    if (sign) next.signingSecret = sign;
    this.secrets.set(botId, platform, next);
    // New credentials are the action the "not connected" row asks for: they start from zero failures.
    if (platform === "slack") this.slack.get(botId)?.resetFailures();
    if (platform === "github") for (const [k, p] of this.github) if (k.startsWith(`${botId}\0`)) p.resetFailures();
    this.sync();
    return this.isConnected(botId, platform);
  }

  isConnected(botId: string, platform: ConnectorPlatform): boolean {
    const c = this.credentials(botId, platform);
    if (platform === "slack") return !!(c?.appToken && c.botToken) && !this.listenerFailing(botId, "slack");
    if (platform === "linear" || platform === "sentry") return !!c?.signingSecret;
    return !!(c?.token || this.ghToken) && !this.listenerFailing(botId, "github");
  }

  /**
   * Bug 51's siblings: saved credentials are not a working connection. A GitHub poller or Slack socket
   * that has failed N times in a row makes the routine read as not connected, which is what shows
   * Connect listener on its row. (Linear and Sentry only receive webhooks: there is nothing to fail here.)
   */
  listenerFailing(botId: string, platform: Platform): boolean {
    const n = LIMITS.listenerFailHealthAfter;
    if (platform === "slack") return (this.slack.get(botId)?.consecutiveFailures() ?? 0) >= n;
    for (const [k, p] of this.github) if (k.startsWith(`${botId}\0`) && p.consecutiveFailures() >= n) return true;
    return false;
  }

  private noteHealth(botId: string, platform: Platform, n: number): void {
    if (n === LIMITS.listenerFailHealthAfter) {
      for (const r of this.d.store.all()) {
        if (r.botId !== botId || !r.def.trigger || !leaves(r.def.trigger).some((l) => platform in l)) continue;
        log.warn("listener failing after retries", { botId, routineId: r.id, platform });
      }
    }
    this.onHealthChange?.([botId]);
  }

  async refreshGhToken(): Promise<void> {
    if (this.stopped) return;
    const run = { abort: new AbortController(), done: Promise.resolve() as Promise<unknown> };
    try {
      const env = ghEnv(this.d.cfg.hostPrivate);
      fs.mkdirSync(env.TMPDIR!, { recursive: true, mode: 0o700 }); // GH_CONFIG_DIR/tmp: makes both
      const p = (this.d.exec ?? defaultExec)("gh", ["auth", "token"], env, run.abort.signal);
      run.done = p.catch(() => undefined);
      this.ghRuns.add(run);
      const out = await p;
      if (!this.stopped) this.ghToken = out.trim() || null;
    } catch {
      if (!this.stopped) this.ghToken = null;
    } finally {
      this.ghRuns.delete(run);
    }
  }

  sync(): void {
    void this.refreshGhToken();
    const polls = new Map<string, { botId: string; repo: string; routineIds: string[] }>(); // I9: (botId, repo)
    const slackBots = new Map<string, { routineId: string }[]>();
    for (const r of this.d.store.all()) {
      if (!r.def.enabled || !r.def.trigger) continue;
      for (const t of leaves(r.def.trigger)) {
        let platform: Platform | null = null;
        if ("github" in t) {
          platform = "github";
          const repo = t.github.repo.toLowerCase();
          const k = `${r.botId}\0${repo}`;
          const cur = polls.get(k) ?? { botId: r.botId, repo, routineIds: [] };
          if (!cur.routineIds.includes(r.id)) cur.routineIds.push(r.id);
          polls.set(k, cur);
        } else if ("slack" in t) {
          platform = "slack";
          slackBots.set(r.botId, [...(slackBots.get(r.botId) ?? []), { routineId: r.id }]);
        }
        const key = `${r.botId}/${r.id}:${platform}`;
        if (platform && !this.seen.has(key)) {
          this.seen.add(key);
          if (!this.isConnected(r.botId, platform)) this.connect.watch(r.botId, platform, r.def.name, r.id);
        }
      }
    }
    for (const [k, p] of this.github) if (!polls.has(k)) { p.stop(); this.github.delete(k); this.pollRoutines.delete(k); }
    for (const [k, { botId, repo, routineIds }] of polls) {
      this.pollRoutines.set(k, routineIds); // update in place every sync(), even for an already-running poller
      if (this.github.has(k)) continue;
      const p = new GithubPoller({
        repo, fetch: this.d.fetch, now: this.d.now, setTimer: this.d.setTimer, clearTimer: this.d.clearTimer,
        // I9: only this Bot's own token (or the user's host-owned gh login), never another Bot's
        token: () => this.credentials(botId, "github")?.token || this.ghToken,
        onEvent: (ev) => { for (const routineId of this.pollRoutines.get(k) ?? []) this.d.queue.ingest(ev, { botId, routineId }); },
        onFailures: (n) => this.noteHealth(botId, "github", n),
      });
      this.github.set(k, p);
      p.start();
    }
    for (const [botId, s] of this.slack) if (!slackBots.has(botId)) { s.stop(); this.slack.delete(botId); this.botRoutines.delete(botId); }
    for (const [botId, routines] of slackBots) {
      this.botRoutines.set(botId, routines); // update in place every sync(), even for an already-running socket
      if (this.slack.has(botId) || !this.isConnected(botId, "slack")) continue;
      const s = new SlackSocket({
        appToken: () => this.credentials(botId, "slack")?.appToken ?? null, botToken: () => this.credentials(botId, "slack")?.botToken ?? null,
        selfUserId: () => this.credentials(botId, "slack")?.userId, fetch: this.d.fetch, ws: this.d.ws, setTimer: this.d.setTimer, clearTimer: this.d.clearTimer,
        onEvent: (ev) => { for (const r of this.botRoutines.get(botId) ?? []) this.d.queue.ingest(ev, { botId, routineId: r.routineId }); },
        onFailures: (n) => this.noteHealth(botId, "slack", n),
      });
      this.slack.set(botId, s);
      void s.start();
    }
  }

  /** Stops the listeners, ends any `gh auth token` still running and resolves once it has exited. */
  stop(): Promise<void> {
    this.stopped = true;
    for (const p of this.github.values()) p.stop();
    for (const s of this.slack.values()) s.stop();
    this.github.clear();
    this.slack.clear();
    const runs = [...this.ghRuns];
    for (const r of runs) r.abort.abort();
    return Promise.all(runs.map((r) => r.done)).then(() => undefined);
  }

  /** Provider webhooks into the routine's own path (RTN-10: GitHub, Slack Events API, Linear, Sentry, PagerDuty). */
  adaptWebhook: WebhookAdapt = (r, h, body) => {
    const t = r.def.trigger;
    if (!t) return null;
    const kinds = new Set(leaves(t).map((l) => Object.keys(l)[0]));
    let json: O;
    try { json = obj(JSON.parse(body.toString("utf8"))); } catch { return null; }
    const now = this.d.now();
    const ignored = { respond: { status: 200, body: { accepted: false, reason: "ignored_event" } } };
    const ghType = one(h, "x-github-event");
    if (kinds.has("github") && ghType) {
      if (ghType === "ping") return { respond: { status: 200, body: { ok: true } } };
      const m = mapGithubEvent(ghType, json);
      if (!m) return ignored;
      const id = one(h, "x-github-delivery") ?? createHash("sha256").update(body).digest("hex").slice(0, 32);
      return { event: githubEvent(m, id, str(obj(json.repository).full_name), now) };
    }
    if (kinds.has("slack") && json.type === "url_verification") return { respond: { status: 200, body: { challenge: str(json.challenge) } } };
    if (kinds.has("slack") && json.type === "event_callback") {
      const botUser = str(obj((json.authorizations as unknown[] | undefined)?.[0]).user_id);
      const ev = mapSlackEvent(json, botUser);
      return ev ? { event: ev } : ignored;
    }
    if (kinds.has("linear") && one(h, "linear-delivery")) {
      const data = obj(json.data);
      const kind = json.type === "Issue" && json.action === "create" ? "issueCreated"
        : json.type === "Issue" && json.action === "update" && obj(json.updatedFrom).stateId !== undefined ? "statusChanged"
        : json.type === "Cycle" && json.action === "update" && data.completedAt ? "endOfCycle" : null;
      if (!kind) return ignored;
      return { event: this.provider("linear", one(h, "linear-delivery")!, kind, str(data.title) || str(data.name), str(json.url), { projectId: str(data.projectId), teamId: str(data.teamId) }, now) };
    }
    if (kinds.has("sentry") && one(h, "sentry-hook-resource")) {
      const data = obj(json.data);
      const project = str(obj(obj(data.issue).project).id) || str(obj(data.event).project);
      const id = one(h, "request-id") ?? createHash("sha256").update(body).digest("hex").slice(0, 32);
      return { event: this.provider("sentry", id, `${one(h, "sentry-hook-resource")}.${str(json.action)}`, str(obj(data.issue).title) || str(obj(data.event).title), str(obj(data.issue).web_url), { projectId: project }, now) };
    }
    if (kinds.has("pagerduty") && json.event) {
      const ev = obj(json.event);
      const data = obj(ev.data);
      return { event: this.provider("pagerduty", str(ev.id), str(ev.event_type), str(data.title), str(data.html_url), { serviceId: str(obj(data.service).id) }, now) };
    }
    return null;
  };

  private provider(source: "linear" | "sentry" | "pagerduty", eventId: string, kind: string, subject: string, url: string, ids: Record<string, string>, now: number): TriggerEvent {
    return { source, eventId, occurredAt: now, kind, subject, url: url || undefined, text: `${kind}: ${subject}${url ? `\n${url}` : ""}`, raw: ids };
  }
}

export function listenerHandlers(a: TriggerAdapters): Pick<CommandHandlers, "setListenerCredentials"> {
  return { setListenerCredentials: (x) => ({ connected: a.setCredentials(x.id, x.platform, x.fields) }) };
}
