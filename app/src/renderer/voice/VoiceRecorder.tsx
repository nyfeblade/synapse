/**
 * Settings → Voice: record a reference clip and save it as a cloned voice.
 *
 * One sentence, seven to ten seconds. The script is known in advance, so the transcript
 * is pre-filled from it and the user only corrects it if they said something different —
 * a transcript that does not match the audio is the main cause of a poor clone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLIP_MAX_S, CLIP_MIN_S, CLIP_TARGET_MAX_S, CLIP_TARGET_MIN_S, CLONE_RIGHTS_NOTE, CLONE_SCRIPTS,
  CLONE_TIPS, DEFAULT_CLONE_SCRIPT, STR5, checkTranscript, type ClipCheck,
} from "@synapse/shared";
import { nativeCall } from "../native";
import {
  checkTake, openRecorder, saveTake, toClipRate, useClonedVoices, useMeter,
  type ClonedVoiceView, type Recorder, type TakeVerdict,
} from "./cloned-voices";

type Phase = "idle" | "recording" | "checking" | "review" | "saving";

export function VoiceRecorder({ onSaved }: { onSaved?: (v: ClonedVoiceView) => void }) {
  const { voices, reload } = useClonedVoices();
  const [phase, setPhase] = useState<Phase>("idle");
  const [scriptId, setScriptId] = useState(DEFAULT_CLONE_SCRIPT.id);
  const [ownWords, setOwnWords] = useState(false);
  const [transcript, setTranscript] = useState(DEFAULT_CLONE_SCRIPT.text);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<TakeVerdict | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const meter = useMeter();
  const rec = useRef<{ recorder: Recorder; sampleRate: number } | null>(null);
  const take = useRef<Float32Array | null>(null);

  const script = CLONE_SCRIPTS.find((s) => s.id === scriptId) ?? DEFAULT_CLONE_SCRIPT;
  // The chosen script is the transcript, character for character, unless the user is using
  // their own words — then they type what they said.
  useEffect(() => { if (!ownWords) setTranscript(script.text); }, [script.text, ownWords]);
  useEffect(() => () => rec.current?.recorder.close(), []);

  const start = useCallback(async () => {
    setError(null);
    setVerdict(null);
    setSaved(null);
    meter.reset();
    try {
      const chosen = await nativeCall<{ input?: string | null }>("audio.devices.get").catch(() => ({ input: null }));
      const r = await openRecorder({ deviceId: chosen?.input ?? null });
      r.onBlock((level, seconds) => meter.set(level, seconds));
      rec.current = { recorder: r.recorder, sampleRate: r.sampleRate };
      await r.recorder.start();
      setPhase("recording");
    } catch (e) {
      setError((e as Error)?.message ? STR5.recordFailed((e as Error).message) : STR5.recordNoMic);
      setPhase("idle");
    }
  }, [meter]);

  const stop = useCallback(async () => {
    const r = rec.current;
    if (!r) return;
    setPhase("checking");
    const raw = r.recorder.stop();
    r.recorder.close();
    rec.current = null;
    const pcm = toClipRate(raw, r.sampleRate);
    take.current = pcm;
    try {
      setVerdict(await checkTake(pcm));
      setPhase("review");
    } catch (e) {
      setError(STR5.recordFailed((e as Error).message));
      setPhase("idle");
    }
  }, []);

  const save = useCallback(async () => {
    if (!take.current) return;
    setPhase("saving");
    try {
      const r = await saveTake({
        pcm: take.current,
        name: name.trim() || STR5.recordNamePlaceholder,
        transcript: transcript.trim(),
        scriptId: ownWords ? "own" : script.id,
      });
      setSaved(r.voice.name);
      setPhase("idle");
      take.current = null;
      setVerdict(null);
      reload();
      onSaved?.(r.voice);
    } catch (e) {
      setError(STR5.recordFailed((e as Error).message));
      setPhase("review");
    }
  }, [name, transcript, ownWords, script.id, reload, onSaved]);

  const retake = () => { take.current = null; setVerdict(null); setError(null); void start(); };

  const secs = meter.seconds;
  const window = secs < CLIP_TARGET_MIN_S ? STR5.recordTooShortYet
    : secs <= CLIP_TARGET_MAX_S ? STR5.recordInWindow
      : STR5.recordTooLong;

  // Only meaningful once the user has typed their own words: the script path matches by construction.
  const words = ownWords && verdict ? checkTranscript(script.text, transcript) : null;
  const checks: ClipCheck[] = verdict?.checks ?? [];

  return (
    <div className="settings-card voice-card" data-testid="voice-recorder">
      <div className="settings-row"><strong style={{ flexGrow: 1 }}>{STR5.recordVoice}</strong></div>
      <div className="settings-row"><span className="muted">{STR5.recordVoiceHelp}</span></div>

      <div className="settings-row">
        <label htmlFor="clone-script" style={{ flexGrow: 1 }}>{STR5.recordScript}</label>
        <select id="clone-script" className="dropdown" value={ownWords ? "own" : scriptId}
          disabled={phase === "recording"}
          onChange={(e) => { const v = e.target.value; setOwnWords(v === "own"); if (v !== "own") setScriptId(v); }}>
          {CLONE_SCRIPTS.map((s) => <option key={s.id} value={s.id}>{`${s.tone} · ${s.about}`}</option>)}
          <option value="own">{STR5.recordOwnWords}</option>
        </select>
      </div>
      {ownWords ? null : <div className="settings-row"><blockquote className="clone-script" style={{ flexGrow: 1 }}>{script.text}</blockquote></div>}

      <ul className="muted clone-tips">{CLONE_TIPS.map((t) => <li key={t}>{t}</li>)}</ul>

      <div className="settings-row">
        {phase === "recording" ? (
          <>
            <meter aria-label="level" min={0} max={0.5} value={meter.level} style={{ flexGrow: 1 }} />
            <span aria-live="polite">{STR5.recordElapsed(secs)} / {STR5.recordTarget} — {window}</span>
            <button type="button" className="btn-outline small" onClick={() => void stop()}>{STR5.recordStop}</button>
          </>
        ) : (
          <>
            <span style={{ flexGrow: 1 }} className="muted">{phase === "checking" ? "…" : `${CLIP_TARGET_MIN_S}–${CLIP_TARGET_MAX_S} seconds`}</span>
            <button type="button" className="btn-primary" disabled={phase === "saving" || phase === "checking"} onClick={() => void start()}>{STR5.recordStart}</button>
          </>
        )}
      </div>

      {verdict ? (
        <>
          <div className="settings-row"><span style={{ flexGrow: 1 }}>{STR5.recordChecks}</span></div>
          <ul className="clone-checks">
            {checks.map((c) => (
              <li key={c.id} data-pass={c.pass ? "yes" : "no"}>
                <span aria-hidden="true">{c.pass ? "✓" : "✗"}</span> {c.label}
                {c.pass ? null : <span className="error"> — {c.detail}</span>}
              </li>
            ))}
            {words ? (
              <li data-pass={words.pass ? "yes" : "no"}>
                <span aria-hidden="true">{words.pass ? "✓" : "✗"}</span> {words.label}
                {words.pass ? null : <span className="error"> — {words.detail}</span>}
              </li>
            ) : null}
          </ul>

          <div className="settings-row">
            <label htmlFor="clone-transcript" style={{ flexGrow: 1 }}>{STR5.recordTranscript}</label>
          </div>
          <div className="settings-row">
            <textarea id="clone-transcript" rows={2} style={{ flexGrow: 1 }} value={transcript}
              onChange={(e) => { setOwnWords(true); setTranscript(e.target.value); }} />
          </div>
          <div className="settings-row"><span className="muted">{STR5.recordTranscriptHelp}</span></div>

          <div className="settings-row">
            <label htmlFor="clone-name" style={{ flexGrow: 1 }}>{STR5.recordNameLabel}</label>
            <input id="clone-name" value={name} placeholder={STR5.recordNamePlaceholder} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="settings-row">
            <span style={{ flexGrow: 1 }} className="muted">{CLONE_RIGHTS_NOTE}</span>
            <button type="button" className="btn-outline small" onClick={retake}>{STR5.recordRetake}</button>
            <button type="button" className="btn-primary" disabled={phase === "saving" || !verdict.ok || !transcript.trim()}
              onClick={() => void save()}>{phase === "saving" ? STR5.recordSaving : STR5.recordSave}</button>
          </div>
          {verdict.ok ? null : <div className="settings-row"><span className="error" role="alert">{`Between ${CLIP_MIN_S} and ${CLIP_MAX_S} seconds, please — fix the marks above and record again.`}</span></div>}
        </>
      ) : (
        <div className="settings-row"><span className="muted">{CLONE_RIGHTS_NOTE}</span></div>
      )}

      {error ? <div className="settings-row"><span className="error" role="alert">{error}</span></div> : null}
      {saved ? <div className="settings-row"><span role="status">{STR5.clonedVoiceSaved(saved)}</span></div> : null}

      {voices.length ? (
        <ul className="clone-list">
          {voices.map((v) => (
            <li key={v.id}>
              <span style={{ flexGrow: 1 }}>{v.name}</span>
              <button type="button" className="link-btn" onClick={() => {
                const next = globalThis.prompt?.(STR5.clonedVoiceRename, v.name);
                if (next) void nativeCall("voice.clips.rename", { id: v.id, name: next }).then(reload, () => {});
              }}>{STR5.clonedVoiceRename}</button>
              <button type="button" className="link-btn" onClick={() => {
                if (globalThis.confirm?.(STR5.clonedVoiceDelete(v.name))) void nativeCall("voice.clips.delete", { id: v.id }).then(reload, () => {});
              }}>{STR5.clonedVoiceDeleteAction}</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
