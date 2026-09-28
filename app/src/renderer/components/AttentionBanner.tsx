import { STRC } from "@synapse/shared";
import { call } from "../bridge";
import { useUi } from "../store";
import { pendingBoxHelp } from "./ComputerView";

/** CMP-08: banner above the composer while a box-help request waits. */
export function AttentionBanner({ botId }: { botId: string }) {
  const help = useUi((s) => pendingBoxHelp(s.transcripts[botId] ?? []));
  if (!help) return null;
  const handBack = (outcome: "done" | "skip") => void call("handBackForeverBox", { id: botId, requestId: help.id, outcome });
  return (
    <div className="attention" role="region" aria-label={STRC.needsAttention}>
      <span className="attention-title">{STRC.needsAttention}</span>
      <span className="attention-text">{help.instruction}</span>
      <button type="button" className="btn-outline small" onClick={() => handBack("skip")}>{STRC.skipThisStep}</button>
      <button type="button" className="btn-primary" onClick={() => handBack("done")}>{STRC.imDoneContinue}</button>
    </div>
  );
}
