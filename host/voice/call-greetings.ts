import { createHash } from "node:crypto";
import { CALL_FEEL, STRV, greetingRejectReason, type BotSummary, type CallGreeting, type CallGreetingsView, type TimeOfDay } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { OneShotModel } from "../helper-model/one-shot";
import { loadPrompt } from "../prompts/index";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";

const PROMPT = "orig/call-greetings.md";
/** Bump to re-author every Bot's set (a prompt or rule change). 2 = bug 151, greetings only. */
const REVISION = 2;
/** A failed authoring waits this long before the next try (never a model call on every ring). */
const RETRY_MS = 30 * 60_000;
const COUNT = CALL_FEEL.greetingsMax;
const WHEN = ["morning", "afternoon", "evening"] as const;
const estimateTokens = (chars: number) => Math.ceil(chars / 4);

const SCHEMA = {
  type: "object",
  properties: {
    greetings: {
      type: "array",
      minItems: CALL_FEEL.greetingsMin,
      maxItems: CALL_FEEL.greetingsMax,
      items: {
        type: "object",
        properties: { text: { type: "string", maxLength: 80 }, when: { type: "string", enum: ["any", ...WHEN] } },
        required: ["text", "when"],
        additionalProperties: false,
      },
    },
  },
  required: ["greetings"],
  additionalProperties: false,
} as const;

interface Saved { version: string; greetings: CallGreeting[]; authoredAt: number; cost: { inputTokens: number; outputTokens: number } }
type Bots = { has(id: string): boolean; summary(id: string): Pick<BotSummary, "profile" | "group"> };

/** A first name only, letters (any script), apostrophes and hyphens: "alex rivera" → "Alex"; junk → null. */
export function cleanFirstName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.normalize("NFKC").trim().split(/\s+/)[0] ?? "";
  if (!/^[\p{L}][\p{L}'’-]{0,29}$/u.test(first)) return null;
  return first[0]!.toUpperCase() + first.slice(1);
}

/** The user's name from their memory profile ("The user's name is Alex Rivera.", "The user goes by Lu."), else null. */
export function userNameFromFacts(facts: string[]): string | null {
  for (const f of facts) {
    const m = /^the user(?:'s|’s)? (?:(?:first |preferred |full )?name is|is called|goes by|prefers to be called) (.+?)\.?$/i.exec(f.trim());
    if (m) { const n = cleanFirstName(m[1]); if (n) return n; }
  }
  return null;
}

/**
 * One greeting as the model wrote it, or the reason it is thrown away: plain, short (≤ 7 words, ≈ 2 s
 * spoken), no emoji or quotes, and (bug 151) a greeting and nothing else — no claim about work, no count,
 * file, status or memory, nothing that could be false when the phone happens to ring.
 */
function cleanGreeting(g: { text?: unknown; when?: unknown }): { ok: CallGreeting } | { bad: string; why: string } {
  if (typeof g?.text !== "string") return { bad: String(g?.text ?? ""), why: "not text" };
  const text = g.text.normalize("NFKC").replace(/["“”*_`#]/g, "").replace(/\s+/g, " ").trim();
  const why = greetingRejectReason(text);
  if (why) return { bad: text, why };
  const when = (WHEN as readonly string[]).includes(g.when as string) ? (g.when as TimeOfDay) : undefined;
  return { ok: when ? { text, when } : { text } };
}

/** Everything usable in one model answer, and up to 3 examples of what was thrown away (fed back on a retry). */
function usableGreetings(out: { greetings?: unknown } | null): { greetings: CallGreeting[]; rejected: { text: string; why: string }[] } {
  const seen = new Set<string>();
  const greetings: CallGreeting[] = [];
  const rejected: { text: string; why: string }[] = [];
  for (const g of Array.isArray(out?.greetings) ? out.greetings : []) {
    const c = cleanGreeting(g as { text?: unknown; when?: unknown });
    if ("bad" in c) { if (rejected.length < 3 && c.bad) rejected.push({ text: c.bad.slice(0, 80), why: c.why }); continue; }
    if (seen.has(c.ok.text.toLowerCase())) continue;
    seen.add(c.ok.text.toLowerCase());
    greetings.push(c.ok);
  }
  return { greetings, rejected };
}

/**
 * Bug 134 (item 1): the pick-up greetings. Each Bot writes its set ONCE, in its own personality (one short
 * helper call), and it is kept here per Bot until the Bot's profile or the user's name changes. Until then
 * — and whenever authoring fails — the stock set is used, so a call never waits on a model and never
 * costs a token per call. The Mac renders the set to audio and caches it (app voice-cache).
 */
export class CallGreetings {
  private saved: Record<string, Saved>;
  private inflight = new Set<string>();
  private failedAt = new Map<string, number>();

  constructor(private d: { bots: Bots; model: OneShotModel | null; file: string; now(): number; userName?: () => string | null }) {
    this.saved = readJson<Record<string, Saved>>(d.file, {});
    this.purgeNonGreetings();
  }

  /**
   * Bug 151: a set cached before the rules tightened can hold a line that isn't a greeting ("Hi, I've
   * drafted three replies for you."). On launch, any set with one is dropped, so that Bot re-authors and
   * the user stops hearing it. The Mac drops the rendered audio of those lines the same way.
   */
  private purgeNonGreetings(): void {
    let changed = false;
    for (const [botId, s] of Object.entries(this.saved)) {
      const bad = s.greetings.map((g) => ({ text: g.text, why: greetingRejectReason(g.text) })).filter((x) => x.why);
      if (!bad.length) continue;
      log.warn("call greetings: a cached set is not all greetings; dropped, the Bot re-authors", { botId, dropped: bad.length, example: bad[0]!.text.slice(0, 60), why: bad[0]!.why });
      delete this.saved[botId];
      changed = true;
    }
    if (changed) writeJsonAtomic(this.d.file, this.saved);
  }

  private who(macName?: string): string | null {
    return this.d.userName?.() ?? cleanFirstName(macName);
  }

  private versionOf(botId: string, user: string | null): string {
    const p = this.d.bots.summary(botId).profile;
    return createHash("sha256").update(JSON.stringify([REVISION, p.name, p.title, p.description.slice(0, 2000), user])).digest("hex").slice(0, 12);
  }

  view(botId: string, macName?: string): CallGreetingsView {
    if (!this.d.bots.has(botId) || this.d.bots.summary(botId).group) throw new GatewayError("NOT_FOUND", "That Bot doesn't exist.", 404);
    const user = this.who(macName);
    const version = this.versionOf(botId, user);
    const s = this.saved[botId];
    if (s && s.version === version) return { botId, greetings: s.greetings, version, authored: true };
    this.author(botId, user, version);
    return { botId, greetings: STRV.stockGreetings(user), version: `stock-${createHash("sha256").update(user ?? "").digest("hex").slice(0, 8)}`, authored: false };
  }

  /** The estimated tokens of the last authoring for a Bot (the report's one-off cost). */
  lastCost(botId: string): Saved["cost"] | null {
    return this.saved[botId]?.cost ?? null;
  }

  forget(botId: string): void {
    if (!(botId in this.saved)) return;
    delete this.saved[botId];
    writeJsonAtomic(this.d.file, this.saved);
  }

  private author(botId: string, user: string | null, version: string): void {
    const model = this.d.model;
    if (!model || this.inflight.has(botId)) return;
    const failed = this.failedAt.get(botId);
    if (failed !== undefined && this.d.now() - failed < RETRY_MS) return;
    this.inflight.add(botId);
    const p = this.d.bots.summary(botId).profile;
    const base = { bot: { name: p.name, title: p.title, description: p.description.slice(0, 1500) }, user, count: COUNT };
    let inputTokens = 0;
    let outputTokens = 0;
    const ask = async (rejected?: { text: string; why: string }[]): Promise<CallGreeting[]> => {
      const input = rejected?.length ? { ...base, rejected } : base;
      inputTokens += estimateTokens(loadPrompt(PROMPT).length + JSON.stringify(input).length);
      const out = await model.run<{ greetings?: unknown }>({ prompt: PROMPT, input, schema: SCHEMA, timeoutMs: 20_000, botId, thinking: false });
      outputTokens += estimateTokens(JSON.stringify(out).length);
      const { greetings, rejected: bad } = usableGreetings(out);
      if (bad.length) log.info("call greetings: lines thrown away (not greetings)", { botId, example: bad[0]!.text, why: bad[0]!.why, count: bad.length });
      // Enough greetings, and at least one that fits any time of day (a call can come at any hour).
      if (greetings.length >= CALL_FEEL.greetingsUsableMin && greetings.some((g) => !g.when)) return greetings;
      throw Object.assign(new Error(`only ${greetings.length} usable greetings`), { rejected: bad });
    };
    void ask()
      // Fewer than 8 survived: ask ONCE more, showing what was thrown away and why.
      .catch((e: { rejected?: { text: string; why: string }[] }) => ask(e?.rejected))
      .then((greetings) => {
        this.saved[botId] = { version, greetings: greetings.slice(0, COUNT), authoredAt: this.d.now(), cost: { inputTokens, outputTokens } };
        writeJsonAtomic(this.d.file, this.saved);
        this.failedAt.delete(botId);
      })
      .catch((e) => {
        // Twice is enough: the built-in neutral set (STRV.stockGreetings) keeps being served, and the
        // next try waits out the backoff instead of costing a model call on every ring.
        this.failedAt.set(botId, this.d.now());
        log.warn("call greetings: authoring failed twice; the built-in set stays", { botId, error: String(e).slice(0, 200) });
      })
      .finally(() => this.inflight.delete(botId));
  }
}
