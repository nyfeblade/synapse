import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Bug 413 (security review of bug 410, H1): who a Composio send really reaches, looked up on the host before the
 * Full-auto intent check runs. A reply by thread goes to the thread's participants; a Slack post goes to a channel,
 * whose name and size are read from Composio. Anything that can't be resolved is an error, and the gate cards it.
 */
export interface ResolvedSend { recipients: string[]; channels: { name: string; members: number }[] }
export type ComposioCall = (slug: string, args: Record<string, unknown>) => Promise<CallToolResult>;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HEADER = /^(from|to|cc|bcc|reply-to)$/i;
const PARTY_KEY = /^(from|to|cc|bcc|sender|recipients?|reply_?to|to_list|cc_list|participants)$/i;
/** Argument keys whose text is the message, not who gets it. */
const BODY_KEY = /^(body|message_body|text|markdown_text|subject|description|summary|content|html)$/i;

const emails = (v: unknown): string[] => (JSON.stringify(v ?? "").match(EMAIL) ?? []).map((e) => e.toLowerCase());

function dataOf(r: CallToolResult): unknown {
  if (r.isError) throw new Error("the lookup failed");
  const text = (r.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  return JSON.parse(text) as unknown;
}

function walk(v: unknown, visit: (key: string | null, v: unknown) => void, key: string | null = null): void {
  visit(key, v);
  if (Array.isArray(v)) for (const x of v) walk(x, visit, key);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, visit, k);
}

/** Every address in the arguments outside the message text itself (recipient_email, cc, bcc, extra_recipients …). */
export function argRecipients(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  walk(args, (k, v) => { if (typeof v === "string" && !(k && BODY_KEY.test(k))) out.push(...emails(v)); });
  return out;
}

/** The From/To/Cc/Bcc/Reply-To addresses of every message in a thread (never addresses inside a body). */
export function threadParticipants(data: unknown): string[] {
  const out: string[] = [];
  walk(data, (k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o.name === "string" && HEADER.test(o.name) && typeof o.value === "string") out.push(...emails(o.value));
    }
    if (k && PARTY_KEY.test(k) && (typeof v === "string" || Array.isArray(v))) out.push(...emails(v));
  });
  return out;
}

const uniq = (xs: string[]) => [...new Set(xs)];

export async function resolveComposioSend(call: ComposioCall, slug: string, args: Record<string, unknown>): Promise<ResolvedSend | { error: string }> {
  try {
    if (slug === "GMAIL_REPLY_TO_THREAD") {
      const thread = typeof args.thread_id === "string" ? args.thread_id : "";
      if (!thread) return { error: "The reply names no thread." };
      const people = threadParticipants(dataOf(await call("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", { thread_id: thread })));
      if (!people.length) return { error: "The thread's participants couldn't be read." };
      return { recipients: uniq([...people, ...argRecipients(args)]), channels: [] };
    }
    if (slug === "SLACK_SEND_MESSAGE" || slug === "SLACK_CHAT_POST_MESSAGE") {
      const want = String(args.channel ?? "").trim();
      if (!want) return { error: "The message names no channel." };
      let found: { name: string; members: number } | null = null;
      walk(dataOf(await call("SLACK_LIST_ALL_CHANNELS", { limit: 1000 })), (_k, v) => {
        if (found || !v || typeof v !== "object" || Array.isArray(v)) return;
        const c = v as Record<string, unknown>;
        if (typeof c.id !== "string" || typeof c.name !== "string") return;
        if (c.id !== want && c.name.toLowerCase() !== want.replace(/^#/, "").toLowerCase()) return;
        if (typeof c.num_members === "number") found = { name: c.name, members: c.num_members };
      });
      if (!found) return { error: "The channel and its size couldn't be read." };
      return { recipients: uniq(argRecipients(args)), channels: [found] };
    }
    return { recipients: uniq(argRecipients(args)), channels: [] };
  } catch {
    return { error: "Who this goes to couldn't be checked." };
  }
}

/** Bug 420: whether the owner's Gmail (through Composio) has sent mail to this address; null when it can't be checked. */
export async function composioSentTo(call: ComposioCall, address: string): Promise<boolean | null> {
  if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(address)) return null;
  try {
    const data = dataOf(await call("GMAIL_FETCH_EMAILS", { query: `in:sent to:${address}`, max_results: 1 }));
    const msgs = (data as { messages?: unknown[] } | null)?.messages;
    return Array.isArray(msgs) ? msgs.length > 0 : null;
  } catch { return null; }
}
