import { STRC, type BoxHelpView } from "@synapse/shared";
import { call } from "../bridge";
import { useComputer } from "../computer-state";
import { DisplayIcon } from "./Icons";

const SETTLED: Record<string, string> = { handed_back: STRC.handedBack, dismissed: STRC.skipped, viewer_closed: STRC.viewerClosed };

export function MonitorIcon() {
  return <DisplayIcon />;
}

/** Computer.dc.html card (C2–C4, CMP-08). */
export function BoxHelpCard({ botId, request }: { botId: string; request: BoxHelpView }) {
  const openComputer = useComputer((s) => s.openComputer);
  const pending = request.status === "pending";
  const takeOver = async () => {
    await call("setTakeoverActive", { id: botId, requestId: request.id, active: true });
    openComputer(botId);
  };
  const handBack = (outcome: "done" | "skip") => void call("handBackForeverBox", { id: botId, requestId: request.id, outcome });
  return (
    <section aria-label={STRC.computer} className="computer-card">
      <div className="cc-head">
        <MonitorIcon />
        <span className="cc-title">{STRC.computer}</span>
        {pending && request.inControl ? (
          <span className="control-pill"><span className="dot" />{STRC.youreInControl}</span>
        ) : (
          <span className="cc-badge">{pending ? STRC.boxHelpBadge : SETTLED[request.status]}</span>
        )}
      </div>
      <div className="cc-text">{request.instruction}</div>
      {request.screenshotDataUrl && <img className="cc-shot" src={request.screenshotDataUrl} alt="Screenshot of the Bot's screen" />}
      {pending && (
        <div className="cc-actions">
          <button type="button" className="btn-primary" onClick={() => void takeOver()}>{STRC.takeOver}</button>
          <button type="button" className="btn-outline" onClick={() => handBack("done")}>{STRC.imDone}</button>
          <button type="button" className="btn-outline" onClick={() => handBack("skip")}>{STRC.skip}</button>
        </div>
      )}
    </section>
  );
}
