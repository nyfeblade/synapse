import { useState } from "react";
import { GatewayCallError, STR, type SendMessageEntry } from "@synapse/shared";
import { call } from "../bridge";
import "../styles/widgets.css";
import { newFlag } from "../is-new";

export function useRespond(botId: string, entryId: string) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const respond = async (value: string, formValues?: Record<string, string>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await call("respondToWidget", { id: botId, entryId, value, ...(formValues ? { formValues } : {}) });
    } catch (e) {
      setError(e instanceof GatewayCallError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { respond, error, busy };
}

export function SettledLine({ entry }: { entry: SendMessageEntry }) {
  if (entry.status === "answered") return <div className="card-settled">{STR.answered}: <strong>{entry.respondedValue}</strong></div>;
  if (entry.status === "skipped") return <div className="card-settled muted">{STR.skipped}</div>;
  if (entry.status === "dismissed") return <div className="card-settled muted">{STR.dismissed}</div>;
  return null;
}

export function WidgetCard({ botId, entry, isNew = false }: { botId: string; entry: SendMessageEntry; isNew?: boolean }) {
  const { respond, error, busy } = useRespond(botId, entry.id);
  const [custom, setCustom] = useState<string | null>(null);
  if (entry.message.type !== "widget") return null;
  const w = entry.message.widget;
  const pending = entry.status === "pending";
  // CHAT-17 / task-6-brief.md: once settled, options stay visible (disabled, chosen one
  // aria-pressed) instead of disappearing — the card is the record of what was asked and
  // answered, not just a live control. See implementer-rules.md's Task 6 widget-shape ruling.
  return (
    <section className={`card-primitive widget${newFlag(isNew)}`} role="group" aria-label={w.question}>
      <div className="card-title">{w.question}</div>
      <div className="widget-options">
        {w.options.map((o) => {
          const chosen = entry.respondedValue === o.value;
          return (
            <button key={o.value} type="button" className={`btn-outline ${o.style ?? "default"}${chosen ? " chosen" : ""}`}
              aria-pressed={chosen} disabled={!pending || busy} onClick={() => void respond(o.value)}>
              {o.label}
            </button>
          );
        })}
        {pending && w.allowCustom && custom === null && <button type="button" className="btn-outline" onClick={() => setCustom("")}>{STR.other}</button>}
        {pending && custom !== null && (
          <input className="text-input" aria-label="Your answer" autoFocus value={custom} onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && custom.trim()) void respond(custom.trim()); }} />
        )}
      </div>
      {!pending && <SettledLine entry={entry} />}
      {error && <div role="alert" className="card-error">{error}</div>}
    </section>
  );
}
