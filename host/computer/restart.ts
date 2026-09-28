import { log } from "../util/log";
import type { BoxStatus } from "./box-status";

const PHASE = { update: "updating", recover: "recovering", reset: "resetting" } as const;

/** CMP-11: the host only answers "can we go?" and shows the banner; the SIGTERM that follows runs ORIG-16 §16.9 (markers, EVT-19). */
export function createPrepareBoxRestart(o: { busyBotIds(): string[]; status: Pick<BoxStatus, "setPhase"> }) {
  return (a: { reason: "update" | "recover" | "reset"; force: boolean }): { ok: boolean; busyBotIds: string[] } => {
    const busyBotIds = o.busyBotIds();
    if (busyBotIds.length && !a.force) return { ok: false, busyBotIds };
    o.status.setPhase(PHASE[a.reason], "getting_ready");
    return { ok: true, busyBotIds };
  };
}

/**
 * Portable install, fix round 1: the Mac re-provisions the box (which restarts services) only while NEW turns are
 * held — messages are accepted and queued, answered after — and once the turns already running have finished.
 * `setBoxMaintenance({ on: true })` holds them and says which Bots still have a turn running (the Mac waits for
 * none); `{ on: false }` lets the queue run. The status shows a quiet line the whole time.
 *
 * The hold is a LEASE (`ttlMs`, default 5 min, at most 30): the Mac renews it about every minute while its
 * operation runs. A Mac that crashed or quit mid-operation renews nothing, so the lease runs out and the host lets
 * the held turns run by itself — no Bot is ever held forever.
 */
export const BOX_MAINTENANCE_LEASE_MS = 5 * 60_000;
const MAX_LEASE_MS = 30 * 60_000;
/** Fix round (review of bug 258): after an hour of deferring for a chatty user, the update runs at the next idle
 *  moment (no turn running) even though the user is still chatting; the 2-minute hold cap then still applies. */
export const DEFER_CAP_MS = 60 * 60_000;

export function createSetBoxMaintenance(o: {
  runner: { holdNewTurns(on: boolean): void };
  runningBotIds(): string[];
  status: Pick<BoxStatus, "setMaintenance">;
  log?(line: string): void;
  /** Bug 258: when the user last sent a message (any Bot), or null. */
  lastUserMessageAt?(): number | null;
  now?(): number;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const leaseMs = (a: { on: boolean; ttlMs?: number }): number => {
    const t = typeof a?.ttlMs === "number" && Number.isFinite(a.ttlMs) && a.ttlMs > 0 ? a.ttlMs : BOX_MAINTENANCE_LEASE_MS;
    return Math.min(t, MAX_LEASE_MS);
  };
  let holding = false;
  let deferSince: number | null = null;
  const set = (a: { on: boolean; ttlMs?: number; quietMs?: number }): { runningBotIds: string[]; deferred?: boolean } => {
    const on = a?.on === true;
    const now = (o.now ?? Date.now)();
    // Bug 258: a NEW hold asked with `quietMs` is deferred while the user wrote that recently (decided here, with the
    // hold, so no message can slip in between the check and the hold). A renewal of a hold already taken never is.
    // Fix round: but only up to DEFER_CAP_MS — after an hour of deferring, the update goes ahead when no turn is
    // running (the caller still respects the 2-minute hold cap once it holds).
    if (on && !holding && typeof a.quietMs === "number" && a.quietMs > 0) {
      const last = o.lastUserMessageAt?.() ?? null;
      const recent = last !== null && now - last < a.quietMs;
      const capped = deferSince !== null && now - deferSince >= DEFER_CAP_MS;
      if (recent && !capped) {
        deferSince ??= now;
        // Idle right now (no turn running) means the update can proceed even mid-conversation once capped; until then,
        // defer as usual.
        return { runningBotIds: [], deferred: true };
      }
    }
    // Re-check fix: the deferral clock resets only when a hold is actually TAKEN. A release (`on: false`, e.g. from a
    // deferred redeploy that threw) or a renewal leaves it running, so the 1-hour cap still fires.
    if (on && !holding) deferSince = null;
    holding = on;
    clear();
    o.runner.holdNewTurns(on);
    o.status.setMaintenance(on);
    if (on) {
      const ms = leaseMs(a);
      timer = setTimeout(() => {
        timer = null;
        const leaseSeconds = Math.round(ms / 1000);
        if (o.log) o.log(`box maintenance: the Mac stopped renewing its hold (lease of ${leaseSeconds} s expired); letting held turns run`);
        else log.warn("box maintenance: the Mac stopped renewing its hold; letting held turns run", { leaseSeconds });
        holding = false;
        o.runner.holdNewTurns(false);
        o.status.setMaintenance(false);
      }, ms);
      timer.unref?.();
    }
    return { runningBotIds: on ? o.runningBotIds() : [] };
  };
  return Object.assign(set, { leaseMs });
}
