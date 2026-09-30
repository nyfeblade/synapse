import { useEffect, useState } from "react";
import { STR_MCP } from "@synapse/shared";
import { nativeCall, onNative } from "../../native";
import { useMcpStatus, type McpStatusView } from "../McpApprovals";
import { Segmented } from "../Segmented";
import { registerSectionBlock } from "./sections";

interface AuditEntry { at: number; clientId: string | null; client: string; tool: string; bot: string | null; outcome: string }
type Target = "claudeDesktop" | "claudeCode" | "cursor";
const TARGETS: readonly { value: Target; label: string }[] = [
  { value: "claudeDesktop", label: STR_MCP.clients["claude-desktop"]! },
  { value: "claudeCode", label: STR_MCP.clients["claude-code"]! },
  { value: "cursor", label: STR_MCP.clients.cursor! },
];

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * 0.1.4: Settings → System → MCP. The switch (off by default), the config to paste into each client (Synapse never
 * edits their files), the approved apps with Revoke, and the audit log.
 */
export function McpSection() {
  const [s, setS, load] = useMcpStatus();
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<Target>("claudeDesktop");
  const [copied, setCopied] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  useEffect(() => {
    const read = () => void nativeCall<{ entries: AuditEntry[] }>("mcp.audit").then((r) => setAudit(r.entries), () => {});
    read();
    return onNative("mcp", read);
  }, []);
  if (!s) return null;
  const toggle = () => {
    setBusy(true);
    void nativeCall<McpStatusView>(s.enabled ? "mcp.disable" : "mcp.enable").then(setS, load).finally(() => setBusy(false));
  };
  const copy = () => void navigator.clipboard?.writeText(s.snippets[target]).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  const revoke = (id: string) => void nativeCall<McpStatusView>("mcp.revoke", { id }).then(setS, load);
  return (
    <div className="updates">
      <h3>{STR_MCP.title}</h3>
      <div className="settings-card mcp-card">
        <div className="settings-row">
          <span id="mcp-access-label" style={{ flexGrow: 1 }}>{STR_MCP.access}</span>
          <button type="button" role="switch" aria-checked={s.enabled} aria-labelledby="mcp-access-label" disabled={busy}
            className={s.enabled ? "switch on" : "switch"} onClick={toggle} />
        </div>
        {s.error && <div className="settings-row"><span className="error" role="alert">{s.error}</span></div>}
        {s.enabled && (
          <>
            <div className="settings-row">
              <span style={{ flexGrow: 1 }}>{STR_MCP.setup}</span>
              <Segmented<Target> label={STR_MCP.setup} value={target} options={TARGETS} onChange={setTarget} />
            </div>
            <div className="settings-row mcp-snippet-row">
              <pre className="mcp-snippet" data-testid="mcp-snippet">{s.snippets[target]}</pre>
              <button type="button" className="btn-outline small" onClick={copy}>{copied ? STR_MCP.copied : STR_MCP.copy}</button>
            </div>
          </>
        )}
      </div>
      {(s.enabled || s.clients.length > 0) && (
        <>
          <h3>{STR_MCP.apps}</h3>
          <div className="settings-card" role="list" aria-label={STR_MCP.apps}>
            {s.clients.length === 0 ? <span className="muted">{STR_MCP.noApps}</span> : s.clients.map((c) => (
              <div className="settings-row" role="listitem" key={c.id}>
                <span style={{ flexGrow: 1, minWidth: 0 }} title={c.exe ?? undefined}>{c.name}</span>
                <span className="muted">{STR_MCP.lastUsed(ago(c.lastSeenAt))}</span>
                <button type="button" className="btn-outline small" aria-label={STR_MCP.revokeApp(c.name)} onClick={() => revoke(c.id)}>{STR_MCP.revoke}</button>
              </div>
            ))}
          </div>
        </>
      )}
      {audit.length > 0 && (
        <>
          <h3>{STR_MCP.activity}</h3>
          <div className="settings-card mcp-activity" role="list" aria-label={STR_MCP.activity}>
            {audit.map((e, i) => (
              <div className="settings-row" role="listitem" key={`${e.at}-${i}`}>
                <span style={{ flexGrow: 1, minWidth: 0 }}>{e.client} · {e.tool}{e.bot ? ` · ${e.bot}` : ""}</span>
                {STR_MCP.outcome[e.outcome] ? <span className="muted">{STR_MCP.outcome[e.outcome]}</span> : null}
                <span className="muted">{new Date(e.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

registerSectionBlock("system", "mcp", 15, McpSection);
