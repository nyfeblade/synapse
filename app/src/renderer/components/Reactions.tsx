import type { SendMessageEntry, UserMessageEntry } from "@synapse/shared";
import { call } from "../bridge";

export function Reactions({ botId, entry }: { botId: string; entry: UserMessageEntry | SendMessageEntry }) {
  const list = entry.reactions ?? [];
  if (!list.length) return null;
  const groups = new Map<string, { n: number; mine: boolean }>();
  for (const r of list) { const g = groups.get(r.emoji) ?? { n: 0, mine: false }; groups.set(r.emoji, { n: g.n + 1, mine: g.mine || r.by === "user" }); }
  // A Bot can react to the user's own messages (the ReactToMessage tool stores `{ emoji, by: botId }`),
  // so `mine` is false on a perfectly ordinary chip. reactToMessage is a plain per-user toggle, so every
  // chip toggles the user's own reaction; gating the click on `mine` left those chips looking clickable
  // (border, hover fill, active fill) while doing nothing at all.
  return (
    <div className="reactions">
      {[...groups].map(([emoji, g]) => (
        <button key={emoji} type="button" className={g.mine ? "reaction mine" : "reaction"} aria-label={`${emoji} ${g.n}${g.mine ? ", you reacted" : ""}`}
          onClick={() => void call("reactToMessage", { id: botId, entryId: entry.id, emoji })}>{emoji} {g.n}</button>
      ))}
    </div>
  );
}
