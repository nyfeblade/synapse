import { useEffect, useState } from "react";
import { STR, type ApprovalCardView, type ApprovalChoice } from "@synapse/shared";
import { call, GatewayCallError } from "../bridge";
import { useUi } from "../store";
import { FullRequestSheet } from "./FullRequestSheet";
import { ServerIcon } from "./Icons";
import { newFlag } from "../is-new";

/** Shown when the answer never reached the host — the approval is still live, so the card stays answerable. */
const COULD_NOT_SEND = "Couldn't send your answer. Check your connection and try again.";

export function ApprovalCard({ botId, approval: a, isNew = false }: { botId: string; approval: ApprovalCardView; isNew?: boolean }) {
  const openSettings = useUi((s) => s.openSettings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Only the host may settle a card. STALE_APPROVAL means the host no longer knows this approval,
  // so it really is gone; every other failure is transient and must leave the card answerable.
  const [stale, setStale] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // A new status from the host supersedes whatever went wrong last time.
  useEffect(() => { setErr(null); }, [a.status]);
  const choose = async (choice: ApprovalChoice) => {
    setBusy(true);
    setErr(null);
    try {
      await call("resolveAutoReviewApproval", { id: botId, approvalId: a.approvalId, choice });
    } catch (e) {
      if (e instanceof GatewayCallError && e.code === "STALE_APPROVAL") setStale(true);
      else setErr(e instanceof GatewayCallError ? e.message : COULD_NOT_SEND);
    } finally {
      setBusy(false);
    }
  };

  if (a.status !== "pending" || stale) {
    const status = stale ? "expired" : a.status;
    const label = status === "expired" ? "Expired approval" : status === "denied" ? "Denied action" : "Approved action";
    return (
      <section aria-label={label} className={`card settled${newFlag(isNew)}`}>
        <div className="card-head">
          <span className="card-title">{STR.settledTitle[status]}</span>
          <span className="status-chip"><span className={`dot ${status}`} />{STR.settledLabel[status]}</span>
        </div>
        <div className="card-body">{a.summary}</div>
        {a.ruleAddedText && <div className="card-note">{a.ruleAddedText}</div>}
        <button type="button" className="card-link" onClick={() => setSheet(true)}>{STR.viewFullRequest}</button>
        <div className="card-foot">{STR.manageAutoReviewIn} <button type="button" className="inline-link" onClick={() => openSettings("auto-review")}>{STR.settings}</button></div>
        {sheet && <FullRequestSheet approval={a} onClose={() => setSheet(false)} />}
      </section>
    );
  }

  const batch = a.items.length > 1;
  const shown = expanded ? a.items : a.items.slice(0, 2);
  return (
    <section aria-label="Approval needed" className={`${batch ? "card pending batch" : "card pending"}${newFlag(isNew)}`}>
      {batch ? (
        <>
          <div className="card-subtitle">{a.title}</div>
          <div className="card-items">
            {shown.map((i) => <span key={i.toolUseId}>{i.summary}</span>)}
            {!expanded && a.items.length > 2 && <button type="button" className="inline-link muted" onClick={() => setExpanded(true)}>{STR.andMore(a.items.length - 2)}</button>}
          </div>
        </>
      ) : (
        <>
          <div className="card-head"><span className="card-title">{a.title}</span></div>
          <div className="card-body">{a.reason}</div>
          {a.locationLine && <div className="card-loc"><ServerIcon /> {a.locationLine}</div>}
          {a.details && (
            <details open className="card-details">
              <summary>{STR.details}</summary>
              <div className="mono">{a.details}</div>
            </details>
          )}
        </>
      )}
      {err && <div role="alert" className="card-error">{err}</div>}
      <div className="card-actions">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void choose("once")}>{STR.allowOnce}</button>
        {a.hasProposedRule && <button type="button" className="btn-outline" disabled={busy} onClick={() => void choose("always")}>{STR.alwaysAllow}</button>}
        <button type="button" className="btn-outline" disabled={busy} onClick={() => void choose("deny")}>{STR.deny}</button>
      </div>
    </section>
  );
}
