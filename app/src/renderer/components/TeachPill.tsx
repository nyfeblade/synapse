import { STR } from "@synapse/shared";
import { useUi } from "../store";
import { RecordIcon } from "./Icons";

/** TCH-01 eligibility shared by the pill and the composer's + menu: a one-to-one Bot, no other recording running. */
export function useTeachEligibility(botId: string): { disabled: boolean; why: string | undefined } {
  const bot = useUi((s) => s.bots[botId]);
  const teach = useUi((s) => s.teach);
  // A recording by THIS Bot disables it too: the control had nothing to open while the recording
  // bar was up, so clicking it did nothing and left a setup banner to pop open later.
  const busy = (teach.state === "RECORDING" || teach.state === "PAUSED" || teach.state === "FINALIZING") && teach.botId !== null;
  const mine = busy && teach.botId === botId;
  const group = Boolean(bot?.group);
  const why = group ? "Teach a task works only in a one-to-one chat." : mine ? "Recording in progress." : busy ? "Another recording is in progress." : undefined;
  return { disabled: !bot || group || busy, why };
}

/** Computer.dc.html title-bar pill "Teach a task" (TCH-01 entry point). */
export function TeachPill({ botId }: { botId: string }) {
  const { disabled, why } = useTeachEligibility(botId);
  return (
    <button type="button" className="btn-compact" disabled={disabled} title={why} aria-label={STR.teachTask}
      onClick={() => useUi.setState({ teachSetupFor: botId })}>
      <RecordIcon />
      {STR.teachTask}
    </button>
  );
}
