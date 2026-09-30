import { useEffect, useState } from "react";
import { STR, STR_RULES, type ApprovalCardView, type ApprovalChoice } from "@synapse/shared";
import { call, GatewayCallError } from "../bridge";
import { useUi } from "../store";
import { FullRequestSheet } from "./FullRequestSheet";
import { ServerIcon } from "./Icons";
import { newFlag } from "../is-new";

/** Shown when the answer never reached the host — the approval is still live, so the card stays answerable. */
const COULD_NOT_SEND = "Couldn't send your answer. Check your connection and try again.";

export function ApprovalCard({ botId, approval: a, isNew = false }: { botId: string; approval: ApprovalCardView; isNew?: boolean }) {
  const botName = useUi((s) => s.bots[botId]?.profile.name);
  const openSettings = useUi((s) => s.openSettings);
  // New-user walk, finding 20: the card names the Bot ("Scout would like…"), not "Your Bot".
  const named = (t: string) => (botName ? t.replace(/^Your Bot\b/, botName) : t);
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
    const label = status === "expired" ? "Expired approval" : status === "stopped" ? "Stopped action" : status === "denied" ? "Denied action" : "Approved action";
    // New-user walk, finding 20: a settled card collapses to one row under its step — the outcome chip, what it was,
    // and the full request — with no title, no box of its own and no Settings footer.
    return (
      <section aria-label={label} className={`approval-settled${newFlag(isNew)}`}>
        <span className="status-chip"><span className={`dot ${status}`} />{STR.settledLabel[status]}</span>
        <span className="approval-settled-what">{a.summary}</span>
        <button type="button" className="link-btn" aria-label={STR.viewFullRequestLabel} onClick={() => setSheet(true)}>{STR.details}</button>
        {a.ruleAddedText && <span className="approval-settled-note">{a.ruleAddedText}</span>}
        {sheet && <FullRequestSheet approval={a} onClose={() => setSheet(false)} />}
      </section>
    );
  }

  const batch = a.items.length > 1;
  const shown = expanded ? a.items : a.items.slice(0, 2);
  return (
    <section aria-label="Approval needed" className={`${batch ? "card pending batch" : "card pending"}${newFlag(isNew)}`}>
      {a.planSteps?.length ? (
        <>
          <div className="card-head"><span className="card-title">{named(a.title)}</span></div>
          <ol className="card-items plan-steps">
            {a.planSteps.map((line, i) => <li key={i}>{line.replace(/^\d+\.\s*/, "")}</li>)}
          </ol>
        </>
      ) : batch ? (
        <>
          <div className="card-subtitle">{named(a.title)}</div>
          <div className="card-items">
            {shown.map((i) => <span key={i.toolUseId}>{i.summary}</span>)}
            {!expanded && a.items.length > 2 && <button type="button" className="inline-link muted" onClick={() => setExpanded(true)}>{STR.andMore(a.items.length - 2)}</button>}
          </div>
        </>
      ) : (
        <>
          <div className="card-head"><span className="card-title">{named(a.title)}</span></div>
          {/* New-user walk, finding 20: no explanatory subtitle (the reason is in the full request) and no
              box-in-a-box disclosure: the command itself, on the card. */}
          {a.details && <div className="mono card-command">{a.details}</div>}
          {a.locationLine && <div className="card-loc"><ServerIcon /> {a.locationLine}</div>}
        </>
      )}
      {/* Safety v2: the card names the rule that raised it (a label, not a subtitle). */}
      {a.trigger?.kind === "rule" && <div className="card-rule"><b>{STR_RULES.cardRule}</b>{a.trigger.label}</div>}
      {err && <div role="alert" className="card-error">{err}</div>}
      <div className="card-actions">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void choose("once")}>{a.planSteps?.length ? STR.approve : STR.allowOnce}</button>
        {a.hasProposedRule && <button type="button" className="btn-outline" disabled={busy} onClick={() => void choose("always")}>{STR.alwaysAllow}</button>}
        <button type="button" className="btn-outline" disabled={busy} onClick={() => void choose("deny")}>{STR.deny}</button>
        <span className="grow" />
        {a.suggestedRule !== undefined && !a.planSteps?.length && (
          <button type="button" className="link-btn" onClick={() => openSettings(a.suggestedRule ? `auto-review/add:${encodeURIComponent(a.suggestedRule)}` : "auto-review")}>{STR_RULES.makeRule}</button>
        )}
        {a.trigger?.kind === "rule" && a.trigger.ruleId && (
          <button type="button" className="link-btn" onClick={() => openSettings(`auto-review/rule:${a.trigger!.ruleId}`)}>{STR_RULES.loosenRule}</button>
        )}
        <button type="button" className="link-btn" aria-label={STR.viewFullRequestLabel} onClick={() => setSheet(true)}>{STR.details}</button>
      </div>
      {sheet && <FullRequestSheet approval={a} onClose={() => setSheet(false)} />}
    </section>
  );
}
