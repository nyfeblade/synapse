/**
 * Bug 433: linear-time forms of text scans the Mac gate runs on a whole command. A regex like
 * `\bcurl\b[^\n]*(-X|--data)` backtracks: from every `curl` it runs to the end of the line and then tries the tail at
 * each place on the way back, so a long line of repeated `curl` is quadratic. `inOrder` answers the same question
 * moving forward only. Pure string code (no node imports).
 */

/**
 * Bug 433: the longest Mac command the gate analyses (UTF-16 units). A longer one is too long to check ahead of time:
 * the fixed rules make it a card (after only the linear NEVER for the app's own data), the Mac gate asks for this
 * call's own approval in every mode, and the Full-auto classifier asks. Never allowed, never deferred.
 */
export const MAC_COMMAND_MAX = 256 * 1024;

/** The regex with the global flag, so a search can start at any index. */
function globalOf(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/**
 * True when the text has a match of parts[0], then parts[1], … in that order, each next part starting at or after the
 * end of the one before it with no `stop` character (a one-char class, like /[\n;&]/) in between: what the regex
 * `parts[0][^stop]*parts[1][^stop]*…` finds. Each part must end at one place for a given start and can't start inside
 * the part before it (a word, a fixed flag, a pipe): every use is of that shape, so taking each next part's first
 * match is never worse than a later one. Linear: every first-part match is tried, but each part's searches only move
 * forward, and its next match and next stop char are kept while still ahead.
 */
export function inOrder(text: string, parts: readonly RegExp[], stop: RegExp): boolean {
  const res = parts.map(globalOf);
  const next: ({ start: number; end: number } | null)[] = res.map(() => null);
  const from: number[] = res.map(() => Infinity);
  /** The first match of part k starting at or after `pos`. */
  const find = (k: number, pos: number): { start: number; end: number } | null => {
    const c = next[k];
    if (pos >= from[k]! && (c === null || c.start >= pos)) return c;
    const re = res[k]!;
    re.lastIndex = pos;
    const m = re.exec(text);
    const hit = m ? { start: m.index, end: m.index + m[0].length } : null;
    next[k] = hit;
    from[k] = pos;
    return hit;
  };
  /** The first stop char at or after `pos` (text.length when none). */
  const stops: { from: number; at: number }[] = res.map(() => ({ from: Infinity, at: -1 }));
  const stopAt = (k: number, pos: number): number => {
    const c = stops[k]!;
    if (pos >= c.from && pos <= c.at) return c.at;
    let j = pos;
    while (j < text.length && !stop.test(text[j]!)) j++;
    stops[k] = { from: pos, at: j };
    return j;
  };
  let pos = 0;
  while (pos <= text.length) {
    const first = find(0, pos);
    if (!first) return false;
    let end = first.end;
    let ok = true;
    for (let k = 1; k < res.length && ok; k++) {
      const m = find(k, end);
      if (!m || m.start > stopAt(k, end)) ok = false;
      else end = m.end;
    }
    if (ok) return true;
    pos = first.start + 1;
  }
  return false;
}

/**
 * Bug 433: realpath of a path's deepest existing ancestor, joined with the missing tail — what the gate's walk-up did
 * (try the path, then its parent, then its parent …), without its quadratic cost on a deep hostile path
 * (`a/a/a/…`, 100 000 levels: one realpath call and one array shift per level). A path that resolves has ancestors
 * that resolve (resolving it resolves each of them), so the deepest one is found by binary search: a few calls.
 * Returns `realpath(ancestor) + "/" + tail` (just the realpath when the path itself resolves), or null when not even
 * "/" resolves (a relative path, which the gate never passes, stops at its first segment).
 */
export function realOfDeepest(abs: string, realpath: (p: string) => string): string | null {
  const tryReal = (p: string): string | null => { try { return realpath(p); } catch { return null; } };
  const whole = tryReal(abs);
  if (whole !== null) return whole;
  if (abs === "/") return null;
  // The walk's candidates, deepest first: cut at each "/" from the right, ending at the first that is "/".
  const cuts: number[] = [];
  for (let i = abs.lastIndexOf("/"); i >= 0; i = i > 0 ? abs.lastIndexOf("/", i - 1) : -1) {
    cuts.push(i);
    if ((abs.slice(0, i) || "/") === "/") break;
  }
  if (!cuts.length) return null;
  const cand = (k: number) => abs.slice(0, cuts[k]) || "/";
  const joined = (k: number, real: string) => `${real}/${abs.slice(cuts[k]! + 1)}`;
  // Binary search for the deepest (lowest k) candidate that resolves; the shallowest one first.
  const last = cuts.length - 1;
  const top = tryReal(cand(last));
  if (top === null) return null;
  let lo = 0;
  let hi = last;
  let best = top; // always realpath(cand(hi))
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = tryReal(cand(mid));
    if (r !== null) { hi = mid; best = r; } else lo = mid + 1;
  }
  return joined(hi, best);
}
