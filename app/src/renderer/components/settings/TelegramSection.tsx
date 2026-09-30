import { useEffect, useState } from "react";
import { STR_TELEGRAM } from "@synapse/shared";
import { nativeCall, onNative } from "../../native";
import { registerSectionBlock } from "./sections";

/** What main's Telegram bridge reports (main/telegram/bridge.ts). Never the token. */
export interface TelegramStatusView {
  enabled: boolean;
  polling: boolean;
  hasToken: boolean;
  botUsername: string | null;
  owner: { name: string; pairedAt: number } | null;
  pairing: { code: string; link: string | null; expiresAt: number } | null;
  error: string | null;
}

const T = STR_TELEGRAM;

/**
 * Wave 4.1: Settings → System → Telegram. The owner's own bot token (sealed on this Mac), the switch (off by
 * default), pairing by a one-time code sent to the bot, and Unpair / Remove.
 */
export function TelegramSection() {
  const [s, setS] = useState<TelegramStatusView | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => void nativeCall<TelegramStatusView>("telegram.status").then((v) => { if (v && typeof v.enabled === "boolean") setS(v); }, () => {});
  useEffect(() => {
    load();
    return onNative("telegram", () => load());
  }, []);
  if (!s) return null;
  const run = (name: string, args: unknown = {}) => {
    setBusy(true);
    setErr(null);
    void nativeCall<TelegramStatusView>(name, args)
      .then((v) => { setS(v); if (name === "telegram.setToken") setToken(""); }, (e: unknown) => { setErr(e instanceof Error ? e.message : String(e)); load(); })
      .finally(() => setBusy(false));
  };
  const error = err ?? (s.error ? T.errors[s.error] ?? null : null);
  return (
    <div className="updates">
      <h3>{T.title}</h3>
      <div className="settings-card telegram-card">
        <div className="settings-row">
          <span id="telegram-access-label" style={{ flexGrow: 1 }}>{T.access}</span>
          <button type="button" role="switch" aria-checked={s.enabled} aria-labelledby="telegram-access-label" disabled={busy || !s.hasToken}
            className={s.enabled ? "switch on" : "switch"} onClick={() => run(s.enabled ? "telegram.disable" : "telegram.enable")} />
        </div>
        {s.hasToken ? (
          <div className="settings-row">
            <span style={{ flexGrow: 1 }}>{T.bot}</span>
            <span className="muted">@{s.botUsername}</span>
            <button type="button" className="btn-outline small" disabled={busy} onClick={() => run("telegram.remove")}>{T.remove}</button>
          </div>
        ) : (
          <div className="settings-row">
            <input className="text-input" type="password" aria-label={T.token} placeholder={T.tokenPlaceholder} value={token}
              autoComplete="off" spellCheck={false} style={{ flexGrow: 1 }} onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) run("telegram.setToken", { token }); }} />
            <button type="button" className="btn-outline small" disabled={busy || !token.trim()} onClick={() => run("telegram.setToken", { token })}>{T.save}</button>
          </div>
        )}
        {s.enabled && s.owner && (
          <div className="settings-row">
            <span style={{ flexGrow: 1, minWidth: 0 }}>{T.pairedWith} {s.owner.name}</span>
            <button type="button" className="btn-outline small" disabled={busy} onClick={() => run("telegram.unpair")}>{T.unpair}</button>
          </div>
        )}
        {s.enabled && s.polling && !s.pairing && (
          <div className="settings-row">
            <span style={{ flexGrow: 1 }} />
            <button type="button" className="btn-outline small" disabled={busy} onClick={() => run("telegram.pair.start")}>{T.pair}</button>
          </div>
        )}
        {s.enabled && s.pairing && (
          <div className="settings-row">
            <span style={{ flexGrow: 1 }}>{T.pairingCode}</span>
            <code className="telegram-code" data-testid="telegram-code">{s.pairing.code}</code>
            {s.pairing.link && <button type="button" className="btn-outline small" onClick={() => void nativeCall("openExternal", { url: s.pairing!.link }).catch(() => {})}>{T.openTelegram}</button>}
            <button type="button" className="btn-outline small" onClick={() => run("telegram.pair.cancel")}>{T.cancel}</button>
          </div>
        )}
        {error && <div className="settings-row"><span className="error" role="alert">{error}</span></div>}
      </div>
    </div>
  );
}

registerSectionBlock("system", "telegram", 16, TelegramSection);
