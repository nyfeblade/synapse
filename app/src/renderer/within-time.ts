/** A sign-in step that hasn't answered by then says so with a plain line (STR.hostTimeout). */
export const SIGN_IN_TIMEOUT_MS = 90_000;

/**
 * Runs `p` to the end, and calls `onSlow` if it hasn't settled within `ms`. It never gives up on `p` early: main's
 * call may still land (a late Save), so the caller keeps its buttons off until it does and only says it's slow.
 */
export async function noteIfSlow<T>(p: Promise<T>, ms: number, onSlow: () => void): Promise<T> {
  const t = setTimeout(onSlow, ms);
  try { return await p; } finally { clearTimeout(t); }
}
