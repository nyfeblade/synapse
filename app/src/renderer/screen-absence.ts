import { useComputer, type ComputerState } from "./computer-state";

/**
 * Bug 36 — WHY a Bot's screen area is blank.
 *
 * `displays[botId]` being absent had exactly one rendering: nothing. Three different situations
 * produce it, and until they are told apart neither the user nor a bug report can say which one
 * they are looking at (that is what kept bug 3 undiagnosable):
 *
 *   `unreachable` — the `getDisplays` fetch failed. The host never answered, so we know NOTHING
 *                   about this Bot's screen. The only one of the three with an action: retry.
 *   `waiting`     — the host answered and named this Bot in `waiting`: every seat on the shared
 *                   computer (MAX_SCREENS) is taken and no idle one could be reclaimed yet.
 *                   Normal and by design; it must not read as a failure.
 *   `none`        — the host answered and simply has no display assigned for this Bot (it has
 *                   never done anything on the computer). Also normal.
 *   `loading`     — nothing has been asked yet. Not an answer, so it must not claim one.
 *
 * The order matters. A failed fetch outranks `waiting` because `waiting` is then last-known data we
 * could not refresh, while a Bot that HAS a display outranks the failed fetch because the pool
 * dials it and reports its own connection outcome in place.
 */
export type ScreenAbsence =
  | { kind: "loading" }
  | { kind: "unreachable"; error: string | null }
  | { kind: "waiting" }
  | { kind: "none" }
  /** Host gave this Bot a screen; the VNC dial has not come up yet. */
  | { kind: "connecting" }
  /** Host gave this Bot a screen; connect/disconnect/timeout failed. */
  | { kind: "dial-failed" };

export type DisplaysFacts = Pick<ComputerState, "displays" | "waiting" | "displaysLoad" | "displaysError">;

/** The reason this Bot's screen area is blank, or null when it has a screen and there is nothing to explain. */
export function screenAbsence(s: DisplaysFacts, botId: string): ScreenAbsence | null {
  if (s.displays[botId]) return null;
  if (s.displaysLoad === "failed") return { kind: "unreachable", error: s.displaysError };
  if (s.waiting.includes(botId)) return { kind: "waiting" };
  if (s.displaysLoad === "loading") return { kind: "loading" };
  return { kind: "none" };
}

/**
 * The same answer, for a component.
 *
 * Four separate selectors on purpose: a single selector returning `screenAbsence(s, botId)` builds
 * a fresh object on every call, and useSyncExternalStore compares snapshots by identity — it would
 * re-render on every unrelated store change and warn that the snapshot is not cached. Each of these
 * four returns a value or a stable reference.
 */
export function useScreenAbsence(botId: string): ScreenAbsence | null {
  const displays = useComputer((s) => s.displays);
  const waiting = useComputer((s) => s.waiting);
  const displaysLoad = useComputer((s) => s.displaysLoad);
  const displaysError = useComputer((s) => s.displaysError);
  return screenAbsence({ displays, waiting, displaysLoad, displaysError }, botId);
}
