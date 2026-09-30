import { useCallback, useEffect, useState } from "react";
import { STR, STR5, STRB, type ExecutionPolicy, type LocalComputer } from "@synapse/shared";
import { call } from "../../bridge";
import { nativeCall } from "../../native";
import { BrowserSigninButton } from "../BrowserSigninButton";
import { MacAppsPanel } from "./MacAppsPanel";
import { SavedSwitch, useSavedNativeSwitch } from "../SavedSwitch";
import { askConfirm } from "../ConfirmDialog";
import { registerSettingsSection } from "./sections";

export function ComputerSection() {
  const [c, setC] = useState<LocalComputer | null>(null);
  const [name, setName] = useState("");
  const [routed, setRouted] = useState(0);
  // settings-persist: null until read. It used to start at the default (on) and swallow a failed read.
  const [keepError, setKeepError] = useState<string | null>(null);
  const keep = useSavedNativeSwitch("keepBoxOnQuit.get", "keepBoxOnQuit.set", setKeepError);
  // 0.1.4: Local network (off by default). The box's firewall is the truth; turning it on asks once.
  const [lanError, setLanError] = useState<string | null>(null);
  const lan = useSavedNativeSwitch("localNetwork.get", "localNetwork.set", setLanError);
  const toggleLan = () => {
    if (lan.value) { lan.toggle(); return; }
    void askConfirm({ title: STR5.localNetworkConfirm, verb: STR5.localNetworkAllow }).then((ok) => { if (ok) lan.toggle(); });
  };
  const [error, setError] = useState<string | null>(null);
  // Hand-testing round: this load's rejection was swallowed, so opening Settings -> Computer while
  // the box was down (which this modal's own Update/Reset causes) left a heading over an empty
  // pane, forever, with no error and nothing to retry.
  const load = useCallback(() => {
    setError(null);
    void call("getLocalComputer", {}).then((r) => { setC(r.computer); setName(r.computer.label); }, (e: Error) => setError(e.message));
  }, []);
  // Bug 225: a tampered or unreadable permission key file — nothing can be saved until it is reset.
  const [policyBroken, setPolicyBroken] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const loadPolicy = useCallback(() => {
    void call("getLocalPolicyStatus", {}).then((r) => setPolicyBroken(r?.ok === false ? (r.reason ?? STR5.localPolicyKeyBroken) : null), () => {});
  }, []);
  const resetPolicy = () => {
    setResetting(true);
    setResetError(null);
    void call("resetLocalPolicy", {}).then(
      (r) => { if (!r.ok) setResetError(STR5.localPolicyKeyBroken); loadPolicy(); load(); },
      (e: Error) => setResetError(e.message),
    ).finally(() => setResetting(false));
  };
  useEffect(() => {
    load();
    loadPolicy();
    const poll = () => void call("getNetworkStats", {}).then((r) => setRouted(r.routedThisSession)).catch(() => {});
    poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [load, loadPolicy]);
  const set = async (p: { label?: string; executionPolicy?: ExecutionPolicy; addAutoRunRoot?: string; removeAutoRunRoot?: string }) => { const r = await call("setLocalComputer", p); setC(r.computer); setName(r.computer.label); };
  const addFolder = async () => {
    const r = await nativeCall<{ path: string | null }>("pickFolder", {}).catch(() => ({ path: null }));
    if (r.path) await set({ addAutoRunRoot: r.path });
  };
  if (!c) {
    return (
      <>
        <h2>{STR5.computer}</h2>
        {error ? (
          <div className="settings-card">
            <span className="error" role="alert">{error}</span>
            <button type="button" className="btn-outline small" onClick={load}>{STR.retry}</button>
          </div>
        ) : <span className="muted">{STR.loading}</span>}
      </>
    );
  }
  return (
    <>
      <h2>{STR5.computer}</h2>
      {policyBroken && (
        <div className="settings-card" data-setting="local-policy-reset">
          <div className="settings-row">
            <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="error" role="alert">{policyBroken}</span>
              {resetError && <span className="error">{resetError}</span>}
            </span>
            <button type="button" className="btn-outline small" disabled={resetting} onClick={resetPolicy}>{STR5.resetPermissions}</button>
          </div>
        </div>
      )}
      <h3>{STR5.computers}</h3>
      <div className="settings-card">
        <div className="settings-row"><span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span>{STR5.currentComputer}</span></span></div>
        <div className="settings-row">
          <label htmlFor="computer-name" style={{ flexGrow: 1 }}>{STR5.computerName}</label>
          <input id="computer-name" className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn-outline small" disabled={!name.trim() || name === c.label} onClick={() => void set({ label: name })}>{STR5.save}</button>
        </div>
        <div className="divider" />
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span>{STR5.executionOnThisComputer}</span></span>
          <select className="dropdown" aria-label={STR5.executionOnThisComputer} value={c.executionPolicy} onChange={(e) => void set({ executionPolicy: e.target.value as ExecutionPolicy })}>
            {(["always", "ask", "never"] as const).map((p) => <option key={p} value={p}>{STR5.policyLabel[p]}</option>)}
          </select>
        </div>
        <div className="divider" />
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span>{STR5.keepBoxOnQuit}</span>{keepError && <span className="error" role="alert">{keepError}</span>}</span>
          <SavedSwitch label={STR5.keepBoxOnQuit} {...keep} onToggle={keep.toggle} />
        </div>
      </div>
      <h3>{STR5.autoRunFolders}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <span style={{ flexGrow: 1 }} />
          <button type="button" className="btn-outline small" onClick={() => void addFolder()}>{STR5.addFolder}</button>
        </div>
        {(c.autoRunRoots ?? []).length === 0
          ? <div className="settings-row"><span className="muted">{STR5.noAutoRunFolders}</span></div>
          : (c.autoRunRoots ?? []).map((r) => (
            <div className="settings-row" key={r}>
              <span style={{ flexGrow: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r}>{r}</span>
              <button type="button" className="btn-outline small" aria-label={STR5.removeFolder(r)} onClick={() => void set({ removeAutoRunRoot: r })}>{STR5.remove}</button>
            </div>
          ))}
      </div>
      <MacAppsPanel />
      <h3>{STRB.signinSection}</h3>
      <div className="settings-card" data-setting="browser-signin">
        <div className="settings-row">
          <span style={{ flexGrow: 1 }} />
          <BrowserSigninButton className="btn-outline small" />
        </div>
      </div>
      <h3>{STR5.network}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span>{STR5.routeTraffic}</span><span className="muted">{STR5.networkLocked} {STR5.routed(routed)}</span></span>
          {/* This is a fact about where the box runs, not a control: there's no routing logic behind it (box/route.env
              only pins bind addresses to 127.0.0.1), so it's shown as status, not a switch — a control that can never
              be operated shouldn't be drawn as one. It reads "on" only because the box is local; if the box is ever
              hosted somewhere other than this Mac, this needs real routing enforcement before it's offered as a choice. */}
          <span className="status-chip" role="status" aria-label={`${STR5.routeTraffic}: ${STR5.routeTrafficOn}`}>
            <span className="dot approved" aria-hidden="true" />
            {STR5.routeTrafficOn}
          </span>
        </div>
        <div className="divider" />
        <div className="settings-row" data-setting="local-network">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span>{STR5.localNetwork}</span>{lanError && <span className="error" role="alert">{lanError}</span>}</span>
          <SavedSwitch label={STR5.localNetwork} {...lan} onToggle={toggleLan} />
        </div>
      </div>
    </>
  );
}

registerSettingsSection("computer", STR5.computer, ComputerSection);
