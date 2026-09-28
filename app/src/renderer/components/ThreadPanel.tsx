import { useRef, useState } from "react";
import { useExpandFlip } from "../flip";
import { useAsync } from "../async-resource";
import { callQuiet } from "../bridge";
import { Async } from "./Async";

// The read had no catch and no state but the replies themselves, so a failed getAgentThread opened
// an empty <ul> under "3 replies": the thread looked empty rather than unreadable, and the only
// trace of the failure was an unhandled rejection in the console.
export function ThreadPanel({ botId, rootId, count }: { botId: string; rootId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useExpandFlip(ref, open);
  // callQuiet: the panel shows the failure where the replies would have been, with a Retry.
  // `enabled` keeps this a read that only happens when the thread is actually opened.
  const thread = useAsync(() => callQuiet("getAgentThread", { id: botId, entryId: rootId }), [botId, rootId], { enabled: open });
  return (
    <div ref={ref} className="thread">
      <button type="button" className="link-btn small" aria-expanded={open} onClick={() => setOpen(!open)}>{count} {count === 1 ? "reply" : "replies"}</button>
      {open && (
        <Async resource={thread} label={`${count} replies`}>
          {({ replies }) => (
            <ul className="thread-list">
              {replies.map((e) => (
                <li key={e.id} className="muted small">
                  {e.kind === "message" ? `You: ${e.content}` : e.kind === "send-message" && e.message.type === "text" ? e.message.content : e.kind === "send-message" && e.message.type === "attachment" ? `📎 ${e.message.name}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Async>
      )}
    </div>
  );
}
