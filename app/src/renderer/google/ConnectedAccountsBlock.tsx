import { useEffect } from "react";
import { STRG, type GoogleStatusView } from "@synapse/shared";
import { registerGeneralBlock } from "../components/settings/sections";
import { useGoogle, useGoogleSync } from "./store";

const summary = (s: GoogleStatusView | null) =>
  !s || s.state === "not-configured" || s.state === "disconnected" ? STRG.notConnected
  : s.state === "needs-reconnect" ? STRG.needsReconnect
  : s.state === "waiting" ? STRG.waiting
  : s.email ?? STRG.connectedAs("");

/** Settings → General → Connected accounts: the app-level Google account (ORIG-GOOGLE). */
export function ConnectedAccountsBlock() {
  const { status, load, openSheet } = useGoogle();
  useGoogleSync();
  useEffect(() => { void load(); }, [load]);
  const linked = status?.state === "connected" || status?.state === "needs-reconnect";
  return (
    <section className="settings-card" aria-label={STRG.connectedAccounts}>
      <div className="settings-row"><span className="grow">{STRG.connectedAccounts}</span></div>
      <div className="divider" />
      <div className="settings-row" data-setting="google">
        <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span>{STRG.google}</span>
          <span className={status?.state === "needs-reconnect" ? "error" : "muted"}>{summary(status)}</span>
        </span>
        <button type="button" className="btn-outline" aria-label={`${linked ? STRG.manage : STRG.connect} ${STRG.google}`} onClick={openSheet}>{linked ? STRG.manage : STRG.connect}</button>
      </div>
    </section>
  );
}

registerGeneralBlock("connected-accounts", 10, ConnectedAccountsBlock);
