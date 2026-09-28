import { useEffect, useState } from "react";
import { STR, STRV } from "@synapse/shared";
import { nativeCall, onNative } from "../native";

/** What the main process reports about whisper (bug 165). */
export interface WhisperInfo {
  state: "ready" | "light" | "no-model" | "no-build";
  name: string | null;
  size: string;
  inCalls: boolean;
}

type Progress = { state: "downloading"; received: number; total: number } | { state: "ready"; name: string } | { state: "failed"; message: string };

/** "312 MB of 574 MB" — a real bar, because a 574 MB download deserves better than a spinner. */
export function downloadLabel(p: Progress): string {
  if (p.state === "downloading") return STRV.whisperDownloading(Math.round(p.received / 1e6), Math.round(p.total / 1e6));
  if (p.state === "failed") return STRV.whisperFailed(p.message);
  return STRV.whisperReady;
}

/**
 * Bug 165, Settings → Voice. In Light mode this card is not there at all: whisper is a Full-mode
 * engine and a row that does nothing is worse than no row.
 *
 * There is deliberately no on/off switch for whisper itself — the voice mode above is the switch.
 * The one choice this card makes is the one the MEASUREMENTS left open: calls. Whisper changes the
 * words on 52% of turns, and a call starts composing its reply from the partial, so in a call the
 * better transcript costs that early start every other turn on top of its own ~470 ms. Dictation
 * has no such cost, which is why dictation gets it and a call only if the user says so.
 */
export function WhisperCard() {
  const [info, setInfo] = useState<WhisperInfo | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const load = () => { void nativeCall<WhisperInfo>("whisper.status.get").then((r) => setInfo(r ?? null), () => setInfo(null)); };
  useEffect(() => {
    load();
    return onNative("whisper", (p: Progress) => {
      setProgress(p);
      // A finished download changes what the status says, so ask again rather than guessing.
      if (p.state !== "downloading") load();
    });
  }, []);
  if (!info || info.state === "light") return null;

  if (info.state === "no-build") {
    return (
      <div className="settings-row">
        <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <span>{STRV.whisperTitle}</span>
          <span className="muted">{STRV.whisperNoBuild}</span>
        </span>
      </div>
    );
  }

  if (info.state === "no-model") {
    const busy = progress?.state === "downloading";
    return (
      <div className="settings-row">
        <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <span>{STRV.whisperTitle}</span>
          <span className="muted">{progress ? downloadLabel(progress) : STRV.whisperNoModel}</span>
        </span>
        <button type="button" className="secondary" disabled={busy}
          onClick={() => { setProgress({ state: "downloading", received: 0, total: 574_000_000 }); void nativeCall("whisper.model.download").catch(() => setProgress({ state: "failed", message: STRV.whisperOffline })); }}>
          {busy ? STRV.whisperDownloadingShort : STRV.whisperDownload}
        </button>
      </div>
    );
  }

  return (
    <div className="settings-row">
      <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <span>{STRV.whisperInCalls}</span>
        <span className="muted">{STRV.whisperInCallsHelp(info.size)}</span>
        {saveError && <span className="error" role="alert">{saveError}</span>}
      </span>
      <button type="button" role="switch" aria-checked={info.inCalls} aria-label={STRV.whisperInCalls} aria-busy={saving} disabled={saving}
        className={info.inCalls ? "switch on" : "switch"}
        onClick={() => {
          if (saving) return;
          const was = info.inCalls; // the confirmed value: no second click gets in while this save is in flight
          const on = !was;
          setInfo({ ...info, inCalls: on });
          setSaveError(null);
          setSaving(true);
          // settings-persist: a failed save went back without a word; it says so now.
          void nativeCall("whisper.inCalls.set", { on })
            .catch(() => { setInfo((i) => (i ? { ...i, inCalls: was } : i)); setSaveError(STR.settingNotSaved); })
            .finally(() => setSaving(false));
        }} />
    </div>
  );
}
