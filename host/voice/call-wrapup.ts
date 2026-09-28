import { CALL_FEEL, STRV, type BotSummary, type TranscriptEntry } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { OneShotModel } from "../helper-model/one-shot";
import { log } from "../util/log";
import { callLength } from "./calls";

const PROMPT = "orig/call-wrapup.md";
/** The transcript sent is its last lines, at most this many characters (a long call costs about what a short one does). */
const TRANSCRIPT_CHARS = 6_000;
const LINE_CHARS = 400;

const SCHEMA = {
  type: "object",
  properties: {
    line: { type: "string", maxLength: 300 },
    summary: { type: "string", maxLength: 800 },
    actions: { type: "array", maxItems: 8, items: { type: "string", maxLength: 240 } },
  },
  required: ["line", "summary", "actions"],
  additionalProperties: false,
} as const;

type Bots = {
  has(id: string): boolean;
  summary(id: string): Pick<BotSummary, "profile">;
  tail(id: string, n: number): TranscriptEntry[];
  auxEntryIds(id: string, n: number): string[];
  appendEntry(id: string, e: TranscriptEntry): void;
};
type Calls = { info(callId: string): { chatId: string; startedAt: number; everOn: string[]; durationMs: number | null } | null };
export interface WrapUpResult { line: string | null; botId?: string }

const clip = (s: unknown, n: number): string => {
  const one = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (one.length <= n) return one;
  const cut = one.slice(0, n - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), n * 0.6)).trimEnd()}…`;
};

/**
 * Bug 134 (item 4): hang-up. A call of at least 30 s with a request in it gets ONE short helper call —
 * the Bot's spoken one-line wrap-up and a compact summary with action items, posted to the call's chat
 * after the ended marker. A trivial call costs nothing. Once per call, however often it is asked.
 */
export class CallWrapUp {
  private done = new Map<string, Promise<WrapUpResult>>();

  constructor(private d: { calls: Calls; bots: Bots; model: OneShotModel | null; now(): number }) {}

  wrapUp(callId: string, durationMs?: number): Promise<WrapUpResult> {
    const prior = this.done.get(callId);
    if (prior) return prior;
    const info = this.d.calls.info(callId);
    if (!info) return Promise.reject(new GatewayError("NOT_FOUND", "That call has ended.", 404));
    const p = this.run(info, durationMs);
    this.done.set(callId, p);
    if (this.done.size > 50) this.done.delete(this.done.keys().next().value!);
    return p;
  }

  private name(id: string): string {
    return this.d.bots.has(id) ? this.d.bots.summary(id).profile.name : id;
  }

  private async run(info: NonNullable<ReturnType<Calls["info"]>>, durationMs?: number): Promise<WrapUpResult> {
    const ms = typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : info.durationMs ?? this.d.now() - info.startedAt;
    if (ms < CALL_FEEL.wrapUpMinMs || !this.d.model || !this.d.bots.has(info.chatId)) return { line: null };
    const lines: string[] = [];
    let requests = 0;
    let lastBot: string | null = null;
    for (const e of this.d.bots.tail(info.chatId, 400)) {
      if (!("createdAt" in e) || e.createdAt < info.startedAt) continue;
      if (e.kind === "message" && e.role === "user" && !("fromAgent" in e && e.fromAgent) && !("toAgent" in e && e.toAgent)) {
        requests += 1;
        lines.push(`User: ${clip(e.content, LINE_CHARS)}`);
      } else if (e.kind === "send-message" && e.message.type === "text") {
        const id = e.author?.id ?? (info.everOn.length === 1 ? info.everOn[0]! : info.chatId);
        lastBot = id;
        lines.push(`${e.author?.name ?? this.name(id)}: ${clip(e.message.content, LINE_CHARS)}`);
      }
    }
    if (!requests) return { line: null };
    const speaker = lastBot && this.d.bots.has(lastBot) ? lastBot : info.everOn.find((b) => this.d.bots.has(b)) ?? info.chatId;
    let transcript = lines;
    while (transcript.length > 1 && transcript.join("\n").length > TRANSCRIPT_CHARS) transcript = transcript.slice(1);
    const input = { bot: this.name(speaker), onCall: info.everOn.map((b) => this.name(b)), minutes: Math.round(ms / 6_000) / 10, transcript };
    try {
      const out = await this.d.model.run<{ line?: unknown; summary?: unknown; actions?: unknown }>({ prompt: PROMPT, input, schema: SCHEMA, timeoutMs: 15_000, botId: speaker, thinking: false });
      const line = clip(out.line, CALL_FEEL.wrapUpLineMaxChars) || null;
      const summary = clip(out.summary, CALL_FEEL.summaryMaxChars);
      const actions = (Array.isArray(out.actions) ? out.actions : []).map((a) => clip(a, CALL_FEEL.actionMaxChars)).filter(Boolean).slice(0, CALL_FEEL.actionsMax);
      if (summary) {
        const [id] = this.d.bots.auxEntryIds(info.chatId, 1);
        this.d.bots.appendEntry(info.chatId, { kind: "notice", id: id!, text: STRV.callSummaryTitle(callLength(ms)), createdAt: this.d.now(), callSummary: { summary, actions, durationMs: ms } });
      }
      return line ? { line, botId: speaker } : { line: null };
    } catch (e) {
      log.warn("call wrap-up failed; the call ends without one", { chatId: info.chatId, error: String(e).slice(0, 200) });
      return { line: null };
    }
  }
}
