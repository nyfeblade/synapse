import { LIMITS, sendEntryId, type CardSpec, type FormField, type SendMessageEntry, type WidgetOption, type WidgetSpec } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { TurnHooks } from "../runner/hooks";
import { toolError, type BotToolExtensions } from "../tools/registry";

export const ASKED_TEXT = "Asked the user. Your turn ends now; you'll be resumed with the answer.";
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Bug 4: the widget option format was undocumented — `widget` is a bare free-form object in SendMessage's
// schema (`z.looseObject({})`, deliberately unstructured: prompt-budget.test.ts's tool-schema ceiling has
// no room left to spell the shape out there, see host/test/perf/prompt-budget.test.ts). This is the shape
// a model actually sees when it gets it wrong, so both errors below carry it plus a tiny concrete example.
const OPTION_SHAPE = '{ label: string, value?: string, style?: "default" | "primary" | "danger" }';
const WIDGET_EXAMPLE = 'widget: { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }';

export function validateWidget(raw: unknown): WidgetSpec | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const question = str(r.question, 500);
  if (!question) return "A widget needs a question.";
  const opts = Array.isArray(r.options) ? r.options : [];
  if (opts.length < 1 || opts.length > LIMITS.widgetOptionsMax) return `A widget needs 1–6 options, each ${OPTION_SHAPE}. Example: ${WIDGET_EXAMPLE}`;
  const options: WidgetOption[] = [];
  for (const [i, o] of opts.entries()) {
    const label = str((o as Record<string, unknown>)?.label, 80);
    if (!label) return `Option ${i + 1} needs a label: ${OPTION_SHAPE}. Example: ${WIDGET_EXAMPLE}`;
    const style = (o as Record<string, unknown>).style;
    options.push({ label, value: str((o as Record<string, unknown>).value, 200) || label, style: style === "primary" || style === "danger" ? style : "default" });
  }
  return { question, options, allowCustom: Boolean(r.allowCustom), dismissOnMoveOn: Boolean(r.dismissOnMoveOn) };
}

export function validateCard(raw: unknown): CardSpec | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  switch (r.kind) {
    case "email-draft": {
      const to = Array.isArray(r.to) ? r.to.map((x) => str(x, 320)).filter(Boolean) : [];
      if (!to.length) return "An email draft needs at least one recipient in to.";
      return { kind: "email-draft", from: str(r.from, 320) || null, to, cc: Array.isArray(r.cc) ? r.cc.map((x) => str(x, 320)).filter(Boolean) : [], subject: str(r.subject, 300), body: str(r.body, 20_000) };
    }
    case "form": {
      const fields = (Array.isArray(r.fields) ? r.fields : []).slice(0, 12).map((f): FormField => {
        const x = f as Record<string, unknown>;
        const kind = x.kind === "textarea" || x.kind === "select" ? x.kind : "text";
        return { name: str(x.name, 60), label: str(x.label, 120), kind, options: Array.isArray(x.options) ? x.options.map((o) => str(o, 120)) : undefined, required: Boolean(x.required), value: str(x.value, 2000) || undefined };
      });
      if (!fields.length || fields.some((f) => !f.name || !f.label)) return "A form needs fields, each with a name and a label.";
      return { kind: "form", title: str(r.title, 200) || "Form", fields, submitLabel: str(r.submitLabel, 40) || undefined };
    }
    case "link": {
      const url = str(r.url, 2000);
      if (!/^https?:\/\//i.test(url)) return "A link card needs an http or https url.";
      return { kind: "link", url, title: str(r.title, 200) || null, description: str(r.description, 500) || null };
    }
    case "table": {
      const columns = Array.isArray(r.columns) ? r.columns.map((c) => str(c, 120)) : [];
      const rows = Array.isArray(r.rows) ? r.rows.slice(0, 200).map((row) => (Array.isArray(row) ? row.map((c) => str(String(c ?? ""), 500)) : [])) : [];
      if (!columns.length) return "A table needs columns.";
      const bad = rows.findIndex((row) => row.length !== columns.length);
      if (bad >= 0) return `Table row ${bad + 1} has ${rows[bad]!.length} cells but there are ${columns.length} columns.`;
      return { kind: "table", title: str(r.title, 200) || null, columns, rows };
    }
    default:
      return `Unknown card kind "${String(r.kind)}". Use email-draft, form, link or table.`;
  }
}

const isInteractive = (c: CardSpec) => c.kind === "email-draft" || c.kind === "form";
const reasonOf = (e: SendMessageEntry): string => {
  const m = e.message;
  if (m.type === "widget") return m.widget.question;
  if (m.type === "card" && m.card.kind === "email-draft") return `Email draft: ${m.card.subject}`;
  if (m.type === "card" && m.card.kind === "form") return m.card.title;
  return "";
};

export function pendingWidgets(bots: BotService, botId: string): SendMessageEntry[] {
  return bots.tail(botId, 500).filter((e): e is SendMessageEntry => e.kind === "send-message" && e.status === "pending");
}

export function refreshAwaiting(bots: BotService, botId: string, now: number): void {
  const pending = pendingWidgets(bots, botId);
  const cur = bots.summary(botId).awaiting;
  if (pending.length) bots.setAwaiting(botId, { tabId: "widget", reason: reasonOf(pending.at(-1)!), since: cur?.tabId === "widget" ? cur.since : now });
  else if (cur?.tabId === "widget") bots.setAwaiting(botId, null);
}

export function createWidgetExtension(d: { bots: BotService; now(): number }): BotToolExtensions {
  const ask = (c: Parameters<NonNullable<NonNullable<BotToolExtensions["sendTypes"]>["widget"]>>[0], message: SendMessageEntry["message"], preview: string) => {
    c.deliver(message, { status: "pending" }, preview);
    c.slot.awaitingUserSelection = true;
    refreshAwaiting(d.bots, c.botId, d.now());
    return { text: ASKED_TEXT };
  };
  return {
    sendTypes: {
      widget: (c) => {
        const w = validateWidget(c.args.widget ?? { question: c.args.content, options: [] });
        if (typeof w === "string") return toolError(w);
        return ask(c, { type: "widget", widget: w }, w.question);
      },
      card: (c) => {
        const card = validateCard(c.args.card);
        if (typeof card === "string") return toolError(card);
        if (isInteractive(card)) return ask(c, { type: "card", card }, card.kind === "email-draft" ? `Email draft: ${card.subject}` : card.title);
        c.deliver({ type: "card", card }, {}, card.kind === "link" ? card.title ?? card.url : card.kind === "table" ? card.title ?? "Table" : card.routineName);
        return { text: "Card sent." };
      },
    },
  };
}

/** CHAT-17: unanswered widgets before a new user turn are marked skipped and listed to the model. */
export function createWidgetHooks(d: { bots: BotService }): TurnHooks {
  return {
    turnBlocks: (botId, t) => {
      if (t.source !== "user") return [];
      const pending = pendingWidgets(d.bots, botId).filter((e) => !(e.message.type === "widget" && e.message.widget.hostKind));
      if (!pending.length) return [];
      for (const e of pending) d.bots.updateEntry(botId, { ...e, status: "skipped" });
      refreshAwaiting(d.bots, botId, Date.now());
      const lines = pending.map((e) => `- ${e.id} "${reasonOf(e)}"`).join("\n");
      return [{ text: `<system_reminder>Unanswered questions (the user moved on without answering):\n${lines}</system_reminder>` }];
    },
  };
}

type HostKind = NonNullable<WidgetSpec["hostKind"]>;

/**
 * RTN-20 / TCH-*: widgets the host posts itself (spend guard, teach rehearsal). Phase 4 Task 6's
 * `hostPost`/`registerHostKind`, folded onto the canonical Phase 2 widget service (controller
 * ruling 1): `createWidgetCommands({ host })` hands their answers here instead of waking the Bot.
 */
export class HostWidgets {
  private kinds = new Map<HostKind, (botId: string, entryId: string, value: string) => void>();
  private oneOff = new Map<string, (value: string) => void>();

  constructor(private d: { bots: BotService; now(): number }) {}

  /** A registered kind handler survives host restarts, so it wins over the one-off callback. */
  registerHostKind(kind: HostKind, fn: (botId: string, entryId: string, value: string) => void): void {
    this.kinds.set(kind, fn);
  }

  hostPost(botId: string, spec: WidgetSpec, onAnswer: (value: string) => void): string {
    const id = sendEntryId(this.d.bots.nextTurnNo(botId), 1);
    const entry: SendMessageEntry = { kind: "send-message", id, requestId: `host_${id}`, createdAt: this.d.now(), message: { type: "widget", widget: spec }, status: "pending" };
    this.d.bots.appendEntry(botId, entry);
    refreshAwaiting(this.d.bots, botId, this.d.now());
    this.oneOff.set(`${botId}:${id}`, onAnswer);
    return id;
  }

  /** True when the host handled the answer (the caller then skips the Bot wake). */
  answer(botId: string, entry: SendMessageEntry, value: string): boolean {
    const key = `${botId}:${entry.id}`;
    const once = this.oneOff.get(key);
    this.oneOff.delete(key);
    const kind = entry.message.type === "widget" && entry.message.widget.hostKind ? this.kinds.get(entry.message.widget.hostKind) : undefined;
    if (kind) { kind(botId, entry.id, value); return true; }
    if (once) { once(value); return true; }
    return false;
  }
}
