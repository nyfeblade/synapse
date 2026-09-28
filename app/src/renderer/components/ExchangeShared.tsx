import type { ReactNode } from "react";
import { STR, type AgentMessageEntry } from "@synapse/shared";
import { useUi } from "../store";
import { ChevronDownIcon } from "./Icons";
import { MiniAvatars } from "./MiniAvatars";

/**
 * Fix round 1, Task 23 finding 1: the "expandable Bot-to-Bot message list" UI, shared by EventRow's
 * `agent-exchange` case (host `EventEntry` data) and ExchangeBlock (client-buffered `TranscriptItem`
 * data) — two components rendering the same widget from two different sources of the same
 * `AgentMessageEntry[]` shape. Filed as a follow-up against the plan (task-23-brief.md:364-373 vs
 * :410-435 specified them separately; the implementer built to spec as written).
 */
export function ExchangeToggle({ countLabel, ids, whoLabel, open, onToggle }: { countLabel: ReactNode; ids: string[]; whoLabel: ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="event-row as-button" aria-expanded={open} onClick={onToggle}>
      <span>{countLabel}</span>
      <MiniAvatars ids={ids} />
      <span>{whoLabel}</span>
      <ChevronDownIcon />
    </button>
  );
}

function PeerName({ id, name }: { id: string | undefined; name: string }) {
  if (!id) return <span className="exchange-who">{name}</span>;
  return (
    <button type="button" className="exchange-peer" onClick={() => void useUi.getState().openBot(id)}>
      {name}
    </button>
  );
}

/** ORIG-09 §09.3: `inbox` marks a message delivered without a wake; both callers style it the same way.
 *  CHAT-04 expand is a readable thread (avatar, from/to, bubble, inbox), and a peer name opens that DM. */
export function ExchangeMessageList({ entries }: { entries: AgentMessageEntry[] }) {
  return (
    <ol className="exchange-list">
      {entries.map((m) => {
        const fromId = m.fromAgent?.id;
        const toId = m.toAgent?.id;
        const fromName = m.fromAgent?.name ?? "You";
        const toName = m.toAgent?.name ?? "you";
        return (
          <li key={m.id} className={m.inbox ? "exchange-msg inbox" : "exchange-msg"}>
            {fromId ? <MiniAvatars ids={[fromId]} max={1} /> : null}
            <span className="exchange-meta">
              <PeerName id={fromId} name={fromName} />
              <span className="exchange-arrow" aria-hidden="true">→</span>
              <PeerName id={toId} name={toName} />
              {m.inbox ? <span className="muted">{STR.noReplyNeeded}</span> : null}
            </span>
            <div className="bubble bot">{m.content}</div>
          </li>
        );
      })}
    </ol>
  );
}
