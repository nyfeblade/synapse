import { useEffect } from "react";
import { COMPOSIO_GOOGLE_TWINS, STR5, STRX, type ComposioAppView } from "@synapse/shared";
import { LogoTile } from "../marketplace/LogoTile";
import { useComposio, useComposioSync } from "./store";

/** One verb per row, like the rest of the Marketplace: Connect is the whole flow once the key is saved. */
function Action({ app }: { app: ComposioAppView }) {
  const { busy, connect, reopen, openSheet } = useComposio();
  if (app.state === "connected") {
    return <span className="mkt-action"><span className="mkt-status">{STRX.connected}</span><button type="button" className="pill" aria-label={STR5.manageAria(app.name)} onClick={openSheet}>{STRX.manage}</button></span>;
  }
  if (app.state === "waiting") {
    return <span className="pill-wait"><span className="muted">{STRX.waiting}</span><button type="button" className="link-btn" onClick={() => reopen(app.toolkit)}>{STRX.reopen}</button></span>;
  }
  const label = app.state === "failed" ? STRX.retry : STRX.connect;
  return <button type="button" className="pill" disabled={!!busy} aria-label={`${label} ${app.name}`} onClick={() => void connect(app.toolkit)}>{label}</button>;
}

/** Gmail, Calendar and Drive live on the Google rows (two ways in); this section lists the Composio-only apps. */
const TWINS = new Set(Object.values(COMPOSIO_GOOGLE_TWINS));

/** Marketplace → Apps through Composio. Before a key is saved it is one row that opens the walkthrough. */
export function ComposioMarketplaceSection() {
  const { status, load, openSheet, error, open } = useComposio();
  useComposioSync();
  useEffect(() => { if (!status) void load(); }, [status, load]);
  if (!status) return null;
  return (
    <section aria-label={STRX.marketplaceSection} className="mkt-section composio-mkt">
      <div className="mkt-section-head"><h3>{STRX.marketplaceSection}</h3></div>
      <div className="mkt-list">
        {!status.keySet ? (
          <div className="mkt-row">
            <span className="mkt-row-main"><LogoTile name={STRX.composio} logo={null} /><span className="mkt-row-text"><span>{STRX.composio}</span></span></span>
            <button type="button" className="pill" aria-label={`${STRX.setUp} ${STRX.composio}`} onClick={openSheet}>{STRX.setUp}</button>
          </div>
        ) : status.apps.filter((a) => !TWINS.has(a.toolkit)).map((a) => (
          <div key={a.toolkit} className="mkt-row" data-toolkit={a.toolkit}>
            <span className="mkt-row-main"><LogoTile name={a.name} logo={null} /><span className="mkt-row-text"><span>{a.name}</span>{a.state === "connected" && <span className="muted ellipsis">{a.bots.length ? STRX.botCount(a.bots.length) : STRX.noBots}</span>}</span></span>
            <Action app={a} />
          </div>
        ))}
      </div>
      {error && !open && <span className="error" role="alert">{error}</span>}
    </section>
  );
}
