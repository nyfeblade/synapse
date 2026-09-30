import { useEffect, useState } from "react";
import { STR, STR_KEY_STEP, STR_PROVIDER_UI, type SafetyReviewerView } from "@synapse/shared";
import { callQuiet } from "../../bridge";
import { subscribeChannel } from "../../feature-store";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^[A-Z_]+: /, "") || STR.hostNoAnswer;

/**
 * Settings → Auto-review → Safety reviewer (spec §7a, §10): which model reviews, whether it may decide on its own
 * (Qualified), asks you for everything it would decide (Ask-only), or hasn't been checked, and the check itself.
 * Shown once a model provider is set up; with Claude alone there is nothing to choose.
 */
export function SafetyReviewerBlock() {
  const [v, setV] = useState<SafetyReviewerView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void callQuiet("getSafetyReviewer", {}).then((x) => { if (x && typeof x === "object" && "onClaude" in x) setV(x); }).catch(() => {}); }, []);
  // The check runs in the background on the host; its progress arrives here.
  useEffect(() => subscribeChannel("safety-check", (x) => { if (x && typeof x === "object" && "onClaude" in (x as object)) setV(x as SafetyReviewerView); }), []);
  if (!v || (v.onClaude && (v.choices?.length ?? 0) <= 1)) return null;
  const run = async (fn: () => Promise<SafetyReviewerView>) => {
    setBusy(true);
    setError(null);
    try { setV(await fn()); } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  };
  const state = v.onClaude ? STR_PROVIDER_UI.safetyQualified : v.state === "qualified" ? STR_PROVIDER_UI.safetyQualified : v.state === "ask-only" ? STR_PROVIDER_UI.safetyAskOnly : STR_PROVIDER_UI.safetyNotChecked;
  const current = v.chosen ?? null;
  return (
    <div className="settings-card safety-reviewer" aria-label={STR_PROVIDER_UI.safetyTitle}>
      <h3>{STR_PROVIDER_UI.safetyTitle}</h3>
      <div className="settings-row">
        <label className="grow" htmlFor="safety-model">{STR_PROVIDER_UI.safetyModel}</label>
        <select id="safety-model" className="text-input" value={current ?? ""} disabled={busy}
          onChange={(e) => void run(() => callQuiet("setSafetyReviewer", { ref: e.target.value || null }))}>
          {(v.choices ?? []).map((c) => <option key={c.ref ?? ""} value={c.ref ?? ""}>{c.ref === null ? `${c.label} (${v.onClaude ? STR_PROVIDER_UI.safetyClaude : v.choices?.find((x) => x.ref === v.ref)?.label ?? v.ref ?? ""})` : c.label}</option>)}
        </select>
      </div>
      <div className="settings-row">
        <span className="grow">{STR_PROVIDER_UI.safetyState}</span>
        <span className={`model-badge ${v.state ?? "qualified"}`} role="status">{state}</span>
      </div>
      {/* Any-key setup (rulings 41–42): a reviewer model that hasn't passed the check decides nothing on its own. */}
      {!v.onClaude && v.state !== "qualified" && <p className="muted safety-asks">{STR_KEY_STEP.reviewerAsks}</p>}
      {!v.onClaude && (
        <div className="settings-row">
          {v.job ? (
            <>
              <span className="grow muted" role="progressbar" aria-label={STR_PROVIDER_UI.safetyRunning} aria-valuemin={0} aria-valuemax={v.job.total} aria-valuenow={v.job.done}>{STR_PROVIDER_UI.safetyProgress(v.job.done, v.job.total)}</span>
              <button type="button" className="btn-outline" disabled={busy} onClick={() => void run(() => callQuiet("cancelSafetyCheck", {}))}>{STR_PROVIDER_UI.safetyCancel}</button>
            </>
          ) : (
            <>
              <span className="grow" />
              <button type="button" className="btn-outline" disabled={busy} onClick={() => void run(() => callQuiet("runSafetyCheck", {}))}>{STR_PROVIDER_UI.safetyRun}</button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
