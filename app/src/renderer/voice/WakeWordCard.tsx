import { useEffect, useState } from "react";
import { STRV } from "@synapse/shared";
import { nativeCall, onNative } from "../native";
import { PrivacySettingsButton } from "./PrivacySettingsButton";

export interface WakeStateView { enabled: boolean; pauseOnBattery: boolean; listening: boolean; pausedFor: string[]; error: string | null; errorPane?: "microphone" | "speech" | null; names: number }

/** Settings → Voice: “Hey <Bot name>” (off by default), whether it pauses on battery, and — live — whether it is listening and why not. */
export function WakeWordCard() {
  const [s, setS] = useState<WakeStateView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void nativeCall<WakeStateView | null>("wake.get").then((r) => (typeof r?.enabled === "boolean" ? setS(r) : setErr(null)), () => setErr(null));
    return onNative<{ type: string; state?: WakeStateView }>("wake", (e) => { if (e.type === "state" && e.state) setS(e.state); });
  }, []);
  const save = (p: Partial<Pick<WakeStateView, "enabled" | "pauseOnBattery">>) =>
    void nativeCall<WakeStateView>("wake.set", p).then(setS, (e: Error) => setErr(e.message));
  if (!s) return err ? <div className="settings-card"><span className="muted">{err}</span></div> : null;
  return (
    <div className="settings-card wake-word-card">
      <div className="settings-row">
        <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <span id="wake-word-label">{STRV.wakeWord}</span>
          
        </span>
        <button type="button" role="switch" aria-checked={s.enabled} aria-label={STRV.wakeWord} className={s.enabled ? "switch on" : "switch"} onClick={() => save({ enabled: !s.enabled })} />
      </div>
      {s.enabled && (
        <>
          <div className="settings-row">
            <span className={s.listening ? "wake-status live" : "wake-status muted"} role="status" style={{ flexGrow: 1 }}>{err ?? STRV.wakeStatus(s)}</span>
            {!err && s.pausedFor[0] === "error" && s.errorPane && <PrivacySettingsButton pane={s.errorPane} />}
          </div>
          <div className="settings-row">
            <span style={{ flexGrow: 1 }}>{STRV.wakePauseOnBattery}</span>
            <button type="button" role="switch" aria-checked={s.pauseOnBattery} aria-label={STRV.wakePauseOnBattery} className={s.pauseOnBattery ? "switch on" : "switch"} onClick={() => save({ pauseOnBattery: !s.pauseOnBattery })} />
          </div>
        </>
      )}
    </div>
  );
}
