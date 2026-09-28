import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import { availableFromVmStat } from "@synapse/shared";

/**
 * Available memory on this Mac (free + reclaimable pages from `vm_stat`), not os.freemem()'s bare
 * "free" line. Kept as a cached number so the many synchronous voice-mode reads never spawn a
 * process: seeded once at startup (~5 ms), refreshed in the background by the call's memory watch.
 */
let cached: number | null = null;

const VM_STAT = "/usr/bin/vm_stat";

export function seedAvailableMemory(): void {
  if (process.platform !== "darwin") return;
  try { cached = availableFromVmStat(execFileSync(VM_STAT, { encoding: "utf8", timeout: 1_000 })); } catch { cached = null; }
}

export function refreshAvailableMemory(): Promise<number> {
  if (process.platform !== "darwin") return Promise.resolve(os.freemem());
  return new Promise((resolve) => {
    execFile(VM_STAT, { encoding: "utf8", timeout: 1_000 }, (err, out) => {
      if (!err) cached = availableFromVmStat(out);
      resolve(cached ?? os.freemem());
    });
  });
}

export function availableMemory(): number {
  return cached ?? os.freemem();
}
