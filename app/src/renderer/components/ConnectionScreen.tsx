import { STR, STRC } from "@synapse/shared";
import type { ConnectionState } from "../bridge";

export function ConnectionScreen({ state, onRetry }: { state: ConnectionState; onRetry: () => void }) {
  const title =
    state.kind === "reconnecting" ? STR.connReconnecting : state.kind === "unreachable" ? STR.connUnreachable : STR.connStarting;
  return (
    <div className="connection" role="status" aria-live="polite">
      <span className="title">{title}</span>
      {state.kind === "unreachable" && (
        <>
          <span>{state.error}</span>
          <button type="button" className="btn-primary" onClick={onRetry}>{STR.retry}</button>
          <button type="button" className="btn-outline" onClick={() => void window.synapse.box.recover()}>{STRC.recover}</button>
        </>
      )}
    </div>
  );
}
