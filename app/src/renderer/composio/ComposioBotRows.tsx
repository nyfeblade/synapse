import { useEffect } from "react";
import { STRX } from "@synapse/shared";
import { useComposio, useComposioSync } from "./store";

/** Bot Settings: one switch per app connected through Composio (default off). Hidden until an app is connected. */
export function ComposioBotRows({ botId }: { botId: string }) {
  const { status, load, setGrant } = useComposio();
  useComposioSync();
  useEffect(() => { if (!status) void load(); }, [status, load]);
  const apps = (status?.apps ?? []).filter((a) => a.state === "connected");
  if (!apps.length) return null;
  return (
    <div className="settings-card" aria-label={STRX.marketplaceSection}>
      {apps.map((a) => {
        const on = a.bots.includes(botId);
        const accounts = (a.accounts ?? []).filter((x) => x.state === "connected");
        // 4.3b: an app with one account is one switch; with several, one checkbox per account.
        if (accounts.length > 1) {
          return (
            <div key={a.toolkit} className="settings-row account-group" data-setting={`composio-${a.toolkit}`}>
              <span className="account-group-title">{a.name}</span>
              <div className="account-checks" role="group" aria-label={a.name}>
                {accounts.map((x) => {
                  const ticked = x.bots.includes(botId);
                  return (
                    <label key={x.id} className="check-row" data-account={x.id}>
                      <input type="checkbox" checked={ticked} aria-label={x.label} onChange={() => void setGrant(a.toolkit, botId, !ticked, x.id)} />
                      <span className="account-label">{x.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        }
        return (
          <div key={a.toolkit} className="settings-row" data-setting={`composio-${a.toolkit}`}>
            <span className="grow">{a.name}</span>
            <button type="button" role="switch" aria-checked={on} aria-label={a.name} className={on ? "switch on" : "switch"} onClick={() => void setGrant(a.toolkit, botId, !on)} />
          </div>
        );
      })}
    </div>
  );
}
