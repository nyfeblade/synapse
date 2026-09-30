import { useState, type ChangeEvent } from "react";
import { STR } from "@synapse/shared";
import { call, GatewayCallError } from "../bridge";

export function MailboxForm({ botId, onDone }: { botId: string; onDone(): void }) {
  const [f, setF] = useState({ label: "", host: "", port: "993", user: "", appPassword: "" });
  const [error, setError] = useState<string | null>(null);
  const bind = (k: keyof typeof f) => ({ value: f[k], onChange: (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });
  const save = async () => {
    try {
      setError(null);
      await call("addMailbox", { id: botId, label: f.label.trim(), host: f.host.trim(), port: Number(f.port), user: f.user.trim(), appPassword: f.appPassword });
      onDone();
    } catch (e) {
      setError(e instanceof GatewayCallError ? e.message : String(e));
    }
  };
  return (
    <div className="mailbox-form">
      <input className="text-input" aria-label="Mailbox label" placeholder="work" {...bind("label")} />
      <input className="text-input" aria-label="IMAP host" placeholder="imap.fastmail.com" {...bind("host")} />
      <input className="text-input" aria-label="IMAP port" inputMode="numeric" {...bind("port")} />
      <input className="text-input" aria-label="User" {...bind("user")} />
      <input className="text-input" aria-label="App password" type="password" {...bind("appPassword")} />
      <button type="button" className="btn-outline small" onClick={() => void save()}>Save mailbox</button>
      {error && <span role="alert" className="form-error">{error}</span>}
      <span className="field-help">{STR.addMailbox}: the password is stored on the computer and never shown to the Bot.</span>
    </div>
  );
}
