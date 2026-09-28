import { useState } from "react";
import { BROWSER_PERMISSION_PREFIX, STR, STR5, STRB, type LocalAskChoice, type LocalToolCardView } from "@synapse/shared";
import { call } from "../../bridge";
import { registerCard, type CardProps } from "./registry";
import { newFlag } from "../../is-new";
import { useUi } from "../../store";
import { noteLocalPermissionChanged } from "../LocalPermissionRow";

export function LocalToolCard({ botId, card, isNew = false }: CardProps) {
  const c = card as LocalToolCardView;
  // Task 34 fuzz: one answer per card (a double-click used to send two, and the second threw uncaught).
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const botName = useUi((s) => s.bots[botId]?.profile.name) ?? "This Bot";
  const choose = (choice: LocalAskChoice) => {
    if (answered) return;
    setAnswered(true);
    setError(null);
    // fix-fullauto-adoption: the adoption card's answer carries only the mode; the coordinator writes the Mac's record.
    call("resolveLocalToolPermission", c.adopt ? { id: botId, askId: c.askId, choice, adopt: c.adopt } : { id: botId, askId: c.askId, choice, action: c.action, target: c.target })
      // settings-persist: "Always" on a permission card turns this Bot's switch on; an open Bot settings panel re-reads it.
      .then(() => { if (choice === "always") noteLocalPermissionChanged(botId); })
      .catch((e: unknown) => { setAnswered(false); setError(e instanceof Error ? e.message : String(e)); });
  };
  const pending = c.status === "pending";
  if (c.adopt) {
    return (
      <section aria-label="Local computer request" tabIndex={0} className={`${pending ? "card pending local-card" : "card settled local-card"}${newFlag(isNew)}`}
        onKeyDown={(e) => { if (pending && e.key === "Escape") { e.stopPropagation(); choose("deny"); } }}>
        <span className="card-title">{STR5.localAdoptTitle(botName, c.adopt)}</span>
        <span className="muted">{STR5.localAdoptBody}</span>
        {pending ? (
          <div className="card-actions">
            <button type="button" className="btn-primary" disabled={answered} onClick={() => choose("once")}>{STR5.localAdoptAllow}</button>
            <button type="button" className="btn-outline" disabled={answered} aria-keyshortcuts="Escape" onClick={() => choose("deny")}>{STR5.localAdoptKeep}</button>
          </div>
        ) : <span className="card-outcome">{STR5.localAdoptOutcome[c.status]}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </section>
    );
  }
  if (c.action === "browser") {
    // mac-browser: the Mac's own words (what and where, or the first-use permission), never a raw command; and no
    // "Never" here (that one switches the whole Mac off).
    const permission = c.target.startsWith(BROWSER_PERMISSION_PREFIX);
    return (
      <section aria-label="Local computer request" tabIndex={0} className={`${pending ? "card pending local-card" : "card settled local-card"}${newFlag(isNew)}`}
        onKeyDown={(e) => { if (pending && e.key === "Escape") { e.stopPropagation(); choose("deny"); } }}>
        <span className="card-title">{permission ? STRB.cardTitlePermission : STRB.cardTitle}</span>
        {c.description && <span className="muted">{c.description}</span>}
        {pending ? (
          <div className="card-actions">
            <button type="button" className="btn-primary" disabled={answered} onClick={() => choose("once")}>{STR5.localOnce}</button>
            <button type="button" className="btn-outline" disabled={answered} onClick={() => choose("always")}>{STR5.localAlways}</button>
            <button type="button" className="btn-outline" disabled={answered} aria-keyshortcuts="Escape" onClick={() => choose("deny")}>{STR5.localDenyOnce}</button>
          </div>
        ) : <span className="card-outcome">{STR5.localOutcome[c.status === "never" ? "denied" : c.status]}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </section>
    );
  }
  return (
    <section aria-label="Local computer request" tabIndex={0} className={`${pending ? "card pending local-card" : "card settled local-card"}${newFlag(isNew)}`}
      onKeyDown={(e) => { if (pending && e.key === "Escape") { e.stopPropagation(); choose("deny"); } }}>
      <span className="card-title">{STR5.localCardTitle}</span>
      <span className="muted">{STR5.localCardBody}</span>
      <code className="card-command">{c.target}</code>
      <span className="muted small">{STR.runsOnLocal}</span>
      {pending ? (
        <div className="card-actions">
          <button type="button" className="btn-primary" disabled={answered} onClick={() => choose("always")}>{STR5.localAlways}</button>
          <button type="button" className="btn-outline" disabled={answered} onClick={() => choose("once")}>{STR5.localOnce}</button>
          <button type="button" className="btn-outline" disabled={answered} onClick={() => choose("never")}>{STR5.localNever}</button>
          <button type="button" className="btn-outline" disabled={answered} aria-keyshortcuts="Escape" onClick={() => choose("deny")}>{STR5.localDenyOnce}</button>
        </div>
      ) : <span className="card-outcome">{STR5.localOutcome[c.status]}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </section>
  );
}

registerCard("local-tool-permission", LocalToolCard);
