import { STR, daySeparator, isAgentMessage, isPageFormCard, type ActivityIcon, type AgentMessageEntry, type AgentRef, type ApprovalCardView, type BoxHelpView, type CardPayload, type EventEntry, type FormCardView, type SecretRequestView, type SendMessageEntry, type TimelineEvent, type ToolCallEntry, type TranscriptEntry, type UserAttachmentEntry, type UserMessageEntry } from "@synapse/shared";

export interface ActivityRow { verb: string; noun: string; count: number; icon: ActivityIcon; live?: boolean }
export type TranscriptItem =
  | { kind: "separator"; key: string; label: string }
  | { kind: "user"; key: string; text: string; entry: UserMessageEntry; attachments: UserAttachmentEntry[]; replyCount: number; voiceMs?: number }
  | { kind: "bot"; key: string; text: string; entry: SendMessageEntry; replyCount: number; author?: AgentRef }
  | { kind: "widget"; key: string; entry: SendMessageEntry }
  // Phase 2's CardSpec-kind cards (email-draft/form/link/table) keep rendering through the entry-based
  // Cards.tsx view; Phase 5's CardPayload-kind cards (connect/local-tool-permission/coding-agent) render
  // through the cards/registry.tsx CardView instead. Both share the "card" TranscriptItem kind.
  | { kind: "card"; key: string; entry: SendMessageEntry }
  | { kind: "card"; key: string; card: CardPayload }
  | { kind: "connect-card"; key: string; entry: SendMessageEntry }
  | { kind: "file"; key: string; entry: SendMessageEntry }
  | { kind: "notice"; key: string; text: string; link?: { botId: string }; voicemail?: { text: string }; callSummary?: { summary: string; actions: string[]; durationMs: number } }
  | { kind: "event"; key: string; entry: EventEntry }
  | { kind: "event-row"; key: string; entry: EventEntry }
  | { kind: "exchange"; key: string; peers: AgentRef[]; entries: AgentMessageEntry[]; count: number }
  | { kind: "activity"; key: string; rows: ActivityRow[]; more: number; steps: ToolCallEntry[]; running: boolean; stopped?: boolean; waiting?: boolean }
  | { kind: "approval"; key: string; approval: ApprovalCardView }
  | { kind: "box-help"; key: string; request: BoxHelpView }
  | { kind: "secret"; key: string; entryId: string; secret: SecretRequestView }
  | { kind: "form"; key: string; entryId: string; card: FormCardView };

/** ORIG-15: the voice-duration chip on a user bubble that was sent from voice mode ("01:31"). */
export function formatClock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const CARD_PAYLOAD_KINDS = new Set<CardPayload["kind"]>(["connect", "local-tool-permission", "coding-agent", "engineering-offer"]);
const isCardPayload = (c: { kind: string }): c is CardPayload => CARD_PAYLOAD_KINDS.has(c.kind as CardPayload["kind"]);

// ToolCallEntry carries startedAt rather than createdAt; every other TranscriptEntry has createdAt.
// Shared with store.ts (imported from there) so the two files don't keep separate copies of this ternary.
export const timeOf = (e: TranscriptEntry): number => (e.kind === "tool-call" ? e.startedAt : e.createdAt);

/** B2B-02: a fan-out is only outbound messages from one sender, each to a different Bot (at least two). */
export function isFanOut(entries: AgentMessageEntry[]): boolean {
  if (entries.length < 2 || entries.some((e) => !e.toAgent)) return false;
  const senders = new Set(entries.map((e) => e.fromAgent?.id ?? "self"));
  const recipients = new Set(entries.map((e) => e.toAgent!.id));
  return senders.size === 1 && recipients.size === entries.length;
}

function peersOf(entries: AgentMessageEntry[]): AgentRef[] {
  const out: AgentRef[] = [];
  for (const e of entries) {
    for (const m of [e.fromAgent, e.toAgent]) if (m && !out.some((p) => p.id === m.id)) out.push({ id: m.id, name: m.name });
  }
  return out;
}

// CHAT-03/23, GRP-13/14: Phase 4 event kinds render as the (expandable, avatar-bearing) `event-row`
// item; Phase 1's bot-created/renamed/skill-saved stay on the plain `event` item Transcript.tsx already
// handles inline.
const PHASE4_EVENTS = new Set<TimelineEvent["type"]>([
  "routine-created", "routine-updated", "routine-enabled", "routine-disabled", "routine-deleted",
  "agents-messaged", "agent-exchange", "wake-origin", "member-pass", "group-created",
]);

/** A live step's text without its "-ing" verb ("Running rm -rf /x" → "rm -rf /x"). */
const target = (step: string) => step.replace(/^[A-Z][a-z]+ing /, "");

function rowsFor(steps: ToolCallEntry[], waiting: ReadonlySet<string> = new Set()): { rows: ActivityRow[]; more: number } {
  const merged = new Map<string, { row: ActivityRow; ids: Set<string>; plain: number; steps: number; nounPlural: string; noun: string }>();
  // Rows with no summary metric: the step still running (shimmering), and — the host sets metric to null
  // on every failed tool call — the ones that errored. Without a row for those, a segment whose steps all
  // failed produced no activity item at all and disappeared from the transcript, taking the expandable
  // step list (the only place the error is ever shown) with it.
  const live: ActivityRow[] = [];
  for (const s of steps) {
    if (!s.metric) {
      // New-user walk, finding 6: held on an approval card, it isn't running; it waits on the user.
      if (s.status === "running" && waiting.has(s.requestId)) live.push({ verb: STR.waitingStep(target(s.step)), noun: "", count: 0, icon: s.icon });
      else if (s.status === "running") live.push({ verb: s.step, noun: "", count: 0, icon: s.icon, live: true });
      else if (s.status === "error") live.push({ verb: `Failed: ${s.step}`, noun: "", count: 0, icon: s.icon });
      else if (s.status === "stopped") live.push({ verb: STR.stoppedStep(s.step), noun: "", count: 0, icon: s.icon });
      continue;
    }
    const k = `${s.metric.verb}|${s.metric.noun}`;
    const m = merged.get(k) ?? { row: { verb: s.metric.verb, noun: "", count: 0, icon: s.icon }, ids: new Set<string>(), plain: 0, steps: 0, noun: s.metric.noun, nounPlural: s.metric.nounPlural };
    if (s.metric.itemIds?.length) s.metric.itemIds.forEach((i) => m.ids.add(i));
    else m.plain += s.metric.count;
    m.steps += 1;
    merged.set(k, m);
  }
  const all = [...merged.values()].map((m) => {
    const count = Math.min(m.ids.size, 200) + m.plain;
    return { row: { ...m.row, count, noun: count === 1 ? m.noun : m.nounPlural }, steps: m.steps };
  });
  const shown = [...all.slice(0, 3).map((a) => a.row), ...live].slice(0, 3 + live.length);
  const more = all.slice(3).reduce((n, a) => n + a.steps, 0);
  return { rows: shown, more };
}

/**
 * Turns transcript entries into render items: bubbles, events, cards, separators, per-segment activity
 * rows (CHAT-22), and Phase 4's exchange blocks / event rows (CHAT-03, CHAT-04, CHAT-23, B2B-02, GRP-13,
 * GRP-14).
 */
export function buildTranscriptItems(entries: TranscriptEntry[], nowMs: number): TranscriptItem[] {
  const waitingOn = new Set(entries.flatMap((e) => (e.kind === "send-message" && e.message.type === "auto-review-approval" && e.message.approval.status === "pending" ? [e.message.approval.requestId] : [])));
  const visibleRequests = new Set(entries.filter((e) => e.kind === "send-message").map((e) => (e as { requestId: string }).requestId));
  const replyCount = new Map<string, number>();
  for (const e of entries) {
    const r = (e as { replyToId?: string }).replyToId;
    if (r) replyCount.set(r, (replyCount.get(r) ?? 0) + 1);
  }
  const out: TranscriptItem[] = [];
  let lastT: number | null = null;
  let seg: { id: string; steps: ToolCallEntry[] } | null = null;
  // CHAT-04 / B2B-02: consecutive Bot-to-Bot entries (a `message` with `fromAgent` and/or `toAgent`,
  // including inbox items) between two other entries collapse into one `exchange` item.
  let ex: AgentMessageEntry[] = [];
  const flush = () => {
    if (!seg) return;
    const steps = seg.steps;
    if (!(steps[0]!.hidden && !visibleRequests.has(steps[0]!.requestId))) {
      const { rows, more } = rowsFor(steps, waitingOn);
      const live = steps.filter((s) => s.status === "running");
      const waiting = live.length > 0 && live.every((s) => waitingOn.has(s.requestId));
      const running = live.length > 0 && !waiting;
      if (rows.length) out.push({ kind: "activity", key: `act-${seg.id}`, rows, more, steps, running, ...(waiting ? { waiting: true } : {}), ...(!live.length && steps.some((s) => s.status === "stopped") ? { stopped: true } : {}) });
    }
    seg = null;
  };
  const flushEx = () => {
    if (!ex.length) return;
    out.push({ kind: "exchange", key: `ex-${ex[0]!.id}`, peers: peersOf(ex), entries: ex, count: ex.length });
    ex = [];
  };
  for (const e of entries) {
    if (e.kind === "user-attachment") {
      const owner = [...out].reverse().find((i) => i.kind === "user" && i.entry.id === e.batchId);
      if (owner && owner.kind === "user") owner.attachments.push(e);
      continue;
    }
    const t = timeOf(e);
    // A DAY DIVIDER, not a gap marker. It fires on a change of calendar day and on nothing else, and
    // it says which day. It used to fire on a 15-minute gap as well and to carry a clock time, which
    // is how a conversation ended up with "TODAY 9:00 AM" and "TODAY 9:20 AM" twenty minutes apart:
    // the same day announced twice, over turns that each already print their own time in their head.
    // Nothing is lost by dropping the gap rule — the time of every turn is still on the turn.
    if (lastT === null || new Date(t).toDateString() !== new Date(lastT).toDateString()) {
      flush();
      flushEx();
      out.push({ kind: "separator", key: `sep-${e.id}`, label: daySeparator(t, nowMs) });
    }
    lastT = t;
    if (e.kind === "tool-call") {
      flushEx();
      if (seg && seg.id !== e.segmentId) flush();
      seg ??= { id: e.segmentId, steps: [] };
      seg.steps.push(e);
      continue;
    }
    flush();
    if (e.kind === "message") {
      if (isAgentMessage(e)) { ex.push(e); continue; }
      flushEx();
      out.push({ kind: "user", key: e.id, text: e.content, entry: e, attachments: [], replyCount: replyCount.get(e.id) ?? 0, ...(e.voice ? { voiceMs: e.voice.durationMs } : {}) });
      continue;
    }
    flushEx();
    if (e.kind === "send-message") {
      if (e.message.type === "card" && e.message.card.kind === "connect-listener") {
        out.push({ kind: "connect-card", key: e.id, entry: e });
        continue;
      }
      const m = e.message;
      if (m.type === "text") {
        out.push(e.author
          ? { kind: "bot", key: e.id, text: m.content, entry: e, replyCount: replyCount.get(e.id) ?? 0, author: e.author }
          : { kind: "bot", key: e.id, text: m.content, entry: e, replyCount: replyCount.get(e.id) ?? 0 });
      }
      else if (m.type === "auto-review-approval") out.push({ kind: "approval", key: e.id, approval: m.approval });
      else if (m.type === "box-help") out.push({ kind: "box-help", key: e.id, request: m.request });
      else if (m.type === "secret-request") out.push({ kind: "secret", key: e.id, entryId: e.id, secret: m.secret });
      else if (m.type === "widget") out.push({ kind: "widget", key: e.id, entry: e });
      else if (m.type === "card") {
        if (isPageFormCard(m.card)) out.push({ kind: "form", key: e.id, entryId: e.id, card: m.card });
        else if (isCardPayload(m.card)) out.push({ kind: "card", key: e.id, card: m.card });
        else out.push({ kind: "card", key: e.id, entry: e });
      } else if (m.type === "attachment") out.push({ kind: "file", key: e.id, entry: e });
    } else if (e.kind === "event") {
      out.push(PHASE4_EVENTS.has(e.event.type) ? { kind: "event-row", key: e.id, entry: e } : { kind: "event", key: e.id, entry: e });
    } else if (e.kind === "notice") out.push({ kind: "notice", key: e.id, text: e.text, ...(e.link ? { link: e.link } : {}), ...(e.voicemail ? { voicemail: e.voicemail } : {}), ...(e.callSummary ? { callSummary: e.callSummary } : {}) });
    else { const exhaustive: never = e; throw new Error(`Unhandled transcript entry kind: ${JSON.stringify(exhaustive)}`); }
  }
  flush();
  flushEx();
  return out;
}
