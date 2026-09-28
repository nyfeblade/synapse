import { LIMITSC, STRC, type SecretRequestView } from "@synapse/shared";
import { useState } from "react";

/** SEC-02/03: the value goes renderer → Electron main (Keychain vault, sealing) → host; it never passes through the gateway client. */
export function SecretCard({ botId, entryId, secret }: { botId: string; entryId: string; secret: SecretRequestView }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await window.synapse.secrets.submitRequest(botId, entryId, value, { destination: secret.destination, field: secret.field, label: secret.label });
      if (status === "failed") setError(STRC.secretNotSaved);
      else setValue("");
    } catch {
      setError(STRC.secretNotSaved);
    } finally {
      setBusy(false);
    }
  };
  const done = secret.status !== "pending";
  return (
    <section aria-label={secret.label} className="computer-card secret-card">
      <div className="cc-head"><span className="cc-title">{secret.label}</span>{done && secret.status === "saved" && <span className="cc-badge">{STRC.saved}</span>}</div>
      {secret.description && <div className="cc-text">{secret.description}</div>}
      {!done && (
        <>
          <input type="password" autoComplete="off" spellCheck={false} aria-label={secret.label} className="field-input" placeholder={STRC.secretPlaceholder(secret.label)} value={value} onChange={(e) => setValue(e.target.value)} />
          {value.length >= LIMITSC.secretMinChars && value.length < LIMITSC.secretWarnBelow && <div className="muted small">{STRC.shortValueWarning}</div>}
          {error && <div className="error small">{error}</div>}
          <div className="cc-actions"><button type="button" className="btn-primary" disabled={busy || value.length < LIMITSC.secretMinChars} onClick={() => void save()}>{STRC.saveSecurely}</button></div>
        </>
      )}
      {secret.status === "saved" && <div className="cc-text">{STRC.savedPrivately}</div>}
      {secret.status === "filled" && <div className="cc-text">{STRC.filledIntoPage}</div>}
      {secret.status === "fill_failed" && <div className="cc-text error">{STRC.couldNotFill}</div>}
      <div className="cc-footer">{STRC.secretFooter}</div>
    </section>
  );
}
