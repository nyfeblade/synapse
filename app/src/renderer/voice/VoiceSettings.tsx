import { useEffect, useState } from "react";
import { SPEECH_RATES, STR5, engineOfVoice, isVoiceMode, voiceBlockedByMode, type VoiceMode, type VoiceSettingsPatch } from "@synapse/shared";
import { call } from "../bridge";
import { nativeCall } from "../native";
import { acceptAgent, useUi } from "../store";
import { byQuality, voiceLabel, type NaturalVoiceView, type VoiceView } from "./audio-devices";
import { assignVoices } from "./call-voices";
import { languageOptions, listVoices } from "./tts";
import { useClonedVoices, type ClonedVoiceView } from "./cloned-voices";

export function VoiceSettings({ botId }: { botId: string }) {
  const bots = useUi((s) => s.bots);
  const me = bots[botId];
  // The page's own voices: the language list, and the fallback list while the helper hasn't answered.
  const [browser, setBrowser] = useState(listVoices());
  // Bug 157: the Apple voices a CALL can speak with are the HELPER's, not the page's. The page's
  // speechSynthesis list is a different, smaller set — no Siri bundles, and one entry per name — so
  // a name picked there could be a voice the call never uses. These are ids, with their quality.
  // null = the answer hasn't come back yet (so a saved voice isn't called missing too early).
  const [apple, setApple] = useState<VoiceView[] | null>(null);
  // The app-level Settings → Voice choice: what a 1:1 call falls back to when this Bot has none.
  const [appVoice, setAppVoice] = useState<string | null>(null);
  // Bug 107: the natural (Kokoro) voices, offered as this Bot's own voice while Kokoro is Ready.
  const [natural, setNatural] = useState<NaturalVoiceView[] | null>(null);
  // Bug 164: the Qwen3 voices, offered as this Bot's own voice while Qwen3 is Ready.
  const [qwen, setQwen] = useState<NaturalVoiceView[] | null>(null);
  // Bug 164: Light voice mode can load neither Qwen nor F5. An older build has no handler for this,
  // and Full is the safe assumption there — it claims nothing is blocked when nothing is.
  const [mode, setMode] = useState<VoiceMode>("full");
  // Cloned voices (F5): the user's own recordings. Empty unless they have made one.
  const cloned = useClonedVoices();
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    const s = globalThis.speechSynthesis;
    const on = () => setBrowser(listVoices());
    s?.addEventListener?.("voiceschanged", on);
    return () => s?.removeEventListener?.("voiceschanged", on);
  }, []);
  useEffect(() => {
    void nativeCall<{ voices?: VoiceView[]; chosen?: string | null }>("audio.voices.list").then(
      (r) => { setApple(Array.isArray(r?.voices) ? r.voices : []); setAppVoice(r?.chosen ?? null); }, () => setApple([]));
  }, []);
  useEffect(() => {
    void nativeCall<{ state?: string; voices?: NaturalVoiceView[] }>("kokoro.status").then(
      (r) => setNatural(r?.state === "ready" && Array.isArray(r.voices) ? r.voices : []), () => setNatural([]));
  }, []);
  useEffect(() => {
    void nativeCall<{ state?: string; voices?: NaturalVoiceView[] }>("qwen.status").then(
      (r) => setQwen(r?.state === "ready" && Array.isArray(r.voices) ? r.voices : []), () => setQwen([]));
  }, []);
  useEffect(() => {
    void nativeCall<{ mode?: string }>("voiceMode.get").then((r) => { if (isVoiceMode(r?.mode)) setMode(r.mode); }, () => {});
  }, []);
  if (!me) return null;
  const st = me.settings;
  const installed = apple ?? [];
  const kokoro = natural ?? [];
  const qwenVoices = qwen ?? [];
  // settings-persist: the saved Bot comes back in the response; the select no longer waits on the host event to move.
  const set = (p: VoiceSettingsPatch) => void call("setAgentVoice", { id: botId, ...p }).then((r) => acceptAgent(r.agent), () => {});
  /**
   * Bug 157: an older saved value is a bare NAME ("Ava"), which the helper resolves to that name's
   * best-quality voice — the same voice this list's first entry of that name is (it is best-first).
   * Saved values keep working; the picker stores the id from here on.
   */
  const resolve = (v: string) => installed.find((x) => x.id === v)?.id ?? installed.find((x) => x.name === v)?.id ?? v;
  const usedBy = (v: string) => Object.values(bots).find((b) => b.id !== botId && b.settings.voice && resolve(b.settings.voice) === v)?.profile.name;
  const byLang = st.spokenLanguage ? installed.filter((v) => v.lang === st.spokenLanguage) : installed;
  // The helper lists the voices for its own locale, so a language with none of its own still gets
  // the full list rather than an empty picker.
  const shown = byQuality(byLang.length ? byLang : installed);
  const appleOpts = shown.length
    ? shown.map((v) => ({ value: v.id, label: voiceLabel(v) }))
    // No helper list (it is loading, failed, or this isn't a Mac build): the page's own names, as before.
    : (st.spokenLanguage ? browser.filter((v) => v.lang === st.spokenLanguage) : browser).map((v) => ({ value: v.name, label: v.name }));
  const value = st.voice ? resolve(st.voice) : "";
  const chosen = installed.find((v) => v.id === value);
  // A saved voice from another language stays in the list, named the same way as the rest.
  if (chosen && !appleOpts.some((o) => o.value === value)) appleOpts.push({ value, label: voiceLabel(chosen) });
  // Only once both lists are in: a saved voice this Mac no longer has says so, instead of the row
  // quietly reading "Not set" while calls still speak with it.
  const known = value === "" || apple === null || natural === null || qwen === null || appleOpts.some((o) => o.value === value) || kokoro.some((n) => `kokoro:${n.id}` === value) || qwenVoices.some((q) => `qwen3:${q.id}` === value) || cloned.voices.some((c: ClonedVoiceView) => `f5:${c.id}` === value);
  // Bug 164: this Bot's voice is one Light mode can't load. The setting stays; the line says why it
  // isn't what the next call will sound like.
  const blockedEngine = voiceBlockedByMode(value, mode) ? (engineOfVoice(value) === "qwen" ? STR5.qwenVoices : STR5.clonedVoices) : null;
  const appleEls = appleOpts.map((o, i) => { const u = usedBy(o.value); return <option key={`${o.value}-${i}`} value={o.value} title={u ? STR5.usedBy(u) : undefined}>{o.label}</option>; });
  /**
   * Bug 157: the same sample line, through the engine the chosen voice belongs to (the helper plays
   * a Kokoro voice with Kokoro, an Apple one with Apple). Nothing chosen previews what a call would
   * actually give this Bot — while Kokoro is Ready, its own natural voice.
   */
  const preview = () => {
    setPreviewing(true);
    setPreviewError(null);
    const v = value || assignVoices([botId], installed, {}, appVoice, false, kokoro.map((n) => n.id), mode)[botId] || "";
    void nativeCall<{ ok?: boolean; message?: string }>("audio.testSpeaker", v ? { voice: v } : {})
      .then((r) => setPreviewError(r?.ok === false ? STR5.speakerTestFailed(r.message ?? "") : null), (e: Error) => setPreviewError(STR5.speakerTestFailed(e.message)))
      .finally(() => setPreviewing(false));
  };
  return (
    <>
    <div className="settings-card voice-card">
      <div className="settings-row"><label htmlFor="voice" style={{ flexGrow: 1 }}>{STR5.voice}</label>
        <select id="voice" className="dropdown" value={value} onChange={(e) => set({ voice: e.target.value || null })}>
          <option value="">{STR5.notSet}</option>
          {known ? null : <option value={value}>{STR5.savedVoiceNotInstalled}</option>}
          {cloned.voices.length ? (
            <optgroup label={STR5.clonedVoices}>
              {cloned.voices.map((v: ClonedVoiceView) => { const id = `f5:${v.id}`; const u = usedBy(id); return <option key={id} value={id} title={u ? STR5.usedBy(u) : undefined}>{STR5.clonedVoiceLabel(v.name)}</option>; })}
            </optgroup>
          ) : null}
          {qwenVoices.length ? (
            <optgroup label={STR5.qwenVoices}>
              {qwenVoices.map((v) => { const id = `qwen3:${v.id}`; const u = usedBy(id); return <option key={id} value={id} title={u ? STR5.usedBy(u) : undefined}>{STR5.qwenVoiceLabel(v.name, v.accent)}</option>; })}
            </optgroup>
          ) : null}
          {kokoro.length ? (
            <>
              <optgroup label={STR5.naturalVoices}>
                {kokoro.map((v) => { const id = `kokoro:${v.id}`; const u = usedBy(id); return <option key={id} value={id} title={u ? STR5.usedBy(u) : undefined}>{STR5.naturalVoiceLabel(v.name, v.accent)}</option>; })}
              </optgroup>
              <optgroup label={STR5.appleVoices}>{appleEls}</optgroup>
            </>
          ) : appleEls}
        </select></div>
      <div className="settings-row">
        <span className={previewError ? "error" : "muted"} style={{ flexGrow: 1 }} role={previewError ? "alert" : undefined}>
          {previewError ?? (blockedEngine ? STR5.voiceModeBlocked(blockedEngine) : null)}
        </span>
        <button type="button" className="btn-outline small" disabled={previewing} onClick={preview}>{previewing ? STR5.previewingVoice : STR5.previewVoice}</button>
      </div>
      <div className="settings-row"><label htmlFor="speed" style={{ flexGrow: 1 }}>{STR5.speed}</label>
        <select id="speed" className="dropdown" value={String(st.speechRate ?? 1)} onChange={(e) => set({ speechRate: Number(e.target.value) })}>
          {SPEECH_RATES.map((r) => <option key={r} value={String(r)}>{`${r}x`}</option>)}
        </select></div>
      <div className="settings-row"><label htmlFor="language" style={{ flexGrow: 1 }}>{STR5.language}</label>
        <select id="language" className="dropdown" value={st.spokenLanguage ?? ""} onChange={(e) => set({ spokenLanguage: e.target.value || null })}>
          <option value="">{STR5.autoDetect}</option>
          {languageOptions(browser.length ? browser : installed).map((l) => <option key={l.lang} value={l.lang}>{l.label}</option>)}
        </select></div>
    </div>
    {/* UI polish pass (brief 2): what each engine costs, as label and value — the facts the old
        paragraph held, without the paragraph. */}
    <h3 className="voice-memory-head">{STR5.voiceMemory}</h3>
    <div className="settings-card voice-memory" role="group" aria-label={STR5.voiceMemory}>
      <div className="settings-row"><span style={{ flexGrow: 1 }} title={STR5.naturalEngineNote}>{STR5.naturalVoices}</span><span className="muted">{STR5.memoryNatural}</span></div>
      {engineOfVoice(value) === "qwen" ? <div className="settings-row"><span style={{ flexGrow: 1 }} title={STR5.qwenEngineNote}>{STR5.qwenVoices}</span><span className="muted">{STR5.memoryQwen}</span></div> : null}
      {cloned.voices.length ? <div className="settings-row"><span style={{ flexGrow: 1 }} title={STR5.clonedEngineNote}>{STR5.clonedVoices}</span><span className="muted">{STR5.memoryCloned}</span></div> : null}
      <div className="settings-row"><span style={{ flexGrow: 1 }} title={STR5.appleEngineNote}>{STR5.appleVoices}</span>
        {/* Bug 99's way out of a System Settings pane, reused: macOS's own voice downloads. */}
        <button type="button" className="link-btn" onClick={() => void nativeCall("audio.voices.openDownloads").catch(() => {})}>{STR5.downloadVoices}</button>
        <span className="muted">{STR5.memoryApple}</span></div>
    </div>
    </>
  );
}
