import { useEffect, useState } from "react";
import type { McpServerView } from "@synapse/shared";
import { call, callQuiet } from "../bridge";
import { subscribeChannel } from "../feature-store";

/**
 * 4.3b, Bot Settings: an MCP app with more than one account (one server each, e.g. Linear and Linear (work)) gets one
 * checkbox per account. Apps with a single account aren't listed: they stay on for every Bot, as before.
 */
export function McpAccountRows({ botId }: { botId: string }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  useEffect(() => {
    const keep = (xs: unknown) => setServers(Array.isArray(xs) ? (xs as McpServerView[]) : []);
    void Promise.resolve().then(() => callQuiet("listMcpServers", {})).then((r) => keep(r?.servers), () => {});
    return subscribeChannel("mcp-servers", (p) => keep(p?.servers));
  }, []);
  const groups = new Map<string, McpServerView[]>();
  for (const s of servers) groups.set(s.name.toLowerCase(), [...(groups.get(s.name.toLowerCase()) ?? []), s]);
  const multi = [...groups.values()].filter((g) => g.length > 1);
  if (!multi.length) return null;
  const toggle = (s: McpServerView, on: boolean) => {
    void Promise.resolve().then(() => call("setMcpServerBots", { serverId: s.id, botId, enabled: on })).then((r) => setServers((xs) => xs.map((x) => (x.id === s.id && r?.server ? r.server : x))), () => {});
  };
  return (
    <div className="settings-card">
      {multi.map((g) => (
        <div key={g[0]!.id} className="settings-row account-group" data-setting={`mcp-${g[0]!.name.toLowerCase()}`}>
          <span className="account-group-title">{g[0]!.name}</span>
          <div className="account-checks" role="group" aria-label={g[0]!.name}>
            {g.map((s) => {
              const label = s.label ? `${s.name} (${s.label})` : s.name;
              const ticked = !s.bots || s.bots.includes(botId);
              return (
                <label key={s.id} className="check-row" data-account={s.id}>
                  <input type="checkbox" checked={ticked} aria-label={label} onChange={() => toggle(s, !ticked)} />
                  <span className="account-label">{label}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
