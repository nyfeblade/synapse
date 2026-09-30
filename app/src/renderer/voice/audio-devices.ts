import { useCallback, useEffect, useState } from "react";
import { STR5 } from "@synapse/shared";
import { nativeCall } from "../native";

/** Bug 105: the renderer's view of the helper's CoreAudio device list (see main/native/audio-devices). */
export interface AudioDeviceView { uid: string; name: string; input: boolean; output: boolean; transport: string; defaultInput: boolean; defaultOutput: boolean; /** Bug 151: the OS gave it no name; `name` is a label made from its UID. */ unnamed?: boolean }
export interface AudioPrefsView { input: string | null; output: string | null }
export type DeviceKind = "input" | "output";
export interface DeviceOption { value: string; label: string }

/**
 * Bug 151: never show a blank row. A Bluetooth headset can arrive with an empty name (the main
 * process already labels those — see main/native/audio-devices deviceLabel); this is the last
 * guard, for a payload that slipped through. It is for display only: choosing is always by UID.
 */
export function deviceName(d: { uid: string; name?: string; transport?: string }): string {
  const n = typeof d.name === "string" ? d.name.trim() : "";
  if (n) return n;
  const id = d.uid.replace(/:(input|output)$/i, "").slice(0, 40);
  const bluetooth = d.transport === "bluetooth" || d.transport === "bluetooth-le" || /^[0-9a-f]{2}([-:][0-9a-f]{2}){5}$/i.test(id);
  return bluetooth ? `Bluetooth device (${id})` : `Audio device (${id})`;
}

/** "System default (<name>)" first (value ""), then each device of that kind with a type hint. */
export function deviceOptions(devices: readonly AudioDeviceView[], kind: DeviceKind, selected: string | null): DeviceOption[] {
  const mine = devices.filter((d) => (kind === "input" ? d.input : d.output));
  const def = mine.find((d) => (kind === "input" ? d.defaultInput : d.defaultOutput));
  const out: DeviceOption[] = [{ value: "", label: STR5.systemDefault(def ? deviceName(def) : null) }];
  for (const d of mine) {
    const hint = STR5.transportLabel[d.transport];
    const name = deviceName(d);
    out.push({ value: d.uid, label: hint ? `${name} · ${hint}` : name });
  }
  // A saved device that is unplugged stays chosen (it comes back when plugged in again) — say so.
  if (selected && !mine.some((d) => d.uid === selected)) out.push({ value: selected, label: STR5.savedDeviceNotConnected });
  return out;
}

/** Bug 106: an installed voice, best quality first (see main/native/audio-devices parseVoiceList). */
export interface VoiceView { id: string; name: string; lang: string; quality: "premium" | "enhanced" | "default"; siri: boolean; personal: boolean }

/** Bug 107: one curated Kokoro voice (see main/native/kokoro KOKORO_VOICES); its value is "kokoro:<id>". */
export interface NaturalVoiceView { id: string; name: string; accent: string; gender?: string }

/** A voice as it is named in the UI: "Ava", and a Siri bundle as "Aaron (Siri)". */
export function voiceName(v: VoiceView): string { return v.siri ? `${v.name} (Siri)` : v.name; }
/** "Ava · Premium" — the name AND the quality, because Default/Enhanced/Premium share a name. */
export function voiceLabel(v: VoiceView): string { return `${voiceName(v)} · ${STR5.voiceQuality[v.quality]}`; }

const QUALITY_ORDER: Record<VoiceView["quality"], number> = { premium: 0, enhanced: 1, default: 2 };
/** Premium first, then Enhanced, then the rest — keeping the helper's own ranking within a quality. */
/** macOS's novelty voices (sound effects and gags), by name. */
const NOVELTY = new Set(["albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "deranged", "good news", "hysterical", "jester", "organ", "pipe organ", "superstar", "trinoids", "whisper", "wobble", "zarvox"]);
/** The Eloquence character voices, one per locale each ("Eddy (English (US))", …). */
const ELOQUENCE = new Set(["eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley"]);

/**
 * New-user walk, finding 21: a Bot's voice list holds real speech voices only — not the novelty voices or the
 * Eloquence character set (about 150 entries otherwise). `keep` is the Bot's saved voice, which always stays listed.
 */
export function speechVoices<T extends { id?: string; name: string }>(voices: readonly T[], keep?: string | null): T[] {
  return voices.filter((v) => {
    if (keep && (v.id === keep || v.name === keep)) return true;
    const n = v.name.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
    return !NOVELTY.has(n) && !ELOQUENCE.has(n) && !/eloquence/i.test(v.id ?? "");
  });
}

export function byQuality(voices: readonly VoiceView[]): VoiceView[] {
  return voices.map((v, i) => [v, i] as const)
    .sort((a, b) => QUALITY_ORDER[a[0].quality] - QUALITY_ORDER[b[0].quality] || a[1] - b[1]).map(([v]) => v);
}

/** "Automatic (<the voice it will use>)" first (value ""), then every voice with its quality. */
export function voiceOptions(voices: readonly VoiceView[]): DeviceOption[] {
  return [{ value: "", label: STR5.voiceAutomatic(voices[0] ? voiceName(voices[0]) : null) }, ...voices.map((v) => ({ value: v.id, label: voiceLabel(v) }))];
}

/** Plain words for the helper's device events; null for anything else. */
export function deviceNotice(e: { type: string; kind?: unknown; name?: unknown; fallback?: unknown; reason?: unknown }): string | null {
  const kind: DeviceKind = e.kind === "output" ? "output" : "input";
  const name = typeof e.name === "string" ? e.name : "";
  if (e.type === "device-fallback") return STR5.deviceFellBack(kind, name, typeof e.fallback === "string" ? e.fallback : "");
  if (e.type === "device-restored") return STR5.deviceRestored(name);
  if (e.type === "echo-unavailable") return STR5.echoUnavailable;
  // Bug 213: the helper opened the Mac's mic instead of a Bluetooth headset's own, keeping it in stereo.
  if (e.type === "mic-choice" && e.reason === "keep-stereo") return STR5.micKeepsStereo;
  return null;
}

/** dBFS → 0–100 for the level meter: -60 dB and below is empty, 0 dB is full. */
export function levelPercent(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.round(Math.min(100, Math.max(0, ((db + 60) / 60) * 100)));
}

/**
 * The device list and the saved choice. Loads when `enabled`, refreshes when the window regains
 * focus (a device may have been plugged in meanwhile), and saves a choice through the main process,
 * which also applies it to a running dictation / voice session.
 */
export function useAudioDevices(enabled = true): { devices: AudioDeviceView[]; prefs: AudioPrefsView; error: string | null; choose(kind: DeviceKind, uid: string | null): Promise<void> } {
  const [devices, setDevices] = useState<AudioDeviceView[]>([]);
  const [prefs, setPrefs] = useState<AudioPrefsView>({ input: null, output: null });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((refresh: boolean) => {
    void nativeCall<{ devices?: AudioDeviceView[]; prefs?: AudioPrefsView }>("audio.devices.list", refresh ? { refresh: true } : {}).then((r) => {
      setError(null);
      if (Array.isArray(r?.devices)) setDevices(r.devices);
      if (r?.prefs) setPrefs({ input: r.prefs.input ?? null, output: r.prefs.output ?? null });
    }, () => setError(STR5.devicesUnavailable));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    load(false);
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);
  const choose = useCallback(async (kind: DeviceKind, uid: string | null) => {
    setPrefs((p) => ({ ...p, [kind]: uid }));
    const r = await nativeCall<AudioPrefsView | null>("audio.devices.set", { [kind]: uid }).catch(() => null);
    if (r && "input" in r) setPrefs({ input: r.input ?? null, output: r.output ?? null });
  }, []);
  return { devices, prefs, error, choose };
}
