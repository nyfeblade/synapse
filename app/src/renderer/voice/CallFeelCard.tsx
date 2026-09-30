import { useEffect, useState, type KeyboardEvent } from "react";
import { STRV } from "@synapse/shared";
import { nativeCall } from "../native";
import { SavedSwitch, useSavedNativeSwitch } from "../components/SavedSwitch";

/** ⌥⌘C-style display of an Electron accelerator. */
export function shortcutLabel(a: string | null): string {
  if (!a) return STRV.shortcutOff;
  const map: Record<string, string> = { CommandOrControl: "⌘", CmdOrCtrl: "⌘", Command: "⌘", Cmd: "⌘", Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Super: "⌘" };
  const parts = a.split("+");
  const key = parts.pop() ?? "";
  const order = ["⌃", "⌥", "⇧", "⌘"];
  return [...parts.map((p) => map[p] ?? p).sort((x, y) => order.indexOf(x) - order.indexOf(y)), key.length === 1 ? key.toUpperCase() : key].join("");
}

/** A key press → an Electron accelerator ("Alt+CommandOrControl+C"), or null while only modifiers are down. */
export function acceleratorFrom(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey">): string | null {
  if (["Meta", "Alt", "Control", "Shift"].includes(e.key)) return null;
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "CommandOrControl"].filter(Boolean) as string[];
  // e.code, not e.key: ⌥ changes the character ("ç"), not the key.
  const m = /^(?:Key([A-Z])|Digit([0-9])|(F[0-9]{1,2}))$/.exec(e.code);
  const key = m ? (m[1] ?? m[2] ?? m[3]!) : e.key === " " ? "Space" : null;
  return key ? [...mods, key].join("+") : null;
}

/**
 * Bug 134, Settings → Voice: "Call sounds" (default on) — a group call's join / leave chime, the
 * ring while a Bot's call is unanswered, and the hang-up tone when a call ends — and the global
 * call shortcut.
 */
export function CallFeelCard() {
  const [err, setErr] = useState<string | null>(null);
  // settings-persist: each switch is null until its saved value is read (they used to START at the default, so a
  // failed read drew On over an Off on disk), takes no second click while saving, and a failed save goes back to
  // the last confirmed value and says so (SavedSwitch.tsx).
  // Bug 134: call sounds, and keep the natural voice loaded while the app runs (both default on).
  const sounds = useSavedNativeSwitch("calls.sounds.get", "calls.sounds.set", setErr);
  const ready = useSavedNativeSwitch("kokoro.keepReady.get", "kokoro.keepReady.set", setErr);
  // 0.1.4 first-run: speech to Apple's servers only with this opt-in (off by default; the notice's Allow turns it on).
  const server = useSavedNativeSwitch("speech.server.get", "speech.server.set", setErr);
  // Bug 224: the bug-161 question-intonation switch is gone — no voice lifts a question any more.
  const [shortcut, setShortcut] = useState<string | null | undefined>(undefined);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    void nativeCall<{ accelerator?: string | null }>("calls.shortcut.get").then((r) => setShortcut(r?.accelerator ?? null), () => setShortcut(null));
  }, []);
  const saveShortcut = (a: string | null) => {
    setRecording(false);
    void nativeCall<{ accelerator: string | null }>("calls.shortcut.set", { accelerator: a }).then((r) => { setShortcut(r?.accelerator ?? null); setErr(null); }, (e: Error) => setErr(e.message));
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === "Escape") return setRecording(false);
    const a = acceleratorFrom(e);
    if (a) saveShortcut(a);
  };
  if (shortcut === undefined) return null;
  return (
    <div className="settings-card call-feel-card">
      <div className="settings-row">
        <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <span>{STRV.keepVoiceReady}</span>
          
        </span>
        <SavedSwitch label={STRV.keepVoiceReady} {...ready} onToggle={ready.toggle} />
      </div>
      <div className="settings-row">
        <span style={{ flexGrow: 1 }}>{STRV.callSounds}</span>
        <SavedSwitch label={STRV.callSounds} {...sounds} onToggle={sounds.toggle} />
      </div>
      <div className="settings-row">
        <span style={{ flexGrow: 1 }}>{STRV.speechServer}</span>
        <SavedSwitch label={STRV.speechServer} {...server} onToggle={server.toggle} />
      </div>
      <div className="settings-row">
        <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <span>{STRV.callShortcut}</span>
          
        </span>
        <button type="button" className="btn-outline small shortcut-field" aria-label={STRV.callShortcut} data-recording={recording} onClick={() => setRecording(true)} onKeyDown={onKey} onBlur={() => setRecording(false)}>
          {recording ? STRV.shortcutRecording : shortcutLabel(shortcut)}
        </button>
        {shortcut && <button type="button" className="btn-outline small" onClick={() => saveShortcut(null)}>{STRV.shortcutTurnOff}</button>}
      </div>
      {err && <span className="error" role="alert">{err}</span>}
    </div>
  );
}
