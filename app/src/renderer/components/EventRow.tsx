import { useState } from "react";
import { STR, STRS, timeSeparator, type AgentMessageEntry, type EventEntry, type TranscriptEntry } from "@synapse/shared";
import { useUi } from "../store";
import { ExchangeMessageList, ExchangeToggle } from "./ExchangeShared";
import { MiniAvatars } from "./MiniAvatars";

const nameOf = (bots: ReturnType<typeof useUi.getState>["bots"], id: string) => bots[id]?.profile.name ?? "a Bot";
const who = (bots: ReturnType<typeof useUi.getState>["bots"], ids: string[]) => (ids.length === 1 ? nameOf(bots, ids[0]!) : STR.nBots(ids.length));

/**
 * Phase 4 event rows (CHAT-03, CHAT-23, GRP-13; board rows A5, G4–G6): routine changes, agent-to-agent
 * fan-outs and their expandable log, wake-origin, member-pass and group-created. Phase 1's `bot-created`
 * / `renamed` / `skill-saved` events stay on the `event` item kind, rendered inline by Transcript.tsx.
 */
export function EventRow({ entry, entries }: { entry: EventEntry; entries: TranscriptEntry[] }) {
  const bots = useUi((s) => s.bots);
  const [open, setOpen] = useState(false);
  const ev = entry.event;
  switch (ev.type) {
    case "routine-created":
      return (
        <div className="event-row">
          <span>{STR.createdRoutine} · {ev.name}</span>
          {ev.nextRunAt ? <span className="muted-2">· Next run {timeSeparator(ev.nextRunAt, Date.now())}</span> : null}
        </div>
      );
    case "routine-updated":
      return <div className="event-row"><span>Updated Routine · {ev.name}</span></div>;
    case "routine-enabled":
      return <div className="event-row"><span>{STR.routinesCount("Enabled", ev.count ?? 1)}</span></div>;
    case "routine-disabled":
      return <div className="event-row"><span>{STR.routinesCount("Disabled", ev.count ?? 1)}</span></div>;
    case "routine-deleted":
      return <div className="event-row"><span>{STR.routinesCount("Deleted", ev.count ?? 1)}</span></div>;
    case "agents-messaged":
      return <div className="event-row"><span>{STR.messaged}</span><MiniAvatars ids={ev.botIds} /><span>{who(bots, ev.botIds)}</span></div>;
    case "agent-exchange": {
      const msgs = entries.filter((e): e is AgentMessageEntry => ev.entryIds.includes(e.id) && e.kind === "message");
      return (
        <div className="exchange">
          <ExchangeToggle countLabel={STR.messagesWith(ev.count)} ids={ev.botIds} whoLabel={who(bots, ev.botIds)} open={open} onToggle={() => setOpen(!open)} />
          {open && <ExchangeMessageList entries={msgs} />}
        </div>
      );
    }
    case "wake-origin": {
      if (ev.source === "agent") {
        const ids = ev.botIds ?? [];
        return ids.length > 1
          ? <div className="event-row"><span>{STR.messagesFrom}</span><MiniAvatars ids={ids} /><span>{STR.nBots(ids.length)}</span></div>
          : <div className="event-row"><span>{STR.messageFrom}</span><MiniAvatars ids={ids} /><span>{nameOf(bots, ids[0] ?? "")}</span></div>;
      }
      if (ev.source === "routine") {
        const label = ev.via === "schedule" ? STRS.scheduledOrigin(ev.routineName ?? "", ev.caughtUp === true) : ev.via === "event" ? STRS.triggeredOrigin(ev.routineName ?? "") : STR.routineOrigin(ev.routineName ?? "");
        return <div className="event-row"><span>{label}</span></div>;
      }
      if (ev.source === "revival") return <div className="event-row"><span>{STR.revivalOrigin(ev.taskTitle ?? "")}</span></div>;
      return <div className="event-row"><span>{STR.followupOrigin}</span></div>;
    }
    case "member-pass":
      return <div className="event-row"><span>{STR.passedNames(ev.botIds.map((id) => nameOf(bots, id)))}</span> <span className="muted-2">{STR.passedSuffix}</span></div>;
    case "group-created": {
      const members = bots[ev.groupId]?.group?.memberIds ?? [];
      return <div className="event-row"><span>{STR.created}</span><MiniAvatars ids={members} /><span>{ev.name}</span></div>;
    }
    default:
      // Phase 1's bot-created / renamed / skill-saved never reach this component (see comment above).
      return null;
  }
}
