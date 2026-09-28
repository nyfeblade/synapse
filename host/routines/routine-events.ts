import { activityEntryId, type EventEntry, type TimelineEvent } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { TurnSlot } from "../runner/turn-slot";

type RoutineEvent = Extract<TimelineEvent, { type: `routine-${string}` }>;
const AGGREGATES = new Set(["routine-enabled", "routine-disabled", "routine-deleted"]);

/** CHAT-03: "Created Routine · <name>"; consecutive enable/disable/delete events in one turn become one row with a count. */
export function appendRoutineEvent(bots: BotService, botId: string, slot: TurnSlot | null, ev: RoutineEvent): void {
  if (!bots.has(botId)) return;
  const turnKey = slot ? slot.requestId : "out-of-turn";
  const now = Date.now();
  if (AGGREGATES.has(ev.type)) {
    const last = bots.tail(botId, 1)[0];
    if (last?.kind === "event" && last.event.type === ev.type && (last.event as RoutineEvent).turnKey === turnKey) {
      const prev = last.event as RoutineEvent;
      bots.updateEntry(botId, { ...last, event: { ...prev, count: (prev.count ?? 1) + 1 } });
      return;
    }
  }
  const id = slot ? activityEntryId(slot.turnNo, ++slot.nextActK) : bots.auxEntryIds(botId, 1)[0]!;
  const event: RoutineEvent = { ...ev, turnKey, ...(AGGREGATES.has(ev.type) ? { count: 1 } : {}) };
  const entry: EventEntry = { kind: "event", id, createdAt: now, event };
  bots.appendEntry(botId, entry);
  if (slot) slot.segment += 1;
}
