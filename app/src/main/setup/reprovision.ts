import type { BoxOpsLock } from "./box-ops-lock";

/**
 * Portable install, app updates: the box's own setup (provision.sh, desktop.env and box/files — the
 * "provision version", bundledImageVersion()) travels with the app, like the host build does. The box
 * records the version it was provisioned with (/etc/bots/image-version and /etc/bots/provisioned).
 * When they differ, the idempotent provision runs again IN PLACE — no recreate, no user data touched —
 * then the host is deployed and the box verified.
 *
 * Fix round 1: it never cuts a Bot's turn. It waits until no call holds the microphone, takes the one
 * box-operations lock (waiting while Settings → Update or setup holds it), then HOLDS NEW TURNS on the host
 * (messages are accepted and queued, and answered after — a durable ack obligation even survives the
 * deploy's restart) and waits for the turns already running to finish. Only then does anything restart. A
 * marker it couldn't read is never taken for a difference. A failure lets the held turns run and says so once.
 */
export function provisionVersionDiffers(bundled: string | null, box: string | null): boolean {
  if (!bundled) return false;
  return box !== bundled;
}

/** The host holds new turns on a lease (the app renews it) so a crashed or quit app never leaves Bots held. */
export const HOLD_LEASE_MS = 5 * 60_000;
export const HOLD_RENEW_MS = 60_000;
/** Longest the app waits for running turns while holding new ones; then it lets go and tries again later.
 *  Bug 258: 2 minutes per update (it was 3). */
export const HOLD_WAIT_CAP_MS = 2 * 60_000;
/** Bug 258: no background re-provision starts while the user sent a message this recently; it is deferred, tried later. */
export const USER_QUIET_MS = 5 * 60_000;

/** Renew `fn` every `ms` until the returned stop is called. */
export function renewEvery(fn: () => void, ms: number): () => void {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * On every connect: a hold left by an app that crashed or quit mid-operation is let go straight away (the lease
 * would end it within minutes anyway), unless THIS app is running a box operation right now. True when released.
 */
export async function releaseStaleHold(o: {
  lock: Pick<BoxOpsLock, "holder">;
  hold(on: boolean): Promise<unknown>;
  log(line: string): void;
}): Promise<boolean> {
  if (o.lock.holder()) return false;
  try { await o.hold(false); return true; } catch (e) { o.log(`box maintenance: couldn't release a leftover hold: ${e instanceof Error ? e.message : String(e)}`); return false; }
}

export type ReprovisionPhase = "waiting" | "running" | "done" | "done-with-warnings" | "failed";
export interface ReprovisionStatus { phase: ReprovisionPhase; message?: string }
export type ReprovisionResult = "current" | "skipped" | "retry-later" | "reprovisioned" | "failed";

export async function reprovisionIfChanged(o: {
  bundled(): string | null;
  /** The box's recorded provision version; `ok: false` when it couldn't be read (the box is down, orb timed out). */
  boxVersion(): Promise<{ ok: true; version: string | null } | { ok: false }>;
  /** A call or dictation holds the microphone right now. */
  callLive(): boolean;
  lock: Pick<BoxOpsLock, "tryAcquire">;
  /** Hold (or release) new turns on the host; returns the Bots whose turn is still running. Bug 258: with `quietMs` the
   *  host takes no hold (`deferred`) while a user message came in that recently. */
  hold(on: boolean, opts?: { quietMs?: number }): Promise<{ runningBotIds: string[]; deferred?: boolean }>;
  provision(): Promise<void>;
  deploy(): Promise<void>;
  waitHealthy(): Promise<void>;
  verify(): Promise<{ ok: boolean; failed: string[] }>;
  status(s: ReprovisionStatus): void;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
  retryMs?: number;
  now?(): number;
  /** Longest wait for running turns under the hold (default 2 min, bug 258). */
  waitCapMs?: number;
  /** Renews the host's hold lease while the operation runs (default every minute). */
  renew?(fn: () => void, ms: number): () => void;
}): Promise<ReprovisionResult> {
  const want = o.bundled();
  if (!want) return "skipped";
  const read = await o.boxVersion();
  if (!read.ok) { o.log("box update: couldn't read the box's setup version; will check again later"); return "retry-later"; }
  if (!provisionVersionDiffers(want, read.version)) return "current";
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const every = o.retryMs ?? 30_000;
  o.log(`box update: the box runs setup ${read.version ?? "(unrecorded)"}, this app ships ${want}`);
  o.status({ phase: "waiting" });
  let release: (() => void) | null = null;
  for (;;) {
    if (o.callLive()) { o.log("box update: waiting (a call is live)"); await sleep(every); continue; }
    release = o.lock.tryAcquire("re-provision");
    if (release) break;
    o.log("box update: waiting (another operation on the Bots' computer is running)");
    await sleep(every);
  }
  let held = false;
  let stopRenew: (() => void) | null = null;
  const stopRenewing = () => { stopRenew?.(); stopRenew = null; };
  const now = o.now ?? Date.now;
  const cap = o.waitCapMs ?? HOLD_WAIT_CAP_MS;
  try {
    const since = now();
    for (;;) {
      // Bug 258: the first hold asks the host whether the user wrote in the last 5 minutes; if so nothing is held,
      // nothing restarts, and the update is tried again later.
      const r = await o.hold(true, held ? undefined : { quietMs: USER_QUIET_MS });
      if (!held && r.deferred) {
        o.log("box update: the user wrote in the last 5 minutes; deferred, will try again later");
        release();
        return "retry-later";
      }
      if (!held) {
        held = true;
        stopRenew = (o.renew ?? renewEvery)(() => { void o.hold(true).catch(() => {}); }, HOLD_RENEW_MS);
      }
      if (!r.runningBotIds.length) break;
      if (now() - since >= cap) {
        // Never restart under a working Bot, and never keep the others held for it: let go, try again later.
        o.log(`box update: ${r.runningBotIds.length} Bot(s) still working after ${Math.round(cap / 60_000)} min; released the hold, will try again later`);
        stopRenewing();
        await o.hold(false).catch(() => {});
        release();
        return "retry-later";
      }
      o.log(`box update: new turns held; waiting for ${r.runningBotIds.length} running turn(s) to finish`);
      await sleep(Math.min(every, 5_000));
    }
    o.status({ phase: "running" });
    await o.provision();
    await o.deploy();
    await o.waitHealthy();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    o.log(`box update failed: ${message}`);
    stopRenewing();
    if (held) await o.hold(false).catch(() => {});
    o.status({ phase: "failed", message });
    release();
    return "failed";
  }
  const v = await o.verify().catch((e: unknown) => ({ ok: false, failed: [e instanceof Error ? e.message : String(e)] }));
  // The deploy restarted the host (a new host holds nothing), but say it anyway: an unchanged host would still be holding.
  stopRenewing();
  await o.hold(false).catch(() => {});
  o.log(v.ok ? "box update: done, verified" : `box update: done; verify reported ${v.failed.join(", ")}`);
  o.status(v.ok ? { phase: "done" } : { phase: "done-with-warnings", message: v.failed.join(", ") });
  release();
  return "reprovisioned";
}
