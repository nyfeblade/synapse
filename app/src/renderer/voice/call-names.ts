/**
 * Bug 134: names on a call, in code (never a model call). Who an utterance addresses, who a Bot hands
 * a part to ("Cy, can you take the calendar part?"), and — for voice commands — which Bot a heard name
 * means, tolerant of case and small speech-recognition slips ("Disc Saver" → "Disk Saver").
 */

export interface NamedBot { id: string; name: string }

const WORD = "[\\p{L}\\p{N}_]";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The same handles the host's room uses (host/groups/addressing.ts): the full name, without spaces, and its first word. */
export function handlesOf(name: string): string[] {
  const full = name.trim().toLowerCase().replace(/\s+/g, " ");
  return [...new Set([full, full.replace(/ /g, ""), full.split(" ")[0] ?? full].filter(Boolean))];
}

function mentions(text: string, handle: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escape(handle).replace(/ /g, "\\s+")}(?!${WORD})`, "iu").test(text);
}

/** The Bots a line names (exact handles, any case), in roster order. */
export function namesIn(text: string, bots: NamedBot[]): string[] {
  return bots.filter((b) => handlesOf(b.name).some((h) => mentions(text, h))).map((b) => b.id);
}

// ---- fuzzy: a heard name → the Bots it could mean ----

const norm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Sounds-alike folding for recognizer slips: c/k/q, ph/f, z/s, doubled letters, a silent trailing e. */
const fold = (s: string) => norm(s).replace(/ph/g, "f").replace(/[ckq]/g, "k").replace(/z/g, "s").replace(/(\p{L})\1+/gu, "$1").replace(/e\b/g, "").replace(/\s+/g, "");

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length]!;
}

/**
 * The Bots `heard` could mean, best first: an exact name or first name wins outright; otherwise every
 * Bot within a small edit distance of the sounds-alike form (1 slip for short names, 2 for longer ones).
 * More than one = ambiguous (the call asks on screen); none = "I couldn't find a Bot called …".
 */
export function matchBots(heard: string, bots: NamedBot[]): string[] {
  const h = norm(heard).replace(/^(the|a|an|our|my)\s+/, "").replace(/\s+(bot|please|too|as well|now|here)$/g, "").trim();
  if (!h) return [];
  const exact = bots.filter((b) => { const n = norm(b.name); return n === h || n.split(" ")[0] === h || n.replace(/ /g, "") === h.replace(/ /g, ""); });
  if (exact.length) {
    const full = exact.filter((b) => norm(b.name) === h);
    return (full.length ? full : exact).map((b) => b.id);
  }
  const fh = fold(h);
  const scored: { id: string; d: number }[] = [];
  for (const b of bots) {
    const candidates = [fold(b.name), fold(norm(b.name).split(" ")[0] ?? "")].filter(Boolean);
    const d = Math.min(...candidates.map((c) => distance(fh, c)));
    const allowed = fh.length <= 4 ? 1 : 2;
    if (d <= allowed) scored.push({ id: b.id, d });
  }
  if (!scored.length) return [];
  const best = Math.min(...scored.map((s) => s.d));
  return scored.filter((s) => s.d === best).map((s) => s.id);
}
