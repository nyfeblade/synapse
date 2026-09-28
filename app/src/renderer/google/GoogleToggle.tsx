import { useEffect } from "react";
import { STRG } from "@synapse/shared";
import { call } from "../bridge";
import { acceptAgent, useUi } from "../store";
import { useGoogle, useGoogleSync } from "./store";

/** Bot Settings: per-Bot "Google" (default off). Tools reach the Bot only when this is on and Google is connected. */
export function GoogleToggle({ botId }: { botId: string }) {
  const on = useUi((s) => s.bots[botId]?.settings.google === true);
  const { status, load, openSheet } = useGoogle();
  useGoogleSync();
  useEffect(() => { if (!status) void load(); }, [status, load]);
  const connected = status?.state === "connected" || status?.state === "needs-reconnect";
  const toggle = () => {
    call("setAgentGoogle", { id: botId, enabled: !on })
      .then((r) => acceptAgent(r.agent))
      .catch((e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) }));
  };
  return (
    <div className="settings-card">
      <div className="settings-row" data-setting="google">
        <span style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
          <span>{STRG.botToggle}</span>
          {/* A connected account is not the same as a usable connector: until this switch is on, the Bot has no
              Google tools at all. Say that here rather than describing tools it cannot call. */}
          {/* Four lines for four states, because the row has TWO independent halves — this Bot's switch
              and the account behind it — and host/google/module.ts's botStatus() is the state machine
              that decides what the Bot actually has. It used to collapse both un-connected cases onto
              botToggleNeedsConnect, so turning the switch on left an ON switch sitting above "connect
              Google first". The switch stays operable without an account on purpose: publish() wakes
              and respawns every already-enabled Bot the instant the account connects. */}
          {!connected
            ? <a href="#" className="muted" onClick={(e) => { e.preventDefault(); openSheet(); }}>{on ? STRG.botToggleOnBeforeConnect : STRG.botToggleNeedsConnect}</a>
            : on ? <span className="muted">{STRG.botToggleSub}</span>
            : <span className="muted">{STRG.botToggleOffWhileConnected(status?.email ?? null)}</span>}
        </span>
        <button type="button" role="switch" aria-checked={on} aria-label={STRG.botToggle} className={on ? "switch on" : "switch"} onClick={toggle} />
      </div>
    </div>
  );
}
