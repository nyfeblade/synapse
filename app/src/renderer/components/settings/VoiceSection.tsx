import { useEffect, useRef, useState } from "react";
import { STR, STR5, VOICE_MODE_FACTS, isVoiceMode, type VoiceMode } from "@synapse/shared";
import { nativeCall, onNative } from "../../native";
import { deviceOptions, levelPercent, useAudioDevices, voiceOptions, type DeviceKind, type NaturalVoiceView, type VoiceView } from "../../voice/audio-devices";
import { Segmented } from "../Segmented";
import { registerSettingsSection } from "./sections";
import { WakeWordCard } from "../../voice/WakeWordCard";
import { BotCallsCard } from "../../voice/BotCallsCard";
import { PhoneAccessCard } from "../../voice/PhoneAccessCard";
import { CallFeelCard } from "../../voice/CallFeelCard";
import { WhisperCard } from "../../voice/WhisperCard";
import { VoiceRecorder } from "../../voice/VoiceRecorder";

/**
 * Bug 105: Settings → Voice. The microphone and speaker used for dictation and voice chat, a live
 * input-level meter to confirm the microphone hears you, and a "Test speaker" button that speaks a
 * short phrase through the chosen output.
 */
export function VoiceSection() {
  const { devices, prefs, error, choose } = useAudioDevices();
  const [level, setLevel] = useState(0);
  const [meterError, setMeterError] = useState<string | null>(null);
  const [meterRun, setMeterRun] = useState(0);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  // Bug 106: the voice calls speak with ("" = the best installed voice).
  const [voices, setVoices] = useState<VoiceView[] | null>(null);
  const [voice, setVoice] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    const load = () => void nativeCall<{ voices?: VoiceView[]; chosen?: string | null }>("audio.voices.list").then((r) => {
      setVoiceError(null);
      setVoices(Array.isArray(r?.voices) ? r.voices : []);
      setVoice(r?.chosen ?? "");
    }, () => setVoiceError(STR5.voicesUnavailable));
    load();
    // Back from System Settings with a new voice downloaded.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);
  // Bug 107: the natural (Kokoro) engine — Ready / Not found — and its curated voices.
  const [natural, setNatural] = useState<{ state: "ready" | "missing" | "checking"; voices: NaturalVoiceView[] }>({ state: "checking", voices: [] });
  useEffect(() => {
    void nativeCall<{ state?: string; voices?: NaturalVoiceView[] }>("kokoro.status").then((r) => {
      const state = r?.state === "ready" || r?.state === "missing" ? r.state : "missing";
      setNatural({ state, voices: Array.isArray(r?.voices) ? r.voices : [] });
    }, () => setNatural({ state: "missing", voices: [] }));
  }, []);
  // Bug 164: Qwen3 — Ready / Not installed — and its nine voices.
  const [qwen, setQwen] = useState<{ state: "ready" | "missing" | "checking"; voices: NaturalVoiceView[] }>({ state: "checking", voices: [] });
  useEffect(() => {
    void nativeCall<{ state?: string; voices?: NaturalVoiceView[] }>("qwen.status").then((r) => {
      const state = r?.state === "ready" || r?.state === "missing" ? r.state : "missing";
      setQwen({ state, voices: Array.isArray(r?.voices) ? r.voices : [] });
    }, () => setQwen({ state: "missing", voices: [] }));
  }, []);
  // Bug 164: how much of the Mac the voice stack may use.
  // settings-persist: null until the saved mode is read — the control shows neither choice until then (it used to
  // draw Full), takes no second pick while a save is in flight, and a failed save goes back to the last confirmed mode.
  const [mode, setMode] = useState<VoiceMode | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const confirmedMode = useRef<VoiceMode | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [modeLoadFailed, setModeLoadFailed] = useState(false);
  const loadMode = () => {
    setModeLoadFailed(false);
    setModeError(null);
    void nativeCall<{ mode?: string }>("voiceMode.get").then(
      (r) => { if (isVoiceMode(r?.mode)) { confirmedMode.current = r.mode; setMode(r.mode); } else { setModeError(STR.settingNotLoaded); setModeLoadFailed(true); } },
      () => { setModeError(STR.settingNotLoaded); setModeLoadFailed(true); },
    );
  };
  useEffect(loadMode, []);
  const pickMode = (m: VoiceMode) => {
    if (modeBusy || confirmedMode.current === null || m === confirmedMode.current) return;
    setMode(m);
    setModeBusy(true);
    setModeError(null);
    void nativeCall("voiceMode.set", { mode: m }).then(
      () => { confirmedMode.current = m; },
      () => { setMode(confirmedMode.current); setModeError(STR.settingNotSaved); },
    ).finally(() => setModeBusy(false));
  };
  const naturalReady = natural.state === "ready" && natural.voices.length > 0;
  // Qwen needs Kokoro: the first sentence of every reply speaks in the Bot's Kokoro voice so the
  // call opens straight away, so a Qwen voice on its own is not something to offer.
  const qwenReady = naturalReady && mode === "full" && qwen.state === "ready" && qwen.voices.length > 0;
  const appleOpts = voiceOptions(voices ?? []);
  const listed = (v: string) => appleOpts.some((o) => o.value === v)
    || (naturalReady && natural.voices.some((n) => `kokoro:${n.id}` === v))
    || (qwenReady && qwen.voices.some((q) => `qwen3:${q.id}` === v));
  // settings-persist: a refused save used to leave the new voice on screen as if it were saved.
  const pickVoice = (v: string) => {
    const was = voice;
    setVoice(v);
    setVoiceError(null);
    void nativeCall("audio.voice.set", { voice: v || null }).catch(() => { setVoice(was); setVoiceError(STR.settingNotSaved); });
  };
  const preview = () => {
    setPreviewing(true);
    setTestResult(null);
    // Automatic previews Kokoro's first voice while it is Ready (it is the default engine then).
    const v = voice || (naturalReady ? `kokoro:${natural.voices[0]!.id}` : "");
    void nativeCall<{ ok: boolean; message?: string }>("audio.testSpeaker", v ? { voice: v } : {})
      .then((r) => setTestResult(r?.ok === false ? STR5.speakerTestFailed(r.message ?? "") : null), (e: Error) => setTestResult(STR5.speakerTestFailed(e.message)))
      .finally(() => setPreviewing(false));
  };
  const onlyBasic = voices !== null && voices.length > 0 && !voices.some((v) => v.quality !== "default");

  // The meter runs while this section is open, on the chosen microphone; a new choice restarts it.
  useEffect(() => {
    setLevel(0);
    setMeterError(null);
    const off = onNative<{ type: string; db?: number; message?: string }>("audio-level", (e) => {
      if (e.type === "level" && typeof e.db === "number") setLevel(levelPercent(e.db));
      if (e.type === "error" && e.message) setMeterError(STR5.meterUnavailable(e.message));
    });
    void nativeCall("audio.meter.start").catch((e: Error) => setMeterError(STR5.meterUnavailable(e.message)));
    return () => { off(); void nativeCall("audio.meter.stop").catch(() => {}); };
  }, [meterRun]);

  const pick = (kind: DeviceKind, value: string) => {
    void choose(kind, value || null).then(() => { if (kind === "input") setMeterRun((n) => n + 1); });
  };
  const testSpeaker = () => {
    setTesting(true);
    setTestResult(null);
    void nativeCall<{ ok: boolean; message?: string }>("audio.testSpeaker")
      .then((r) => setTestResult(r?.ok === false ? STR5.speakerTestFailed(r.message ?? "") : null), (e: Error) => setTestResult(STR5.speakerTestFailed(e.message)))
      .finally(() => setTesting(false));
  };

  const select = (kind: DeviceKind, label: string) => (
    <select id={`audio-${kind}`} className="dropdown audio-device-select" aria-label={label} value={prefs[kind] ?? ""} onChange={(e) => pick(kind, e.target.value)}>
      {deviceOptions(devices, kind, prefs[kind]).map((o) => <option key={o.value || "default"} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <>
      <h2>{STR5.voice}</h2>
      {error && <span className="error" role="alert">{error}</span>}
      <div className="settings-card voice-devices-card">
        <div className="settings-row">
          <label htmlFor="audio-input" style={{ flexGrow: 1 }}>{STR5.microphone}</label>
          {select("input", STR5.microphone)}
        </div>
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span id="audio-level-label">{STR5.inputLevel}</span><span className="muted">{meterError ?? STR5.inputLevelHelp}</span></span>
          <div className="level-meter" role="meter" aria-labelledby="audio-level-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
            <span className="level-meter-fill" style={{ width: `${level}%` }} />
          </div>
        </div>
        <div className="settings-row">
          <label htmlFor="audio-output" style={{ flexGrow: 1 }}>{STR5.speaker}</label>
          {select("output", STR5.speaker)}
        </div>
        <div className="settings-row">
          <span className="muted" style={{ flexGrow: 1 }} role={testResult ? "alert" : undefined}>{testResult ?? ""}</span>
          <button type="button" className="btn-outline small" disabled={testing} onClick={testSpeaker}>{testing ? STR5.testingSpeaker : STR5.testSpeaker}</button>
        </div>
      </div>
      <WakeWordCard />
      <BotCallsCard />
      <PhoneAccessCard />
      <CallFeelCard />
      {/* Bug 165: whisper's one finer choice, and the missing-model download. Renders nothing in Light mode. */}
      <div className="settings-card"><WhisperCard /></div>
      <div className="settings-card voice-choice-card">
        <div className="settings-row">
          <span id="voice-mode-label" style={{ flexGrow: 1 }}>{STR5.voiceModeLabel}</span>
          <Segmented<VoiceMode> label={STR5.voiceModeLabel} value={mode} onChange={pickMode}
            options={[{ value: "light", label: STR5.voiceModeLight }, { value: "full", label: STR5.voiceModeFull }]} />
        </div>
        {modeError && <div className="settings-row"><span className="error" role="alert">{modeError}</span>{modeLoadFailed && <button type="button" className="link-btn" onClick={loadMode}>{STR.retry}</button>}</div>}
        <div className="settings-row">
          <span className="muted" style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <span>{STR5.voiceModeOption(STR5.voiceModeLight, STR5.voiceModeFact(VOICE_MODE_FACTS.light.memoryMb, VOICE_MODE_FACTS.light.firstWordMs), STR5.voiceModeLightWhat)}</span>
            <span>{STR5.voiceModeOption(STR5.voiceModeFull, STR5.voiceModeFact(VOICE_MODE_FACTS.full.memoryMb, VOICE_MODE_FACTS.full.firstWordMs), STR5.voiceModeFullWhat)}</span>
            <span>{STR5.voiceModeTakesEffect}</span>
          </span>
        </div>
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span id="natural-status-label">{STR5.naturalStatusLabel}</span></span>
          <span className={natural.state === "ready" ? undefined : "muted"} role="status" aria-labelledby="natural-status-label">{STR5.naturalStatus[natural.state]}</span>
        </div>
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><span id="qwen-status-label">{STR5.qwenStatusLabel}</span>{qwen.state === "missing" ? <span className="muted">{STR5.qwenNotInstalled}</span> : null}</span>
          <span className={qwen.state === "ready" ? undefined : "muted"} role="status" aria-labelledby="qwen-status-label">{STR5.qwenStatus[qwen.state]}</span>
        </div>
        <div className="settings-row">
          <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}><label htmlFor="call-voice">{STR5.callVoice}</label></span>
          <select id="call-voice" className="dropdown audio-device-select" aria-label={STR5.callVoice} value={voice} onChange={(e) => pickVoice(e.target.value)}>
            {naturalReady ? (
              <>
                <option value="">{STR5.naturalAutomatic}</option>
                {qwenReady ? (
                  <optgroup label={STR5.qwenVoices}>
                    {qwen.voices.map((v) => <option key={v.id} value={`qwen3:${v.id}`}>{STR5.qwenVoiceLabel(v.name, v.accent)}</option>)}
                  </optgroup>
                ) : null}
                <optgroup label={STR5.naturalVoices}>
                  {natural.voices.map((v) => <option key={v.id} value={`kokoro:${v.id}`}>{STR5.naturalVoiceLabel(v.name, v.accent)}</option>)}
                </optgroup>
                <optgroup label={STR5.appleVoices}>
                  {appleOpts.slice(1).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </optgroup>
              </>
            ) : appleOpts.map((o) => <option key={o.value || "auto"} value={o.value}>{o.label}</option>)}
            {/* settings-persist: the saved voice, when it isn't among the choices listed right now (its engine is
                still loading, Light mode, or gone), is still what the picker shows — not "Automatic". */}
            {voice && !listed(voice) ? <option value={voice}>{voice}</option> : null}
          </select>
          <button type="button" className="btn-outline small" disabled={previewing} onClick={preview}>{previewing ? STR5.previewingVoice : STR5.previewVoice}</button>
        </div>
        <div className="settings-row">
          <span className={onlyBasic ? "error" : "muted"} style={{ flexGrow: 1 }} role={onlyBasic || voiceError ? "status" : undefined}>{voiceError ?? (onlyBasic ? STR5.onlyBasicVoices : STR5.betterVoicesHint)}</span>
          <button type="button" className="btn-outline small" onClick={() => void nativeCall("audio.voices.openDownloads").catch(() => {})}>{STR5.downloadVoices}</button>
        </div>
      </div>
      <VoiceRecorder />
    </>
  );
}

registerSettingsSection("voice", STR5.voice, VoiceSection);
