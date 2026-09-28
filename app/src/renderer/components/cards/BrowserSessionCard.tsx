import { useState } from "react";
import { STRB, type BrowserSessionCardView } from "@synapse/shared";
import { nativeCall } from "../../native";
import { BrowserSigninButton } from "../BrowserSigninButton";
import { registerCard, type CardProps } from "./registry";

/** mac-browser: one compact card per browser session: the page, the steps taken, and a way to see the window. */
export function BrowserSessionCard({ botId, card }: CardProps) {
  const c = card as BrowserSessionCardView;
  const [error, setError] = useState<string | null>(null);
  const show = () => { setError(null); nativeCall<{ shown: boolean }>("browser.show", { botId }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); };
  let host = c.url;
  try { host = new URL(c.url).host || c.url; } catch { /* keep the raw url */ }
  return (
    <section aria-label={`${STRB.cardTitle}: ${c.title}`} className="card settled browser-card">
      <span className="card-title">{c.title || host}</span>
      <span className="muted small">
        {host} · {STRB.steps(c.steps)}{c.screenshots > 0 ? ` · ${STRB.screenshots(c.screenshots)}` : ""}{c.status !== "active" ? ` · ${STRB.status[c.status]}` : ""}
      </span>
      <div className="card-actions">
        {c.status !== "closed" && <button type="button" className="btn-outline" onClick={show}>{STRB.showWindow}</button>}
        <BrowserSigninButton />
      </div>
      {error && <span className="error" role="alert">{error}</span>}
    </section>
  );
}

registerCard("browser-session", BrowserSessionCard);
