import { randomUUID } from "node:crypto";
import { GITHUB_EVENT_KINDS, LIMITS, LIMITS_SCHED, STR, type Chain, type RoutineDef, type RoutineTriggerKind, type RoutineView, type Trigger } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { SseHub } from "../gateway/sse-hub";
import type { OneShotModel } from "../helper-model/one-shot";
import { normalizeSchedule, type NormalizedSchedule } from "../schedule/normalize";
import { formatQuietHours, parseQuietHours, splitQuietClause } from "../schedule/quiet";
import { describeSchedule, parseSchedule, rawSchedule } from "../schedule/schedule";
import { checkGroupSpacing } from "../schedule/spacing";
import { ScheduleError } from "../schedule/types";
import { parseMailQuery } from "../triggers/email/query";
import { macFolderOf } from "../triggers/mac-folder";
import { describeCalendar, isMacPath, validateTrigger } from "../triggers/match";
import type { HostSettingsStore } from "../store/host-settings";
import type { SchedulerEngine } from "./engine";
import type { FireConsumer } from "./fire-consumer";
import type { RoutineRecord, RoutineStore } from "./routine-store";
import type { SchedulerDb } from "./scheduler-db";
import { hashKey, keyPreview, newWebhookKey } from "./webhook-keys";

export interface RoutineServiceDeps {
  cfg: HostConfig;
  store: RoutineStore;
  db: SchedulerDb;
  engine: SchedulerEngine;
  consumer: FireConsumer;
  bots: BotService;
  settings: HostSettingsStore;
  hub: SseHub;
  model: OneShotModel | null;
  now(): number;
  publicBaseUrl(): string;
  listenerConnected?(botId: string, platform: "slack" | "github" | "linear" | "sentry"): boolean;
  mailboxReachable?(botId: string, account: string): boolean;
  /** Bug 115: the calendar and Mac-folder pollers' live state (false after N failed polls in a row). */
  calendarReachable?(calendarId: string): boolean;
  macFolderReachable?(folder: string): boolean;
  /** C1: Bot-initiated runs continue (and are bounded by) the calling turn's chain. */
  chains?: { get(chainId: string): Chain | null; hop(chainId: string): Chain };
}

/** Optional routine settings the tool and the UI can pass (null clears). */
export interface RoutineExtras { quietHours?: string | null; catchUp?: boolean; dailyCap?: number | null }

/** C1: a Bot may start one routine at most this many times an hour. */
export const BOT_RUNS_PER_HOUR = 3;

const bad = (message: string) => new GatewayError("BAD_ROUTINE", message);
const FILE_VERB = { created: "added to", modified: "changed in", deleted: "removed from" } as const;

export function describeTriggerLocal(t: Trigger | undefined, cron: (s: string) => string = (s) => s): string {
  if (!t) return "";
  if ("cron" in t) return cron(t.cron.schedule);
  if ("webhook" in t) return "When a webhook is received";
  if ("slack" in t) return `When a Slack message arrives in ${t.slack.channel}`;
  if ("github" in t) return `When ${t.github.repo} has ${t.github.events.join(", ")}`;
  if ("linear" in t) return `When Linear sends ${t.linear.event}`;
  if ("sentry" in t) return `When Sentry sends ${t.sentry.event}`;
  if ("pagerduty" in t) return `When PagerDuty sends ${t.pagerduty.event}`;
  if ("file" in t) return `When a file is ${t.file.events.map((e) => FILE_VERB[e]).join(" or ")} ${t.file.paths.join(", ")}`;
  if ("email" in t) return `When an email matching "${t.email.query}" arrives`;
  if ("calendar" in t) return describeCalendar(t.calendar);
  if ("group" in t) return t.group.listeners.map((l) => describeTriggerLocal(l, cron)).join(" or ");
  return "When its trigger fires";
}

function kindOf(def: RoutineDef): RoutineTriggerKind {
  const t = def.trigger;
  if (def.schedule || !t || "cron" in t) return "schedule";
  if ("group" in t) return "group";
  for (const k of ["webhook", "slack", "github", "linear", "sentry", "pagerduty", "file", "email", "calendar"] as const) if (k in t) return k;
  return "webhook";
}
const cronOf = (t: Trigger | undefined) => (t && "cron" in t ? t.cron.schedule : null);
function needsWebhook(t: Trigger | undefined): boolean {
  if (!t) return false;
  if ("group" in t) return t.group.listeners.some(needsWebhook);
  return "webhook" in t || "github" in t || "slack" in t || "linear" in t || "sentry" in t || "pagerduty" in t;
}
function cronMembers(t: Trigger): string[] {
  if ("cron" in t) return [t.cron.schedule];
  if ("group" in t) return t.group.listeners.flatMap(cronMembers);
  return [];
}

export class RoutineService {
  constructor(readonly d: RoutineServiceDeps) {}

  private tz(_botId: string): string {
    return this.d.settings.timeZone();
  }

  private rec(botId: string, id: string): RoutineRecord {
    this.d.bots.require(botId);
    const r = this.d.store.get(botId, id);
    if (!r) throw new GatewayError("NOT_FOUND", `No routine "${id}".`, 404);
    return r;
  }

  private webhookView(rec: RoutineRecord): { url: string; keyPreview: string; header: string } | null {
    const w = rec.def.webhook;
    return w ? { url: `${this.d.publicBaseUrl()}/hooks/${w.routineUuid}`, keyPreview: w.keyPreview, header: `Authorization: Bearer bot_…${w.keyPreview}` } : null;
  }

  private toView(rec: RoutineRecord): RoutineView {
    const tz = this.tz(rec.botId);
    const nowMs = this.d.now();
    const cronDesc = (s: string) => {
      try {
        return describeSchedule(parseSchedule(s, { tz, nowMs }), tz);
      } catch {
        return s;
      }
    };
    const sched = rec.def.schedule ?? cronOf(rec.def.trigger);
    let description = describeTriggerLocal(rec.def.trigger, cronDesc);
    let raw: string | null = null;
    if (sched) {
      try {
        const p = parseSchedule(sched, { tz, nowMs });
        description = describeSchedule(p, tz);
        raw = rawSchedule(p, tz);
      } catch {
        description = sched;
      }
    }
    const t = rec.def.trigger;
    const platform = t && "slack" in t ? "slack" : t && "github" in t ? "github" : t && "linear" in t ? "linear" : t && "sentry" in t ? "sentry" : null;
    const emailAccount = t && "email" in t ? t.email.account : null;
    const macFolders = t && "file" in t ? t.file.paths.filter((p) => isMacPath(p)).map(macFolderOf) : [];
    return {
      botId: rec.botId, id: rec.id, name: rec.def.name, prompt: rec.def.prompt, enabled: rec.def.enabled, triggerKind: kindOf(rec.def),
      schedule: sched, scheduleRaw: raw, description, nextRunAt: this.d.engine.nextRunAt(rec.botId, rec.id), lastRunAt: rec.def.lastRunAt ?? null,
      createdAt: rec.def.createdAt, runs: this.d.store.runs(rec.botId, rec.id), webhook: this.webhookView(rec), trigger: t ?? null,
      quietHours: rec.def.quietHours ?? null, catchUp: rec.def.catchUp === true, dailyCap: rec.def.dailyCap ?? null,
      listenerConnected: platform ? (this.d.listenerConnected?.(rec.botId, platform) ?? false)
        : emailAccount ? (this.d.mailboxReachable?.(rec.botId, emailAccount) ?? true)
        : t && "calendar" in t ? (this.d.calendarReachable?.(t.calendar.calendarId ?? "primary") ?? true)
        : macFolders.length ? macFolders.every((f) => this.d.macFolderReachable?.(f) ?? true)
        : null,
    };
  }

  view(botId: string, id: string): RoutineView {
    return this.toView(this.rec(botId, id));
  }
  list(botId: string): RoutineView[] {
    return this.d.store.list(botId).map((r) => this.toView(r));
  }
  listAll(): RoutineView[] {
    return this.d.store.all().filter((r) => this.d.bots.has(r.botId)).map((r) => this.toView(r));
  }

  private checkName(raw: string): string {
    const name = raw.replace(/\s+/g, " ").trim();
    if (!name) throw bad("Not saved — the routine needs a name.");
    if (name.length > LIMITS.routineNameMax) throw bad("Not saved — the name can be at most 80 characters.");
    return name;
  }

  private async normalizeTrigger(t: Trigger, o: { tz: string; nowMs: number; model: OneShotModel | null }): Promise<Trigger> {
    const shape = triggerShapeError(t);
    if (shape) throw bad(`Not saved — ${shape}`);
    if ("microsoftTeams" in t) throw bad("Not saved — Microsoft Teams triggers aren't available.");
    if ("cron" in t) return { cron: { schedule: (await normalizeSchedule(t.cron.schedule, o)).schedule } };
    if ("group" in t) {
      const n = t.group.listeners.length;
      if (n < LIMITS.triggerListenersMin || n > LIMITS.triggerListenersMax) throw bad("Not saved — a group trigger needs 2 to 8 listeners.");
      if (t.group.listeners.some((l) => "group" in l)) throw bad("Not saved — a group trigger can't contain another group.");
      const listeners: Trigger[] = [];
      for (const l of t.group.listeners) listeners.push(await this.normalizeTrigger(l, o));
      const crons = listeners.flatMap(cronMembers);
      if (crons.length >= 2) checkGroupSpacing(crons.map((s) => parseSchedule(s, { tz: o.tz, nowMs: o.nowMs })), o.tz, o.nowMs);
      return { group: { listeners } };
    }
    if ("file" in t && (t.file.paths.length < 1 || t.file.paths.length > 8)) throw bad("Not saved — a file trigger watches 1 to 8 paths.");
    if ("calendar" in t || "file" in t) {
      const why = validateTrigger(t, this.d.cfg.workspace);
      if (why) throw bad(`Not saved — ${why}`);
    }
    // Bug 44(a): the subscriber parses this query and skips the routine when it cannot. Refusing the
    // save is the only place the user can still do something about it; RoutineHealth catches the ones
    // that arrive another way (a Bot writing automation.json, a routine saved by an older build).
    if ("email" in t) {
      try {
        parseMailQuery(t.email.query);
      } catch {
        throw bad(`Not saved — ${STR.routineBadEmailQuery(t.email.query)} Use terms like from:, to:, subject:, has:attachment, is:unread, label: or newer_than:7d.`);
      }
    }
    return t;
  }

  private async normalize(botId: string, schedule: string | undefined, trigger: Trigger | undefined): Promise<{ schedule?: string; trigger?: Trigger; normalized: NormalizedSchedule | null }> {
    const o = { tz: this.tz(botId), nowMs: this.d.now(), model: this.d.model };
    try {
      if (schedule !== undefined) {
        const n = await normalizeSchedule(schedule, o);
        return { schedule: n.schedule, normalized: n };
      }
      const t = await this.normalizeTrigger(trigger!, o);
      const cron = cronOf(t);
      return { trigger: t, normalized: cron ? await normalizeSchedule(cron, o) : null };
    } catch (e) {
      if (e instanceof ScheduleError) throw new GatewayError("BAD_SCHEDULE", e.message);
      throw e;
    }
  }

  /** Quiet hours, catch-up and the daily trigger cap, checked and normalized ("10pm-7am" → "22:00-07:00"). */
  private extras(a: RoutineExtras): Partial<Pick<RoutineDef, "quietHours" | "catchUp" | "dailyCap">> {
    const out: Partial<Pick<RoutineDef, "quietHours" | "catchUp" | "dailyCap">> = {};
    if (a.quietHours !== undefined) {
      if (a.quietHours === null || a.quietHours.trim() === "") out.quietHours = undefined;
      else {
        try {
          out.quietHours = formatQuietHours(parseQuietHours(a.quietHours));
        } catch (e) {
          throw new GatewayError("BAD_SCHEDULE", `Not saved — ${(e as Error).message} (quiet hours).`);
        }
      }
    }
    if (a.catchUp !== undefined) out.catchUp = a.catchUp;
    if (a.dailyCap !== undefined) {
      if (a.dailyCap === null) out.dailyCap = undefined;
      else if (!Number.isInteger(a.dailyCap) || a.dailyCap < 1 || a.dailyCap > LIMITS_SCHED.triggerDailyCapMax) throw bad(`Not saved — the daily cap is 1 to ${LIMITS_SCHED.triggerDailyCapMax} runs.`);
      else out.dailyCap = a.dailyCap;
    }
    return out;
  }

  /** "every hour, quiet 22:00-07:00": the quiet clause in the schedule text becomes quietHours (an explicit value wins). */
  private quietFromSchedule<T extends { schedule?: string; quietHours?: string | null }>(a: T): T {
    if (a.schedule === undefined) return a;
    const s = splitQuietClause(a.schedule);
    if (s.quiet === undefined) return a;
    return { ...a, schedule: s.schedule, ...(a.quietHours === undefined ? { quietHours: s.quiet } : {}) };
  }

  async create(botId: string, a: { name: string; prompt: string; schedule?: string; trigger?: Trigger; enabled?: boolean } & RoutineExtras): Promise<{ view: RoutineView; normalized: NormalizedSchedule | null; key: string | null }> {
    this.d.bots.require(botId);
    const name = this.checkName(a.name);
    if (!a.prompt?.trim()) throw bad("Not saved — the routine needs an instruction.");
    if ((a.schedule === undefined) === (a.trigger === undefined)) throw bad("Not saved — give the routine exactly one of a schedule or a trigger.");
    const split = this.quietFromSchedule(a);
    const extras = this.extras(split);
    const n = await this.normalize(botId, split.schedule, a.trigger);
    const key = needsWebhook(n.trigger) ? newWebhookKey() : null;
    // A time-based routine catches up once after sleep unless told not to (a missed 8:00 digest still arrives).
    const catchUp = extras.catchUp ?? (n.schedule !== undefined || cronOf(n.trigger) !== null);
    const rec = this.d.store.create(botId, {
      name, prompt: a.prompt, enabled: a.enabled ?? true, ...extras, ...(catchUp ? { catchUp: true } : {}),
      ...(n.schedule ? { schedule: n.schedule } : {}), ...(n.trigger ? { trigger: n.trigger } : {}),
      ...(key ? { webhook: { routineUuid: randomUUID(), keyHash: hashKey(key), keyPreview: keyPreview(key) } } : {}),
    });
    if (!rec) throw new GatewayError("MAX_ROUTINES", STR.routineMaxReached, 409);
    this.d.store.markConfirmed(botId);
    this.d.engine.reindex(botId, rec.id);
    this.publish(botId);
    return { view: this.toView(rec), normalized: n.normalized, key };
  }

  async update(botId: string, id: string, patch: { name?: string; prompt?: string; schedule?: string; trigger?: Trigger; enabled?: boolean } & RoutineExtras): Promise<{ view: RoutineView; normalized: NormalizedSchedule | null; key: string | null }> {
    const cur = this.rec(botId, id);
    if (patch.schedule !== undefined && patch.trigger !== undefined) throw bad("Not saved — give the routine exactly one of a schedule or a trigger.");
    patch = this.quietFromSchedule(patch);
    const next: Partial<RoutineDef> = { ...this.extras(patch) };
    if (patch.name !== undefined) next.name = this.checkName(patch.name);
    if (patch.prompt !== undefined) {
      if (!patch.prompt.trim()) throw bad("Not saved — the routine needs an instruction.");
      next.prompt = patch.prompt;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    let normalized: NormalizedSchedule | null = null;
    let key: string | null = null;
    if (patch.schedule !== undefined || patch.trigger !== undefined) {
      const n = await this.normalize(botId, patch.schedule, patch.trigger);
      normalized = n.normalized;
      next.schedule = n.schedule;
      next.trigger = n.trigger;
      if (needsWebhook(n.trigger) && !cur.def.webhook) {
        // the full key is returned once, here — a Bot has no separate Rotate action (ORIG-04 §04.2)
        key = newWebhookKey();
        next.webhook = { routineUuid: randomUUID(), keyHash: hashKey(key), keyPreview: keyPreview(key) };
      }
      if (!needsWebhook(n.trigger)) next.webhook = undefined;
    }
    const rec = this.d.store.update(botId, id, next);
    this.d.engine.reindex(botId, id);
    this.publish(botId);
    return { view: this.toView(rec), normalized, key };
  }

  setEnabled(botId: string, id: string, enabled: boolean): RoutineView {
    this.rec(botId, id);
    const rec = this.d.store.update(botId, id, { enabled });
    this.d.engine.reindex(botId, id);
    this.publish(botId);
    return this.toView(rec);
  }

  remove(botId: string, id: string): void {
    this.rec(botId, id);
    this.d.store.remove(botId, id);
    this.d.engine.reindex(botId, id);
    this.publish(botId);
  }

  /** RTN-18 / ORIG-17: Test run and "Run now" — real work, bypasses the gate and the spend guard. */
  runNow(botId: string, id: string): string {
    const rec = this.rec(botId, id);
    const runId = randomUUID();
    const res = this.d.consumer.submit({ runId, botId, routineId: id, trigger: "manual", scheduledFor: this.d.now(), defHash: rec.defHash, bypassGate: true });
    if (!res.accepted) throw new GatewayError("NOT_RUN", res.reason === "duplicate_in_flight" ? STR.runAlreadyRunning : `Not run: ${res.reason}`);
    return runId;
  }

  /**
   * C1: a Bot asked for a run (update_state action "run"). Unlike Run now it is reviewed (automation_write),
   * never bypasses the gate, the spend guard, the usage pause or the concurrency cap, is capped per routine
   * per hour, and continues the caller's chain so a run → run → run loop spends the chain's hop and token budget.
   */
  botRun(botId: string, id: string, o: { chainId: string | null }): string {
    const rec = this.rec(botId, id);
    const now = this.d.now();
    const recent = this.d.db.fires({ botId, routineId: id }).filter((f) => f.trigger === "bot-run" && f.createdAt > now - 3_600_000).length;
    if (recent >= BOT_RUNS_PER_HOUR) throw new GatewayError("NOT_RUN", `Not run: a Bot can start this routine at most ${BOT_RUNS_PER_HOUR} times an hour. It still runs on its own trigger, or the user can press Run now.`);
    const chain = o.chainId ? (this.d.chains?.get(o.chainId) ?? null) : null;
    if (chain) {
      if (chain.hops + 1 >= LIMITS.maxHops) throw new GatewayError("NOT_RUN", `Not run: this chain of Bot actions reached ${LIMITS.maxHops} hops.`);
      if (chain.weightedTokens > LIMITS.chainTokenBudget) throw new GatewayError("NOT_RUN", "Not run: this chain of Bot actions used up its token budget.");
    }
    const runId = randomUUID();
    const res = this.d.consumer.submit({ runId, botId, routineId: id, trigger: "bot-run", scheduledFor: now, defHash: rec.defHash, ...(chain ? { chainId: chain.chainId } : {}) });
    if (!res.accepted) throw new GatewayError("NOT_RUN", res.reason === "duplicate_in_flight" ? STR.runAlreadyRunning : `Not run: ${res.reason}`);
    if (chain) this.d.chains!.hop(chain.chainId);
    return runId;
  }

  webhook(botId: string, id: string): { url: string; keyPreview: string; header: string } {
    const v = this.webhookView(this.rec(botId, id));
    if (!v) throw new GatewayError("NO_WEBHOOK", STR.availableAfterSave);
    return v;
  }

  rotateKey(botId: string, id: string): { url: string; key: string; header: string } {
    const rec = this.rec(botId, id);
    const w = rec.def.webhook;
    if (!w) throw new GatewayError("NO_WEBHOOK", STR.availableAfterSave);
    const key = newWebhookKey();
    this.d.store.update(botId, id, { webhook: { ...w, keyHash: hashKey(key), keyPreview: keyPreview(key) } });
    this.publish(botId);
    return { url: `${this.d.publicBaseUrl()}/hooks/${w.routineUuid}`, key, header: `Authorization: Bearer ${key}` };
  }

  byWebhookUuid(uuid: string): RoutineRecord | null {
    return this.d.store.all().find((r) => r.def.webhook?.routineUuid === uuid) ?? null;
  }

  removeBot(botId: string): void {
    this.d.store.removeBot(botId);
    this.d.engine.reindex(botId, null);
    this.d.db.removeBot(botId); // I7: fires (with event_json), index and offline skips
    this.d.hub.publish({ channel: "automations", payload: { botId, routines: [] } }); // I7: open views and trigger sync see it gone
  }

  publish(botId: string): void {
    if (this.d.bots.has(botId)) this.d.hub.publish({ channel: "automations", payload: { botId, routines: this.list(botId) } });
  }
}

const TRIGGER_KINDS = ["cron", "slack", "github", "linear", "sentry", "pagerduty", "microsoftTeams", "webhook", "file", "email", "calendar", "group"] as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Final box verification: a Bot's malformed trigger ({time, timezone, days}) was saved as a routine that could never
 *  fire. A trigger must be exactly one known kind with its required fields; a time-based routine uses `schedule`. */
export function triggerShapeError(t: unknown): string | null {
  const keys = isObj(t) ? Object.keys(t) : [];
  if (keys.length !== 1 || !(TRIGGER_KINDS as readonly string[]).includes(keys[0]!)) {
    return `the trigger must be exactly one of ${TRIGGER_KINDS.filter((k) => k !== "microsoftTeams").join(", ")}. For a time-based routine, pass schedule (for example "weekdays at 9am") instead of a trigger.`;
  }
  const kind = keys[0]!;
  const v = (t as Record<string, unknown>)[kind];
  if (!isObj(v)) return `the ${kind} trigger needs its settings object.`;
  switch (kind) {
    case "cron": return typeof v.schedule === "string" ? null : "a cron trigger needs a schedule string.";
    case "slack": return typeof v.channel === "string" && (v.match === "mention" || v.match === "message" || isObj(v.match)) ? null : "a Slack trigger needs a channel and a match.";
    case "github": return typeof v.repo === "string" && strs(v.events) && (v.events as string[]).length > 0 && (v.events as string[]).every((e) => (GITHUB_EVENT_KINDS as readonly string[]).includes(e)) ? null : "a GitHub trigger needs a repo like owner/name and known events.";
    case "linear": return ["issueCreated", "statusChanged", "endOfCycle"].includes(String(v.event)) ? null : "a Linear trigger's event is issueCreated, statusChanged or endOfCycle.";
    case "sentry": case "pagerduty": return typeof v.event === "string" && v.event ? null : `a ${kind} trigger needs an event.`;
    case "file": return strs(v.paths) && strs(v.events) && (v.events as string[]).every((e) => ["created", "modified", "deleted"].includes(e)) ? null : "a file trigger needs paths and events (created, modified, deleted).";
    case "email": return typeof v.account === "string" && typeof v.query === "string" && (v.googleAccount === undefined || typeof v.googleAccount === "string") ? null : "an email trigger needs a mailbox and a query (googleAccount, when given, is one Google account's address).";
    case "calendar": return typeof v.minutesBefore === "number" && (v.calendarId === undefined || typeof v.calendarId === "string") && (v.match === undefined || typeof v.match === "string") && (v.account === undefined || typeof v.account === "string") ? null : "a calendar trigger needs minutesBefore (a number of minutes); account, when given, is one Google account's address.";
    case "group": {
      if (!Array.isArray(v.listeners)) return "a group trigger needs listeners.";
      for (const l of v.listeners) { const e = triggerShapeError(l); if (e) return e; }
      return null;
    }
    default: return null; // webhook, microsoftTeams (refused below)
  }
}

