import { STR5, type CodingAgentCardView } from "@synapse/shared";
import { nativeCall } from "../../native";
import { registerCard, type CardProps } from "./registry";

export function CodingAgentCard({ card }: CardProps) {
  const { agent } = card as CodingAgentCardView;
  return (
    <section aria-label={`${STR5.codingAgent}: ${agent.title}`} className="card pending coding-card">
      <span className="card-title">{agent.title}</span>
      <span className="muted small">{agent.repo} · <code>{agent.branch}</code></span>
      {agent.note && <span className="muted small">{agent.note}</span>}
      <span className={`status status-${agent.status}`}>{STR5.codingStatus[agent.status]}</span>
      {agent.summary && agent.status !== "running" && <span className="muted pre-wrap">{agent.summary}</span>}
      {agent.prUrl && <a href={agent.prUrl} onClick={(e) => { e.preventDefault(); void nativeCall("openExternal", { url: agent.prUrl }); }}>{STR5.openPr}</a>}
    </section>
  );
}

registerCard("coding-agent", CodingAgentCard);
