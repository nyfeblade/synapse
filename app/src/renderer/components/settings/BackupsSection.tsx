import { useCallback, useEffect, useState } from "react";
import { STR, STRO } from "@synapse/shared";
import { nativeCall, onNative } from "../../native";
import { copyWithConfirmation } from "../../toast";
import { registerSectionBlock } from "./sections";

interface Archive { file: string; name: string; createdAt: number; bytes: number; reason: "manual" | "auto" | "pre-restore" }
interface Status { settings: { auto: boolean; keep: number; dir: string }; defaultDir: string; lastAt: number | null; lastError: string | null; running: "backup" | "restore" | null; recoveryPending: boolean; archives: Archive[] }
interface Preview { file: string; createdAt: number; bytes: number; bots: { id: string; name: string }[]; appVersion: string }
interface Outcome { bots: number; verified: boolean; macSecretsSkipped: boolean; hostSealed: "applied" | "skipped" | "none" }

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const KEEP = [3, 7, 14, 30];

/** Settings → Backups: back up now, the daily backup, the folder, the one-time recovery code, restore. */
export function BackupsSection() {
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [needCode, setNeedCode] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(() => {
    void nativeCall<Status>("backups.status").then(setS, (e: Error) => setError(e.message));
    void nativeCall<{ code: string | null }>("backups.recoveryCode").then((r) => setCode(r?.code ?? null), () => {});
  }, []);
  useEffect(() => { load(); return onNative<Status>("backups", setS); }, [load]);

  const act = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try { return await fn(); } catch (e) { setError((e as Error).message); return undefined; }
  };
  const backupNow = async () => {
    setBusy(true);
    await act(() => nativeCall("backups.backupNow"));
    setBusy(false);
    load();
  };
  const setting = (patch: Record<string, unknown>) => void act(() => nativeCall<Status>("backups.setSettings", patch).then(setS));
  const open = async (file: string, recovery?: string) => {
    setTarget(file);
    setPreview(null);
    setOutcome(null);
    setError(null);
    try {
      setPreview(await nativeCall<Preview>("backups.preview", recovery ? { file, code: recovery } : { file }));
      setNeedCode(false);
    } catch (e) {
      const m = (e as Error).message;
      if (/recovery code/i.test(m)) { setNeedCode(true); if (recovery) setError(m); } else setError(m);
    }
  };
  const fromFile = async () => {
    const r = await act(() => nativeCall<{ file: string | null }>("backups.chooseArchive"));
    if (r?.file) await open(r.file);
  };
  const restore = async () => {
    if (!preview) return;
    setRestoring(true);
    const r = await act(() => nativeCall<Outcome>("backups.restore", needCode || codeInput ? { file: preview.file, code: codeInput } : { file: preview.file }));
    setRestoring(false);
    if (r) { setOutcome(r); setPreview(null); setTarget(null); }
    load();
  };
  const cancel = () => { setTarget(null); setPreview(null); setNeedCode(false); setCodeInput(""); };

  if (!s) return (<><h3>{STRO.backups}</h3>{error ? <span className="error" role="alert">{error}</span> : <span className="muted">{STR.loading}</span>}</>);
  return (
    <div className="updates">
      <h3>{STRO.backups}</h3>
      <div className="settings-card">
        <h3>{STRO.backupTitle}</h3>
        
        <div className="row-actions">
          <span className="muted" style={{ flexGrow: 1 }}>{s.lastAt ? STRO.lastBackup(when(s.lastAt)) : STRO.neverBackedUp}</span>
          <button type="button" className="btn-primary" disabled={busy || s.running !== null} onClick={() => void backupNow()}>{busy ? STRO.backingUp : STRO.backupNow}</button>
        </div>
        {s.lastError && !busy && <span className="error small">{s.lastError}</span>}
        <div className="settings-row"><span style={{ flexGrow: 1 }}>{STRO.autoBackup}</span>
          <button type="button" role="switch" aria-checked={s.settings.auto} aria-label={STRO.autoBackup} className={s.settings.auto ? "switch on" : "switch"} onClick={() => setting({ auto: !s.settings.auto })} /></div>
        <div className="settings-row"><label htmlFor="backup-keep" style={{ flexGrow: 1 }}>{STRO.keepLast}</label>
          <select id="backup-keep" className="dropdown" value={s.settings.keep} onChange={(e) => setting({ keep: Number(e.target.value) })}>
            {[...new Set([...KEEP, s.settings.keep])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{STRO.keepN(n)}</option>)}
          </select></div>
        <div className="settings-row">
          <span style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}><span>{STRO.folder}</span><span className="muted small" title={s.settings.dir} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.settings.dir}</span></span>
          {s.settings.dir !== s.defaultDir && <button type="button" className="btn-outline small" onClick={() => setting({ dir: null })}>{STRO.useDefaultFolder}</button>}
          <button type="button" className="btn-outline small" onClick={() => void act(() => nativeCall<Status>("backups.chooseFolder").then(setS))}>{STRO.changeFolder}</button>
        </div>
      </div>
      {code && (
        <div className="settings-card" role="region" aria-label={STRO.recoveryTitle}>
          <h3>{STRO.recoveryTitle}</h3>
          
          <code className="status-box" style={{ userSelect: "all", wordBreak: "break-all" }}>{code}</code>
          <div className="row-actions">
            <button type="button" className="btn-outline small" onClick={() => void copyWithConfirmation(code)}>{STRO.copy}</button>
            <button type="button" className="btn-outline small" onClick={() => void act(() => nativeCall("backups.saveRecoveryCode"))}>{STRO.saveToFile}</button>
            <button type="button" className="btn-primary" onClick={() => void act(() => nativeCall("backups.ackRecoveryCode")).then(() => setCode(null))}>{STRO.savedIt}</button>
          </div>
        </div>
      )}
      {target && (
        <div className="settings-card" role="region" aria-label={STRO.previewTitle}>
          <h3>{STRO.previewTitle}</h3>
          {needCode && !preview && (
            <div className="row-actions">
              <label htmlFor="backup-code" className="muted">{STRO.enterRecoveryCode}</label>
              <input id="backup-code" className="text-input" autoComplete="off" spellCheck={false} placeholder="SYN-…" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} />
              <button type="button" className="btn-outline small" disabled={!codeInput.trim()} onClick={() => void open(target, codeInput.trim())}>{STRO.open}</button>
              <button type="button" className="btn-outline" onClick={cancel}>{STR.cancel}</button>
            </div>
          )}
          {preview && (
            <>
              <span>{STRO.previewMeta(when(preview.createdAt), size(preview.bytes), preview.bots.length)}</span>
              {preview.bots.length > 0 && <span className="muted">{preview.bots.map((b) => b.name).join(", ")}</span>}
              <p className="muted">{STRO.restoreWarning}</p>
              {restoring ? <span className="muted" role="status">{STRO.restoring}</span> : (
                <div className="row-actions">
                  <button type="button" className="btn-danger" onClick={() => void restore()}>{STRO.restoreConfirm}</button>
                  <button type="button" className="btn-outline" onClick={cancel}>{STR.cancel}</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {outcome && (
        <div className="status-box" role="status">
          {STRO.restored(outcome.bots, outcome.verified)}
          {outcome.macSecretsSkipped && <> {STRO.macSecretsSkipped}</>}
          {outcome.hostSealed === "skipped" && <> {STRO.hostSealedSkipped}</>}
        </div>
      )}
      <div className="settings-card">
        <h3>{STRO.archives}</h3>
        {s.archives.length === 0 ? <span className="muted">{STRO.noArchives}</span> : s.archives.map((a) => (
          <div key={a.file} className="settings-row">
            <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
              <span className="muted small">{when(a.createdAt)} · {size(a.bytes)}{a.reason === "pre-restore" ? ` · ${STRO.safetyBackup}` : ""}</span>
            </span>
            <button type="button" className="btn-outline small" onClick={() => void act(() => nativeCall("backups.reveal", { file: a.file }))}>{STRO.reveal}</button>
            <button type="button" className="btn-outline small" disabled={s.running !== null || restoring} onClick={() => void open(a.file)}>{STRO.restore}</button>
          </div>
        ))}
        <div className="row-actions" style={{ padding: "8px 0" }}>
          <button type="button" className="btn-outline small" disabled={s.running !== null || restoring} onClick={() => void fromFile()}>{STRO.restoreFromFile}</button>
        </div>
      </div>
      {error && <div className="error small" role="alert">{error}</div>}
    </div>
  );
}

registerSectionBlock("system", "backups", 10, BackupsSection);
