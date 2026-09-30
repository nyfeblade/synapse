import type { BoxHelpView, FormCardView, SecretRequestView } from "./computer";
import type { B2BKind, ResultStatus } from "./b2b";
import type { CardPayload } from "./phase5";

export type Surface = "box_shell" | "host_shell" | "computer" | "mcp" | "subagent" | "cloud_agent" | "automation_write" | "control_plane";
export type ApprovalStatus = "pending" | "approved" | "always" | "denied" | "expired" | "stopped";

export interface ApprovalItemView { toolUseId: string; summary: string; status: ApprovalStatus }
export interface ApprovalVerdictView { reason: string; tier: number | null; matchedRuleIds: string[]; floorCategory: string | null; stage: string }

export interface ApprovalCardView {
  approvalId: string;
  requestId: string;
  surface: Surface;
  title: string;
  reason: string;
  summary: string;
  locationLine: string | null;
  details: string | null;        // ≤340 chars with "...[N chars omitted]..." (APR-09)
  command: string | null;        // full, redacted, ≤4,000 chars (APR-20 full-request sheet)
  items: ApprovalItemView[];     // ≥2 only for batched cards (APR-19)
  hasProposedRule: boolean;
  status: ApprovalStatus;
  cause: string | null;          // ttl | user_redirect | quiesce | session_end | settings_change
  verdict: ApprovalVerdictView | null;
  ruleAddedText: string | null;
  createdAt: number;
  settledAt: number | null;
  /** Smarter approvals: a plan card's steps, one line each (absent on every other card). */
  planSteps?: string[];
  /** Safety v2: what raised the card: a rule (preset or the owner's), or the reason. */
  trigger?: ApprovalTriggerView;
  /** Safety v2: "Make this a rule…": a plain-English Always allow rule for this action, or null. */
  suggestedRule?: string | null;
}

/** Safety v2: a card names its rule ("Sends", "Never email eve@x.com") or its reason. */
export interface ApprovalTriggerView { kind: "rule" | "reason"; label: string; ruleId?: string; source?: string }

/** CHAT-12: reactions are stored on the target entry. `by` is "user" or the reacting Bot's id. */
export interface Reaction { emoji: string; by: "user" | string }

export interface UserMessageEntry {
  kind: "message"; id: string; role: "user"; content: string; clientNonce?: string; createdAt: number;
  replyToId?: string;            // CHAT-11
  branched?: boolean;            // CHAT-11: part of a reply thread
  attachmentEntryIds?: string[]; // CHAT-09: ids of the t<n>ua<k> entries sent with this message
  skillIds?: string[];           // SKL-03: skills invoked with "/"
  reactions?: Reaction[];
  voice?: { durationMs: number; call?: boolean };  // CHAT-08: sent as a voice message; call = spoken in voice mode (bug 101: brief, spoken reply)
  hints?: string[];                // PLG-05: mention hints (STR5.mentionHint) folded into the prompt
  /** Bug 198: sent while the Bot was working — waiting for its next safe point ("queued"), then shown to it ("delivered"). */
  steer?: "queued" | "delivered";
  /** 4.3 Email in: the owner sent this task by email. `content` is only the text they added; the rest is outside content. */
  email?: EmailInMeta;
}

/** 4.3: an emailed task. `quoted` (the forwarded or quoted part) is outside content, never the owner's words. */
export interface EmailInMeta {
  /** The owner's account it arrived on, and the address or label that routed it. */
  account: string;
  via: string;
  subject: string;
  gmailId: string;
  threadId: string;
  /** The owner's own address it came from (the reply goes here). */
  from: string;
  quoted: string;
  attachments: string[];
  /** The email carried someone else's content and no marker showed where the owner's words end: none are taken as theirs. */
  withheld?: boolean;
}

/** CHAT-09 / FILE-02: one attachment sent with a user message (entry id t<n>ua<k>). */
export interface UserAttachmentEntry {
  kind: "user-attachment"; id: string; batchId: string; attachmentId: string; name: string; size: number; mime: string;
  storePath: string;             // content-addressed store path in agent-data
  boxPath: string | null;        // /workspace/.host-out/uploads/<name>, or null when not staged (videos, >50 MiB)
  createdAt: number;
}

/** FILE-03: a file the Bot sends. `url` is file:///workspace/…, file://<attachment store>/…, or https://… */
export interface AttachmentPayload { type: "attachment"; url: string; name: string; size: number | null; mime: string; pages: number | null; caption: string | null }

export interface WidgetOption { label: string; value: string; style?: "default" | "primary" | "danger" }
/** CHAT-16: a question with 1–6 options. `hostKind` marks widgets the host posts itself (spend guard) or the teach flow, rather than a Bot (RTN-*, TCH-*). */
export interface WidgetSpec { question: string; options: WidgetOption[]; allowCustom?: boolean; dismissOnMoveOn?: boolean; hostKind?: "spend-guard" | "spend-guard-paused" | "teach-rehearsal" | "budget-ask" }
export interface FormField { name: string; label: string; kind: "text" | "textarea" | "select"; options?: string[]; required?: boolean; value?: string }
/** CHAT-16 card kinds in Phase 2 (`chart` is deferred to Phase 5), plus Phase 4's `connect-listener` (RTN-12). */
export type CardSpec =
  | { kind: "email-draft"; from: string | null; to: string[]; cc?: string[]; subject: string; body: string }
  | { kind: "form"; title: string; fields: FormField[]; submitLabel?: string }
  | { kind: "link"; url: string; title: string | null; description: string | null }
  | { kind: "table"; title: string | null; columns: string[]; rows: string[][] }
  | { kind: "connect-listener"; platform: "slack" | "github"; routineId: string; routineName: string; connected: boolean };
export type WidgetStatus = "pending" | "answered" | "skipped" | "dismissed";

/** B2B-01, §4.3: on an agent-to-agent message, `fromAgent` names the sender (recipient's copy), `toAgent` the recipient (sender's copy). */
export interface AgentRef { id: string; name: string }
export interface AgentMeta extends AgentRef { kind: B2BKind; rid?: string; inReplyTo?: string; status?: ResultStatus; artifacts?: string[] }

/** B2B-01, §4.3: outbound `toAgent` on the sender, inbound `fromAgent` on the recipient. Never a user message. */
export interface AgentMessageEntry {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  content: string;
  fromAgent?: AgentMeta;
  toAgent?: AgentMeta;
  inbox?: boolean;          // ORIG-09 §09.3: delivered without a wake
  chainId: string;
  images?: { url: string; alt?: string }[];
  createdAt: number;
}

export type SendMessagePayload =
  | { type: "text"; content: string }
  | { type: "auto-review-approval"; approval: ApprovalCardView }
  | { type: "box-help"; request: BoxHelpView }
  | { type: "secret-request"; secret: SecretRequestView }
  | AttachmentPayload
  | { type: "widget"; widget: WidgetSpec }
  /** CHAT-16 chat cards (Phase 2), the SEC-04 page-fill form (Phase 3; tell apart with isPageFormCard) or Phase 5 cards. */
  | { type: "card"; card: CardSpec | FormCardView | CardPayload };

export interface SendMessageEntry {
  kind: "send-message"; id: string; requestId: string; createdAt: number; message: SendMessagePayload;
  replyToId?: string;
  branched?: boolean;
  reactions?: Reaction[];
  status?: WidgetStatus;         // widgets and interactive cards (email-draft, form)
  respondedValue?: string;       // CHAT-17: the answer shown on the settled card
  author?: AgentRef;             // B2B-01: set when a group member (not the user's Bot itself) posted this
}

export type ActivityIcon = "terminal" | "file" | "edit" | "search" | "globe" | "mail" | "calendar" | "tool" | "thought";

/** CHAT-22 / ORIG-18 §18.1: one summary row per (verb, noun) in a segment, e.g. "Read 48 emails". */
export interface ActivityMetric { verb: string; noun: string; nounPlural: string; count: number; itemIds?: string[] }

/** bug 198: a line of an Edit's old_string→new_string diff, for the neutral (no red/green) diff card. */
export interface DiffLine { type: "add" | "del" | "ctx"; text: string }

/**
 * bug 198: the full content behind a step's one-line summary — set only once the call has ENDED
 * (never on the "running" entry, same as `metric`), and only for the tool families that can hold
 * code-like content long enough to need a card rather than a text node: a file's body (Read/Write), an
 * edit's diff, or a shell command and its output. `truncated` says the host capped it (LIMITS.stepBodyMaxChars
 * / stepBodyMaxLines / shellEnrichChars / shellEnrichLines) — the content is still real, just partial.
 */
export type StepBody =
  /** fix round 1: `startLine` is the real first line number from the Read tool's own "cat -n" output
   *  (offset/limit-aware — it is never assumed to be 1), kept cheap for a future gutter. */
  | { kind: "read"; path: string; language: string; content: string; startLine: number; truncated: boolean }
  | { kind: "write"; path: string; language: string; content: string; truncated: boolean }
  | { kind: "edit"; path: string; language: string; diff: DiffLine[]; truncated: boolean }
  | { kind: "command"; command: string; output: string | null; truncated: boolean };

export interface ToolCallEntry {
  kind: "tool-call";
  id: string;
  requestId: string;
  segmentId: string;             // tool calls between two visible entries share a segment
  hidden: boolean;               // from a hidden turn: shown only if that turn sent something (EVT-04)
  name: string;
  step: string;                  // CHAT-05 expanded line, e.g. "Edited math.ts +14 −10"
  icon: ActivityIcon;
  metric: ActivityMetric | null; // null = counts as a step but gets no summary row
  /** "stopped": cut off by the user's Stop before it ran (new-user walk, finding 3). */
  status: "running" | "done" | "error" | "stopped";
  startedAt: number;
  endedAt?: number;
  /** bug 198: the step's expanded card content, lazily rendered by ActivityGroup only once the row is opened. */
  body?: StepBody | null;
}

export type TimelineEvent =
  | { type: "bot-created"; botId: string; name: string }
  | { type: "renamed"; name: string }
  | { type: "skill-saved"; skillId: string; name: string }
  | { type: "routine-created" | "routine-updated" | "routine-enabled" | "routine-disabled" | "routine-deleted"; routineId: string; name: string; nextRunAt?: number | null; count?: number; turnKey?: string }
  | { type: "agents-messaged"; botIds: string[]; chainId: string }
  | { type: "agent-exchange"; chainId: string; botIds: string[]; entryIds: string[]; count: number }
  | { type: "wake-origin"; source: "agent" | "routine" | "followup" | "revival" | "mcp"; client?: string; botIds?: string[]; routineId?: string; routineName?: string; taskId?: string; taskTitle?: string; via?: "schedule" | "event" | "manual" | "bot"; caughtUp?: boolean }
  | { type: "member-pass"; botIds: string[]; roomTurnId: string }
  | { type: "group-created"; groupId: string; name: string };
export interface EventEntry { kind: "event"; id: string; createdAt: number; event: TimelineEvent }
/** `link` (bug 108): the chat this notice points at, e.g. "Joined a call in Kenny · 4m" → Kenny's chat. */
export interface NoticeEntry {
  kind: "notice"; id: string; text: string; createdAt: number; link?: { botId: string };
  /** Bug 134: a Bot's voicemail (declined or missed call). The text is the transcript; the audio is rendered and kept on the Mac only. */
  voicemail?: { text: string };
  /** Bug 134: a substantial call's compact summary with action items. */
  callSummary?: { summary: string; actions: string[]; durationMs: number };
}

export type TranscriptEntry = UserMessageEntry | UserAttachmentEntry | AgentMessageEntry | SendMessageEntry | ToolCallEntry | EventEntry | NoticeEntry;

/** B2B-01: tells a bot-to-bot message entry apart from a user's own message. Both share kind "message". */
export function isAgentMessage(e: TranscriptEntry): e is AgentMessageEntry {
  return e.kind === "message" && Boolean((e as AgentMessageEntry).fromAgent || (e as AgentMessageEntry).toAgent);
}

/** PAL-02 snippet match markers. */
export const SNIPPET_OPEN = "";
export const SNIPPET_CLOSE = "";
