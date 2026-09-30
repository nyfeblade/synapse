import { contextWindow, PROVIDER_CATALOG } from "@synapse/shared";
import { providerFetch } from "../../usage/metered-provider";
import { adapterFor, modelTarget } from "./adapters/index";
import type { CanonMessage } from "./adapters/types";
import type { ProviderSessionStore } from "./session-store";

/**
 * Compaction for a provider Bot (spec §7): one tool-less call writes a summary of the conversation; the summary plus
 * the user's last few messages replace the history the model sees, after a compact boundary in the session file (the
 * full history stays on disk, for SearchHistory and the indexer). Metered as `compaction`.
 *
 * The conversation goes to the summarizer as one plain transcript, not as the provider's own message list: it holds tool
 * calls the summary call has no tools for (some providers refuse that), and a transcript is trimmed from the oldest end
 * when it is longer than the summarizer can read.
 *
 * It runs on the provider's helper model when the transcript fits well inside that model's window, else on the Bot's
 * own model.
 */
export const KEEP_USER_TURNS = 4;
const SUMMARY_MAX_TOKENS = 4_000;
const TOOL_TEXT_MAX = 2_000;
/** Characters per token, for sizing only. */
const CPT = 4;

export function transcriptOf(msgs: CanonMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
      lines.push(`User: ${text}`);
    } else if (m.role === "assistant") {
      if (m.text) lines.push(`Assistant: ${m.text}`);
      for (const c of m.toolCalls) lines.push(`Assistant called ${c.name} with ${c.arguments.slice(0, TOOL_TEXT_MAX)}`);
    } else {
      const t = m.text.length > TOOL_TEXT_MAX ? `${m.text.slice(0, TOOL_TEXT_MAX)} …[${m.text.length - TOOL_TEXT_MAX} chars cut]` : m.text;
      lines.push(`${m.isError ? "Tool error" : "Tool result"} (${m.name}): ${t}${m.images?.length ? ` [${m.images.length} image]` : ""}`);
    }
  }
  return lines.join("\n\n");
}

/** The user's own last messages (not tool results, not hidden nudges that start with a system reminder). */
function lastUserTurns(msgs: CanonMessage[], n: number): string[] {
  const out: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && out.length < n; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    const text = m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n").trim();
    if (text && !text.startsWith("<system-reminder>")) out.unshift(text);
  }
  return out;
}

export function summaryMessage(summary: string, recent: string[]): CanonMessage {
  const parts = [`[Conversation summary — the earlier history was compacted]\n${summary.trim()}`];
  if (recent.length) parts.push(`[The user's most recent messages, verbatim]\n${recent.map((r) => `- ${r}`).join("\n")}`);
  return { role: "user", parts: [{ type: "text", text: parts.join("\n\n") }] };
}

/** Picks the summarizer: the helper when the transcript fits in 80% of its window, else the Bot's own model. */
export function summarizerFor(ref: string, transcriptTokens: number): string {
  const p = modelTarget(ref);
  // Claude compacts on the Bot's own model, as the CLI does (a cheaper summarizer would be an unmeasured quality cut).
  const helper = !p || p.provider === "anthropic" ? null : PROVIDER_CATALOG[p.provider].helperModel;
  if (p && helper) {
    const h = `${p.provider}:${helper}`;
    if (transcriptTokens + SUMMARY_MAX_TOKENS < 0.8 * contextWindow(h)) return h;
  }
  return ref;
}

/**
 * Summarizes `history` and returns the messages that replace it (the summary and the recent user turns), or null when
 * there's nothing to compact. Throws what providerFetch throws.
 */
export async function summarize(d: { botId: string; ref: string; history: CanonMessage[]; instructions: string; signal: AbortSignal }): Promise<CanonMessage[] | null> {
  if (d.history.length < 2) return null;
  let transcript = transcriptOf(d.history);
  const ref0 = summarizerFor(d.ref, Math.ceil(transcript.length / CPT));
  const budgetChars = Math.floor((0.8 * contextWindow(ref0) - SUMMARY_MAX_TOKENS) * CPT);
  if (transcript.length > budgetChars) transcript = `[…the oldest part of the conversation was cut to fit]\n${transcript.slice(transcript.length - budgetChars)}`;
  const p = modelTarget(ref0)!;
  const adapter = adapterFor(p.provider);
  const body = adapter.encode({
    model: p.model, system: "You summarize a conversation between a user and their assistant Bot so the Bot can continue it.",
    messages: [{ role: "user", parts: [{ type: "text", text: `<conversation>\n${transcript}\n</conversation>\n\n${d.instructions}` }] }],
    tools: [], wireName: (n) => n, maxOutputTokens: SUMMARY_MAX_TOKENS,
  });
  const s = await providerFetch({ purpose: "compaction", botId: d.botId }, adapter, { ref: ref0, body, signal: d.signal });
  const dec = adapter.decoder();
  for await (const chunk of s.chunks) dec.push(chunk);
  const summary = dec.finish().text.trim();
  if (!summary) return null;
  return [summaryMessage(summary, lastUserTurns(d.history, KEEP_USER_TURNS))];
}

/** app.ts compactFn for a `prov-` session: compacts the stored conversation. */
export async function compactProviderSession(d: { store: ProviderSessionStore; botId: string; sessionId: string; ref: string; instructions: string; signal: AbortSignal }): Promise<boolean> {
  const history = d.store.load(d.botId, d.sessionId);
  const replacement = await summarize({ botId: d.botId, ref: d.ref, history, instructions: d.instructions, signal: d.signal });
  if (!replacement || d.signal.aborted) return false;
  d.store.appendBoundary(d.botId, d.sessionId);
  d.store.append(d.botId, d.sessionId, replacement);
  return true;
}
