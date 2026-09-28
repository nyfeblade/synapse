import { STR, type ApprovalCardView } from "@synapse/shared";
import { copyWithConfirmation } from "../toast";
import { CodeCardBody } from "./CodeBlock";
import { Dialog } from "./Dialog";
import { CloseIcon } from "./Icons";

const fmt = (t: number | null) => (t ? new Date(t).toLocaleString() : "—");

/** APR-20 full-request sheet. */
export function FullRequestSheet({ approval: a, onClose }: { approval: ApprovalCardView; onClose(): void }) {
  const rows: [string, string][] = [
    ["Summary", a.summary], ["Reason", a.verdict?.reason ?? a.reason], ["Where", a.locationLine ?? "—"], ["Surface", a.surface],
    ["Matched rules", a.verdict?.matchedRuleIds.join(", ") || "—"], ["Safety category", a.verdict?.floorCategory ?? "—"],
    ["Risk tier", a.verdict?.tier === null || a.verdict?.tier === undefined ? "—" : String(a.verdict.tier)], ["Decided by", a.verdict?.stage ?? "—"],
    ["Created", fmt(a.createdAt)], ["Settled", fmt(a.settledAt)], ["Expiry cause", a.cause ?? "—"], ["Request ID", a.requestId],
  ];
  return (
    <Dialog label={STR.fullRequest} onClose={onClose} className="sheet">
      <>
        <div className="sheet-head"><span className="card-title">{a.title}</span><button type="button" className="icon-btn" aria-label={STR.close} onClick={onClose}><CloseIcon /></button></div>
        <dl className="sheet-list">{rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}</dl>
        {/* bug 198: this could run to ~4,000 chars (LIMITS.approvalCommandMax) of raw shell — a bare
            `<pre>` had no fold and no copy of its own; reuses bug 193's code card instead. Fix round 1,
            finding 8: `.sheet-command` (app.css) wraps this ONE card's lines instead of the card's
            usual horizontal scroll — a full-request sheet is read top to bottom, not side to side. */}
        {a.command && <div className="sheet-command"><CodeCardBody language="Shell" code={a.command} /></div>}
        <button type="button" className="btn-outline small" onClick={() => void copyWithConfirmation(a.requestId)}>{STR.copyRequestId}</button>
      </>
    </Dialog>
  );
}
