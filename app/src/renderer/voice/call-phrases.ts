import { CALL_FEEL, STRV, timeOfDay, type CallGreeting } from "@synapse/shared";

/**
 * Bug 134: the lines a call says by itself, chosen in code. Greetings: one of the Bot's own set (or the
 * stock set) for the time of day, never one of the last 3 used for that Bot (kept per viewer, in this
 * Mac's browser storage). Fillers, "sorry, go ahead" and "that'll take a minute": a shuffle bag each,
 * so no line comes back until the others have been said.
 */

/** Draws every item once, in a random order, before any repeats; never the same item twice in a row. */
export class ShuffleBag<T> {
  private bag: T[] = [];
  private last: T | undefined;
  constructor(private items: readonly T[], private rand: () => number = Math.random) {}
  next(): T | undefined {
    if (!this.items.length) return undefined;
    if (!this.bag.length) {
      this.bag = [...this.items];
      for (let i = this.bag.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [this.bag[i], this.bag[j]] = [this.bag[j]!, this.bag[i]!]; }
      if (this.bag.length > 1 && this.bag[this.bag.length - 1] === this.last) this.bag.unshift(this.bag.pop()!);
    }
    this.last = this.bag.pop();
    return this.last;
  }
}

/** This Mac's browser storage (reached through globalThis, so the bags also run in the host's latency harness). */
const store = () => (globalThis as unknown as { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;

const RECENT_KEY = (botId: string) => `synapse.callGreetings.recent.${botId}`;
const BAG_KEY = (botId: string) => `synapse.callGreetings.bag.${botId}`;

function readTexts(key: string, cap?: number): string[] {
  try {
    const v = JSON.parse(store().getItem(key) ?? "[]") as unknown;
    const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return cap === undefined ? list : list.slice(-cap);
  } catch { return []; }
}

export function recentGreetings(botId: string): string[] {
  return readTexts(RECENT_KEY(botId), CALL_FEEL.greetingNoRepeat);
}

/** The greetings already drawn in this Bot's current bag (bug 151: a shuffle bag, not a coin toss). */
export function drawnGreetings(botId: string): string[] {
  return readTexts(BAG_KEY(botId));
}

function rememberGreeting(botId: string, text: string, drawn: string[]): void {
  try {
    const next = [...recentGreetings(botId).filter((t) => t !== text), text].slice(-CALL_FEEL.greetingNoRepeat);
    store().setItem(RECENT_KEY(botId), JSON.stringify(next));
    store().setItem(BAG_KEY(botId), JSON.stringify(drawn.slice(-2 * CALL_FEEL.greetingsMax)));
  } catch { /* private window: the rotation is best effort */ }
}

/**
 * One greeting for right now, drawn from a shuffle bag (bug 151): every greeting for this time of day is
 * said once before any is said again, and never one of the last 3 used for this Bot. `joining` (a Bot
 * added mid-call) wants a short, any-time one ("Hey, what's up?"). The bag survives a restart (it lives
 * in this Mac's browser storage), and each time of day keeps its own progress.
 */
export function nextGreeting(
  greetings: CallGreeting[],
  o: { hour: number; recent: string[]; drawn?: string[]; joining?: boolean; rand?: () => number },
): { text: string; drawn: string[] } | null {
  const tod = timeOfDay(o.hour);
  // This time of day's greetings win when there are any; otherwise the any-time ones carry the call.
  let pool = greetings.filter((g) => (o.joining ? !g.when && g.text.split(/\s+/).length <= 4 : !g.when || g.when === tod));
  if (o.joining && !pool.length) pool = greetings.filter((g) => !g.when);
  if (!pool.length) pool = greetings;
  if (!pool.length) return null;

  const inPool = new Set(pool.map((g) => g.text));
  const all = o.drawn ?? [];
  const others = all.filter((t) => !inPool.has(t)); // another time of day's bag: left as it is
  let drawn = all.filter((t) => inPool.has(t));
  let fresh = pool.filter((g) => !drawn.includes(g.text) && !o.recent.includes(g.text));
  if (!fresh.length) {
    drawn = []; // the bag is empty: refill it, still never one of the last 3
    fresh = pool.filter((g) => !o.recent.includes(g.text));
  }
  if (!fresh.length) fresh = pool; // a tiny set (fewer than 4): the no-repeat rule can't be met
  const text = fresh[Math.floor((o.rand ?? Math.random)() * fresh.length)]!.text;
  return { text, drawn: [...others, ...drawn, text] };
}

/** `nextGreeting`'s text alone. */
export function pickGreeting(greetings: CallGreeting[], o: { hour: number; recent: string[]; drawn?: string[]; joining?: boolean; rand?: () => number }): string | null {
  return nextGreeting(greetings, o)?.text ?? null;
}

/** Picks and remembers (so the next calls avoid it and the bag moves on). */
export function takeGreeting(botId: string, greetings: CallGreeting[], o: { joining?: boolean; now?: Date } = {}): string | null {
  const next = nextGreeting(greetings, { hour: (o.now ?? new Date()).getHours(), recent: recentGreetings(botId), drawn: drawnGreetings(botId), joining: o.joining });
  if (next) rememberGreeting(botId, next.text, next.drawn);
  return next?.text ?? null;
}

/** Bug 218: every end-of-turn sound, once each. */
export function ackLines(): string[] {
  return [...new Set([...STRV.acks.question, ...STRV.acks.request, ...STRV.acks.other])];
}

/** The fixed lines every Bot may say by itself (pre-rendered in its voice, like its greetings). */
export function stockLines(): string[] {
  return [...STRV.fillers, ...STRV.sorryLines, ...STRV.longTaskLines, ...STRV.goodbyes, ...ackLines(), STRV.delegatedOnIt];
}

export type AckMood = "question" | "request" | "other";

/**
 * A shuffle bag per kind per Bot, for one call. Bug 218: `ready(botId, text)` says whether an end-of-turn sound is
 * already rendered in that Bot's voice — a sound is only worth making if it can play at once, so one that isn't
 * is never drawn (the call just waits for the answer, as before).
 */
export function phraseBags(o: { ready?: (botId: string, text: string) => boolean; rand?: () => number } = {}): { next(kind: "filler" | "sorry" | "long-task" | "ack", botId: string, mood?: AckMood): string | null } {
  const bags = new Map<string, ShuffleBag<string>>();
  const lists = { filler: STRV.fillers, sorry: STRV.sorryLines, "long-task": STRV.longTaskLines } as const;
  return {
    next(kind, botId, mood = "other") {
      const list: readonly string[] = kind === "ack" ? STRV.acks[mood] : lists[kind];
      const k = `${kind}:${kind === "ack" ? mood : ""}:${botId}`;
      let b = bags.get(k);
      if (!b) { b = new ShuffleBag(list, o.rand); bags.set(k, b); }
      if (kind !== "ack") return b.next() ?? null;
      // A sound not rendered yet is skipped (the bag moves on); none ready at all = no sound this turn.
      for (let i = 0; i < list.length; i++) {
        const t = b.next();
        if (t && (!o.ready || o.ready(botId, t))) return t;
      }
      return null;
    },
  };
}
