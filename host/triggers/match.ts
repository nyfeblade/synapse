import path from "node:path";
import { LIMITS, LIMITS_SCHED, type FileEventKind, type GithubEventKind, type RoutineDef, type RoutineTriggerKind, type SlackMatch, type Trigger } from "@synapse/shared";
import type { TriggerEvent, TriggerSource } from "./types";

export interface MatchContext { savedAt: number; botSlackUserId?: string; workspace?: string }

const MAGIC = /[*?[{]/;
const lower = (s: string | undefined) => (s ?? "").toLowerCase();

export function isAlwaysIgnored(p: string, workspace: string): boolean {
  const rel = path.relative(workspace, path.resolve(p));
  const segs = rel.split(path.sep);
  if (segs[0] === "teach-sessions" || segs[0] === ".host-out") return true;
  if (segs.some((s) => s === ".bot" || s === ".git" || s === "node_modules")) return true;
  return /\.(tmp|swp)$/.test(p);
}

/** "mac:~/Downloads" watches a folder on the user's Mac over the local bridge (direct children, names only). */
export const MAC_PREFIX = "mac:";
export const isMacPath = (p: string) => p.startsWith(MAC_PREFIX);
const macFolder = (p: string) => p.replace(/\/+$/, "");
function macHit(g: string, p: string): boolean {
  const dir = macFolder(g);
  if (!p.startsWith(`${dir}/`)) return false;
  return !p.slice(dir.length + 1).includes("/");
}

const words = (s: string | undefined) => lower(s).split(/\s+/).filter(Boolean);
/** A calendar trigger's `match`: every word must appear in the event title (case-insensitive). */
export const calendarTitleMatches = (match: string | undefined, title: string | undefined) => words(match).every((w) => lower(title).includes(w));

function globsFor(g: string, workspace: string): string[] {
  const abs = path.isAbsolute(g) ? g : path.join(workspace, g);
  return MAGIC.test(abs) ? [abs] : [abs, `${abs.replace(/\/+$/, "")}/**`];
}

function slackOk(s: { channel: string; match: SlackMatch }, ev: TriggerEvent): boolean {
  if (s.channel !== "*" && lower(s.channel) !== lower(ev.channel)) return false;
  const m = s.match;
  const threadReply = typeof ev.raw.thread_ts === "string" && ev.raw.thread_ts !== ev.raw.ts;
  if (m === "mention") return ev.kind === "mention";
  if (m === "message") return ev.kind === "message" && !threadReply;
  if ("keyword" in m) return (ev.kind === "message" || ev.kind === "mention") && lower(ev.text).includes(lower(m.keyword));
  if (ev.kind !== "reaction") return false;
  const emoji = String(ev.raw.reaction ?? "");
  if (m.reaction.emoji?.length && !m.reaction.emoji.includes(emoji)) return false;
  return !m.reaction.bySelf || ev.selfAuthored === true;
}

const idIn = (list: string[] | undefined, v: unknown) => !list?.length || list.includes(String(v ?? ""));

function one(t: Trigger, ev: TriggerEvent, ctx: MatchContext): boolean {
  if ("group" in t) {
    const n = t.group.listeners.length;
    if (n < LIMITS.triggerListenersMin || n > LIMITS.triggerListenersMax) return false;
    return t.group.listeners.some((l) => one(l, ev, ctx));
  }
  if ("cron" in t || "microsoftTeams" in t) return false;
  if ("webhook" in t) return ev.source === "webhook";
  if ("slack" in t) return ev.source === "slack" && slackOk(t.slack, ev);
  if ("github" in t) {
    const g = t.github;
    if (ev.source !== "github" || lower(ev.repo) !== lower(g.repo)) return false;
    if (!g.events.includes(ev.kind as GithubEventKind)) return false;
    if (g.userAllowlist?.length && !g.userAllowlist.some((u) => lower(u) === lower(ev.actor))) return false;
    return !(ev.kind === "ciCompleted" && g.ciBranch && ev.branch !== g.ciBranch);
  }
  if ("linear" in t) return ev.source === "linear" && ev.kind === t.linear.event && idIn(t.linear.projectIds, ev.raw.projectId) && idIn(t.linear.teamIds, ev.raw.teamId);
  if ("sentry" in t) return ev.source === "sentry" && ev.kind === t.sentry.event && idIn(t.sentry.projectIds, ev.raw.projectId);
  if ("pagerduty" in t) return ev.source === "pagerduty" && ev.kind === t.pagerduty.event && idIn(t.pagerduty.serviceIds, ev.raw.serviceId);
  if ("file" in t) {
    const f = t.file;
    const ws = ctx.workspace ?? "/workspace";
    if (ev.source !== "file" || !ev.path || !f.events.includes(ev.kind as FileEventKind)) return false;
    if (isMacPath(ev.path)) return f.paths.some((g) => isMacPath(g) && macHit(g, ev.path!));
    if (isAlwaysIgnored(ev.path, ws)) return false;
    if (f.ignore?.some((g) => globsFor(g, ws).some((x) => path.matchesGlob(ev.path!, x)))) return false;
    return f.paths.some((g) => !isMacPath(g) && globsFor(g, ws).some((x) => path.matchesGlob(ev.path!, x)));
  }
  if ("calendar" in t) {
    const c = t.calendar;
    if (ev.source !== "calendar" || Number(ev.raw.minutesBefore) !== c.minutesBefore) return false;
    if ((c.calendarId ?? "primary") !== String(ev.raw.calendarId ?? "primary")) return false;
    return calendarTitleMatches(c.match, ev.subject);
  }
  const e = t.email;
  return ev.source === "email" && ev.account === e.account && lower(ev.channel || "INBOX") === lower(e.folder ?? "INBOX") && ev.raw.query === e.query;
}

export function matchesTrigger(t: Trigger, ev: TriggerEvent, ctx: MatchContext): boolean {
  return ev.occurredAt >= ctx.savedAt && one(t, ev, ctx);
}

export function triggerSources(t: Trigger): TriggerSource[] {
  if ("group" in t) return [...new Set(t.group.listeners.flatMap(triggerSources))];
  if ("cron" in t || "microsoftTeams" in t) return [];
  return [Object.keys(t)[0] as TriggerSource];
}

export function triggerKindOf(def: RoutineDef): RoutineTriggerKind {
  const t = def.trigger;
  if (!t || "cron" in t) return "schedule";
  if ("microsoftTeams" in t) return "webhook"; // schema kept, never delivered (RTN-10); validateTrigger rejects new ones
  return Object.keys(t)[0] as RoutineTriggerKind;
}

export function describeTrigger(t: Trigger): string {
  if ("group" in t) return t.group.listeners.map(describeTrigger).join(" or ");
  if ("cron" in t) return "On a schedule";
  if ("webhook" in t) return "When a webhook is received";
  if ("slack" in t) {
    const where = t.slack.channel === "*" ? "any channel" : t.slack.channel === "@dm" ? "a direct message" : t.slack.channel;
    const m = t.slack.match;
    if (m === "mention") return `When someone mentions me in ${where}`;
    if (m === "message") return `When a message is posted in ${where}`;
    if ("keyword" in m) return `When a message in ${where} mentions “${m.keyword}”`;
    return `When someone reacts in ${where}`;
  }
  if ("github" in t) return `When ${t.github.events.length === 1 ? "a GitHub event happens" : "GitHub events happen"} in ${t.github.repo}`;
  if ("linear" in t) return `When Linear reports ${t.linear.event}`;
  if ("sentry" in t) return `When Sentry reports ${t.sentry.event}`;
  if ("pagerduty" in t) return `When PagerDuty reports ${t.pagerduty.event}`;
  if ("file" in t) {
    const verb = t.file.events.length === 1 ? { created: "added to", modified: "changed in", deleted: "removed from" }[t.file.events[0]!] : "added, changed or removed in";
    return `When a file is ${verb} ${t.file.paths.join(", ")}`;
  }
  if ("email" in t) return `When an email in ${t.email.account} matches “${t.email.query}”`;
  if ("calendar" in t) return describeCalendar(t.calendar);
  return "Microsoft Teams (not available)";
}

export function describeCalendar(c: { minutesBefore: number; match?: string }): string {
  const lead = `${c.minutesBefore} minute${c.minutesBefore === 1 ? "" : "s"}`;
  return `${lead} before a calendar event${c.match?.trim() ? ` matching “${c.match.trim()}”` : ""}`;
}

export function validateTrigger(t: Trigger, workspace = "/workspace"): string | null {
  if ("group" in t) {
    const n = t.group.listeners.length;
    if (n < LIMITS.triggerListenersMin || n > LIMITS.triggerListenersMax) return "A trigger group needs 2 to 8 listeners.";
    if (t.group.listeners.some((l) => "group" in l)) return "Trigger groups can't be nested.";
    for (const l of t.group.listeners) { const e = validateTrigger(l, workspace); if (e) return e; }
    return null;
  }
  if ("microsoftTeams" in t) return "Microsoft Teams triggers aren't available yet.";
  if ("github" in t && (!/^[\w.-]+\/[\w.-]+$/.test(t.github.repo) || !t.github.events.length)) return "A GitHub trigger needs a repo like owner/name and at least one event.";
  if ("file" in t) {
    const f = t.file;
    if (f.paths.length < 1 || f.paths.length > 8 || !f.events.length) return "A file trigger needs 1 to 8 paths and at least one event.";
    const outside = f.paths.some((p) => { if (isMacPath(p)) return p.length <= MAC_PREFIX.length; const abs = path.isAbsolute(p) ? path.resolve(p) : path.join(workspace, p); return abs !== workspace && !abs.startsWith(`${workspace}/`); });
    if (outside) return "File triggers can only watch folders inside /workspace.";
  }
  if ("calendar" in t) {
    const n = t.calendar.minutesBefore;
    if (!Number.isInteger(n) || n < 1 || n > LIMITS_SCHED.calendarLeadMaxMin) return "A calendar trigger fires 1 to 1440 minutes before an event starts.";
  }
  if ("email" in t && (!t.email.account.trim() || !t.email.query.trim())) return "An email trigger needs a mailbox and a query.";
  return null;
}
