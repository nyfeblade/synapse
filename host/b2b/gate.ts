import { B2B_KINDS, LIMITS, type B2BKind, type B2BRequest, type SendToAgentArgs } from "@synapse/shared";
import type { RequestStore } from "./requests";
import { extractArtifacts, hasAsk, informativeTokens, isCourtesyOnly, jaccard, normalizeText, novelty, sha1, tokenSet4 } from "./text";
import type { ThreadStore } from "./threads";

export type GateDecision =
  | { verdict: "reject"; check: "G1" | "G6"; text: string }
  | { verdict: "drop"; check: "G2" | "G3" | "G4" | "G5" | "G7"; text: string }
  | { verdict: "pass"; boundRid: string | null; kind: B2BKind }
  | { verdict: "ambiguous"; check: "G7" | "G8"; boundRid: string | null; kind: B2BKind; digest: string };

export interface GateInput { from: string; to: string; toName: string; args: SendToAgentArgs; requests: RequestStore; threads: ThreadStore; nameOf(id: string): string; now: number }

const WAKING: B2BKind[] = ["request", "question", "blocker", "handoff"];
const NEEDS_EXPECTS: B2BKind[] = ["request", "question", "handoff"];
const TEXT = {
  kind: "Not sent: kind is required. Use request, question, blocker, handoff or result.",
  field: (field: string, kind: string, hint: string) => `Not sent: ${field} is required for kind "${kind}". ${hint}`,
  g2: "Not sent: that request was already answered, and results don't take replies. If you need something more, send a new request.",
  g3: "Not sent: this only acknowledges or thanks. Bots never send acknowledgements — the other Bot already knows its message arrived. Continue your work.",
  dup: (name: string, min: number) => `Not sent: it repeats what you already sent ${name} ${min} min ago.`,
  g6Answered: (rid: string, min: number, preview: string) => `Not sent: this repeats request ${rid} (answered ${min} min ago: "${preview.slice(0, 200)}"). Use that result or ask something new.`,
  g6Open: (rid: string, min: number) => `Not sent: this repeats request ${rid} (still open, sent ${min} min ago). Its result will wake you — use it or ask something new.`,
  g7: (name: string) => `Not sent: it adds nothing new to your thread with ${name}. Send only new results, questions, requests or blockers.`,
};
const mins = (now: number, at: number) => Math.max(1, Math.round((now - at) / 60_000));
const words4 = (tokens: string[]) => new Set(tokens.filter((t) => /^[\p{L}]{4,}$/u.test(t)));
const isData = (t: string) => /\d|\/|https?:/.test(t);

/** ORIG-09 §09.2: deterministic checks in order; the first that decides ends the gate. */
export function runGate(i: GateInput): GateDecision {
  const a = i.args;
  const kind = a.kind;
  const reject = (text: string): GateDecision => ({ verdict: "reject", check: "G1", text });

  // G1 schema
  if (!kind || !(B2B_KINDS as readonly string[]).includes(kind)) return reject(TEXT.kind);
  const msg = (a.message ?? "").trim();
  if (!msg) return reject(TEXT.field("message", kind, "Write the message itself."));
  if (msg.length > LIMITS.b2bMessageMax) return reject("Not sent: message is longer than 8,000 characters. Put long content in a file under /workspace and send its path.");
  const expects = (a.expects ?? "").trim();
  if (NEEDS_EXPECTS.includes(kind) && expects.length < LIMITS.b2bExpectsMin) return reject(TEXT.field("expects", kind, "Say exactly what you expect back (at least 8 characters)."));
  if (expects.length > LIMITS.b2bExpectsMax) return reject("Not sent: expects can be at most 300 characters.");
  if ((a.artifacts?.length ?? 0) > LIMITS.b2bArtifactsMax) return reject("Not sent: at most 10 artifacts per message.");
  let bound: B2BRequest | null = null;
  if (a.in_reply_to) {
    const r = i.requests.get(a.in_reply_to);
    const betweenPair = r && ((r.from === i.to && r.to === i.from) || (r.from === i.from && r.to === i.to));
    if (!r || !betweenPair) return reject(TEXT.field("in_reply_to", kind, `${a.in_reply_to} isn't a request between you and ${i.toName}. Use the id from the message you are answering.`));
    // G2 reply to a result
    if (r.status === "answered") return { verdict: "drop", check: "G2", text: TEXT.g2 };
    if (r.status !== "open") return reject(`Not sent: request ${r.rid} is no longer open (${r.status}).`);
    if (kind === "result" && r.from !== i.to) return reject(TEXT.field("in_reply_to", kind, `${r.rid} was your own request; only ${i.toName} can answer it.`));
    bound = r;
  } else if (kind === "result") {
    const open = i.requests.openBetween(i.to, i.from);
    if (open.length === 1) bound = open[0] as B2BRequest;
  }

  // G3 acknowledgement only
  if (isCourtesyOnly(msg)) return { verdict: "drop", check: "G3", text: TEXT.g3 };

  const lines = i.threads.lines(i.from, i.to);
  // G4 exact duplicate in the last 24 h, either direction
  const h = sha1(normalizeText(msg));
  const dup = [...lines].reverse().find((l) => l.sha1 === h && i.now - l.at <= LIMITS.gateExactDupWindowMs);
  if (dup) return { verdict: "drop", check: "G4", text: TEXT.dup(i.toName, mins(i.now, dup.at)) };

  // G5 near duplicate of the sender's last message to this recipient (2 h), with no new artifact or data.
  // Requests and questions skip G5: a re-sent request is G6's job, whose error names the earlier request (and counts toward L2).
  const last = [...lines].reverse().find((l) => l.from === i.from && l.to === i.to && i.now - l.at <= LIMITS.gateNearDupWindowMs);
  if (last && kind !== "request" && kind !== "question") {
    const lastTokens = new Set(last.tokens);
    const newData = informativeTokens(msg).filter((t) => isData(t) && !lastTokens.has(t));
    const newArtifacts = (a.artifacts ?? []).filter((x) => !last.artifacts.includes(x));
    if (jaccard(tokenSet4(msg), words4(last.tokens)) >= LIMITS.gateNearDupJaccard && !newData.length && !newArtifacts.length) {
      return { verdict: "drop", check: "G5", text: TEXT.dup(i.toName, mins(i.now, last.at)) };
    }
  }

  // G6 repeated request (open, or answered in the last 2 h)
  if (kind === "request" || kind === "question") {
    const mine = tokenSet4(`${msg} ${expects}`);
    for (const r of i.requests.recentBetween(i.from, i.to, LIMITS.gateRepeatWindowMs)) {
      if (r.kind !== "request" && r.kind !== "question") continue;
      const orig = lines.find((l) => l.rid === r.rid);
      const theirs = orig ? new Set([...words4(orig.tokens), ...tokenSet4(r.expects)]) : tokenSet4(r.expects);
      if (jaccard(mine, theirs) >= LIMITS.gateRepeatJaccard) {
        const text = r.status === "answered" ? TEXT.g6Answered(r.rid, mins(i.now, r.answeredAt ?? r.createdAt), r.answerPreview ?? "") : TEXT.g6Open(r.rid, mins(i.now, r.createdAt));
        return { verdict: "reject", check: "G6", text };
      }
    }
  }

  // G7 novelty against the thread digest and the message being answered
  const digest = i.threads.digest(i.from, i.to, i.requests, i.nameOf);
  if (!(kind === "result" && bound)) {
    const known = new Set(informativeTokens(digest));
    for (const l of lines) for (const t of l.tokens) known.add(t);
    if (bound) for (const t of informativeTokens(bound.expects)) known.add(t);
    const nov = novelty(informativeTokens(msg), known);
    const threadArtifacts = new Set(lines.flatMap((l) => l.artifacts));
    const newArtifacts = [...(a.artifacts ?? []), ...extractArtifacts(msg)].filter((x) => !threadArtifacts.has(x));
    if (nov < LIMITS.gateNoveltyPass) {
      const clearlyNothing = nov < LIMITS.gateNoveltyDrop && !newArtifacts.length;
      if (clearlyNothing && !WAKING.includes(kind)) return { verdict: "drop", check: "G7", text: TEXT.g7(i.toName) };
      return { verdict: "ambiguous", check: "G7", boundRid: bound?.rid ?? null, kind, digest };
    }
  }

  // G8 kind sanity
  if ((kind === "request" || kind === "question" || kind === "blocker") && !hasAsk(msg)) {
    return { verdict: "ambiguous", check: "G8", boundRid: bound?.rid ?? null, kind, digest };
  }
  return { verdict: "pass", boundRid: bound?.rid ?? null, kind };
}

/** ORIG-09 §09.7: member posts in a room turn pass G3–G5 against the room's history since the member last spoke. */
export function gatePost(i: { text: string; history: string[]; lastOwnPost: string | null; now: number }): { verdict: "pass" } | { verdict: "drop"; check: "G3" | "G4" | "G5" } {
  if (isCourtesyOnly(i.text)) return { verdict: "drop", check: "G3" };
  const h = sha1(normalizeText(i.text));
  if (i.history.some((x) => sha1(normalizeText(x)) === h)) return { verdict: "drop", check: "G4" };
  if (i.lastOwnPost) {
    const lastData = new Set(informativeTokens(i.lastOwnPost).filter(isData));
    const newData = informativeTokens(i.text).filter((t) => isData(t) && !lastData.has(t));
    if (!newData.length && jaccard(tokenSet4(i.text), tokenSet4(i.lastOwnPost)) >= LIMITS.gateNearDupJaccard) return { verdict: "drop", check: "G5" };
  }
  return { verdict: "pass" };
}
