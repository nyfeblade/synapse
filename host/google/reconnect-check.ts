import path from "node:path";
import type { GoogleReconnectCheckView, GoogleStatusView } from "@synapse/shared";
import { occurrencesAfter, parseSchedule } from "../schedule/schedule";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";

/** Mondays at 10:00 in the user's zone: a working-hours nudge, not a midnight one. */
export const RECONNECT_CHECK_SCHEDULE = "0 10 * * 1";
const CHECK_MS = 3_600_000;
const LOOKBACK_MS = 8 * 86_400_000;

interface Saved {
  /** The user's choice; null follows the default (on only while the app is in Testing). */
  enabled: boolean | null;
  /** Slots before this are never owed (a fresh install or a new choice doesn't run a past Monday). */
  anchorAt: number;
  lastSlot: number | null;
  lastRunAt: number | null;
  /** One notification per expired sign-in: set when sent, cleared once the account is connected again. */
  notified: boolean;
}

export interface ReconnectCheckDeps {
  hostPrivate: string;
  now(): number;
  tz(): string;
  status(): GoogleStatusView;
  /** Forces a token refresh; an expired sign-in (invalid_grant) flips the account to needs-reconnect. */
  probe(): Promise<void>;
  /** The one "Reconnect Google" notification (a tray with Reconnect and "Let a Bot click through"). */
  notify(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

/**
 * google-setup: the built-in weekly Google sign-in check. It runs on the routines' schedule engine (the same cron
 * parser and occurrence walk as every routine and the standup) but costs no model call: one token refresh, and one
 * notification when the sign-in has expired. Opt-in; the default is on only while the app is in Testing, the one
 * case where Google ends sign-ins after 7 days.
 */
export class GoogleReconnectCheck {
  private file: string;
  private s: Saved;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private d: ReconnectCheckDeps) {
    this.file = path.join(d.hostPrivate, "google", "reconnect-check.json");
    const raw = readJson<Partial<Saved>>(this.file, {});
    this.s = {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : null, anchorAt: raw.anchorAt ?? d.now(),
      lastSlot: raw.lastSlot ?? null, lastRunAt: raw.lastRunAt ?? null, notified: raw.notified === true,
    };
  }

  private save(): void { writeJsonAtomic(this.file, this.s, 0o600); }

  enabled(): boolean { return this.s.enabled ?? this.d.status().testing === true; }

  view(): GoogleReconnectCheckView {
    return { enabled: this.enabled(), explicit: this.s.enabled !== null, testing: this.d.status().testing ?? null, lastRunAt: this.s.lastRunAt };
  }

  set(enabled: boolean): GoogleReconnectCheckView {
    if (enabled && !this.enabled()) this.s.anchorAt = this.d.now();
    this.s.enabled = enabled === true;
    this.save();
    return this.view();
  }

  /**
   * The one notification per expired sign-in, whoever noticed it first (this check, or a Bot's Google call that
   * hit invalid_grant). Nothing is sent while the account is fine.
   */
  notifyIfNeeded(): boolean {
    if (this.d.status().state !== "needs-reconnect" || this.s.notified) return false;
    this.s.notified = true;
    this.save();
    this.d.notify();
    return true;
  }

  /** The account changed: a connected account starts a new episode (the next expiry notifies again). */
  onStatus(st: GoogleStatusView): void {
    if (st.state === "connected" && this.s.notified) { this.s.notified = false; this.save(); }
  }

  /** One check now: refresh the sign-in, then notify only if it needs reconnecting. */
  async runOnce(): Promise<void> {
    this.running ??= (async () => {
      const st = this.d.status();
      if (st.state === "connected") await this.d.probe().catch(() => undefined);
      this.s.lastRunAt = this.d.now();
      this.save();
      if (this.notifyIfNeeded()) log.info("google: weekly check found the sign-in expired");
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private owedSlot(now: number): number | null {
    if (!this.enabled()) return null;
    const sched = parseSchedule(RECONNECT_CHECK_SCHEDULE, { tz: this.d.tz(), nowMs: now });
    let last: number | null = null;
    for (const t of occurrencesAfter(sched, now - LOOKBACK_MS, this.d.tz())) { if (t > now) break; last = t; }
    if (last === null || last < this.s.anchorAt || (this.s.lastSlot !== null && last <= this.s.lastSlot)) return null;
    return last;
  }

  /** Runs the owed slot, if any (a Mac asleep through Monday 10:00 runs it once on wake, never more). */
  async tick(): Promise<void> {
    const slot = this.owedSlot(this.d.now());
    if (slot === null) return;
    this.s.lastSlot = slot;
    await this.runOnce();
  }

  start(): void {
    this.stopped = false;
    const arm = () => { if (!this.stopped) this.timer = this.d.setTimer(() => { void this.tick().finally(arm); }, CHECK_MS); };
    void this.tick();
    arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }
}
