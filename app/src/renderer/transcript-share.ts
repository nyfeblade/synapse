import type { TranscriptItem } from "./transcript-items";

/**
 * Bug 442: `buildTranscriptItems` rebuilds every item on every transcript event, so every row looked changed and
 * every row re-rendered: a 100-turn chat spent ~0.5 s of main thread per reply. Structural sharing: an item equal
 * in value to the one with the same key last time IS that one, so a memoised row sees the same object and skips.
 * Entries are compared by identity first; a value compare (bounded depth) covers the objects built per pass
 * (activity rows, approval views).
 */
export function sameValue(a: unknown, b: unknown, depth = 6): boolean {
  if (a === b) return true;
  if (depth <= 0 || typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i], depth - 1)) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1)) return false;
  }
  return true;
}

/** Keep last pass's object for every item whose value is unchanged; `prev` is updated to this pass. */
export function shareItems(prev: Map<string, TranscriptItem>, next: TranscriptItem[]): TranscriptItem[] {
  const out = next.map((it) => {
    const p = prev.get(it.key);
    return p && p.kind === it.kind && sameValue(p, it) ? p : it;
  });
  prev.clear();
  for (const it of out) prev.set(it.key, it);
  return out;
}
