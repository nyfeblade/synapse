import { useEffect, useState } from "react";
import { create } from "zustand";
import { STRF } from "@synapse/shared";
import { Dialog } from "../components/Dialog";
import { CloseIcon } from "../components/Icons";
import { nativeCall, onNative } from "../native";

/**
 * Your feedback: each private send as a conversation with Synapse's replies, and a reply box.
 * Main keeps the thread codes; this screen only ever sees a short id per thread.
 */
export interface ThreadMessage { from: "you" | "synapse"; text: string; at: string | null }
export interface ThreadView { id: string; sentAt: number; status: "open" | "closed"; messages: ThreadMessage[]; unread: number }
interface State { open: boolean; threads: ThreadView[] | null; unread: number }
export const useThreads = create<State>(() => ({ open: false, threads: null, unread: 0 }));

type List = { threads: ThreadView[]; unread: number };
const accept = (r: List) => useThreads.setState({ threads: r.threads, unread: r.unread });

export async function loadThreads(): Promise<void> {
  try { accept(await nativeCall<List>("feedback.threads.list")); } catch { /* no bridge */ }
}

/** Opens the screen: shows what's stored at once, checks for new replies, and marks them seen. */
export function openThreads(): void {
  useThreads.setState({ open: true });
  void loadThreads().then(async () => {
    try { accept(await nativeCall<List>("feedback.threads.refresh")); } catch { /* offline: what's stored */ }
    await nativeCall("feedback.threads.markSeen").catch(() => {});
    useThreads.setState({ unread: 0 });
  });
}
export const closeThreads = () => useThreads.setState({ open: false });

/** The quiet notice for a new reply: one element, replaced rather than stacked; View opens the screen. */
let live: HTMLElement | null = null;
export function showReplyNotice(): void {
  live?.remove();
  const el = document.createElement("div");
  el.className = "link-copied feedback-notice";
  el.setAttribute("role", "status");
  el.append(document.createTextNode(`${STRF.replyNotice} · `));
  const view = document.createElement("button");
  view.type = "button";
  view.className = "crash-toast-view";
  view.textContent = STRF.view;
  view.addEventListener("click", () => { el.remove(); live = null; openThreads(); });
  el.append(view);
  document.body.appendChild(el);
  live = el;
  window.setTimeout(() => { if (live === el) { el.remove(); live = null; } }, 10_000);
}

/** Mounted once: listens for replies and draws the screen when open. */
export function FeedbackThreadsHost() {
  const open = useThreads((s) => s.open);
  useEffect(() => onNative<{ unread: number }>("feedback-reply", (p) => { useThreads.setState({ unread: p?.unread ?? 1 }); showReplyNotice(); }), []);
  return open ? <FeedbackThreads /> : null;
}

const when = (t: number | string | null) => (t === null ? "" : new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));

export function FeedbackThreads() {
  const threads = useThreads((s) => s.threads);
  return (
    <Dialog label={STRF.yourFeedback} onClose={closeThreads} className="sheet feedback-sheet feedback-threads">
      <div className="sheet-head">
        <h2 className="feedback-title">{STRF.yourFeedback}</h2>
        <button type="button" className="icon-btn" aria-label={STRF.close} onClick={closeThreads}><CloseIcon /></button>
      </div>
      {threads === null ? <p className="muted small">{STRF.loading}</p>
        : threads.length === 0 ? <p className="muted small">{STRF.noThreads}</p>
        : threads.map((t) => <Thread key={t.id} t={t} />)}
    </Dialog>
  );
}

function Thread({ t }: { t: ThreadView }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    void nativeCall<List>("feedback.threads.reply", { id: t.id, message: text }).then((r) => { accept(r); setText(""); }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <section className="feedback-thread" aria-label={STRF.sentOn(when(t.sentAt))}>
      <div className="feedback-thread-top">
        <p className="feedback-thread-head muted small">{STRF.sentOn(when(t.sentAt))}{t.status === "closed" ? ` · ${STRF.closed}` : ""}</p>
        <CopyLink id={t.id} onError={setError} />
      </div>
      <ol className="feedback-msgs">
        {t.messages.map((m, i) => (
          <li key={i} className={`feedback-msg ${m.from}`}>
            <span className="feedback-msg-from small">{m.from === "synapse" ? STRF.synapse : STRF.you}{m.at ? ` · ${when(m.at)}` : ""}</span>
            <span className="feedback-msg-text">{m.text}</span>
          </li>
        ))}
      </ol>
      <div className="feedback-reply">
        <div className="field">
          <textarea aria-label={STRF.replyLabel} placeholder={STRF.replyLabel} rows={2} maxLength={5000} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <button type="button" className="btn-primary" disabled={busy || !text.trim()} onClick={send}>{STRF.send}</button>
      </div>
      {error && <div className="error small" role="alert">{error}</div>}
      <p className="feedback-thread-foot muted small">{STRF.linkHint}</p>
    </section>
  );
}

/** Copy link: main writes the page's link (with the thread's code) straight to the clipboard; the code never comes here. */
function CopyLink({ id, onError }: { id: string; onError(e: string | null): void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const h = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(h);
  }, [copied]);
  const copy = () => {
    onError(null);
    void nativeCall("feedback.threads.link", { id }).then(() => setCopied(true), (e: Error) => onError(e.message));
  };
  return <button type="button" className="btn-outline small" onClick={copy}>{copied ? STRF.copied : STRF.copyLink}</button>;
}
