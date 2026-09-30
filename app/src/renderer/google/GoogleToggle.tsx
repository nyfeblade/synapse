import { useEffect } from "react";
import { STRG } from "@synapse/shared";
import { call } from "../bridge";
import { acceptAgent, useUi } from "../store";
import { useGoogle, useGoogleSync } from "./store";
import { CopyRow } from "./GoogleSetupGuide";

const plus = (email: string, tag: string) => `${email.slice(0, email.lastIndexOf("@"))}+${tag}@${email.slice(email.lastIndexOf("@") + 1)}`;

/** 4.3 Email in (off by default): forward mail to the Bot's plus address, or label it Synapse/<Bot>. */
function EmailInRow({ botId, emails }: { botId: string; emails: string[] }) {
  const on = useUi((s) => s.bots[botId]?.settings.emailIn === true);
  const tag = useUi((s) => s.bots[botId]?.settings.emailInTag ?? null);
  const name = useUi((s) => s.bots[botId]?.profile.name ?? "");
  const toggle = () => {
    call("setAgentEmailIn", { id: botId, enabled: !on })
      .then((r) => acceptAgent(r.agent))
      .catch((e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) }));
  };
  return (
    <div className="email-in" data-setting="email-in">
      <div className="settings-row">
        <span style={{ flexGrow: 1 }}>{STRG.emailIn}</span>
        <button type="button" role="switch" aria-checked={on} aria-label={STRG.emailIn} className={on ? "switch on" : "switch"} onClick={toggle} />
      </div>
      {on && tag && (
        <div className="email-in-addresses">
          {emails.map((e) => <CopyRow key={e} label={STRG.emailInAddress} value={plus(e, tag)} />)}
          <CopyRow label={STRG.emailInLabel} value={STRG.emailInLabelName(name)} />
        </div>
      )}
    </div>
  );
}

/** Bot Settings: per-Bot "Google" (default off). Tools reach the Bot only when this is on and Google is connected. */
export function GoogleToggle({ botId }: { botId: string }) {
  const on = useUi((s) => s.bots[botId]?.settings.google === true);
  const { status, load, openSheet, setAccountGrant } = useGoogle();
  useGoogleSync();
  useEffect(() => { if (!status) void load(); }, [status, load]);
  const connected = status?.state === "connected" || status?.state === "needs-reconnect";
  const accounts = status?.accounts ?? [];
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
      {/* 4.3b: which accounts this Bot may use. One account is simply on with the switch; with several (or none
          ticked), each is a checkbox. Default none for an account added later. */}
      {on && connected && (accounts.length > 1 || !accounts.some((a) => a.bots.includes(botId))) && (
        <div className="account-checks" role="group" aria-label={STRG.accounts}>
          {accounts.map((a) => {
            const label = a.email ?? STRG.accountFallback;
            const ticked = a.bots.includes(botId);
            return (
              <label key={a.id} className="check-row" data-account={a.id}>
                <input type="checkbox" checked={ticked} aria-label={label} onChange={() => void setAccountGrant(botId, a.id, !ticked)} />
                <span className="account-label">{label}</span>
              </label>
            );
          })}
        </div>
      )}
      {on && connected && <EmailInRow botId={botId} emails={accounts.filter((a) => a.bots.includes(botId) && a.email).map((a) => a.email!)} />}
    </div>
  );
}
