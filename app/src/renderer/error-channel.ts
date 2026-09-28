// The renderer's one error channel.
//
// The app already had a place to put "this action failed": `actionError` in store.ts, rendered by
// Sidebar.tsx as a role="alert" banner. What it did not have was a DEFAULT route into it — every
// write decided for itself, and 19 of them decided nothing at all. bridge.ts now routes every
// rejected call() here, and store.ts registers the sink that writes the message into `actionError`.
//
// A sink rather than a direct import of the store so the bridge keeps knowing nothing about UI
// state (and so there is no bridge ↔ store import cycle).

import { GatewayCallError } from "@synapse/shared";

type Sink = (message: string) => void;
const IN_PLACE_CODES = new Set(["BUDGET_ASK"]);

let sink: Sink | null = null;

/** store.ts calls this once, at module load. */
export function setErrorSink(fn: Sink): void {
  sink = fn;
}

/** The user-facing text of a failure. GatewayCallError's message is the host's own wording. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Put a failure in front of the user. Called by default from call(); see bridge.ts. */
export function reportFailure(e: unknown): void {
  // cost-dashboard: "this would pass a budget, continue?" is a question the composer asks in place with
  // an approval card (BudgetAskCard); in the banner it would read as a failure, twice.
  if (e instanceof GatewayCallError && IN_PLACE_CODES.has(e.code)) return;
  // No sink means the store module was never loaded, which in the real app cannot happen (main.tsx
  // imports App, which imports the store). Swallowing here rather than throwing keeps a reporting
  // path from ever being the thing that breaks a render.
  sink?.(messageOf(e));
}
