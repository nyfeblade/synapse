import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Exec } from "../box-provider";
import type { registerNative } from "../native";
import { readAppSettings, writeAppSettings } from "../app-settings";
import type { AppRuntime } from "../box-lifecycle";
import { boxSteps, type RunStreamed } from "./box-steps";
import { detectOrb, ORBSTACK_DOWNLOAD_URL, startOrbStack } from "./orb";
import { BoxProvisioner, type ProvisionState } from "./provisioner";
import { boxBusyMessage, type BoxOpsLock } from "./box-ops-lock";

/**
 * Portable install: the first-run setup screen's Mac side. The screen polls `setup.status` and listens
 * to "setup" events; the box is set up by BoxProvisioner (resumable) with the bundled box scripts.
 */
export interface SetupStatus {
  done: boolean;
  machine: string;
  orb: Awaited<ReturnType<typeof detectOrb>>;
  box: Omit<ProvisionState, "log"> & { logTail: string[] };
  connected: boolean;
  /** This Mac: Apple silicon, and free disk for the Bots' computer. */
  mac: { arm64: boolean; freeBytes: number | null };
}

export function registerSetup(o: {
  reg: typeof registerNative;
  emit(channel: string, payload: unknown): void;
  userData: string; appDir: string; runtime: AppRuntime; home: string;
  exec: Exec; orb(): string; machine(): string; boxDir(): string;
  imageVersion(): string | null; hostBuild(): string | null;
  reconnect(): Promise<void>; connected(): boolean; forgetPin(): void;
  openExternal(url: string): Promise<void>;
  /** FUZZ / e2e profiles never see the setup screen (there is no OrbStack machine behind them). */
  skip: boolean;
  log(line: string): void;
  run?: RunStreamed;
  /** Fix round 1: the ONE box-operations lock (re-provision, setup, Settings → Update / Recover / Reset). */
  lock: BoxOpsLock;
}): { isDone(): boolean; provisioner: BoxProvisioner } {
  const settings = () => readAppSettings(o.userData, o.appDir, o.runtime);
  /**
   * Done when setup finished once, or when this profile already had a working box before this build
   * (it pinned that box's key: box-pin.json) — an existing install never sees the setup screen again. Reads
   * only: the startup migration (portable-migration.ts) records the machine and the done flag.
   */
  const isDone = (): boolean => o.skip || settings().setupDone === true || fs.existsSync(path.join(o.userData, "box-pin.json"));

  let last = 0;
  let pending: NodeJS.Timeout | null = null;
  const publish = (s: ProvisionState) => {
    // At most ~8 updates a second to the renderer: apt prints thousands of lines.
    const send = () => { last = Date.now(); pending = null; o.emit("setup", { box: slim(s) }); };
    if (s.phase !== "running" || Date.now() - last > 120) { if (pending) clearTimeout(pending); send(); return; }
    if (!pending) pending = setTimeout(send, 120);
  };
  const slim = (s: ProvisionState) => ({ ...s, log: undefined, logTail: s.log.slice(-12) });

  const steps = () => boxSteps({
    exec: o.exec, orb: o.orb, machine: o.machine(), boxDir: o.boxDir(),
    imageVersion: o.imageVersion, hostBuild: o.hostBuild, reconnect: o.reconnect, connected: o.connected,
    forgetPin: o.forgetPin, mac: { cpus: os.cpus().length, totalMemBytes: os.totalmem() }, run: o.run,
  });
  const provisioner = new BoxProvisioner({ steps: steps(), publish });

  const freeBytes = (): number | null => {
    try { const s = fs.statfsSync(o.home); return s.bavail * s.bsize; } catch { return null; }
  };

  o.reg("setup.status", async () => {
    const orb = await detectOrb({ exec: o.exec, home: o.home });
    const box = provisioner.state();
    const status: SetupStatus = {
      done: isDone(), machine: o.machine(), orb, box: slim(box) as SetupStatus["box"], connected: o.connected(),
      mac: { arm64: process.arch === "arm64", freeBytes: freeBytes() },
    };
    return status;
  });
  // The gate the window asks first: no OrbStack call, so an existing install starts as fast as before.
  o.reg("setup.done", () => ({ done: isDone() }));
  o.reg("setup.orb.download", () => o.openExternal(ORBSTACK_DOWNLOAD_URL));
  o.reg("setup.orb.start", () => startOrbStack(o.exec, { home: o.home }));
  o.reg("setup.box.start", () => {
    // One operation on the Bots' computer at a time: refused (and nothing run) while another holds it.
    if (provisioner.state().phase === "running") return { started: false };
    const release = o.lock.tryAcquire("setup");
    if (!release) return { started: false, busy: boxBusyMessage(o.lock.holder()) };
    const s = settings();
    // The machine name is decided once and kept: a relaunch mid-setup resumes on the same machine.
    if (!s.boxMachine) writeAppSettings(o.userData, { boxMachine: o.machine() });
    // Retry reuses the same provisioner: its steps resume where the last run stopped, and the log stays.
    void provisioner.start().then((end) => {
      release();
      o.log(`setup: the Bots' computer ${end.phase}${end.error ? ` (${end.error})` : ""} in ${Math.round(((end.finishedAt ?? 0) - (end.startedAt ?? 0)) / 1000)} s ${JSON.stringify(end.timings)}`);
    });
    return { started: true };
  });
  o.reg("setup.box.cancel", () => { provisioner.cancel(); return { ok: true }; });
  o.reg("setup.box.log", () => provisioner.state().log.join("\n"));
  o.reg("setup.finish", () => { writeAppSettings(o.userData, { setupDone: true }); o.log("setup: finished"); return { done: true }; });
  return { isDone, provisioner };
}
