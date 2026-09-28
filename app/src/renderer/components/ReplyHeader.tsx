import { STR } from "@synapse/shared";
import { useUi } from "../store";

export function ReplyHeader({ botId, replyToId }: { botId: string; replyToId: string }) {
  const target = useUi((s) => s.transcripts[botId]?.find((e) => e.id === replyToId));
  const quote = !target ? "" : target.kind === "message" ? target.content : target.kind === "send-message" && target.message.type === "text" ? target.message.content : target.kind === "send-message" && target.message.type === "attachment" ? target.message.name : "";
  return (
    <button type="button" className="reply-header" onClick={() => void useUi.getState().jumpTo(botId, replyToId)}>
      ↪ {STR.inReplyTo} <span className="muted clamp1">{quote.slice(0, 80)}</span>
    </button>
  );
}
