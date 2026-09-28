import { STR, STRC, STR_SETUP } from "@synapse/shared";
import { nativeCall, onNative } from "../native";
import { askConfirm } from "./ConfirmDialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { registerUpdatesBlock } from "./settings/UpdatesSection";
import { useComputer } from "../computer-state";

/** Phase 3 box updates (CMP-11/12). Inside Phase 5's Settings → Updates it renders as a block under the app's own
 *  update card (heading off); standalone it keeps its own heading. */
export function UpdatesSection({ heading = true }: { heading?: boolean } = {}) {
  const boxStatus = useComputer((s) => s.box);
  const [bundled, setBundled] = useState<string | null>(null);
  const [busy, setBusy] = useState<string[] | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [alsoBots, setAlsoBots] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fix round 1: the background box update shares one lock with Update; while it runs, Update is off, and a
  // failure shows here once, with Retry.
  const [boxUpdate, setBoxUpdate] = useState<{ phase: string; message?: string } | null>(null);
  const [boxBusy, setBoxBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!window.synapse?.native) return; // a host page without the native bridge (tests of the card alone)
    void nativeCall<{ status: { phase: string; message?: string } | null; busyWith: string | null }>("boxUpdate.status").then((r) => { setBoxUpdate(r?.status ?? null); setBoxBusy(r?.busyWith ?? null); }).catch(() => {});
    return onNative<{ phase: string; message?: string }>("box-update", (u) => { setBoxUpdate(u); setBoxBusy(u.phase === "waiting" || u.phase === "running" ? "re-provision" : null); });
  }, []);
  const reprovisioning = boxBusy === "re-provision";
  useEffect(() => { void window.synapse.box.info().then((i) => setBundled(i.bundledImageVersion), (e: Error) => setError(e.message)); }, []);
  const latest = bundled !== null && boxStatus?.imageVersion === bundled;
  const backupNotReady = boxStatus != null && !boxStatus.backupReady;
  const run = async (force: boolean, confirmed = false) => {
    setError(null);
    // A named confirm: Update rebuilds the machine (the data is backed up and put back).
    if (!confirmed && !(await askConfirm({ title: STR_SETUP.rebuildTitle, line: STR_SETUP.rebuildLine, verb: STR_SETUP.rebuildVerb }))) return;
    try {
      const r = await window.synapse.box.update(force);
      setBusy(r.status === "busy" ? (r.busyBotIds ?? []) : null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Hand-testing round: the poll behind "Update once agents finish" used to live in a local
  // `const t` with no cleanup, so closing Settings (App.tsx renders `{settingsOpen && <SettingsModal/>}`)
  // or switching section unmounted the card while the interval kept running — and the next time the
  // agents went idle it recreated the whole box with nothing on screen to cancel it. The handle now
  // lives in a ref the unmount cleanup clears, the card shows a waiting row while it polls, and
  // Cancel stops it.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopWaiting = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    setWaiting(false);
  }, []);
  useEffect(() => () => { if (timer.current !== null) clearInterval(timer.current); timer.current = null; }, []);
  const waitThenUpdate = () => {
    if (timer.current !== null) return; // a second click must not start a second poll
    setWaiting(true);
    timer.current = setInterval(() => {
      if ((useComputer.getState().box?.busyBotIds.length ?? 0) !== 0) return;
      stopWaiting();
      void run(false, true);
    }, 5000);
  };
  const doReset = async () => {
    if (resetting) return;
    setError(null);
    setResetting(true);
    try {
      await window.synapse.box.reset(alsoBots);
      setConfirmReset(false);
      setResetDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResetting(false);
    }
  };
  return (
    <div className="updates">
      {heading && <h2>{STRC.updatesNav}</h2>}
      <div className="settings-card">
        <h3>{STRC.updateTitle}</h3>
        <p className="muted">{STRC.updateHelp}</p>
        {reprovisioning && <span className="muted" role="status">{STR_SETUP.boxUpdating}</span>}
        {!reprovisioning && boxUpdate?.phase === "failed" && (
          <div className="row-actions">
            <span className="error" role="alert">{STR_SETUP.boxUpdateFailed}{boxUpdate.message ? `: ${boxUpdate.message.slice(0, 200)}` : ""}</span>
            <button type="button" className="btn-outline" onClick={() => void nativeCall("boxUpdate.retry").then(() => { setBoxUpdate(null); setBoxBusy("re-provision"); }, (e: Error) => setError(e.message))}>{STR_SETUP.retry}</button>
          </div>
        )}
        {backupNotReady ? (
          <div className="status-box">{STRC.backupNotReady}</div>
        ) : latest ? (
          <div className="status-box">{STRC.onLatest}</div>
        ) : busy ? (
          waiting ? (
            <div className="row-actions">
              <span className="muted" role="status">{STRC.waitingForAgents}</span>
              <button type="button" className="btn-outline" onClick={stopWaiting}>{STR.cancel}</button>
            </div>
          ) : (
            <div className="row-actions">
              <span className="muted">{STRC.agentBusy}</span>
              <button type="button" className="btn-outline" onClick={waitThenUpdate}>{STRC.updateWhenDone}</button>
              <button type="button" className="btn-primary" disabled={reprovisioning} onClick={() => void run(true, true)}>{STRC.updateAnyway}</button>
            </div>
          )
        ) : (
          <button type="button" className="btn-primary" disabled={bundled === null || reprovisioning} onClick={() => void run(false)}>{STRC.update}</button>
        )}
      </div>
      <div className="settings-card">
        <h3>{STRC.resetTitle}</h3>
        <p className="muted">{STRC.resetHelp}</p>
        {confirmReset ? (
          <div className="row-actions">
            <label className="check"><input type="checkbox" checked={alsoBots} onChange={(e) => setAlsoBots(e.target.checked)} />{STRC.alsoRestoreBots}</label>
            <button type="button" className="btn-danger" disabled={resetting} onClick={() => void doReset()}>{STRC.resetConfirm}</button>
            <button type="button" className="btn-outline" disabled={resetting} onClick={() => setConfirmReset(false)}>{STR.cancel}</button>
          </div>
        ) : (
          <>
            {/* Hand-testing round: the armed red confirmation used to stay on screen after a
                successful reset, with nothing saying it ran — so the obvious next click fired a
                genuine second reset over the freshly restored box. */}
            {resetDone && <div className="status-box" role="status">{STRC.resetDone}</div>}
            <button type="button" className="btn-danger" disabled={backupNotReady} onClick={() => { setResetDone(false); setConfirmReset(true); }}>{STRC.resetButton}</button>
          </>
        )}
      </div>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

registerUpdatesBlock("box", 10, () => <UpdatesSection heading={false} />);
