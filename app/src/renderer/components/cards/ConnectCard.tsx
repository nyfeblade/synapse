import { useEffect, useState, type ReactNode } from "react";
import { STR5, type ConnectCardView, type McpServerStatus } from "@synapse/shared";
import { call } from "../../bridge";
import { subscribeChannel } from "../../feature-store";
import { LogoTile } from "../../marketplace/LogoTile";
import { nativeCall } from "../../native";
import { registerCard, type CardProps } from "./registry";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ConnectCard({ card }: CardProps) {
  const c = card as ConnectCardView;
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The card payload is written once, when the Bot posts it, and nothing rewrites it. Without this
  // the card would still read "Waiting for authorization" long after the browser flow finished.
  const [live, setLive] = useState<McpServerStatus | null>(null);
  const serverId = waitingFor ?? c.serverId;
  useEffect(() => {
    if (!serverId) return;
    return subscribeChannel("mcp-servers", (p) => {
      const s = p.servers.find((x) => x.id === serverId);
      if (!s) return;
      setLive(s.status);
      if (s.status !== "waiting-auth") setWaitingFor(null);
    });
  }, [serverId]);

  const authorize = async (id: string) => {
    setError(null);
    setWaitingFor(id);
    try {
      const { authorizationUrl } = await call("startMcpAuth", { serverId: id });
      if (authorizationUrl) await nativeCall("openExternal", { url: authorizationUrl });
    } catch (e) {
      setWaitingFor(null);
      setError(message(e));
    }
  };
  const add = async () => {
    if (!c.catalogId) return;
    setError(null);
    try {
      const r = await call("installPlugin", { id: c.catalogId });
      if (r.openUrl) await nativeCall("openExternal", { url: r.openUrl });
      else if (r.needsAuth && r.serverIds[0]) await authorize(r.serverIds[0]);
    } catch (e) {
      setError(message(e));
    }
  };

  const state: ConnectCardView["state"] =
    live === "connected" ? "connected"
      : live === "waiting-auth" ? "waiting-auth"
        : live && c.serverId ? "added"
          : c.state;
  let action: ReactNode;
  if (state === "connected") action = <span className="status-chip">{STR5.connected}</span>;
  else if (waitingFor || state === "waiting-auth") action = <span className="pill-wait"><span className="muted">{STR5.waitingForAuthorization}</span><button type="button" className="link-btn" onClick={() => void authorize((waitingFor ?? c.serverId)!)}>{STR5.reopen}</button></span>;
  else if (state === "added" && c.serverId) action = <button type="button" className="pill" aria-label={`${STR5.authorize} ${c.name}`} onClick={() => void authorize(c.serverId!)}>{STR5.authorize}</button>;
  else action = <button type="button" className="pill" aria-label={STR5.addAria(c.name)} onClick={() => void add()}>{STR5.add}</button>;
  return (
    <section aria-label={c.name} className="card pending connect-card">
      <div className="mkt-row"><LogoTile name={c.name} logo={c.logo} /><span className="mkt-row-text"><span>{c.name}</span><span className="muted">{STR5.connectCardBody(c.name, c.toolCount)}</span></span>{action}</div>
      {error && <div role="alert" className="card-error">{error}</div>}
    </section>
  );
}

registerCard("connect", ConnectCard);
