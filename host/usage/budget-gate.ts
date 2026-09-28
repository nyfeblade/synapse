import type { AuthProxy } from "../auth/proxy";

type Unreported = NonNullable<ConstructorParameters<typeof AuthProxy>[0]["onUnreported"]>;
type Allow = (botId: string | null) => { ok: boolean; message: string | null };

/** Bounded so a host that never wires its budget can't grow this without end. */
const MAX_QUEUED = 1_000;
export const BUDGET_STARTING_MSG = "Synapse is still starting; try again in a moment.";

/**
 * Bug 296: the key proxy asks the spend budget before each model call and hands it the spend no CLI reported. The budget
 * exists only once Phase 5 is wired, well after boot, so until then every call is refused (fail closed) and unreported
 * spend is queued, then recorded when the budget arrives. `ready` resolves when it is wired: boot conformance, the first
 * real model calls, waits for it.
 */
export class BudgetGate {
  private allowFn: Allow | null = null;
  private unreportedFn: Unreported | null = null;
  private queued: Parameters<Unreported>[] = [];
  private resolve!: () => void;
  readonly ready = new Promise<void>((r) => { this.resolve = r; });

  allow(botId: string | null): { ok: boolean; message: string | null } {
    return this.allowFn ? this.allowFn(botId) : { ok: false, message: BUDGET_STARTING_MSG };
  }

  unreported(...a: Parameters<Unreported>): void {
    if (this.unreportedFn) { this.unreportedFn(...a); return; }
    if (this.queued.length < MAX_QUEUED) this.queued.push(a);
  }

  wire(o: { allow: Allow; unreported: Unreported }): void {
    this.allowFn = o.allow;
    this.unreportedFn = o.unreported;
    for (const a of this.queued.splice(0)) o.unreported(...a);
    this.resolve();
  }
}
