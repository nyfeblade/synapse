import type { RunTrigger } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

/** RTN-19: trays only for manual runs, at failure counts 1, 2, 4, 8…; reset after the next ok run. Durable across restarts. */
export class FailureThrottle {
  private counts: Record<string, number>;

  constructor(private file: string) {
    this.counts = readJson<Record<string, number>>(file, {});
  }

  note(botId: string, routineId: string, ok: boolean, trigger: RunTrigger): boolean {
    const k = `${botId}/${routineId}`;
    if (ok) {
      if (this.counts[k]) {
        delete this.counts[k];
        this.save();
      }
      return false;
    }
    if (trigger !== "manual") return false;
    const n = (this.counts[k] ?? 0) + 1;
    this.counts[k] = n;
    this.save();
    return (n & (n - 1)) === 0;
  }

  private save(): void {
    writeJsonAtomic(this.file, this.counts, 0o600);
  }
}
