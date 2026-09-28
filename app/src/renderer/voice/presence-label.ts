import { STRV, type BotSummary } from "@synapse/shared";

export type BotPresenceKind = "call" | "busy" | "idle";

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim().replace(/[.…]+$/, "");
  return one.length <= n ? one : `${one.slice(0, n - 1).trimEnd()}…`;
};

/**
 * Bug 134 (item 12): what each Bot is doing, from state the app already has (no model call): on the
 * live call, working on something (its current activity, short), or idle.
 */
export function botPresence(b: BotSummary, onCall: boolean): { kind: BotPresenceKind; label: string } {
  if (onCall) return { kind: "call", label: STRV.presenceOnCall };
  if (b.running || (b.presence && b.presence !== "idle")) {
    const task = short(b.activity?.detail ?? b.activity?.tool ?? "", 32);
    return { kind: "busy", label: STRV.presenceBusy(task) };
  }
  return { kind: "idle", label: STRV.presenceIdle };
}
