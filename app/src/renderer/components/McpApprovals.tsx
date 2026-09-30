import { useEffect, useState } from "react";
import { STR_MCP } from "@synapse/shared";
import { nativeCall, onNative } from "../native";
import { Announce } from "./Announce";

/** What main's mcp.status answers (app/src/main/mcp/wire.ts). */
export interface McpStatusView {
  enabled: boolean;
  error: string | null;
  clients: { id: string; key: string; name: string; exe: string | null; createdAt: number; lastSeenAt: number }[];
  pending: { id: string; key: string; name: string; exe: string | null; createdAt: number }[];
  snippets: { claudeDesktop: string; claudeCode: string; cursor: string };
}

/** Main's MCP status, kept fresh by its "mcp" events. Nothing is asked while nobody renders this. */
export function useMcpStatus(): [McpStatusView | null, (v: McpStatusView) => void, () => void] {
  const [s, setS] = useState<McpStatusView | null>(null);
  const load = () => void nativeCall<McpStatusView>("mcp.status").then((v) => { if (v && typeof v.enabled === "boolean") setS(v); }, () => {});
  useEffect(() => {
    load();
    return onNative("mcp", () => load());
  }, []);
  return [s, setS, load];
}

/**
 * 0.1.4: an app asking to use the owner's Bots over MCP, on first connect. Names the app and the program that
 * launched it; Allow issues its token, Deny turns it away. An MCP client can never answer this itself.
 */
export function McpApprovals() {
  const [s, setS, load] = useMcpStatus();
  const [busy, setBusy] = useState(false);
  if (!s?.pending.length) return null;
  const act = (name: "mcp.allow" | "mcp.deny", id: string) => {
    setBusy(true);
    void nativeCall<McpStatusView>(name, { id }).then(setS, load).finally(() => setBusy(false));
  };
  return (
    <Announce>
      <div className="key-prompts" data-announcement="mcp-approvals">
        {s.pending.map((p) => (
          <div key={p.id} className="disk-banner key-prompt mcp-approval" role="alertdialog" aria-label={STR_MCP.wants(p.name)}>
            <span className="mcp-approval-text">
              <span>{STR_MCP.wants(p.name)}</span>
              {p.exe && <span className="muted small mcp-exe" title={p.exe}>{p.exe}</span>}
            </span>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => act("mcp.deny", p.id)}>{STR_MCP.deny}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => act("mcp.allow", p.id)}>{STR_MCP.allow}</button>
          </div>
        ))}
      </div>
    </Announce>
  );
}
