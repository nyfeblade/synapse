import { useEffect, useState } from "react";
import { STRG, STRGS, STRX, type GoogleReconnectCheckView, type GoogleStatusView } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { SavedSwitch } from "../components/SavedSwitch";
import { registerGeneralBlock } from "../components/settings/sections";
import { useGoogle, useGoogleSync } from "./store";
import { useComposio, useComposioSync } from "../composio/store";

const summary = (s: GoogleStatusView | null) =>
  !s || s.state === "not-configured" || s.state === "disconnected" ? STRG.notConnected
  : s.state === "needs-reconnect" ? STRG.needsReconnect
  : s.state === "waiting" ? STRG.waiting
  // 4.3b: the accounts are listed under the row.
  : (s.accounts?.length ?? 0) > 1 ? STRG.accountCount(s.accounts!.length)
  : s.email ?? STRG.connectedAs("");

/** google-setup: the weekly sign-in check (host-kept; the default follows Testing until the user chooses). */
function ReconnectCheckRow() {
  const [v, setV] = useState<GoogleReconnectCheckView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void (callQuiet("getGoogleReconnectCheck", {}) as Promise<GoogleReconnectCheckView>).then(setV, () => setFailed(true)); }, []);
  const toggle = () => {
    if (!v) return;
    setBusy(true);
    void (callQuiet("setGoogleReconnectCheck", { enabled: !v.enabled }) as Promise<GoogleReconnectCheckView>).then(setV, () => setFailed(true)).finally(() => setBusy(false));
  };
  return (
    <div className="settings-row" data-setting="google-reconnect-check">
      <span className="grow">{STRGS.reconnectCheck}</span>
      <SavedSwitch label={STRGS.reconnectCheck} value={v ? v.enabled : null} busy={busy} failed={failed} onToggle={toggle} />
    </div>
  );
}

/** 4.3b: every connected Google account, each with Remove, and Add account. Titles and labels only. */
function GoogleAccountRows({ status }: { status: GoogleStatusView }) {
  const { busy, addAccount, removeAccount } = useGoogle();
  // One account is already the row's own line (its address); with several, each gets a row with Remove.
  const accounts = (status.accounts?.length ?? 0) > 1 ? status.accounts! : [];
  return (
    <>
      {accounts.map((a) => {
        const label = a.email ?? STRG.accountFallback;
        return (
          <div key={a.id} className="settings-row account-row" data-account={a.id}>
            <span className="grow account-label">{label}</span>
            {a.state === "needs-reconnect" && <span className="error">{STRG.accountNeedsSignIn}</span>}
            <button type="button" className="link-btn" disabled={busy} aria-label={`${STRG.remove} ${label}`} onClick={() => void removeAccount(a.id)}>{STRG.remove}</button>
          </div>
        );
      })}
      <div className="settings-row account-row">
        <button type="button" className="link-btn" disabled={busy} onClick={() => void addAccount()}>{STRG.addAccount}</button>
      </div>
    </>
  );
}

/** Settings → General → Connected accounts: the app-level Google accounts (ORIG-GOOGLE, 4.3b). */
export function ConnectedAccountsBlock() {
  const { status, load, openSheet } = useGoogle();
  useGoogleSync();
  useEffect(() => { void load(); }, [load]);
  const linked = status?.state === "connected" || status?.state === "needs-reconnect";
  const verb = linked ? STRG.manage : !status?.clientId ? STRGS.setUp : STRG.connect;
  const composio = useComposio();
  useComposioSync();
  useEffect(() => { void useComposio.getState().load(); }, []);
  const cx = composio.status;
  const cxConnected = (cx?.apps ?? []).filter((a) => a.state === "connected").map((a) => a.name);
  return (
    <>
    <h3>{STRG.connectedAccounts}</h3>
    <section className="settings-card" aria-label={STRG.connectedAccounts}>
      <div className="settings-row" data-setting="google">
        <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span>{STRG.google}</span>
          <span className={status?.state === "needs-reconnect" ? "error" : "muted"}>{summary(status)}</span>
        </span>
        <button type="button" className="btn-outline" aria-label={`${verb} ${STRG.google}`} onClick={() => openSheet()}>{verb}</button>
      </div>
      {linked && status && <GoogleAccountRows status={status} />}
      {!!status?.clientId && <ReconnectCheckRow />}
      <div className="settings-row" data-setting="composio">
        <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span>{STRX.composio}</span>
          <span className="muted">{!cx?.keySet ? STRX.notSetUp : cxConnected.length ? cxConnected.join(", ") : STRX.keySaved}</span>
        </span>
        <button type="button" className="btn-outline" aria-label={`${cx?.keySet ? STRX.manage : STRX.setUp} ${STRX.composio}`} onClick={composio.openSheet}>{cx?.keySet ? STRX.manage : STRX.setUp}</button>
      </div>
    </section>
    </>
  );
}

registerGeneralBlock("connected-accounts", 10, ConnectedAccountsBlock);
