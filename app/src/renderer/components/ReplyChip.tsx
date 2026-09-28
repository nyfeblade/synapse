import { STR } from "@synapse/shared";
import { useComposer } from "../composer-store";
import { useUi } from "../store";
import { CloseIcon } from "./Icons";

export function ReplyChip({ botId }: { botId: string }) {
  const id = useComposer((s) => s.byBot[botId]?.replyToId ?? null);
  const target = useUi((s) => (id ? s.transcripts[botId]?.find((e) => e.id === id) : undefined));
  if (!id) return null;
  const quote = target?.kind === "message" ? target.content : target?.kind === "send-message" && target.message.type === "text" ? target.message.content : "";
  return (
    <div className="reply-chip">
      <span>{STR.replyingTo}:</span><span className="muted clamp1">{quote.slice(0, 80)}</span>
      <button type="button" className="chip-x" aria-label="Cancel reply" onClick={() => useComposer.getState().setReplyTo(botId, null)}><CloseIcon size={10} /></button>
    </div>
  );
}
