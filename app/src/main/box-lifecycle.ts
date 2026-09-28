import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ForeverBoxStep, SnapshotInfo } from "@synapse/shared";
import { STRC } from "@synapse/shared";
import type { Exec } from "./box-provider";
import { resolveOrb } from "./orb-path";
import { BoxOpsLock, boxBusyMessage } from "./setup/box-ops-lock";
import { adoptable, CREATED_MARKER, listMachines, machineMarks, machineSize } from "./setup/orb";
import type { Call } from "./gateway-call";
import type { SnapshotSink } from "./snapshot-sink";

export interface BoxOps {
  restartMachine(): Promise<void>;
  recreateMachine(): Promise<void>;
  /** perBotUid: the per-Bot-account mode for a box about to receive a snapshot (provision.sh PER_BOT_UID). */
  provision(o?: { perBotUid?: "on" | "off" }): Promise<void>;
  deploy(): Promise<void>;
  /** Fix round 1: whether this box runs per-Bot accounts (a rebuilt box takes the snapshot's mode). */
  perBotUidMode?(): Promise<"on" | "off">;
  waitHealthy(timeoutMs: number): Promise<void>;
}

export interface AppRuntime { isPackaged: boolean; resourcesPath: string }

/**
 * The box/ folder the app runs: Synapse.app's Contents/Resources/box when packaged (packager
 * extraResource, see scripts/package.mjs), else the repo's box/ next to the app folder (`electron app/`).
 */
export function defaultBoxDir(appPath: string, rt?: AppRuntime): string {
  if (rt?.isPackaged) return path.join(rt.resourcesPath, "box");
  return path.join(appPath, "..", "box");
}

/** Same recipe as provision.sh's /etc/bots/image-version: provision.sh, desktop.env, then files/** in C-locale path order. */
export function bundledImageVersion(boxDir: string): string {
  const rel = fs.readdirSync(path.join(boxDir, "files"), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("._")).map((d) => path.relative(boxDir, path.join(d.parentPath, d.name)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const f of ["provision.sh", "desktop.env", ...rel]) h.update(fs.readFileSync(path.join(boxDir, f)));
  return h.digest("hex").slice(0, 16);
}

/**
 * OrbStack implementation (D1). The scripts come from the app's bundled box/ folder (the repo's box/ in
 * development). Portable install: it works on the profile's machine ("synapse-box" for a new install, an
 * existing "box" kept), passes it to the scripts as BOX_MACHINE, and never deletes a machine Synapse
 * didn't make.
 */
export class OrbBoxOps implements BoxOps {
  constructor(private o: {
    exec: Exec; boxDir: string; machine?: string; health(): Promise<boolean>; orb?: () => string;
    /** Sizes a recreated machine like first-run setup does (machineSize). */
    mac?: { cpus: number; totalMemBytes: number };
    /** The machine was recreated: its box key is new (the caller forgets the pin, so secret sync re-pins). */
    onRecreated?(): void;
  }) {}
  private orb() { return (this.o.orb ?? resolveOrb)(); }
  private m() { return this.o.machine ?? "box"; }
  private env() { return { ORB: this.orb(), BOX_MACHINE: this.m() }; }
  private async run(cmd: string, args: string[], timeoutMs = 30 * 60_000, env?: Record<string, string>): Promise<void> {
    const r = await this.o.exec(cmd, args, { timeoutMs, ...(env ? { env } : {}) });
    if (r.code !== 0) throw new Error(`${cmd} ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`);
  }
  async restartMachine() { await this.run(this.orb(), ["restart", this.m()], 180_000); }
  async recreateMachine() {
    const m = (await listMachines(this.o.exec, this.orb())).find((x) => x.name === this.m());
    if (m && !adoptable(m, await machineMarks(this.o.exec, this.orb(), this.m()))) {
      throw new Error(`A machine called "${this.m()}" exists in OrbStack and wasn't made by Synapse. Synapse won't delete it.`);
    }
    if (m) await this.run(this.orb(), ["delete", "-f", this.m()], 180_000);
    const size = machineSize(this.o.mac ?? { cpus: os.cpus().length, totalMemBytes: os.totalmem() });
    await this.run(this.orb(), ["create", "--isolated", "-a", "arm64", "--cpus", String(size.cpus), "--memory", String(size.memoryMib), "--disk", size.disk, "-u", "synapse-admin", "debian:bookworm", this.m()], 600_000);
    await this.run(this.orb(), ["-m", this.m(), "-u", "root", "sh", "-c", `install -d -m 0755 /etc/bots && date -u +%FT%TZ > ${CREATED_MARKER}`], 60_000);
    this.o.onRecreated?.();
  }
  async provision(o?: { perBotUid?: "on" | "off" }) { await this.run("bash", [`${this.o.boxDir}/provision-from-mac.sh`], undefined, { ...this.env(), ...(o?.perBotUid ? { PER_BOT_UID: o.perBotUid } : {}) }); }
  async perBotUidMode(): Promise<"on" | "off"> {
    const r = await this.o.exec(this.orb(), ["-m", this.m(), "-u", "root", "test", "-f", "/etc/systemd/system/bothost.service.d/50-per-bot-uid.conf"], { timeoutMs: 60_000 });
    return r.code === 0 ? "on" : "off";
  }
  async deploy() { await this.run("bash", [`${this.o.boxDir}/deploy.sh`], undefined, this.env()); }
  async waitHealthy(timeoutMs: number) {
    const until = Date.now() + timeoutMs;
    while (!(await this.o.health().catch(() => false))) {
      if (Date.now() > until) throw new Error(STRC.cantReach);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export interface LifecycleState { phase: "ready" | "updating" | "recovering" | "resetting"; step: ForeverBoxStep | null; error: string | null }

export interface LifecycleDeps {
  ops: BoxOps;
  call: Call;
  sink: Pick<SnapshotSink, "backupNow" | "push" | "latest">;
  publish(s: LifecycleState): void;
  afterReconnect(): Promise<void>;
  /** Backoff between retries; injected by tests so the suite never waits on a real timer. */
  sleep?(ms: number): Promise<void>;
}

/** How long a single reconnect attempt gets to see /health before the deps are re-read and it tries again. */
const RECONNECT_SLICE_MS = 30_000;
const RETRY_BACKOFF_MS = 2_000;
const RESTORE_ATTEMPTS = 3;

/** CMP-11 on the Mac (Decision 9): the box can't rebuild itself. */
export class BoxLifecycle {
  private s: LifecycleState = { phase: "ready", step: null, error: null };

  /** Portable install, fix round 1: the ONE box-operations lock, shared with the background re-provision and setup. */
  constructor(private o: LifecycleDeps, private lock: BoxOpsLock = new BoxOpsLock()) {}

  /** The operation holding the box right now (this one, a re-provision, setup), or null. */
  busyWith(): string | null { return this.lock.holder(); }

  state(): LifecycleState { return this.s; }

  /**
   * Swaps in fresh ops/call/sink/afterReconnect (e.g. after recreateMachine() hands out a new
   * gateway token). Every method below reads through `this.o.*` at each call site, so calling this
   * mid-operation (which is exactly what update()'s own afterReconnect() triggers, via index.ts's
   * startBoxOps re-running on reconnect) makes the *rest* of that same run use the newest deps
   * instead of the stale ones the instance was constructed with (T22 fix 1).
   */
  setDeps(o: LifecycleDeps): void {
    this.o = o;
  }

  private set(phase: LifecycleState["phase"], step: ForeverBoxStep | null, error: string | null = null): void {
    // A retry that lands on the step it is already showing must not re-publish: the banner is an
    // IPC send to the renderer, and reconnect() below can run the same step a dozen times.
    if (this.s.phase === phase && this.s.step === step && this.s.error === error) return;
    this.s = { phase, step, error };
    this.o.publish(this.s);
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * The ONE place any lifecycle step waits for the box to come back, and the reason it reconnects
   * FIRST and probes /health second.
   *
   * recreateMachine() runs `orb delete -f box`, which takes /home/box/.host/gateway.json with it,
   * so the recreated host mints a brand-new random bearer token (host/gateway/token.ts) — and
   * host/gateway/server.ts rejects a mismatched bearer with 401 *before* it ever routes /health.
   * The ops/call/sink handed to this class are closures over the token they were built with
   * (index.ts startBoxOps), so probing /health before afterReconnect() re-reads gateway.json meant
   * probing with the deleted machine's token: the probe could never return ok, waitHealthy always
   * timed out, and Update always died at "starting" with the box already wiped and the snapshot
   * never restored. afterReconnect() runs first now, so the wait (and everything after it) speaks
   * to the new box with the new token.
   *
   * Each attempt gets a slice of the budget; if the box isn't up yet, the deps are re-read and the
   * probe runs again, because index.ts's connect() swallows its own errors and simply leaves the
   * old deps in place when the host isn't listening yet.
   */
  private async reconnect(phase: LifecycleState["phase"], connecting: ForeverBoxStep, waiting: ForeverBoxStep, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    // Bounded by attempts as well as by wall clock: a probe that fails instantly (a 401, a refused
    // connection) must not spin the loop flat out for the whole budget.
    const attempts = Math.max(1, Math.ceil(timeoutMs / (RECONNECT_SLICE_MS + RETRY_BACKOFF_MS)));
    let last: Error | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        this.set(phase, connecting);
        await this.o.afterReconnect();
        this.set(phase, waiting);
        await this.o.ops.waitHealthy(Math.max(1_000, Math.min(RECONNECT_SLICE_MS, until - Date.now())));
        return;
      } catch (e) {
        last = e as Error;
      }
      if (attempt >= attempts || Date.now() >= until) throw last ?? new Error(STRC.cantReach);
      await this.sleep(RETRY_BACKOFF_MS);
    }
  }

  /**
   * Push the snapshot back to the box and restore it. Retried: once recreateMachine() has run, the
   * box is empty, and giving up on a single blip (a 401 from deps that went stale, a dropped chunk)
   * leaves the user with a wiped computer even though the snapshot is sitting on the Mac.
   */
  private async restore(id: string, parts: SnapshotInfo["parts"]): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.o.sink.push(id);
        await this.o.call("restoreSnapshot", { id, parts });
        return;
      } catch (e) {
        if (attempt >= RESTORE_ATTEMPTS) throw e;
        await this.sleep(RETRY_BACKOFF_MS);
        // The commonest cause of a failed push is deps that went stale under us (the host
        // restarted and the bearer moved on), so re-read them before trying again. A reconnect
        // that itself fails is not fatal here — the next push attempt reports the real problem.
        await this.o.afterReconnect().catch(() => {});
      }
    }
  }

  /**
   * The one place that owns the "never strand the banner" invariant for every entry point
   * (Update/Recover/Reset). Anything that rejects between the first set(...) and the final
   * set("ready", …) — including the steps that used to sit outside each method's own try, such as
   * prepareBoxRestart and sink.latest() — puts the lifecycle back in `ready` with `failed` as the
   * error. That matters beyond the banner: index.ts's scheduled-backup timer only fires while
   * state().phase === "ready", and nothing re-publishes the phase on reconnect (startBoxOps only
   * calls setDeps), so a phase stuck at "resetting" silently stopped every snapshot until relaunch.
   * A step that already reported its own outcome (it set "ready" with its own message) is left alone.
   */
  private async guard<T>(name: "update" | "recover" | "reset", failed: string, fn: () => Promise<T>): Promise<T> {
    const release = this.lock.tryAcquire(name);
    if (!release) throw new Error(boxBusyMessage(this.lock.holder()));
    try {
      return await fn();
    } catch (e) {
      if (this.s.phase !== "ready") this.set("ready", null, `${failed}: ${(e as Error).message}`);
      throw e;
    } finally {
      release();
    }
  }

  update(o: { force: boolean }): Promise<{ status: "done" | "busy"; busyBotIds?: string[] }> {
    return this.guard("update", STRC.updateFailed, async () => {
      this.set("updating", "getting_ready");
      const prep = await this.o.call("prepareBoxRestart", { reason: "update", force: o.force });
      if (!prep.ok) {
        this.set("ready", null);
        return { status: "busy", busyBotIds: prep.busyBotIds };
      }
      this.set("updating", "backing_up");
      let snapId: string;
      try {
        snapId = (await this.o.sink.backupNow("before_update")).id;
      } catch {
        this.set("ready", null, STRC.backupNotReady);
        throw new Error(STRC.backupNotReady);
      }
      this.set("updating", "recreating");
      // The snapshot is this box's: the rebuilt one takes its per-Bot-account mode (an unmigrated snapshot needs it off).
      const perBotUid = await this.o.ops.perBotUidMode?.();
      await this.o.ops.recreateMachine();
      await this.o.ops.provision(perBotUid ? { perBotUid } : undefined);
      await this.o.ops.deploy();
      // The recreated host has a new gateway token: pick it up BEFORE waiting on /health.
      await this.reconnect("updating", "starting", "starting", 300_000);
      this.set("updating", "cleaning_up");
      await this.restore(snapId, ["workspace", "home", "agent-data"]);
      await this.reconnect("updating", "reconnecting", "reconnecting", 300_000); // secrets re-sync (vault.key is new, §12.1)
      this.set("ready", null);
      return { status: "done" };
    });
  }

  recover(): Promise<void> {
    return this.guard("recover", STRC.recoverFailed, async () => {
      this.set("recovering", "starting");
      await this.o.ops.restartMachine();
      await this.reconnect("recovering", "reconnecting", "reconnecting", 300_000);
      this.set("ready", null);
    });
  }

  reset(o: { alsoBots: boolean }): Promise<void> {
    return this.guard("reset", STRC.resetFailed, async () => {
      this.set("resetting", "getting_ready");
      await this.o.call("prepareBoxRestart", { reason: "reset", force: true });
      const snap = this.o.sink.latest();
      if (!snap) {
        this.set("ready", null, STRC.backupNotReady);
        throw new Error(STRC.backupNotReady);
      }
      this.set("resetting", "wiping");
      await this.restore(snap.id, o.alsoBots ? ["workspace", "home", "agent-data"] : ["workspace", "home"]);
      await this.reconnect("resetting", "starting", "reconnecting", 300_000);
      this.set("ready", null);
    });
  }
}
