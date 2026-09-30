import { useEffect, useState } from "react";
import { STR, STRF, STRO, STRSH } from "@synapse/shared";
import { openFeedback } from "../../feedback/store";
import { nativeCall, onNative } from "../../native";
import { confirmCopy } from "../../toast";
import { useMacDisk } from "../MacDiskBanner";
import { SavedSwitch, useSavedNativeSwitch } from "../SavedSwitch";
import { registerSectionBlock } from "./sections";

interface Report { id: string; at: number; kind: string; message: string; appVersion: string; hostVersion: string | null; count: number; seen: boolean }

/** Settings → Diagnostics: recent problems, each with Copy report and Show in Finder (a redacted zip). Local only. */
export function DiagnosticsSection() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void nativeCall<{ reports: Report[] }>("crashes.list").then((r) => setReports(r.reports), (e: Error) => setError(e.message));
    load();
    void nativeCall("crashes.markSeen").catch(() => {});
    return onNative("crashes", load);
  }, []);
  const act = (name: string, id: string, after?: () => void) => void nativeCall(name, { id }).then(() => after?.(), (e: Error) => setError(e.message));
  return (
    <div className="updates">
      <h3>{STRO.diagnostics}</h3>
      
      <div className="settings-card">
        {reports === null ? <span className="muted">{STR.loading}</span> : reports.length === 0 ? <span className="muted">{STRO.noProblems}</span> : reports.map((r) => (
          <div key={r.id} className="settings-row">
            <span style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <span>{STRO.kind[r.kind] ?? r.kind}{r.count > 1 ? ` ×${r.count}` : ""}</span>
              <span className="muted small">{new Date(r.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {r.message}</span>
            </span>
            <button type="button" className="btn-outline small" onClick={() => act("crashes.copy", r.id, () => confirmCopy(STRO.reportCopied))}>{STRO.copyReport}</button>
            <button type="button" className="btn-outline small" onClick={() => act("crashes.reveal", r.id)}>{STRO.revealReport}</button>
            <button type="button" className="btn-outline small" onClick={() => void openFeedback({ type: "bug", crash: r.id })}>{STRF.sendReport}</button>
          </div>
        ))}
      </div>
      {error && <div className="error small" role="alert">{error}</div>}
      <StorageCard />
      <DeveloperTools />
    </div>
  );
}

/** Bot sharing: the owner's advanced actions (a Bot menu's Export for website). Off by default. */
function DeveloperTools() {
  const [err, setErr] = useState<string | null>(null);
  const sw = useSavedNativeSwitch("devTools.get", "devTools.set", setErr);
  return (
    <div className="settings-card">
      <div className="settings-row">
        <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span>{STRSH.showDeveloperTools}</span>{err && <span className="error" role="alert">{err}</span>}</span>
        <SavedSwitch label={STRSH.showDeveloperTools} {...sw} onToggle={sw.toggle} />
      </div>
    </div>
  );
}

/** bug-log 128: free space on this Mac and on the box, from the main process's 10-minute check. */
function StorageCard() {
  const v = useMacDisk();
  const row = (label: string, bytes: number | null | undefined) => (
    <div className="settings-row">
      <span style={{ flexGrow: 1 }}>{label}</span>
      <span className="muted">{typeof bytes === "number" ? STRO.gbFree(bytes) : STRO.notKnownYet}</span>
    </div>
  );
  return (
    <>
      <h3>{STRO.storage}</h3>
      <div className="settings-card">
        {row(STRO.thisMac, v?.freeBytes)}
        {row(STRO.synapseComputer, v?.boxFreeBytes)}
      </div>
    </>
  );
}

registerSectionBlock("system", "diagnostics", 20, DiagnosticsSection);
