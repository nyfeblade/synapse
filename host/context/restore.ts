import { LIMITS, type SendMessageEntry, type UserMessageEntry } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { pendingWidgets } from "../chat/widgets";
import type { TurnHooks } from "../runner/hooks";
import { patchCtx, readCtx } from "./context-meter";

const q = (s: string) => `"${s.replace(/\s+/g, " ").trim().slice(0, LIMITS.restoreQuoteMax)}"`;

export function buildRestoreBlock(d: { bots: BotService; botId: string; dataRoot: string }): string {
  const tail = d.bots.tail(d.botId, 400);
  const s = d.bots.summary(d.botId);
  const waiting = [
    ...(s.awaiting && s.awaiting.tabId !== "widget" ? [s.awaiting.reason] : []),
    ...pendingWidgets(d.bots, d.botId).map((w) => (w.message.type === "widget" ? `question ${w.id}: ${w.message.widget.question}` : `card ${w.id}`)),
  ];
  const confirmed = d.bots.confirmedUserSeq(d.botId);
  const users = tail.filter((e): e is UserMessageEntry => e.kind === "message");
  const unacked = users.filter((m) => Number(m.id.slice(1, -1)) > confirmed).map((m) => m.id);
  const sent = tail.filter((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "text");
  const todos = d.bots.brainKv<{ content: string; status: string }[]>(d.botId, "todos", []).filter((t) => t.status !== "completed").map((t) => t.content);
  const lines = [
    `- Waiting on the user: ${waiting.length ? waiting.join("; ") : "nothing"}`,
    `- Unacknowledged user messages: ${unacked.length ? `${unacked.length} (${unacked.join(", ")})` : "none"}`,
    "- Running background work: none",
    `- Your open todo list: ${todos.length ? todos.join("; ") : "empty"}`,
    `- Last 3 things the user said (newest last): ${users.slice(-3).map((m) => `${m.id} ${q(m.content)}`).join(" · ") || "nothing yet"}`,
    `- Last 3 things you sent the user (newest last): ${sent.slice(-3).map((m) => q(m.message.type === "text" ? m.message.content : "")).join(" · ") || "nothing yet"}`,
    "- Group chats you're in: none; other Bots you've talked with recently: none",
  ];
  const head = "<system_reminder><context_restore>\nYour conversation was just summarized. Facts from the app (authoritative):\n";
  // Bug #61: the mirror is host-private (no Bot can read it); the Bot searches its own history through the host.
  const foot = "\nFull history: search it with SearchHistory (it has everything summarised away).\n</context_restore></system_reminder>";
  let body = lines.join("\n");
  const room = LIMITS.restoreMaxChars - head.length - foot.length;
  if (body.length > room) body = `${body.slice(0, room - 1)}…`;
  return head + body + foot;
}

export function createRestoreHooks(d: { bots: BotService; dataRoot: string }): TurnHooks {
  return {
    turnBlocks: (botId, t) => {
      if (t.source === "maintenance" || !readCtx(d.bots, botId).restorePending) return [];
      patchCtx(d.bots, botId, { restorePending: false });
      return [{ text: buildRestoreBlock({ bots: d.bots, botId, dataRoot: d.dataRoot }) }];
    },
    onEvent: (botId, e) => {
      if (e.kind === "tool_start" && e.name === "TodoWrite" && Array.isArray(e.input.todos)) d.bots.setBrainKv(botId, "todos", e.input.todos);
    },
  };
}
