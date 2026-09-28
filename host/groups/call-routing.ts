import type { RoomMessage } from "./member-prompt";

/**
 * Call-behaviour (the user's decision D4, spatial-calls design §3.2): on a call with several Bots, an utterance that
 * names nobody is routed IN CODE — no floor-manager model call (it added up to 5 s before a spoken reply could start,
 * and a helper-model call per unnamed utterance on calls with 3+ Bots).
 *
 *   1. Continuity: the Bot that spoke last answers if its last line asked something, or came shortly before the
 *      user's post (the conversation is with it).
 *   2. Otherwise, a local relevance score: the utterance's words against each Bot's name, title and description.
 *      The top score wins only by a clear margin.
 *   3. Otherwise the Bot that spoke last (else the first on the call).
 *
 * Names ("Scout, …") and "everyone" are resolved before this, as they always were.
 */

/**
 * A Bot line posted this recently before the user's post keeps the floor. Post times, not speech times: a reply is
 * posted when it is written and read aloud after (5-15 s of audio on the user's calls), so the window is wider than
 * the ~8 s of silence a person would allow.
 */
export const CALL_CONTINUITY_MS = 20_000;
/** Review round 1: a Bot's question keeps the floor a little longer than a plain line, but not for ever. */
export const CALL_QUESTION_MS = 30_000;

export interface CallMember { id: string; name: string; description: string }

const STOP = new Set(("about above after again also always another any anything around back been before being best both " +
  "call can could come could does doing done down each else even ever every find first from gets give going good have " +
  "here hers into just keep know last like look make many maybe more most much must need next only other over please " +
  "really right same should show some something still such sure take tell than thank thanks that thats their them then " +
  "there these they thing things think this those through time today tomorrow tonight very want what whats when where " +
  "which while will with would your yours yeah okay").split(" "));

/** Light stemming that keeps the word: "meetings" → "meet", "booked" → "book", "boxes" → "box", "notes" → "note". */
function stem(w: string): string {
  if (/(?:ing|ed)$/.test(w) && w.length - (w.endsWith("ing") ? 3 : 2) >= 4) return stem(w.replace(/(?:ing|ed)$/, ""));
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (/(?:ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && w.length > 4) return w.slice(0, -1);
  return w;
}
/** Content words, lightly stemmed. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** Review round 1: the user's newest post, found by who wrote it (a Bot line can land in the chat after it). */
export function lastUserPost(history: RoomMessage[]): RoomMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.from === "user") return history[i];
  return undefined;
}

export function pickCallResponder(p: { post: RoomMessage | undefined; members: CallMember[]; history: RoomMessage[] }): string | null {
  const ids = p.members.map((m) => m.id);
  if (!ids.length) return null;
  const cut = p.post ? p.history.indexOf(p.post) : -1;
  const before = cut >= 0 ? p.history.slice(0, cut) : p.history;
  const last = [...before].reverse().find((m) => ids.includes(m.from));
  // 1. Continuity: a line shortly before, or a question a little longer before.
  const gap = last && p.post ? p.post.at - last.at : Infinity;
  if (last && (gap <= CALL_CONTINUITY_MS || (last.text.trim().endsWith("?") && gap <= CALL_QUESTION_MS))) return last.from;
  // 2. Relevance, by a clear margin.
  const said = contentWords(p.post?.text ?? "");
  if (said.size) {
    const scored = p.members.map((m) => {
      const knows = contentWords(`${m.name} ${m.description}`);
      let n = 0;
      for (const w of said) if (knows.has(w)) n += 1;
      return { id: m.id, n };
    }).sort((a, b) => b.n - a.n);
    if (scored[0]!.n >= 1 && scored[0]!.n - (scored[1]?.n ?? 0) >= 1) return scored[0]!.id;
  }
  // 3. The last speaker, else the first on the call.
  return last?.from ?? ids[0]!;
}
