import { useState } from "react";
import { STR5, type CodingAgentCardView } from "@synapse/shared";
import { call } from "../../bridge";
import { nativeCall } from "../../native";
import { registerCard, type CardProps } from "./registry";

export function CodingAgentCard({ card }: CardProps) {
  const { agent } = card as CodingAgentCardView;
  // 0.1.4 first-run: a running agent can be stopped from its card (the host settles the card to Cancelled).
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    setStopping(true);
    void call("cancelCodingAgent", { id: agent.id }).catch(() => {}).finally(() => setStopping(false));
  };
  return (
    <section aria-label={`${STR5.codingAgent}: ${agent.title}`} className="card pending coding-card">
      <span className="card-title">{agent.title}</span>
      <span className="muted small">{agent.repo} · <code>{agent.branch}</code></span>
      {agent.note && <span className="muted small">{agent.note}</span>}
      <span className={`status status-${agent.status}`}>{STR5.codingStatus[agent.status]}</span>
      {agent.summary && agent.status !== "running" && <span className="muted pre-wrap">{agent.summary}</span>}
      {agent.prUrl && <a href={agent.prUrl} onClick={(e) => { e.preventDefault(); void nativeCall("openExternal", { url: agent.prUrl }); }}>{STR5.openPr}</a>}
      {agent.status === "running" && (
        <div className="card-actions">
          <button type="button" className="btn-outline small" disabled={stopping} onClick={stop}>{STR5.codingStop}</button>
        </div>
      )}
    </section>
  );
}

registerCard("coding-agent", CodingAgentCard);
