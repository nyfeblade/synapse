import { STRF, STRO } from "@synapse/shared";
import { openFeedback } from "./feedback/store";
import { nativeCall, onNative } from "./native";

/** How long the "recovered" toast stays: long enough to click View, short enough not to nag. */
const VISIBLE_MS = 8000;
let live: HTMLElement | null = null;

/**
 * "Synapse recovered from a problem · View". Imperative like toast.ts (one element, reused
 * .link-copied styling); a second problem replaces the first toast rather than stacking.
 */
export function showRecoveredToast(openDiagnostics: () => void): void {
  live?.remove();
  const el = document.createElement("div");
  el.className = "link-copied crash-toast";
  el.setAttribute("role", "status");
  el.append(document.createTextNode(`${STRO.recoveredToast} · `));
  const view = document.createElement("button");
  view.type = "button";
  view.className = "crash-toast-view";
  view.textContent = STRO.view;
  view.addEventListener("click", () => { el.remove(); live = null; openDiagnostics(); });
  el.append(view);
  // After a crash: send it to us, with its report as the logs (previewed first, like any feedback).
  const report = document.createElement("button");
  report.type = "button";
  report.className = "crash-toast-view";
  report.textContent = STRF.sendReport;
  report.addEventListener("click", () => { el.remove(); live = null; void openFeedback({ type: "bug", crash: "latest" }); });
  el.append(document.createTextNode(" · "), report);
  document.body.appendChild(el);
  live = el;
  window.setTimeout(() => { if (live === el) { el.remove(); live = null; } }, VISIBLE_MS);
}

/**
 * Window errors and unhandled rejections go to the main process's local crash store (Settings →
 * Diagnostics). Nothing leaves the Mac. Also shows the toast for problems recorded while the app
 * runs, and once at start-up for ones from the last session.
 */
export function installRendererErrorReporting(openDiagnostics: () => void): () => void {
  const send = (e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    void nativeCall("crashes.reportRenderer", { message: err.message, stack: err.stack }).catch(() => {});
  };
  const onError = (ev: ErrorEvent) => send(ev.error ?? ev.message);
  const onRejection = (ev: Event) => send((ev as PromiseRejectionEvent).reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  let last = 0;
  const off = onNative<{ unseen: number }>("crashes", (p) => {
    if (p.unseen > last) showRecoveredToast(openDiagnostics);
    last = p.unseen;
  });
  void nativeCall<{ unseen: number }>("crashes.unseen").then((r) => { last = r.unseen; if (r.unseen > 0) showRecoveredToast(openDiagnostics); }, () => {});
  return () => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); off(); };
}
