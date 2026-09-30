import { LIMITS } from "@synapse/shared";
import { fillTemplate, loadPrompt } from "../prompts/index";
import type { Delivery } from "./mailbox";

const PRIORITY_LINE = "PRIORITY instruction from another Bot: deal with it before anything else, and abandon in-progress work that conflicts with it.";
/** Bug #61: asking is the one sanctioned way across the Bot walls, so the answer comes from the teammate's own data. */
const QUESTION_LINE = 'Answer a question from your own history and memory (SearchHistory): say what answers it in your own words, never paste raw transcripts or files, and leave out anything the user asked you to keep to yourself.';
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One `<message>` block. Bodies are escaped and fenced as another Bot's words, never the user's (ORIG-09 §09.4). */
export function messageBlock(m: Delivery): string {
  const attrs = [`kind="${m.kind}"`];
  if (m.kind === "result") { if (m.inReplyTo) attrs.push(`in_reply_to="${m.inReplyTo}"`); }
  else if (m.rid) attrs.push(`id="${m.rid}"`);
  attrs.push(`from="${esc(m.fromName)} (id ${m.from.slice(0, 4)}…)"`);
  if (m.kind === "result" && m.status) attrs.push(`status="${m.status}"`);
  if (m.expects) attrs.push(`expects="${esc(m.expects)}"`);
  if (m.taskId) attrs.push(`task="${esc(m.taskId)}"`);
  if (m.artifacts?.length) attrs.push(`artifacts="${esc(m.artifacts.join(" "))}"`);
  if (m.images?.length) attrs.push(`images="${esc(m.images.map((i) => i.url).join(" "))}"`);
  if (m.priority) attrs.push(`priority="true"`);
  return `<message ${attrs.join(" ")}>${esc(m.message)}</message>`;
}

/** Wake #6: header, per-sender thread digests (≤ 800 chars each), the typed messages and the reply rules. */
export function renderAgentWake(p: { messages: Delivery[]; digests: string[]; nameOf(id: string): string }): string {
  const n = p.messages.length;
  return fillTemplate(loadPrompt("wakes/agent.md"), {
    COUNT: String(n),
    NOUN: n === 1 ? "message" : "messages",
    PRIORITY: p.messages.some((m) => m.priority) ? `${PRIORITY_LINE}\n` : "",
    QUESTION: p.messages.some((m) => m.kind === "question") ? `${QUESTION_LINE}\n` : "",
    DIGESTS: p.digests.join("\n"),
    MESSAGES: p.messages.map(messageBlock).join("\n"),
  }).trim();
}

/**
 * Bug 432: the longest this batch's wake can be, whatever the thread digests hold by the time it runs (each sender's
 * digest at its cap) and with the priority and question lines in. Auto-review reads LIMITS.reviewerContextChars of a
 * wake's text, so a message is refused at send (b2b/gate.ts) and a batch stops growing (mailbox batchOf) before
 * this passes that cap: the reviewer always sees the whole wake, never its first part only.
 */
export function agentWakeMaxChars(messages: Delivery[]): number {
  const senders = new Set(messages.map((m) => m.from)).size;
  const text = renderAgentWake({ messages: messages.map((m) => ({ ...m, priority: true })), digests: Array.from({ length: senders }, () => "x".repeat(LIMITS.digestMaxChars)), nameOf: (id) => id });
  return text.length + (messages.some((m) => m.kind === "question") ? 0 : QUESTION_LINE.length + 1);
}

/** Bug 432: whether this batch's wake always fits what Auto-review reads. */
export const agentWakeFits = (messages: Delivery[]): boolean => agentWakeMaxChars(messages) <= LIMITS.reviewerContextChars;
