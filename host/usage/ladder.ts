import { createHash } from "node:crypto";
import { LIMITS5, STR5, type LadderLevel, type Tray } from "@synapse/shared";
import type { BackgroundKind, LadderLike } from "../phase5/types";
import type { SettledTurn, TurnObserver } from "../runner/observers";
import type { TrayService } from "../trays/trays";
import type { UsageStore } from "./usage-store";

const UNIT: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };

export function parseResetsAt(message: string, nowMs: number): number {
  const m = /resets? (?:at|in) (.+)/i.exec(message);
  if (m) {
    const rest = m[1]!.trim();
    const rel = /^(\d+(?:\.\d+)?)\s*(second|minute|hour|day)s?/i.exec(rest);
    if (rel) return nowMs + Math.round(Number(rel[1]) * UNIT[rel[2]!.toLowerCase()]!);
    const at = Date.parse(rest.replace(/[.)\s]+$/, ""));
    if (!Number.isNaN(at) && at > nowMs) return at;
  }
  return nowMs + LIMITS5.limitDefaultResetMs;
}

/**
 * Review round 2 (P1): the wait an API rate limit named ("Try again in 30 s.", "retry after 2 minutes", a retry-after
 * the CLI reported), in ms, or null. A 429 on an API key is a rate limit of seconds, not a plan's usage window.
 */
export function parseRetryAfterMs(message: string): number | null {
  const m = /(?:try again|retry)(?: after| in)?\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)\b/i.exec(message);
  if (!m) return null;
  const u = m[2]!.toLowerCase();
  const mult = u.startsWith("h") ? 3_600_000 : u.startsWith("m") ? 60_000 : 1000;
  return Math.round(Number(m[1]) * mult);
}

export function routineOffsetMs(routineId: string): number {
  return createHash("sha256").update(routineId).digest().readUInt32BE(0) % LIMITS5.routineResumeOffsetMaxMs;
}

const LEVEL_RANK: Record<LadderLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
/** Dismissals are one row per week (usage80:<week>, budget:<week>) plus the limit tray; a few months is plenty. */
const DISMISSALS_MAX = 16;

export class UsageLadder implements LadderLike, TurnObserver {
  /** The current pause is an API rate limit (seconds), not a plan limit. */
  private shortPause = false;
  private limited: number | null = null;

  constructor(private d: {
    usage: UsageStore; trays: TrayService; now(): number; onReviewerDegraded?(untilMs: number): void; onChange?(): void;
    /** Security review (minor 4): the account's monthly dollar budget, as a % spent this month, or null when none. */
    monthBudgetPct?(): number | null;
  }) {}

  /** Review of new-user walk finding 7: one budget, the account's monthly one; near it, background work slows. */
  private budgetPct(): number | null {
    return this.d.monthBudgetPct?.() ?? null;
  }

  usagePct(): number | null {
    // The dollar budgets only: there is no Claude plan window (synapse-public).
    const b = this.budgetPct();
    return b === null ? null : Math.round(b * 10) / 10;
  }

  limitedUntil(): number | null {
    return this.limited !== null && this.limited > this.d.now() ? this.limited : null;
  }

  level(): LadderLevel {
    if (this.limitedUntil() !== null) return "L4";
    const budget = this.budgetPct();
    if (budget !== null && budget >= LIMITS5.ladderL3 * 100) return "L3";
    const pct = this.usagePct() ?? 0;
    if (pct >= LIMITS5.ladderL2 * 100) return "L2";
    if (pct >= LIMITS5.ladderL1 * 100) return "L1";
    return "L0";
  }

  allowsBackground(_kind: BackgroundKind): boolean {
    return ["L0", "L1"].includes(this.level());
  }

  /** Phase 4's fire consumer asks this before each routine fire (USE-03, USE-04). */
  routinePausedUntil(routineId: string): number | null {
    const until = this.limitedUntil();
    if (until !== null) return this.shortPause ? until : until + routineOffsetMs(routineId);
    if (this.level() === "L3" && this.d.usage.ladderState().resumedWeek !== this.d.usage.weekStart()) return Number.POSITIVE_INFINITY;
    return null;
  }

  resumeRoutines(): void {
    this.d.usage.setLadderState({ ...this.d.usage.ladderState(), resumedWeek: this.d.usage.weekStart() });
    this.d.onChange?.();
  }

  /**
   * The user dismissed a tray an automatic producer raises: remember the state behind it so the next settled
   * turn doesn't put it straight back. Only a worse state raises it again — a higher ladder level, a lockout
   * past the one they were shown, or a new week (a new dedupeKey). Anything else here is someone else's tray.
   */
  noteTrayDismissed(dedupeKey: string | null | undefined): void {
    if (!dedupeKey) return;
    const rank = dedupeKey === "usage-limit" ? this.limited
      : dedupeKey.startsWith("usage80:") ? LEVEL_RANK[this.level()]
      : dedupeKey.startsWith("budget:") ? 1
      : null;
    if (rank === null) return;
    const s = this.d.usage.ladderState();
    if ((s.dismissed[dedupeKey] ?? -1) >= rank) return;
    const dismissed = { ...s.dismissed, [dedupeKey]: rank };
    for (const k of Object.keys(dismissed).slice(0, -DISMISSALS_MAX)) delete dismissed[k];
    this.d.usage.setLadderState({ ...s, dismissed });
  }

  noteLimitError(message: string): void {
    // An API rate limit (no "resets at/in"): pause for the wait it named, or a minute. No "Usage limit reached" tray, no
    // degraded reviewer, no routine offset: it is seconds, not a plan's window.
    if (!/resets? (?:at|in)/i.test(message)) {
      this.limited = this.d.now() + (parseRetryAfterMs(message) ?? LIMITS5.rateLimitPauseMs);
      this.shortPause = true;
      this.d.onChange?.();
      return;
    }
    this.shortPause = false;
    const until = parseResetsAt(message, this.d.now());
    this.limited = until;
    const hours = Math.max(1, Math.ceil((until - this.d.now()) / 3_600_000));
    // Rank `now`: a dismissal covers the lockout the user was told about, and a lockout that outlasts it is news.
    this.addUnlessDismissed(this.d.now(), { botId: null, title: "Usage limit reached", detail: STR5.resetsInHours(hours), dedupeKey: "usage-limit" });
    this.d.onReviewerDegraded?.(until);
    this.d.onChange?.();
  }

  onSettled(t: SettledTurn): void {
    if (t.result.error?.code === "BOT-E0420") this.noteLimitError(t.result.error.message);
    else this.evaluate();
  }

  evaluate(): void {
    const lvl = this.level();
    const week = this.d.usage.weekStart();
    if (lvl !== "L0") this.addUnlessDismissed(LEVEL_RANK[lvl], { botId: null, title: STR5.trayUsage80, dedupeKey: `usage80:${week}` });
    if (lvl === "L3" && this.d.usage.ladderState().resumedWeek !== week) this.addResumeTray(week);
  }

  private addResumeTray(week: number): void {
    // Rank 1: there is nothing worse to say about this week's budget, so a dismissal holds until the next one.
    const t = this.addUnlessDismissed(1, { botId: null, title: STR5.trayBudgetPaused, dedupeKey: `budget:${week}` });
    if (t && !t.buttons.some((b) => b.action === "resume-routines")) t.buttons.push({ label: STR5.resume, action: "resume-routines" });
  }

  /** Raises the tray unless the user dismissed this key at `rank` or worse (see noteTrayDismissed). */
  private addUnlessDismissed(rank: number, t: { botId: null; title: string; detail?: string; dedupeKey: string }): Tray | null {
    if ((this.d.usage.ladderState().dismissed[t.dedupeKey] ?? -1) >= rank) return null;
    return this.d.trays.add(t);
  }
}
