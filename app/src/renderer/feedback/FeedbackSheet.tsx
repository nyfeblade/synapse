import { useEffect, useMemo, useState } from "react";
import { FEEDBACK_LIMITS, FEEDBACK_TYPES, STRF, cleanMessage, describeHidden, spamReason, type FeedbackType } from "@synapse/shared";
import { Dialog } from "../components/Dialog";
import { CloseIcon } from "../components/Icons";
import { Segmented } from "../components/Segmented";
import { registerAccountItem } from "../components/account-menu";
import { nativeCall, onNative } from "../native";
import { buildPayload, githubIssueUrl, type FeedbackContext } from "./payload";
import { closeFeedback, openFeedback, useFeedback } from "./store";
import { FeedbackThreadsHost, loadThreads, openThreads, useThreads } from "./FeedbackThreads";
import "../styles/feedback.css";

registerAccountItem("feedback", 45, () => ({ label: STRF.sendFeedback, onSelect: () => void openFeedback() }));

const TYPE_OPTIONS = FEEDBACK_TYPES.map((t) => ({ value: t, label: STRF.types[t]! }));

/** Mounted once by the app: the Help menu's Send Feedback… opens it too. */
export function FeedbackHost() {
  const open = useFeedback((s) => s.open);
  useEffect(() => onNative("feedback", () => void openFeedback()), []);
  return <>{open ? <FeedbackSheet /> : null}<FeedbackThreadsHost /></>;
}

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; testMode?: boolean } | { kind: "error"; message: string } | { kind: "posted"; logsCut: boolean };

export function FeedbackSheet() {
  const preset = useFeedback((s) => s.preset);
  const screenshot = useFeedback((s) => s.screenshot);
  const [type, setType] = useState<FeedbackType | null>(preset.type ?? null);
  const [message, setMessage] = useState("");
  const [includeLogs, setIncludeLogs] = useState(!!preset.crash);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [ctx, setCtx] = useState<FeedbackContext | null>(null);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  useEffect(() => {
    let live = true;
    void nativeCall<FeedbackContext>("feedback.context", preset.crash ? { crash: preset.crash } : {}).then((c) => { if (live) setCtx(c); }, (e: Error) => { if (live) setStatus({ kind: "error", message: e.message }); });
    return () => { live = false; };
  }, [preset.crash]);

  const draft = { type, message, includeLogs, includeScreenshot };
  const payload = useMemo(() => buildPayload(draft, ctx, screenshot), [type, message, includeLogs, includeScreenshot, ctx, screenshot]); // eslint-disable-line react-hooks/exhaustive-deps
  const cleaned = cleanMessage(message);
  // The same check the server makes: a message it would refuse says why here, and isn't sent.
  const refused = spamReason(cleaned.text);
  const problem = () => (!type ? STRF.chooseType : !cleaned.text ? STRF.writeMessage : refused || null);
  const hiddenNote = describeHidden(cleaned.found);
  const [zoom, setZoom] = useState(false);

  const sendPrivately = () => {
    const p = problem();
    if (p || !payload) { setStatus({ kind: "error", message: p ?? STRF.loading }); return; }
    setStatus({ kind: "sending" });
    void nativeCall<{ testMode?: boolean }>("feedback.send", payload).then((r) => setStatus({ kind: "sent", testMode: r?.testMode === true }), (e: Error) => setStatus({ kind: "error", message: e.message }));
  };
  const postGithub = () => {
    const p = problem();
    if (p || !payload) { setStatus({ kind: "error", message: p ?? STRF.loading }); return; }
    const { url, logsCut } = githubIssueUrl(payload);
    void nativeCall("feedback.openIssue", { url }).then(() => setStatus({ kind: "posted", logsCut }), (e: Error) => setStatus({ kind: "error", message: e.message }));
  };

  const title = preset.crash ? STRF.sendReport : STRF.sendFeedback;
  const hasThreads = useThreads((s) => (s.threads?.length ?? 0) > 0);
  useEffect(() => { void loadThreads(); }, []);
  return (
    <Dialog label={title} onClose={closeFeedback} className="sheet feedback-sheet">
      <div className="sheet-head">
        <h2 className="feedback-title">{title}</h2>
        <span className="feedback-head-actions">
          {hasThreads && <button type="button" className="btn-compact" onClick={() => { closeFeedback(); openThreads(); }}>{STRF.yourFeedback}</button>}
          <button type="button" className="icon-btn" aria-label={STRF.close} onClick={closeFeedback}><CloseIcon /></button>
        </span>
      </div>
      {status.kind === "sent" ? (
        <div className="feedback-done">
          <p role="status">{status.testMode ? STRF.sentTestMode : STRF.sent}</p>
          <button type="button" className="btn-primary" onClick={closeFeedback}>{STRF.close}</button>
        </div>
      ) : (
        <>
          <Segmented label={STRF.type} value={type} options={TYPE_OPTIONS} onChange={(t) => { setType(t); if (status.kind === "error") setStatus({ kind: "idle" }); }} />
          <div className="field">
            <textarea aria-label={STRF.message} placeholder={STRF.message} rows={5} maxLength={FEEDBACK_LIMITS.message} value={message} onChange={(e) => { setMessage(e.target.value); if (status.kind === "error") setStatus({ kind: "idle" }); }} />
          </div>
          <label className="check">
            <input type="checkbox" checked={includeScreenshot} disabled={!screenshot} onChange={(e) => setIncludeScreenshot(e.target.checked)} />{STRF.screenshot}
          </label>
          {includeScreenshot && screenshot && (
            <button type="button" className="feedback-shot-btn" aria-label={STRF.showScreenshot} onClick={() => setZoom(true)}>
              <img className="feedback-shot" alt="" src={`data:image/png;base64,${screenshot}`} />
            </button>
          )}
          {zoom && screenshot && (
            <Dialog label={STRF.screenshotTitle} onClose={() => setZoom(false)} className="feedback-zoom">
              <button type="button" className="feedback-zoom-close" aria-label={STRF.close} onClick={() => setZoom(false)}>
                <img alt={STRF.screenshotTitle} src={`data:image/png;base64,${screenshot}`} />
              </button>
            </Dialog>
          )}
          <label className="check">
            <input type="checkbox" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} />{STRF.logs}
          </label>
          {includeLogs && <pre className="feedback-logs" aria-label={STRF.logs}>{ctx ? ctx.logs || STRF.noLogs : STRF.loading}</pre>}
          {hiddenNote && <p className="feedback-meta muted small" role="status">{STRF.willHide(hiddenNote)}</p>}
          {refused && <p className="feedback-meta error small">{refused}</p>}
          <p className="feedback-meta muted small" data-testid="feedback-meta">
            {ctx ? `${STRF.app} ${ctx.appVersion} · ${ctx.macos} · ${ctx.model}` : STRF.loading}
          </p>
          <button type="button" className="btn-compact feedback-preview-toggle" aria-expanded={preview} onClick={() => setPreview(!preview)}>{preview ? STRF.hidePreview : STRF.preview}</button>
          {preview && <Preview payload={payload} missing={problem() ?? STRF.loading} />}
          {status.kind === "error" && <div className="error small" role="alert">{status.message}</div>}
          {status.kind === "posted" && status.logsCut && <p className="muted small" role="status">{STRF.githubLogsCut}</p>}
          <div className="feedback-actions">
            <button type="button" className="btn-outline" onClick={postGithub} disabled={status.kind === "sending"}>{STRF.postGithub}</button>
            <button type="button" className="btn-primary" onClick={sendPrivately} disabled={status.kind === "sending"}>{status.kind === "sending" ? STRF.sending : STRF.sendPrivately}</button>
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Every field of the payload, as it will be sent. */
function Preview({ payload, missing }: { payload: ReturnType<typeof buildPayload>; missing: string }) {
  if (!payload) return <section className="feedback-preview" aria-label={STRF.previewTitle}><p className="muted small">{missing}</p></section>;
  return (
    <section className="feedback-preview" aria-label={STRF.previewTitle}>
      <dl className="sheet-list">
        <div><dt>{STRF.type}</dt><dd>{STRF.types[payload.type]}</dd></div>
        <div><dt>{STRF.message}</dt><dd className="feedback-pre">{payload.message}</dd></div>
        <div><dt>{STRF.app}</dt><dd>{payload.appVersion}</dd></div>
        <div><dt>{STRF.macos}</dt><dd>{payload.macos}</dd></div>
        <div><dt>{STRF.mac}</dt><dd>{payload.model}</dd></div>
        <div><dt>{STRF.logs}</dt><dd>{payload.logs ? <pre className="feedback-logs">{payload.logs}</pre> : STRF.noLogs}</dd></div>
        <div><dt>{STRF.screenshot}</dt><dd>{payload.screenshot ? <img className="feedback-shot" alt={STRF.previewTitle} src={`data:image/png;base64,${payload.screenshot}`} /> : STRF.noScreenshot}</dd></div>
      </dl>
    </section>
  );
}
