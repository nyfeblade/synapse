import type { FullAutoResult } from "@synapse/shared";
import type { WakeSource } from "../brain/types";
import { FULL_AUTO_BULK_MAX, OWNER_SOURCES, hasBulkValue, hasDestructiveFlag, recipientsOf, unresolvedWho } from "../review/full-auto-intent";
import type { OriginKind, RiskTarget } from "../review/types";

/**
 * Smarter approvals (0.1.4, docs/superpowers/specs/2026-09-29-smarter-approvals-design.md): approve a whole plan
 * once, and trusted recipients. Pure rules; the approval gate holds the state and calls these. Both only ever
 * REMOVE a card for a connector send whose recipients the host resolved; neither can add a grant by itself.
 */

export const PLAN_TOOL = "mcp__bot__ProposePlan";
export const PLAN_MAX_STEPS = 10;
const STEP_SCOPE_MAX = 20;
const TEXT_MAX = 300;
/** A grant ends with the task, and in any case after this long. */
export const PLAN_GRANT_MAX_MS = 2 * 60 * 60_000;
export const TRUSTED_MAX = 50;

export interface PlanStep { tool: string; summary: string; recipients: string[]; targets: string[] }
export interface Plan { title: string; steps: PlanStep[] }

/** The connector actions a plan step or a trusted recipient can cover. Nothing else is ever skipped. */
const CONNECTOR_ACTIONS = new Set(["google_write", "composio_write", "mcp"]);
/** A connector tool name: mcp__<server>__<tool>, but never the Bot's own built-ins. */
const CONNECTOR_TOOL = /^mcp__(?!bot__)[\w.-]+__[\w.-]+$/;

const str = (v: unknown, max = TEXT_MAX): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
const norm = (v: string): string => v.trim().toLowerCase().replace(/^#/, "#");

/** The ProposePlan input, checked. A string is why it was refused. */
export function parsePlan(input: Record<string, unknown>): Plan | string {
  const title = str(input.title, 120);
  if (!title) return "Give the plan a short title.";
  const raw = input.steps;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PLAN_MAX_STEPS) return `A plan has 1 to ${PLAN_MAX_STEPS} steps.`;
  const steps: PlanStep[] = [];
  for (const [i, s] of raw.entries()) {
    if (!s || typeof s !== "object") return `Step ${i + 1} isn't an object.`;
    const o = s as Record<string, unknown>;
    const tool = str(o.tool, 200);
    if (!tool || !CONNECTOR_TOOL.test(tool)) return `Step ${i + 1}: tool must be the exact connector tool name (mcp__server__tool). Built-in tools, commands, the Mac and the browser can't be plan steps.`;
    const summary = str(o.summary);
    if (!summary) return `Step ${i + 1}: add a one-line summary.`;
    const list = (v: unknown): string[] | null => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > STEP_SCOPE_MAX || !v.every((x) => str(x) !== null)) return null;
      return [...new Set((v as string[]).map(norm))];
    };
    const recipients = list(o.recipients);
    const targets = list(o.targets);
    if (!recipients || !targets) return `Step ${i + 1}: recipients and targets are lists of up to ${STEP_SCOPE_MAX} short strings.`;
    if (recipients.some((r) => /^(all|everyone|everybody|@channel|@everyone|@here|\*)$/i.test(r))) return `Step ${i + 1}: a plan can't send to everyone at once.`;
    if (!recipients.length && !targets.length) return `Step ${i + 1}: name who it reaches (recipients) or what it acts on (targets).`;
    steps.push({ tool, summary, recipients, targets });
  }
  return { title, steps };
}

/** One line per step for the card. */
export function planLines(p: Plan): string[] {
  return p.steps.map((s, i) => {
    const scope = [...s.recipients, ...s.targets].join(", ");
    return `${i + 1}. ${s.summary}${scope ? ` (${scope})` : ""}`;
  });
}

/** Keys whose value names the thing a call acts on (not who it reaches, not its text). */
const TARGET_KEY = /^(id|ids|path|file_path|file|url|link|repo|repository|owner|page|page_id|parent_id|database_id|document_id|doc_id|spreadsheet_id|sheet_id|file_id|folder_id|calendar|calendar_id|event_id|thread_id|message_id|draft_id|reply_to_id|issue|issue_id|issue_number|project|project_id|board|board_id|list_id|card_id|task_id|team_id|workspace|workspace_id|channel|channel_id|channel_name|chat_id|conversation_id|post_id|record_id|table|table_id|base_id)$/i;
const CHANNEL_KEY = /^(channel|channels|channel_id|channel_name|chat_id|conversation_id)$/i;
/** Keys the host adds for its own card (never part of what the Bot asked for). */
const HOST_KEYS = new Set(["card_facts", "content_hash", "draft_hash", "resolved_to", "existing_attendees", "tool", "toolkit", "server"]);

export interface CallScope { recipients: string[]; channels: string[]; targets: string[] }

/** What a connector call reaches and acts on. `resolved` = the host's own lookup (null = it couldn't be resolved). */
export function callScope(target: RiskTarget, resolved: { recipients: string[]; channels: { name: string }[] } | null): CallScope | null {
  // Bug 440: a recipient field the host can't resolve (a name, a user id) can't be matched to a plan or a trusted list.
  if (!resolved || unresolvedWho(target, resolved)) return null;
  const recipients = new Set([...recipientsOf(target), ...resolved.recipients.map((r) => r.toLowerCase())]);
  // Bug 413: an update also reaches the event's existing guests.
  const existing = target.arguments.existing_attendees;
  if (Array.isArray(existing)) for (const e of existing) if (typeof e === "string") recipients.add(e.toLowerCase());
  const channels = new Set(resolved.channels.map((c) => `#${c.name.toLowerCase().replace(/^#/, "")}`));
  const targets = new Set<string>();
  const visit = (k: string | null, v: unknown): void => {
    if (k && HOST_KEYS.has(k)) return;
    if (Array.isArray(v)) { for (const x of v) visit(k, x); return; }
    if (v && typeof v === "object") { for (const [kk, x] of Object.entries(v)) visit(kk, x); return; }
    if ((typeof v === "string" || typeof v === "number") && k && String(v).trim()) {
      const val = String(v).trim().toLowerCase();
      if (CHANNEL_KEY.test(k)) channels.add(val.startsWith("#") ? val : `#${val}`);
      else if (TARGET_KEY.test(k)) targets.add(val);
    }
  };
  visit(null, target.arguments);
  return { recipients: [...recipients], channels: [...channels], targets: [...targets] };
}

/** A connector call's own tool name, as a plan step names it. */
export function stepMatches(step: PlanStep, toolName: string, scope: CallScope): boolean {
  if (step.tool !== toolName) return false;
  const allowed = new Set(step.recipients.map((r) => (r.includes("@") ? r : r.startsWith("#") ? r : `#${r}`)));
  if (!scope.recipients.every((r) => allowed.has(r))) return false;
  if (!scope.channels.every((c) => allowed.has(c) || step.targets.includes(c) || step.targets.includes(c.slice(1)))) return false;
  if (step.targets.length && !scope.targets.every((t) => step.targets.includes(t))) return false;
  return true;
}

/**
 * The call itself may be covered by a plan or a trusted recipient at all: a connector write the Full-auto
 * classifier calls a send (or nothing), with no destructive flag and no bulk value. Money, deletion, security and
 * an unknown tool always card.
 */
export function coverable(target: RiskTarget, fa: FullAutoResult): boolean {
  if (!CONNECTOR_ACTIONS.has(target.action)) return false;
  if (fa.ask && (fa.category !== "send" || fa.rule === "send.unknown-tool")) return false;
  return !hasDestructiveFlag(target) && !hasBulkValue(target);
}

/** The owner's own wake: their words in this chat (and its nudges), not a routine, an event, another Bot. */
export const ownerWake = (origin: OriginKind, source: WakeSource | null): boolean => origin === "user" && !!source && OWNER_SOURCES.has(source);

/** Sends whose every recipient the host resolves (calendar_update is out: it also mails the event's other guests). */
const TRUSTED_SEND = { google_write: new Set(["gmail_send", "calendar_create"]), composio_write: new Set(["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD", "GOOGLECALENDAR_CREATE_EVENT"]) } as Record<string, ReadonlySet<string>>;

/**
 * Trusted recipients: a send to only the owner's own address never asks (any wake); a send whose every recipient
 * is the owner or a trusted person skips the card on the owner's own wake. Anything else: null (the gate goes on).
 */
/** Whether this send is one the trusted-recipient rule could ever cover (a cheap check before any lookup). */
export const trustedTool = (target: RiskTarget): boolean => TRUSTED_SEND[target.action]?.has(String(target.arguments.tool ?? "")) ?? false;

export function trustedSendOk(i: { target: RiskTarget; builtin: boolean; scope: CallScope | null; self: string | null; trusted: readonly string[]; origin: OriginKind; source: WakeSource | null }): boolean {
  if (!i.builtin || !trustedTool(i.target)) return false;
  if (!i.scope || i.scope.channels.length || !i.scope.recipients.length || i.scope.recipients.length > FULL_AUTO_BULK_MAX) return false;
  const self = i.self?.toLowerCase() ?? null;
  const trusted = new Set(i.trusted.map((t) => t.toLowerCase()));
  const others = i.scope.recipients.filter((r) => r !== self);
  if (!others.length) return true;
  return others.every((r) => trusted.has(r)) && ownerWake(i.origin, i.source);
}

/** The Settings list, checked: lower-cased addresses, no duplicates, at most 50. */
export function normalizeTrusted(list: unknown): string[] | string {
  if (!Array.isArray(list)) return "Trusted people must be a list of email addresses.";
  const out: string[] = [];
  for (const raw of list) {
    const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(e) || e.length > 254) return `“${String(raw).slice(0, 80)}” isn't an email address.`;
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > TRUSTED_MAX) return `You can trust at most ${TRUSTED_MAX} people.`;
  return out;
}
