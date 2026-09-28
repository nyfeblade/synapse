import { useState } from "react";
import { STR, isPageFormCard, type SendMessageEntry } from "@synapse/shared";
import { newFlag } from "../is-new";
import { SettledLine, useRespond } from "./WidgetCard";

/** Entrance gate, threaded from Transcript so a hydrating card never animates (motion-spec §5.1). */
type Legacy = { botId: string; entry: SendMessageEntry; isNew?: boolean };

/** A url the Bot truncated ("https://") throws in `new URL`, and an uncaught throw here blanks the transcript. */
function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

export function CardView({ botId, entry, isNew = false }: Legacy) {
  if (entry.message.type !== "card") return null;
  const c = entry.message.card;
  if (isPageFormCard(c)) return null; // SEC-04 page-fill forms render as FormCard.tsx via transcript-items
  if (c.kind === "email-draft") return <EmailDraftCard botId={botId} entry={entry} isNew={isNew} />;
  if (c.kind === "form") return <FormCard botId={botId} entry={entry} isNew={isNew} />;
  if (c.kind === "connect" || c.kind === "local-tool-permission" || c.kind === "coding-agent" || c.kind === "engineering-offer") {
    // Phase 5 card kinds land with their dependencies here; Task 15 adds their rendering.
    return null;
  }
  if (c.kind === "link") {
    return (
      <a className={`card-primitive link-card${newFlag(isNew)}`} href={c.url} target="_blank" rel="noreferrer">
        <span className="card-title">{c.title ?? hostOf(c.url)}</span>
        {c.description && <span className="muted">{c.description}</span>}
        <span className="muted small">{hostOf(c.url)}</span>
      </a>
    );
  }
  if (c.kind === "connect-listener") return null; // rendered by ConnectListenerCard (Phase 4) via transcript-items
  if (c.kind === "table") {
    return (
      <section className={`card-primitive table-card${newFlag(isNew)}`} aria-label={c.title ?? "Table"}>
        {c.title && <div className="card-title">{c.title}</div>}
        <table>
          <thead><tr>{c.columns.map((h: string) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{c.rows.map((r: string[], i: number) => <tr key={i}>{r.map((v: string, j: number) => <td key={j}>{v}</td>)}</tr>)}</tbody>
        </table>
      </section>
    );
  }
  // Phase 5 CardPayload kinds (connect, local-tool-permission, coding-agent) never reach this
  // legacy CardSpec view — transcript-items.ts routes them to cards/registry.tsx's CardView.
  return null;
}

function EmailDraftCard({ botId, entry, isNew = false }: Legacy) {
  const { respond, error, busy } = useRespond(botId, entry.id);
  if (entry.message.type !== "card" || entry.message.card.kind !== "email-draft") return null;
  const c = entry.message.card;
  return (
    <section className={`card-primitive email-card${newFlag(isNew)}`} aria-label={`${STR.newEmail}: ${c.subject}`}>
      <div className="card-head muted">{STR.newEmail} · {STR.readyToSend}</div>
      <dl className="email-fields">
        {c.from && (<><dt>From</dt><dd>{c.from}</dd></>)}
        <dt>To</dt><dd>{c.to.join(", ")}</dd>
        {c.cc?.length ? (<><dt>Cc</dt><dd>{c.cc.join(", ")}</dd></>) : null}
        <dt>Subject</dt><dd>{c.subject}</dd>
      </dl>
      <div className="email-body">{c.body}</div>
      {entry.status === "pending" ? (
        <div className="card-actions">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void respond("send")}>{STR.sendEmail}</button>
          <button type="button" className="btn-outline" disabled={busy} onClick={() => void respond("discard")}>{STR.discard}</button>
        </div>
      ) : <SettledLine entry={entry} />}
      {error && <div role="alert" className="card-error">{error}</div>}
    </section>
  );
}

function FormCard({ botId, entry, isNew = false }: Legacy) {
  const { respond, error, busy } = useRespond(botId, entry.id);
  const card = entry.message.type === "card" && entry.message.card.kind === "form" && !isPageFormCard(entry.message.card) ? entry.message.card : null;
  // A select with no preset value used to render blank (selectedIndex -1) and submit "".
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries((card?.fields ?? []).map((f) => [f.name, f.value ?? (f.kind === "select" ? f.options?.[0] ?? "" : "")])));
  if (!card) return null;
  const missing = card.fields.some((f) => f.required && !(vals[f.name] ?? "").trim());
  return (
    <form className={`card-primitive form-card${newFlag(isNew)}`} aria-label={card.title} onSubmit={(e) => { e.preventDefault(); if (!missing) void respond("submit", vals); }}>
      <div className="card-title">{card.title}</div>
      {card.fields.map((f) => (
        <label key={f.name} className="form-field">
          <span>{f.label}</span>
          {/* `.field-input` is the same field the app's OTHER form card (FormCard.tsx) uses. Bare, these
              three were raw browser controls in the transcript: Arial, square corners, native borders,
              a 15.5px input bar and a monospace textarea with an OS resize grabber. */}
          {f.kind === "textarea" ? <textarea className="field-input" value={vals[f.name]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} disabled={entry.status !== "pending"} />
            : f.kind === "select" ? <select className="field-input" value={vals[f.name]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} disabled={entry.status !== "pending"}>{(f.options ?? []).map((o) => <option key={o}>{o}</option>)}</select>
            : <input className="field-input" type="text" value={vals[f.name]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} disabled={entry.status !== "pending"} />}
        </label>
      ))}
      {entry.status === "pending" ? <div className="card-actions"><button type="submit" className="btn-primary" disabled={busy || missing}>{card.submitLabel ?? STR.submit}</button></div> : <SettledLine entry={entry} />}
      {error && <div role="alert" className="card-error">{error}</div>}
    </form>
  );
}
