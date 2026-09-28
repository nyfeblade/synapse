import { useEffect, useState } from "react";
import { STR, type CommandName } from "@synapse/shared";
import { useAsync } from "../async-resource";
import { callQuiet } from "../bridge";
import { useUi } from "../store";
import { SavedSwitch } from "./SavedSwitch";

/** settings-persist: the event LocalToolCard sends when a card's answer may have changed this Mac's per-Bot record. */
export const LOCAL_PERMISSION_CHANGED = "synapse:local-permission-changed";

export function noteLocalPermissionChanged(botId: string): void {
  window.dispatchEvent(new CustomEvent(LOCAL_PERMISSION_CHANGED, { detail: botId }));
}

type Get = "getLocalBrowserAllowed" | "getLocalMacAppAllowed";
type Set = "setLocalBrowserAllowed" | "setLocalMacAppAllowed";

/**
 * One per-Bot ability switch recorded on THIS Mac (mac-browser, mac-apps). The coordinator is the only
 * writer and the only reader; the host is never asked.
 *
 * settings-persist, the ways the old rows lied:
 *  - A read that failed (the coordinator not connected yet on a fresh launch, a reconnect in progress)
 *    was drawn as a plain Off switch, and nothing ever asked again: a Bot whose switch was ON on disk
 *    showed OFF until the panel was reopened. It now says it could not read, offers Retry, and re-reads
 *    on every (re)connect and whenever a permission card for this Bot is answered.
 *  - A click showed nothing until a second round trip came back, and a save that failed said so only in
 *    a banner far away. It now flips at once, takes the coordinator's read-back as the truth, and a save
 *    that failed or that the Mac did not keep goes back to what is saved with a short error beside it.
 */
export function LocalPermissionRow({ botId, get, set, setting, label, help }: { botId: string; get: Get; set: Set; setting: string; label: string; help: string }) {
  const connected = useUi((s) => s.connection.kind === "connected");
  // callQuiet: a failed read is shown in this row, with its own Retry.
  const r = useAsync(() => callQuiet(get as CommandName, { id: botId } as never) as Promise<{ allowed?: unknown }>, [botId, connected]);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { reload } = r;
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === botId) reload(); };
    window.addEventListener(LOCAL_PERMISSION_CHANGED, on);
    return () => window.removeEventListener(LOCAL_PERMISSION_CHANGED, on);
  }, [botId, reload]);
  useEffect(() => { setPending(null); setError(null); }, [botId]);

  const saved = r.status === "ready" ? r.value?.allowed === true : null;
  const on = pending ?? saved === true;
  const flip = () => {
    if (saved === null || pending !== null) return;
    const want = !saved;
    setPending(want);
    setError(null);
    // callQuiet: the failure is shown here, next to the switch that went back.
    void (callQuiet(set as CommandName, { id: botId, allowed: want } as never) as Promise<{ allowed?: unknown }>).then(
      (res) => {
        const kept = res?.allowed === true;
        r.setValue({ allowed: kept });
        if (kept !== want) setError(STR.settingNotSaved);
      },
      (e: unknown) => setError(`${STR.settingNotSaved} ${e instanceof Error ? e.message : String(e)}`.trim()),
    ).finally(() => setPending(null));
  };
  return (
    <div className="settings-row" data-setting={setting} style={{ flexWrap: "wrap" }}>
      <span style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
        <span>{label}</span>
        <span className="muted">{help}</span>
        {r.status === "error" && (
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="error" role="alert">{r.message || STR.settingNotLoaded}</span>
            <button type="button" className="link-btn" onClick={reload}>{STR.retry}</button>
          </span>
        )}
        {error && <span className="error" role="alert">{error}</span>}
      </span>
      {/* Until the Mac's record is read there is no switch, only a neutral placeholder: never an Off standing in for it. */}
      <SavedSwitch label={label} value={saved === null ? null : on} busy={pending !== null} failed={r.status === "error"} onToggle={flip} />
    </div>
  );
}
