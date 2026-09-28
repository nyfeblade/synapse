import { useState, type ChangeEvent } from "react";
import { STR, type SendMessageEntry } from "@synapse/shared";
import { call, GatewayCallError } from "../bridge";

const LABEL = { slack: "Slack", github: "GitHub", linear: "Linear", sentry: "Sentry" } as const;
export type ListenerPlatform = keyof typeof LABEL;

/** The host can store a secret and still not be connected; say what it is waiting for instead of no-opping. */
function stillNeeded(platform: ListenerPlatform, fields: Record<string, string>): string {
  if (platform === "slack") {
    const missing = [fields.appToken ? null : "app-level token", fields.botToken ? null : "bot token"].filter(Boolean) as string[];
    if (missing.length) return `${LABEL.slack} still needs the ${missing.join(" and the ")}.`;
  }
  if (platform === "github" && !fields.token) return `${LABEL.github} still needs a personal access token.`;
  return `${LABEL[platform]} isn't connected yet — check the values and try again.`;
}

export function ConnectListenerForm({ botId, platform, onConnected }: { botId: string; platform: ListenerPlatform; onConnected?(): void }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: ChangeEvent<HTMLInputElement>) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { connected } = await call("setListenerCredentials", { id: botId, platform, fields });
      if (connected) { setDone(true); onConnected?.(); }
      else setError(stillNeeded(platform, fields));
    } catch (e) {
      setError(e instanceof GatewayCallError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (done) return <span className="connect-done">Connected</span>;
  return (
    <div className="connect-form">
      {platform === "slack" && (
        <>
          <input type="password" aria-label="Slack app token" placeholder="xapp-…" onChange={set("appToken")} />
          <input type="password" aria-label="Slack bot token" placeholder="xoxb-…" onChange={set("botToken")} />
        </>
      )}
      {platform === "github" && <input type="password" aria-label="GitHub token" placeholder="github_pat_…" onChange={set("token")} />}
      {/* I4: provider webhooks are refused unless signed with this secret */}
      <input type="password" aria-label={`${LABEL[platform]} webhook signing secret`} placeholder="Webhook signing secret" onChange={set("signingSecret")} />
      <button type="button" className="btn-outline small" disabled={busy} onClick={() => void submit()}>{STR.connect}</button>
      {error && <span role="alert" className="form-error">{error}</span>}
    </div>
  );
}

/** RTN-12 connect card: "Connect <platform> so this routine can fire". */
export function ConnectListenerCard({ botId, entry }: { botId: string; entry: SendMessageEntry }) {
  if (entry.message.type !== "card") return null;
  const card = entry.message.card;
  if (card.kind !== "connect-listener") return null;
  return (
    <section className="connect-card" aria-label={STR.connectSoRoutineCanFire(LABEL[card.platform])}>
      <div className="connect-title">{STR.connectSoRoutineCanFire(LABEL[card.platform])}</div>
      <div className="connect-sub">{card.routineName}</div>
      {card.connected ? <span className="connect-done">Connected</span> : <ConnectListenerForm botId={botId} platform={card.platform} />}
    </section>
  );
}
