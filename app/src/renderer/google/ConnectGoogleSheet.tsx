import { useEffect, useState } from "react";
import { STR, STRG, STRGS } from "@synapse/shared";
import { Dialog } from "../components/Dialog";
import { Segmented } from "../components/Segmented";
import { GoogleBotPanel, GoogleSetupSteps } from "./GoogleSetupGuide";
import { useGoogle, useGoogleSync, type GoogleSheetMode } from "./store";

const MODES = [{ value: "self", label: STRGS.doItYourself }, { value: "bot", label: STRGS.letABot }] as const;

/** ORIG-GOOGLE + google-setup: the app's own Google sign-in, with the user's own "Desktop app" OAuth client. */
export function ConnectGoogleSheet() {
  const { open, status, error, busy, mode, close, connect, disconnect, setMode, addAccount, removeAccount } = useGoogle();
  useGoogleSync();
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  useEffect(() => { if (status?.clientId) setClientId((c) => c || status.clientId!); }, [status?.clientId]);
  // This sheet opens FROM the Marketplace, on top of it. Its own window-level Escape handler and the
  // Marketplace's fired on the same keypress, so one Escape closed both. The stack owns it now.
  if (!open) return null;
  const state = status?.state ?? "not-configured";
  const linked = state === "connected" || state === "needs-reconnect";
  const savedClient = !!status?.clientId && clientId.trim() === status.clientId;
  const canConnect = !busy && !!clientId.trim() && (!!secret.trim() || savedClient);
  const submit = () => void connect(secret.trim() || !savedClient ? { clientId: clientId.trim(), clientSecret: secret.trim() } : undefined).then(() => setSecret(""));
  const waiting = state === "waiting" && (
    <span className="pill-wait" role="status"><span>{STRGS.clickAllow}</span>
      <button type="button" className="link-btn" disabled={busy} onClick={() => void connect()}>{STRG.reopen}</button></span>
  );
  const task = status?.setupTask ?? null;

  const connectFields = (
    <>
      <div className="field">
        <label htmlFor="google-client-id">{STRG.clientId}</label>
        <input id="google-client-id" type="text" autoComplete="off" spellCheck={false} value={clientId} placeholder="…apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="google-client-secret">{STRG.clientSecret}</label>
        <input id="google-client-secret" type="password" autoComplete="off" spellCheck={false} value={secret} placeholder={savedClient ? "••••••••" : "GOCSPX-…"} onChange={(e) => setSecret(e.target.value)} />
      </div>
      <p className="google-note">{STRGS.unverifiedNote}</p>
      <div className="google-connect-row">
        {waiting}
        <button type="button" className="btn-primary" disabled={!canConnect} onClick={submit}>{STRG.connect}</button>
      </div>
    </>
  );

  return (
    <Dialog label={STRG.connectGoogle} onClose={close} className="tpl-sheet google-sheet">
      <>
        <h2>{STRG.connectGoogle}</h2>
        {linked && status && (
          <>
            <section className="settings-card google-account" aria-label={STRG.google}>
              {state === "needs-reconnect" && <p className="warning" role="note">{status.error ?? STRG.needsReconnect}</p>}
              {/* 4.3b: one account reads as before; with several, one row each with Remove. Add account signs in another address. */}
              {(status.accounts?.length ?? 0) <= 1 && status.email && <div className="settings-row"><span className="grow">{STRG.connectedAs(status.email)}</span></div>}
              {(status.accounts?.length ?? 0) > 1 && status.accounts!.map((a) => (
                <div key={a.id} className="settings-row account-row" data-account={a.id}>
                  <span className="grow account-label">{a.email ?? STRG.accountFallback}</span>
                  {a.state === "needs-reconnect" && <span className="error">{STRG.accountNeedsSignIn}</span>}
                  <button type="button" className="link-btn" disabled={busy} aria-label={`${STRG.remove} ${a.email ?? STRG.accountFallback}`} onClick={() => void removeAccount(a.id)}>{STRG.remove}</button>
                </div>
              ))}
              {status.services.length > 0 && <div className="settings-row"><span className="muted">{STRG.grantedServices(status.services)}</span></div>}
              <div className="settings-row gap">
                <button type="button" className="btn-outline" disabled={busy} onClick={() => void addAccount()}>{STRG.addAccount}</button>
                {state === "needs-reconnect" && <button type="button" className="btn-primary" disabled={busy} onClick={() => void connect()}>{STRG.reconnect}</button>}
                {state === "needs-reconnect" && mode !== "bot" && <button type="button" className="btn-outline" onClick={() => setMode("bot")}>{STRGS.letABotClick}</button>}
                <button type="button" className="btn-outline" disabled={busy} onClick={() => void disconnect()}>{STRG.disconnect}</button>
              </div>
            </section>
            {state === "needs-reconnect" && (mode === "bot" || task) && <GoogleBotPanel mode="reconnect" />}
          </>
        )}
        {!linked && (
          <>
            <Segmented<GoogleSheetMode> label={STRGS.sheetTitle} value={task ? "bot" : mode} options={MODES} onChange={setMode} />
            {(mode === "bot" || task) && <GoogleBotPanel mode="setup" />}
            <GoogleSetupSteps connectFields={connectFields} />
          </>
        )}
        {error && <span className="error" role="alert">{error}</span>}
        <div className="sheet-actions">
          <button type="button" className="btn-secondary" onClick={close}>{STR.close}</button>
        </div>
      </>
    </Dialog>
  );
}
