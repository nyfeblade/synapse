import type { TimelineEvent } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { TurnRunner } from "./turn-runner";
import type { TurnSlot } from "./turn-slot";

type WakeOriginEvent = Extract<TimelineEvent, { type: "wake-origin" }>;

function eventFor(slot: TurnSlot): WakeOriginEvent | null {
  const w = slot.context.wake;
  if (!w || slot.lane === "user" || slot.source === "group-member" || slot.context.group) return null;
  switch (w.kind) {
    case "agent":
      return { type: "wake-origin", source: "agent", botIds: [...new Set(w.senderIds)] };
    case "routine":
      return { type: "wake-origin", source: "routine", routineId: w.routineId, routineName: w.routineName, ...(w.via ? { via: w.via } : {}), ...(w.caughtUp ? { caughtUp: true } : {}) };
    case "revival":
      return { type: "wake-origin", source: "revival", taskId: w.taskId, taskTitle: w.title };
    case "followup":
      return { type: "wake-origin", source: "followup" };
  }
}

/** CHAT-23 / ORIG-18 §18.2: one centered row naming why a non-user turn woke, inserted before its first visible write. */
export function installWakeOrigin(runner: TurnRunner, bots: BotService): void {
  const done = new WeakSet<TurnSlot>(); // Task 2 fires once per turn; this guard keeps the row single even if the event entry itself counts as visible
  runner.addObserver({
    onBeforeFirstVisible(botId, slot) {
      if (done.has(slot)) return;
      done.add(slot);
      const event = eventFor(slot);
      if (!event || !bots.has(botId)) return;
      const [id] = bots.auxEntryIds(botId, 1);
      bots.appendEntry(botId, { kind: "event", id: id!, createdAt: Date.now(), event });
    },
  });
}
