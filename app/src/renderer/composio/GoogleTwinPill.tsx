import { useEffect } from "react";
import { STR5, STRX, type CatalogEntry, type ComposioAppView } from "@synapse/shared";
import { useGoogle } from "../google/store";
import { useComposio, useComposioSync } from "./store";

/**
 * Gmail, Google Calendar and Google Drive appear once in the Marketplace, with two ways in: Connect directly (the
 * user's own Google app, the listed default) and One click with Composio (marked: its data goes through Composio).
 */
export function GoogleTwinPill({ e, toolkit }: { e: CatalogEntry; toolkit: string }) {
  const { status, busy, connect, reopen, openSheet, load } = useComposio();
  useComposioSync();
  useEffect(() => { if (!status) void load(); }, [status, load]);
  const app: ComposioAppView | undefined = status?.apps.find((a) => a.toolkit === toolkit);
  const openGoogle = () => useGoogle.getState().openSheet();
  if (e.state === "connected") {
    return <span className="mkt-action"><span className="mkt-status">{STR5.statusConnected}</span><button type="button" className="pill" aria-label={STR5.manageAria(e.name)} onClick={openGoogle}>{STR5.manage}</button></span>;
  }
  if (app?.state === "connected") {
    return <span className="mkt-action"><span className="mkt-status">{STRX.connectedComposio}</span><button type="button" className="pill" aria-label={STR5.manageAria(e.name)} onClick={openSheet}>{STR5.manage}</button></span>;
  }
  if (app?.state === "waiting") {
    return <span className="pill-wait"><span className="muted">{STRX.waiting}</span><button type="button" className="link-btn" onClick={() => reopen(toolkit)}>{STRX.reopen}</button></span>;
  }
  // Without a key the quick option starts the key walkthrough; with one it is the whole flow.
  const quick = () => (status?.keySet ? void connect(toolkit) : openSheet());
  return (
    <span className="mkt-action mkt-twin">
      <button type="button" className="pill" aria-label={`${STRX.connectDirectly} ${e.name}`} onClick={openGoogle}>{STRX.connectDirectly}</button>
      <button type="button" className="link-btn" disabled={!!busy} aria-label={`${STRX.oneClick} ${e.name}`} onClick={quick}>{STRX.oneClick}</button>
      <span className="muted mkt-twin-note">{STRX.throughComposio}</span>
    </span>
  );
}
