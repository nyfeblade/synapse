import { LIMITS } from "@synapse/shared";
import type { OneShotModel } from "../brain/one-shot";
import { FOLLOWUP_EXTRACTION_RULE, type FollowupStore } from "../followups/store";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { isoDate, normalizeFact, type Fact, type FactKind, type Tier } from "./facts";
import type { Provenance } from "./ledger";
import type { MemoryStore } from "./memory-store";

/** One settled exchange; `ref` is the user message's transcript entry id (provenance only, never sent to the model). */
export interface Exchange { user: string; bot: string; ref?: string }

/** Bug 292: a bare acknowledgement or greeting carries nothing worth remembering (grouped, Synapse's own list). */
const TRIVIAL_GROUPS = {
  greetings: ["hello", "hi", "hey", "yo", "sup", "morning", "bye", "cheers"],
  thanks: ["thanks", "thank you", "thx", "ty", "np", "much appreciated"],
  agreement: ["ok", "okay", "k", "kk", "sure", "yes", "yep", "yeah", "no", "nope", "alright", "sounds good", "will do", "noted", "got it", "gotcha"],
  reactions: ["cool", "nice", "great", "good", "awesome", "perfect", "done", "lol", "haha"],
};
export const TRIVIAL = new Set(Object.values(TRIVIAL_GROUPS).flat());
const SECRET_PATTERNS = [
  /\bsk-[a-z0-9-]{8,}/i, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:\d[ -]?){13,19}\b/, /\b(password|passcode|pin|otp|2fa code)\s*(is|:)\s*\S+/i,
];
const DAY = 86_400_000;

export function isMemorable(userText: string): boolean {
  const t = userText.trim();
  const bare = t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
  if (TRIVIAL.has(bare)) return false;
  return t.length > 40 || t.includes("?");
}
export function stripUntrusted(s: string): string {
  return s.replace(/<untrusted_data>[\s\S]*?<\/untrusted_data>/g, "[untrusted content removed]");
}
export function looksLikeSecret(s: string, secrets: string[]): boolean {
  return SECRET_PATTERNS.some((r) => r.test(s)) || secrets.some((v) => v.length >= 4 && s.includes(v));
}
function redact(s: string, secrets: string[]): string {
  let out = stripUntrusted(s);
  for (const v of secrets) if (v.length >= 4) out = out.split(v).join("[secret]");
  return out;
}

export function parseExtraction(text: string, shown: Fact[]): { adds: { tier: Tier; kind: FactKind; content: string }[]; removes: string[] } {
  const { adds, removes } = parseExtractionPairs(text, shown);
  return { adds: adds.map(({ replaces: _r, ...a }) => a), removes };
}

/**
 * Memory provenance: the same parse, read one step further at no model cost. The prompt already asks for "a remove line
 * for the old one and the new line" when a fact changes, so a `remove:` right next to an addition (before or after it)
 * is read as "this replaces that" (`replaces`) and becomes a supersession in the ledger; `removes` keeps every valid
 * remove, paired or not, exactly as parseExtraction returns it.
 */
export function parseExtractionPairs(text: string, shown: Fact[]): { adds: { tier: Tier; kind: FactKind; content: string; replaces?: string }[]; removes: string[] } {
  const adds: { tier: Tier; kind: FactKind; content: string; replaces?: string }[] = [];
  const removes: string[] = [];
  if (text.trim() === "NONE") return { adds, removes };
  const seq: ({ add: number } | { remove: string })[] = [];
  const shownSet = new Set(shown.map((f) => f.content));
  for (const line of text.split("\n")) {
    const l = line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "");
    if (!l || l === "NONE") continue;
    // Cross-plan (ORIG-11 §11.1): a `followup:` line is handled entirely by
    // FollowupStore.ingestExtractionOutput (see MemoryExtractor.run) and must never also
    // fall through to the unmatched-tag "log" default below — that would duplicate it as a
    // spurious memory fact. Dropping it here is unconditional (not gated on opt-in) because a
    // Bot that isn't opted in will never emit this tag in the first place.
    if (/^followup:/i.test(l)) continue;
    const m = /^(profile|log|note|remove):\s*(.*)$/i.exec(l);
    const tag = m ? m[1]!.toLowerCase() : "log";
    const body = (m ? m[2]! : l).trim();
    if (tag !== "remove" && body.length > LIMITS.memoryFactMax) continue; // §05.1 guard: additions over 500 chars are dropped
    const content = normalizeFact(body);
    if (!content) continue;
    if (tag === "remove") { if (shownSet.has(content)) { removes.push(content); seq.push({ remove: content }); } continue; }
    seq.push({ add: adds.length });
    adds.push({ tier: tag === "profile" ? "profile" : "log", kind: tag === "note" ? "note" : "fact", content });
  }
  seq.forEach((x, i) => {
    if (!("remove" in x)) return;
    const prev = seq[i - 1], next = seq[i + 1];
    const to = prev && "add" in prev && !adds[prev.add]!.replaces ? prev.add : next && "add" in next && !adds[next.add]!.replaces ? next.add : null;
    if (to !== null) adds[to]!.replaces = x.remove;
  });
  return { adds, removes };
}

/** The exchange a fact most likely came from (most shared words; the latest on a tie): its transcript entry id. */
function sourceRef(content: string, batch: { user: string; ref?: string }[]): string | null {
  const want = tokens(content);
  let best: { ref: string; n: number } | null = null;
  for (const e of batch) {
    if (!e.ref) continue;
    const n = [...tokens(e.user)].filter((t) => want.has(t)).length;
    if (!best || n >= best.n) best = { ref: e.ref, n };
  }
  return best?.ref ?? null;
}

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((t) => !TRIVIAL.has(t)));
}

export class MemoryExtractor {
  private now: () => number;
  constructor(
    private d: {
      store: MemoryStore; model: OneShotModel; secrets(botId: string): string[]; timeZone(): string; nameOf(botId: string): string; now?: () => number;
      /** Cross-plan (ORIG-11 §11.1): when set and the Bot has opted in, the extraction prompt also accepts `followup:` lines, fed to `store.ingestExtractionOutput`. */
      followups?: { store: FollowupStore; optedIn(botId: string): boolean };
    },
  ) {
    this.now = d.now ?? Date.now;
  }

  /** captured: the secret values captured when the turn settled (I5); merged with the vault's current ones. */
  async run(botId: string, exchangeOrBatch: Exchange | Exchange[], captured: string[] = []): Promise<{ added: number; removed: number }> {
    const scope = { kind: "agent" as const, botId };
    const secrets = [...new Set([...captured, ...this.d.secrets(botId)])];
    // cost-diet-2 lever 4: a batch of memorable exchanges (oldest first) shares one call: the prompt and the
    // existing memories are sent once instead of once per exchange.
    const raw = Array.isArray(exchangeOrBatch) ? exchangeOrBatch : [exchangeOrBatch];
    const batch = raw.map((e) => ({ user: redact(e.user, secrets), bot: redact(e.bot, secrets) })); // the model never sees `ref`
    const user = batch.map((e) => e.user).join("\n");
    const bot = batch.map((e) => e.bot).join("\n");
    const profile = this.d.store.profile(scope).slice(-LIMITS.memAgentProfileMax);
    const log = this.d.store.log(scope);
    const recent = log.slice(-LIMITS.memAgentRecentMax);
    const cutoff = this.now() - 730 * DAY; // §05.4: skip log months older than 24 months
    const q = tokens(`${user} ${bot}`);
    const related = log.slice(0, -LIMITS.memAgentRecentMax).slice(-LIMITS.extractionArchiveScan).filter((f) => f.createdAt >= cutoff)
      .map((f) => ({ f, score: [...tokens(f.content)].filter((t) => q.has(t)).length }))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, LIMITS.extractionRelatedMax).map((x) => x.f);
    const shown = [...profile, ...recent, ...related];
    const input = {
      today: isoDate(this.now(), this.d.timeZone()), botName: this.d.nameOf(botId),
      existing: { profile: profile.map((f) => f.content), recent: recent.map((f) => f.content), related: related.map((f) => f.content) },
      ...(batch.length === 1 ? { exchange: batch[0]! } : { exchanges: batch }),
    };
    const followupsOn = this.d.followups?.optedIn(botId) === true;
    const basePrompt = fillTemplate(loadPrompt("orig/memory-extraction.md"), { botName: input.botName });
    const system = followupsOn ? `${basePrompt}\n\n${FOLLOWUP_EXTRACTION_RULE}` : basePrompt;
    const out = await this.d.model.complete({ system, user: JSON.stringify(input), tag: { purpose: "extraction", botId } });
    const { adds, removes } = parseExtractionPairs(out, shown);
    if (followupsOn) this.d.followups!.store.ingestExtractionOutput(botId, out, this.d.timeZone(), null);
    const paired = new Set(adds.flatMap((a) => (a.replaces && !looksLikeSecret(a.content, secrets) ? [a.replaces] : [])));
    let removed = 0;
    // An unpaired remove: the fact is no longer true (the ledger keeps it as history).
    for (const r of removes) if (!paired.has(r) && this.d.store.remove(scope, r, "retract")) removed++;
    let added = 0;
    const refs = raw.map((e, i) => ({ user: batch[i]!.user, ref: e.ref }));
    for (const { replaces, ...a } of adds) {
      if (looksLikeSecret(a.content, secrets)) { // §05.1 guard: never store a secret (the old fact it replaced still goes)
        if (replaces && this.d.store.remove(scope, replaces, "retract")) removed++;
        continue;
      }
      // The user said it in this chat; the extraction prompt drops what they didn't confirm (web, email, files).
      const prov: Provenance = { botId, chatId: botId, messageId: sourceRef(a.content, refs), source: "user", confidence: 0.8 };
      if (replaces) {
        const r = this.d.store.supersede(scope, replaces, { ...a, date: input.today }, prov);
        if (r.added) added++;
        if (r.replaced) removed++;
      } else if (this.d.store.add(scope, { ...a, date: input.today }, prov).added) added++;
    }
    return { added, removed };
  }
}
