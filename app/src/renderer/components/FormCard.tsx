import { STRC, type FormCardView } from "@synapse/shared";
import { useState } from "react";

/** SEC-04: one form per step; secret fields go through the Mac vault and are filled by the host. */
export function FormCard({ botId, entryId, card }: { botId: string; entryId: string; card: FormCardView }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = card.status === "pending";
  const submit = async () => {
    setBusy(true);
    setError(null);
    const answers: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const f of card.fields) (f.secret ? secrets : answers)[f.name] = vals[f.name] ?? "";
    try {
      await window.synapse.secrets.submitForm(botId, entryId, answers, secrets);
      setVals({});
    } catch {
      setError(STRC.formNotSubmitted);
    } finally {
      setBusy(false);
    }
  };
  const missing = card.fields.some((f) => f.required && !(vals[f.name] ?? "").trim());
  return (
    <section aria-label={card.title} className="computer-card form-card">
      <div className="cc-head"><span className="cc-title">{card.title}</span>{!pending && <span className="cc-badge">{STRC.formSubmitted}</span>}</div>
      {pending && card.fields.map((f) => (
        <label key={f.name} className="form-field">
          <span>{f.label}</span>
          <input className="field-input" type={f.secret ? "password" : f.type === "number" ? "text" : f.type === "address" ? "text" : f.type} autoComplete="off" value={vals[f.name] ?? ""} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
        </label>
      ))}
      {pending && error && <div className="cc-text error">{error}</div>}
      {pending && <div className="cc-actions"><button type="button" className="btn-primary" disabled={busy || missing} onClick={() => void submit()}>{STRC.submit}</button></div>}
      {card.status === "fill_failed" && <div className="cc-text error">{STRC.couldNotFill}</div>}
    </section>
  );
}
