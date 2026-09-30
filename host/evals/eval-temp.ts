import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Temp dirs for an eval run, removed when the run is done (or the process exits). The approval eval used to leave
 * one `eval-*` dir per case in the system temp dir; every eval script makes its temp dirs through this instead.
 */
export class EvalTemp {
  private dirs = new Set<string>();
  private readonly onExit = () => this.cleanup();

  constructor(private base: string = os.tmpdir()) {
    process.once("exit", this.onExit);
  }

  /** A new dir under the temp dir, tracked for cleanup. */
  dir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(this.base, prefix));
    this.dirs.add(d);
    return d;
  }

  /** Remove one dir now (after its case). */
  done(d: string): void {
    fs.rmSync(d, { recursive: true, force: true });
    this.dirs.delete(d);
  }

  /** Remove every dir still tracked. Safe to call twice. */
  cleanup(): void {
    for (const d of this.dirs) fs.rmSync(d, { recursive: true, force: true });
    this.dirs.clear();
    process.removeListener("exit", this.onExit);
  }

  get live(): number { return this.dirs.size; }
}
