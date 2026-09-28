import { LIMITS, STR, type RoutineDef, type Trigger } from "@synapse/shared";
import { parseSchedule } from "../schedule/schedule";
import { parseMailQuery } from "../triggers/email/query";
import { macFolderOf } from "../triggers/mac-folder";
import { isMacPath } from "../triggers/match";
import type { RoutineRecord, RoutineStore } from "./routine-store";

/**
 * Bug 44(a), THE CLASS: "a failure that is logged and then represented to someone as success."
 *
 * `email-triggers.ts` skips a routine whose query will not parse and `engine.ts` skips one whose
 * schedule will not parse — both correctly, because neither can be armed — and both only
 * `log.warn` about it. Line 56 of email-triggers has already checked `r.def.enabled`, so what is
 * skipped is a routine the user is being shown as **Active**: it can never fire, and the only trace
 * is a line in a host log nobody reads.
 *
 * The fix is not to stop skipping. It is that the skip has to reach the user, on the routine's own
 * row, through state the renderer already renders:
 *
 *   - `enabled: false` — the row stops saying Active (RoutineDetail's switch, the sidebar count).
 *   - a failed entry in the routine's run history carrying the reason, which RoutineDetail's
 *     `RunRow` already prints verbatim.
 *
 * Nothing new is asked of the renderer, and nothing is routed through the sidebar alert (bug 46:
 * it renders behind the app's full-screen surfaces).
 *
 * A routine is only turned off when NOTHING about it can be armed. A group trigger with one broken
 * listener and three good ones keeps running on the three, and says so.
 */

export const PROBLEM_KEYS = ["schedule", "email-query", "mailbox", "imap", "listener", "calendar", "mac-folder"] as const;
/** Problems that fix themselves once the user acts (or the far end answers): the routine stays on. */
const RECOVERABLE: readonly ProblemKey[] = ["mailbox", "imap", "listener", "calendar", "mac-folder"];
export type ProblemKey = (typeof PROBLEM_KEYS)[number];

export interface RoutineProblem {
  key: ProblemKey;
  /** What the user is told, on the routine's own row. */
  detail: string;
  /** Nothing about this routine can fire: it must stop claiming to be Active. */
  fatal: boolean;
}

/** The run id (and requestId) of the entry a problem writes: stable, so re-checking replaces it rather than piling up. */
export const PROBLEM_RUN_PREFIX = "routine-problem-";

export interface ProblemContext {
  tz: string;
  /** A mailbox with this label is set up for the Bot (the connector secret exists). */
  hasMailbox(account: string): boolean;
  /** False after N consecutive IMAP / Gmail-poll failures (bug 51). Missing means reachable. */
  mailboxReachable?(account: string): boolean;
  /** True after N consecutive GitHub-poll / Slack-socket failures with saved credentials (bug 51's siblings). */
  listenerFailing?(platform: "github" | "slack"): boolean;
  /** Bug 115: true after N consecutive failed events.list polls of this calendar. */
  calendarFailing?(calendarId: string): boolean;
  /** Bug 115: true after N consecutive failed listings of this Mac folder ("~/Downloads"). */
  macFolderFailing?(folder: string): boolean;
}

function leaves(t: Trigger | undefined): Trigger[] {
  if (!t) return [];
  return "group" in t ? t.group.listeners.flatMap(leaves) : [t];
}

/**
 * The one place that answers "can the host arm this routine?" — the same parsers the subscriber and
 * the scheduler use, so this cannot drift away from what they will accept.
 */
export function routineProblem(def: RoutineDef, ctx: ProblemContext): RoutineProblem | null {
  const found: { key: ProblemKey; why: string }[] = [];
  let armed = 0;
  const cron = (s: string) => {
    try {
      parseSchedule(s, { tz: ctx.tz, nowMs: def.createdAt });
      armed++;
    } catch {
      found.push({ key: "schedule", why: STR.routineBadSchedule(s) });
    }
  };
  if (def.schedule) cron(def.schedule);
  for (const l of leaves(def.trigger)) {
    if ("cron" in l) { cron(l.cron.schedule); continue; }
    if ("email" in l) {
      try {
        parseMailQuery(l.email.query);
      } catch {
        found.push({ key: "email-query", why: STR.routineBadEmailQuery(l.email.query) });
        continue;
      }
      if (!ctx.hasMailbox(l.email.account)) {
        found.push({ key: "mailbox", why: STR.routineNoMailbox(l.email.account) });
        continue;
      }
      if (ctx.mailboxReachable && !ctx.mailboxReachable(l.email.account)) {
        // Bug 51: the row names the action that fixes it.
        found.push({ key: "imap", why: STR.routineMailboxUnreachable(l.email.account) });
        continue;
      }
      armed++;
      continue;
    }
    if ("calendar" in l) {
      const cal = l.calendar.calendarId ?? "primary";
      if (ctx.calendarFailing?.(cal)) { found.push({ key: "calendar", why: STR.routineCalendarFailing(cal) }); continue; }
      armed++;
      continue;
    }
    if ("file" in l) {
      const failing = l.file.paths.filter((p) => isMacPath(p)).map(macFolderOf).find((f) => ctx.macFolderFailing?.(f));
      if (failing !== undefined) { found.push({ key: "mac-folder", why: STR.routineMacFolderFailing(failing) }); continue; }
      armed++;
      continue;
    }
    const platform = "github" in l ? "github" : "slack" in l ? "slack" : null;
    if (platform && ctx.listenerFailing?.(platform)) {
      found.push({ key: "listener", why: STR.routineListenerFailing(platform === "github" ? "GitHub" : "Slack") });
      continue;
    }
    armed++; // webhook, slack, github, linear, sentry, pagerduty, file: armed while their connection works
  }
  // A listener that is merely waiting to be connected has its own row already (RTN-12's Connect card),
  // so a missing mailbox never turns a routine off — adding the mailbox arms it again by itself.
  const first = found.find((f) => !RECOVERABLE.includes(f.key)) ?? found[0];
  if (!first) return null;
  const fatal = armed === 0 && !RECOVERABLE.includes(first.key);
  const detail = first.key === "mailbox" ? STR.routineNotWatching(first.why)
    : first.key === "imap" || first.key === "listener" || first.key === "calendar" || first.key === "mac-folder" ? first.why
    : fatal ? STR.routineWontRun(first.why) : STR.routinePartlyWontRun(first.why);
  return { key: first.key, detail: detail.slice(0, LIMITS.runDetailMax), fatal };
}

export interface RoutineHealthDeps {
  store: RoutineStore;
  now(): number;
  botTz(botId: string): string;
  hasMailbox(botId: string, account: string): boolean;
  mailboxReachable?(botId: string, account: string): boolean;
  listenerFailing?(botId: string, platform: "github" | "slack"): boolean;
  calendarFailing?(botId: string, calendarId: string): boolean;
  macFolderFailing?(folder: string): boolean;
  /** Bug 115: a new problem was written on a routine's row (phase4 raises a tray entry for it). */
  onProblem?(rec: RoutineRecord, problem: RoutineProblem): void;
  /** The routine's row changed: reindex has already happened through the store, this republishes it. */
  onChanged(botId: string, routineId: string): void;
}

/**
 * Runs wherever the host (re-)arms routines — phase4's `resyncTriggers`, which covers boot, every
 * routine edit (the `automations` SSE), a new mailbox, and a Bot's own write to automation.json.
 *
 * Re-entrancy: `onChanged` publishes `automations`, which calls `resyncTriggers` again. The second
 * pass is a no-op — a fatal problem has already turned the routine off (and an off routine claims
 * nothing, so it is skipped), and a recoverable one writes nothing once its entry is already there.
 */
export class RoutineHealth {
  constructor(private d: RoutineHealthDeps) {}

  reconcile(): void {
    for (const rec of this.d.store.all()) this.check(rec);
  }

  /** @returns the problem the user was told about, or null. */
  check(rec: RoutineRecord): RoutineProblem | null {
    if (!rec.def.enabled) return null; // a routine that is off is not claiming anything
    const p = routineProblem(rec.def, {
      tz: this.d.botTz(rec.botId),
      hasMailbox: (a) => this.d.hasMailbox(rec.botId, a),
      mailboxReachable: (a) => this.d.mailboxReachable?.(rec.botId, a) ?? true,
      listenerFailing: (p) => this.d.listenerFailing?.(rec.botId, p) ?? false,
      calendarFailing: (c) => this.d.calendarFailing?.(rec.botId, c) ?? false,
      macFolderFailing: (f) => this.d.macFolderFailing?.(f) ?? false,
    });
    if (!p) return null;
    const runId = `${PROBLEM_RUN_PREFIX}${p.key}`;
    const prev = this.d.store.runs(rec.botId, rec.id).find((r) => r.id === runId);
    const now = this.d.now();
    if (p.fatal) this.d.store.update(rec.botId, rec.id, { enabled: false });
    if (!prev || prev.detail !== p.detail) {
      this.d.store.upsertRun(rec.botId, rec.id, {
        id: runId, requestId: runId, trigger: "event", status: "error",
        startedAt: prev?.startedAt ?? now, finishedAt: now, detail: p.detail,
      });
      this.d.onChanged(rec.botId, rec.id);
      this.d.onProblem?.(rec, p);
    } else if (p.fatal) this.d.onChanged(rec.botId, rec.id);
    return p;
  }
}
