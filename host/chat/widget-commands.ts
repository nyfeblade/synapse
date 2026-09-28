import { isPageFormCard, type SendMessageEntry, type WidgetStatus } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import type { AckLedger } from "../runner/ack-ledger";
import { refreshAwaiting, type HostWidgets } from "./widgets";

const CLOSED: Record<Exclude<WidgetStatus, "pending">, string> = {
  answered: "This question was already answered.",
  skipped: "This question was skipped.",
  dismissed: "This question was dismissed.",
};

export function createWidgetCommands(d: { bots: BotService; acks: AckLedger; wake(botId: string, text: string): void; now?: () => number; host?: Pick<HostWidgets, "answer"> }): CommandHandlers {
  const now = d.now ?? Date.now;
  const load = (botId: string, entryId: string): SendMessageEntry => {
    const e = d.bots.getEntry(botId, entryId);
    if (!e || e.kind !== "send-message" || (e.message.type !== "widget" && e.message.type !== "card")) throw new GatewayError("NOT_A_WIDGET", "That message isn't a question or card.", 404);
    if (e.status !== "pending") throw new GatewayError("WIDGET_CLOSED", CLOSED[(e.status ?? "answered") as Exclude<WidgetStatus, "pending">], 409);
    return e;
  };
  return {
    respondToWidget: async (a) => {
      const e = load(a.id, a.entryId);
      const m = e.message;
      let shown: string;
      let text: string;
      if (m.type === "widget") {
        const opt = m.widget.options.find((o) => o.value === a.value);
        if (!opt && !m.widget.allowCustom) throw new GatewayError("BAD_OPTION", "That isn't one of the options.");
        shown = opt?.label ?? a.value.trim().slice(0, 500);
        if (!shown) throw new GatewayError("EMPTY_ANSWER", "The answer is empty.");
        if (m.widget.hostKind && d.host) {
          // RTN-20: a host-posted widget (spend guard); the host applies the answer, not a Bot wake.
          d.bots.updateEntry(a.id, { ...e, status: "answered", respondedValue: shown });
          refreshAwaiting(d.bots, a.id, now());
          if (d.host.answer(a.id, e, opt?.value ?? a.value)) return { status: "answered" };
        }
        text = `The user answered your question ${e.id} ("${m.widget.question}"): ${shown}`;
      } else if (m.type === "card" && m.card.kind === "form" && !isPageFormCard(m.card)) {
        const vals = a.formValues ?? {};
        const missing = m.card.fields.filter((f) => f.required && !String(vals[f.name] ?? "").trim());
        if (missing.length) throw new GatewayError("FORM_INCOMPLETE", `Fill in ${missing.map((f) => f.label).join(", ")}.`);
        shown = "Submitted";
        text = `The user submitted your form ${e.id} ("${m.card.title}"):\n${m.card.fields.map((f) => `- ${f.label}: ${String(vals[f.name] ?? "").slice(0, 2000)}`).join("\n")}`;
      } else if (m.type === "card" && m.card.kind === "email-draft") {
        if (a.value !== "send" && a.value !== "discard") throw new GatewayError("BAD_OPTION", "Choose Send email or Discard.");
        shown = a.value === "send" ? "Send email" : "Discard";
        text = a.value === "send"
          ? `The user chose "Send email" on your email draft ${e.id} ("${m.card.subject}"). Send exactly that draft now.`
          : `The user discarded your email draft ${e.id} ("${m.card.subject}"). Don't send it.`;
      } else throw new GatewayError("NOT_INTERACTIVE", "This card has no actions.");
      d.bots.updateEntry(a.id, { ...e, status: "answered", respondedValue: shown });
      refreshAwaiting(d.bots, a.id, now());
      d.acks.record(a.id); // the answer is the user's reply: the Bot owes a reply to it (OUT-08)
      d.wake(a.id, text);
      return { status: "answered" };
    },
    dismissWidget: async (a) => {
      const e = load(a.id, a.entryId);
      d.bots.updateEntry(a.id, { ...e, status: "dismissed" });
      refreshAwaiting(d.bots, a.id, now());
      return { status: "dismissed" };
    },
  };
}
