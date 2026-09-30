import { useEffect } from "react";
import { create } from "zustand";
import { STR } from "@synapse/shared";
import { Dialog } from "./Dialog";

/**
 * The one confirm for destructive actions (UI polish pass, brief 2). It replaces `window.confirm`,
 * whose "OK" says nothing about what happens: here the button names the act ("Delete", "Remove",
 * "Reset"), and Cancel — which takes focus first, and is what Escape and a click outside mean —
 * leaves everything exactly as it was.
 *
 *   if (await askConfirm({ title: "Delete Scout?", verb: "Delete" })) void deleteBot(id);
 *
 * A surface rendered on its own (a unit test, a window without the app shell) has no host mounted;
 * there, and only there, the question falls back to the platform's confirm so it is never skipped.
 */
/** `tone: "neutral"`: a confirm that restores or allows rather than destroys (Undo) commits with the app's neutral
 *  primary button, like Allow once or Save; the default stays the danger button. */
interface Ask { title: string; line?: string; verb: string; tone?: "danger" | "neutral"; resolve(ok: boolean): void }
const useConfirm = create<{ ask: Ask | null; hosts: number }>(() => ({ ask: null, hosts: 0 }));

export function askConfirm(opts: { title: string; line?: string; verb: string; tone?: "danger" | "neutral" }): Promise<boolean> {
  if (useConfirm.getState().hosts === 0) return Promise.resolve(window.confirm(opts.line ? `${opts.title}\n\n${opts.line}` : opts.title));
  return new Promise((resolve) => {
    useConfirm.getState().ask?.resolve(false); // a second ask never strands the first
    useConfirm.setState({ ask: { ...opts, resolve } });
  });
}

export function ConfirmHost() {
  const ask = useConfirm((s) => s.ask);
  useEffect(() => {
    useConfirm.setState((s) => ({ hosts: s.hosts + 1 }));
    return () => useConfirm.setState((s) => ({ hosts: s.hosts - 1 }));
  }, []);
  if (!ask) return null;
  const settle = (ok: boolean) => { useConfirm.setState({ ask: null }); ask.resolve(ok); };
  return (
    <Dialog label={ask.title} onClose={() => settle(false)} className="modal confirm-dialog">
      <div className="confirm-body">
        <h2 className="confirm-title">{ask.title}</h2>
        {ask.line ? <p className="confirm-line">{ask.line}</p> : null}
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" onClick={() => settle(false)}>{STR.cancel}</button>
          <button type="button" className={ask.tone === "neutral" ? "btn-primary" : "btn-danger"} onClick={() => settle(true)}>{ask.verb}</button>
        </div>
      </div>
    </Dialog>
  );
}
