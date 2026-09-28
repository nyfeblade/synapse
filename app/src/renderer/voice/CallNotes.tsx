import { useState } from "react";
import { STRV } from "@synapse/shared";
import { nativeCall } from "../native";
import { useUi } from "../store";
import { PauseIcon, PlayIcon } from "../components/Icons";

/**
 * Bug 134 (item 11): a Bot's voicemail in its chat — the missed-call line, a play button and the
 * transcript. The audio is rendered in the Bot's voice on this Mac the first time it plays, kept there
 * (30 days) and never uploaded; with no natural voice, Apple's voice reads the transcript.
 */
export function VoicemailNote({ botId, entryId, missed, text }: { botId: string; entryId: string; missed: string; text: string }) {
  const [playing, setPlaying] = useState(false);
  const bot = useUi((s) => s.bots[botId]);
  const toggle = () => {
    if (playing) { setPlaying(false); void nativeCall("voicemail.stop").catch(() => {}); return; }
    setPlaying(true);
    const st = bot?.settings;
    void nativeCall("voicemail.play", { id: entryId, text, ...(st?.voice ? { voice: st.voice } : {}), ...(st?.speechRate ? { rate: st.speechRate } : {}) })
      .catch(() => {}).finally(() => setPlaying(false));
  };
  return (
    <div className="event-row notice voicemail" data-testid="voicemail">
      <span className="voicemail-head">
        <button type="button" className="round-btn" aria-pressed={playing} aria-label={playing ? STRV.pauseVoicemail : STRV.playVoicemail} title={playing ? STRV.pauseVoicemail : STRV.playVoicemail} onClick={toggle}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span>{missed}</span>
      </span>
      <span className="voicemail-text">{text}</span>
    </div>
  );
}

/** Bug 134 (item 4): a substantial call's compact summary with its action items. */
export function CallSummaryNote({ title, summary, actions }: { title: string; summary: string; actions: string[] }) {
  return (
    <div className="event-row notice call-summary" role="note" aria-label={title} data-testid="call-summary">
      <span className="call-summary-title">{title}</span>
      <span className="call-summary-text">{summary}</span>
      {actions.length > 0 && (
        <>
          <span className="call-summary-label">{STRV.actionItems}</span>
          <ul className="call-summary-actions">{actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </>
      )}
    </div>
  );
}
