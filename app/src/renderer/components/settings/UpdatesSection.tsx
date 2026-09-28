import { useCallback, useEffect, useState, type ComponentType } from "react";
import { STR, STR5, STRO } from "@synapse/shared";
import { nativeCall } from "../../native";
import { registerAccountItem } from "../account-menu";
import { useUi } from "../../store";
import { registerSectionBlock } from "./sections";
import { startUpdatesSync, useUpdates, type UpdateState } from "../../updates/store";
import { UpdatesFields } from "../../firstrun/SetupScreen";
import { useSetupGate } from "../../firstrun/store";
import { STR_SETUP } from "@synapse/shared";

const blocks: { id: string; order: number; Component: ComponentType }[] = [];
export function registerUpdatesBlock(id: string, order: number, Component: ComponentType): void {
  blocks.splice(0, blocks.length, ...blocks.filter((b) => b.id !== id), { id, order, Component });
  blocks.sort((a, b) => a.order - b.order);
}

/** P5 review I7: the private update source (owner/repo) and its token (portable install: the profile's update-source.json, not the keychain).
 *  Hand-testing round: the field used to start empty and never subscribe to the store, so a saved
 *  feed was invisible and a mistyped one could not be removed (an empty feed disabled Save, and
 *  `save()` stripped it from the payload). It now shows what is stored, and an explicit edit —
 *  including clearing the field — is what enables Save and is what gets sent. */
function UpdateSource({ stored }: { stored: string }) {
  const [feed, setFeed] = useState(stored);
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setFeed(stored); }, [stored]);
  useEffect(() => { void nativeCall<{ hasToken: boolean }>("updates.source").then((s) => setHasToken(s.hasToken)).catch(() => {}); }, []);
  const save = async () => {
    setMsg(null);
    try {
      // `feed` always goes in the payload — it used to be stripped when empty, which is exactly
      // the case where the user is trying to remove a mistyped source.
      const st = await nativeCall<UpdateState>("updates.setSource", { feed: feed.trim(), ...(token ? { token } : {}) });
      useUpdates.setState({ state: st });
      if (token) setHasToken(true);
      setToken("");
      setMsg(STR5.updateSourceSaved);
    } catch (e) { setMsg((e as Error).message); }
  };
  // Portable install: "Updates from GitHub" — the repo, a read-only token (stored in the profile, encrypted,
  // never the keychain) and a link to create one; the same fields as the setup screen.
  return <UpdatesFields feed={feed} setFeed={(v) => { setFeed(v); setMsg(null); }} token={token} setToken={(v) => { setToken(v); setMsg(null); }} hasToken={hasToken} msg={msg} save={() => void save()} idPrefix="update" />;
}

/** The local release folder: checked before the GitHub feed (docs/release.md). */
function ReleaseFolder() {
  const [f, setF] = useState<{ folder: string | null; defaultFolder: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = (name: string) => void nativeCall<{ folder: string | null; defaultFolder: string }>(name).then(setF, (e: Error) => setErr(e.message));
  useEffect(() => run("updates.folder"), []);
  if (!f) return null;
  return (
    <div className="settings-card">
      <div className="settings-row">
        <span style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <span>{STRO.releaseFolder}</span>
          <span className="muted small" title={f.folder ?? ""} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.folder}</span>
        </span>
        {f.folder !== f.defaultFolder && <button type="button" className="btn-outline small" onClick={() => run("updates.resetFolder")}>{STRO.useDefaultFolder}</button>}
        <button type="button" className="btn-outline small" onClick={() => run("updates.chooseFolder")}>{STRO.changeFolder}</button>
      </div>
      {err && <span className="error small">{err}</span>}
    </div>
  );
}

/** Every status `UpdateService` can emit gets a line. Without this the shipped default (`no-feed`
 *  — no source configured, or an unpackaged build) made "Check for Updates" a button that changed
 *  nothing at all on screen. */
function StatusLine({ s }: { s: UpdateState }) {
  if (s.status === "ready" && s.latest) return <span className="muted">{STR5.updateReady(s.latest)}</span>;
  if (s.status === "none") return <span className="muted">{STR5.upToDate}</span>;
  if (s.status === "no-feed") return <span className="muted">{STR5.noUpdateSource}</span>;
  if (s.status === "checking") return <span className="muted">{STR5.checking}</span>;
  if (s.status === "downloading" || s.status === "available") return <span className="muted">{STR5.downloading}</span>;
  return null;
}

export function UpdatesSection() {
  const s = useUpdates((st) => st.state);
  const [error, setError] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  // Hand-testing round: this load used to be a bare `void ...then(...)`, so a rejection (Settings
  // opens while the box is restarting) became an unhandled rejection and the section rendered as a
  // heading over nothing — indistinguishable from "still loading".
  const load = useCallback(() => {
    setError(null);
    void nativeCall<UpdateState>("updates.get").then((v) => useUpdates.setState({ state: v }), (e: Error) => setError(e.message));
  }, []);
  useEffect(() => { startUpdatesSync(); load(); }, [load]);
  if (!s) {
    return (
      <>
        <h3>{STR5.updates}</h3>
        {error ? (
          <div className="settings-card">
            <span className="error" role="alert">{error}</span>
            <button type="button" className="btn-outline small" onClick={load}>{STR.retry}</button>
          </div>
        ) : <span className="muted">{STR.loading}</span>}
      </>
    );
  }
  const downloading = s.status === "downloading" || s.status === "available";
  return (
    <>
      {/* UI polish pass (brief 2): two labelled groups of at most seven controls — the app itself, then
          where releases come from — instead of one "App" block holding both. */}
      <h3>{STR5.updates}</h3>
      <div className="settings-card">
        <div className="settings-row"><label htmlFor="update-track" style={{ flexGrow: 1 }}>{STR5.updateTrack}</label>
          <select id="update-track" className="dropdown" value="stable" onChange={() => {}}><option value="stable">{STR5.stable}</option></select></div>
        <div className="settings-row"><span style={{ flexGrow: 1 }}>{STR5.automaticUpdates}</span>
          <button type="button" role="switch" aria-checked={s.auto} aria-label={STR5.automaticUpdates} className={s.auto ? "switch on" : "switch"}
            // settings-persist: this save had no failure path at all — a refused write was a click that did nothing.
            onClick={() => { setAutoError(null); void nativeCall<UpdateState>("updates.setAuto", { on: !s.auto }).then((v) => useUpdates.setState({ state: v }), () => setAutoError(STR.settingNotSaved)); }} />
          {autoError && <span className="error" role="alert">{autoError}</span>}</div>
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <span>{STR5.version(s.version)}</span>
            <StatusLine s={s} />
            {s.error && <span className="error">{s.error}</span>}
          </span>
          {s.status === "ready"
            ? <button type="button" className="btn-primary" onClick={() => void nativeCall("updates.restart")}>{STR5.restartToUpdate}</button>
            : <button type="button" className="btn-outline small" disabled={s.status === "checking" || downloading} onClick={() => void nativeCall<UpdateState>("updates.check").then((v) => useUpdates.setState({ state: v }))}>{s.status === "checking" ? STR5.checking : downloading ? STR5.downloading : STR5.checkForUpdates}</button>}
        </div>
      </div>
      <h3>{STRO.releaseSource}</h3>
      <ReleaseFolder />
      <UpdateSource stored={s.feed ?? ""} />
      {blocks.map(({ id, Component }) => <Component key={id} />)}
    </>
  );
}

registerSectionBlock("system", "updates", 0, UpdatesSection);

/** Portable install: Settings → System → Setup reopens the first-run setup screen over the app. */
function SetupBlock() {
  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="grow">{STR_SETUP.settingsRow}</span>
        <button type="button" className="btn-outline small" onClick={() => { useUi.getState().closeSettings(); useSetupGate.getState().reopen(); }}>{STR_SETUP.open}</button>
      </div>
    </div>
  );
}
registerSectionBlock("system", "setup", 5, SetupBlock);
// Reads the live store (kept fresh by startUpdatesSync, module-scope — see updates/store.ts)
// instead of a render-local variable, so this reflects a background update even when Settings →
// Updates was never mounted (Fix round 1, finding 2 / UI-03).
registerAccountItem("update", 10, () => {
  const st = useUpdates.getState().state;
  return st?.status === "ready" && st.latest ? { label: STR5.newUpdate, onSelect: () => useUi.getState().openSettings("updates") } : null;
});
