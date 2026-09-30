import { useEffect, useState } from "react";
import { STR, STR_HEALTH, isBadHealth, type ConnectorHealthView } from "@synapse/shared";
import { runFix, useHealth, useHealthSync } from "../../health/store";
import { registerSettingsSection } from "./sections";

/** One connector: a small dot, its name, its state (and a Broken one's short reason), and Fix when it needs one. */
function ConnectionRow({ c }: { c: ConnectorHealthView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fix = () => {
    if (!c.fix || busy) return;
    setBusy(true);
    setError(null);
    void runFix(c.fix).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const label = STR_HEALTH.state[c.state];
  return (
    <div className="settings-row connection-row" data-connector={c.id} data-state={c.state}>
      <span className={`health-dot ${c.state}`} aria-hidden="true" />
      <span className="grow connection-name">{c.name}</span>
      <span className={isBadHealth(c.state) ? "connection-state bad" : "connection-state"}>{c.state === "broken" && c.reason ? `${label} · ${c.reason}` : label}</span>
      {isBadHealth(c.state) && c.fix && (
        <button type="button" className="btn-outline small" disabled={busy} aria-label={`${STR_HEALTH.fix} ${c.name}`} onClick={fix}>{STR_HEALTH.fix}</button>
      )}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

/** 4.4: Settings → Connections. Every connector's health in one list; Fix runs its existing reconnect flow. */
export function ConnectionsSection() {
  const { connectors, error, load } = useHealth();
  useHealthSync();
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <h2>{STR_HEALTH.section}</h2>
      {error && !connectors && <p><span className="error" role="alert">{error}</span> <button type="button" className="link-btn" onClick={() => void load()}>{STR.retry}</button></p>}
      {connectors && connectors.length === 0 && <p className="muted">{STR_HEALTH.none}</p>}
      {connectors && connectors.length > 0 && (
        <div className="settings-card connections-card" aria-label={STR_HEALTH.section}>
          {connectors.map((c) => <ConnectionRow key={c.id} c={c} />)}
        </div>
      )}
    </>
  );
}

registerSettingsSection("connections", STR_HEALTH.section, ConnectionsSection);
