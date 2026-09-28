import { useEffect, useState } from "react";
import { GOOGLE_SCOPES, GOOGLE_SETUP_STEPS, STR, STRG } from "@synapse/shared";
import { Dialog } from "../components/Dialog";
import { useGoogle, useGoogleSync } from "./store";

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="copy-field" aria-label={`${STRG.copy} ${label} ${value}`}
      onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      <span className="copy-label">{label}</span><span className="copy-value">{value}</span><span className="muted">{copied ? STRG.copied : STRG.copy}</span>
    </button>
  );
}

/** ORIG-GOOGLE: the app's own Google sign-in, with the user's own "Desktop app" OAuth client. */
export function ConnectGoogleSheet() {
  const { open, status, error, busy, close, connect, disconnect } = useGoogle();
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

  return (
    <Dialog label={STRG.connectGoogle} onClose={close} className="tpl-sheet google-sheet">
      <>
        <h2>{STRG.connectGoogle}</h2>
        {linked && status && (
          <section className="settings-card google-account" aria-label={STRG.google}>
            {state === "needs-reconnect" && <p className="warning" role="note">{status.error ?? STRG.needsReconnect}</p>}
            {status.email && <div className="settings-row"><span className="grow">{STRG.connectedAs(status.email)}</span></div>}
            {status.services.length > 0 && <div className="settings-row"><span className="muted">{STRG.grantedServices(status.services)}</span></div>}
            <div className="settings-row gap">
              {state === "needs-reconnect" && <button type="button" className="btn-primary" disabled={busy} onClick={() => void connect()}>{STRG.reconnect}</button>}
              <button type="button" className="btn-outline" disabled={busy} onClick={() => void disconnect()}>{STRG.disconnect}</button>
            </div>
          </section>
        )}
        {!linked && (
          <>
            <h3>{STRG.setupTitle}</h3>
            <ol aria-label="Setup steps" className="google-steps">{GOOGLE_SETUP_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
            <span className="field-label">{STRG.scopesLabel}</span>
            <ul className="google-scopes">{GOOGLE_SCOPES.map((s) => <li key={s} className="mono">{s.replace("https://www.googleapis.com/auth/", "")}</li>)}</ul>
            <CopyRow label={STRG.redirectLabel} value={status?.redirectUri ?? "http://127.0.0.1:47823/mcp/oauth/callback"} />
            <p className="field-help">{STRG.testingNote}</p>
            <div className="field">
              <label htmlFor="google-client-id">{STRG.clientId}</label>
              <input id="google-client-id" type="text" autoComplete="off" spellCheck={false} value={clientId} placeholder="…apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="google-client-secret">{STRG.clientSecret}</label>
              <input id="google-client-secret" type="password" autoComplete="off" spellCheck={false} value={secret} placeholder={savedClient ? "••••••••" : "GOCSPX-…"} onChange={(e) => setSecret(e.target.value)} />
            </div>
            {state === "waiting" && (
              <span className="pill-wait"><span className="muted">{STRG.waiting}</span>
                <button type="button" className="link-btn" disabled={busy} onClick={() => void connect()}>{STRG.reopen}</button></span>
            )}
            <p className="field-help">{STRG.unverifiedHint}</p>
          </>
        )}
        {error && <span className="error" role="alert">{error}</span>}
        <p className="field-help">{STRG.secretStored}</p>
        <div className="sheet-actions">
          <button type="button" className="btn-outline" onClick={close}>{STR.close}</button>
          {!linked && <button type="button" className="btn-primary" disabled={!canConnect} onClick={submit}>{STRG.connect}</button>}
        </div>
      </>
    </Dialog>
  );
}
