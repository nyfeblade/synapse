/**
 * Classifying the native dictation helper's exit.
 *
 * Apple's SFSpeechRecognizer ends a recognition task by itself after a stretch of silence, and the
 * helper reports that as a normal error before exiting:
 *
 *   {"type":"ready"}
 *   {"type":"error","message":"No speech detected"}
 *   {"type":"end"}
 *
 * That is not a failure the user should ever see — it just means nobody spoke. A revoked
 * microphone / speech-recognition permission is a real failure and must still be surfaced.
 */

import { STR5 } from "@synapse/shared";

/** True for the recognizer's own "nobody spoke" end-of-session, in any of its phrasings. */
export function isBenignSpeechEnd(message: string): boolean {
  return /\bno speech\b/i.test(message);
}

/** True when the helper failed because microphone or speech-recognition access is off. */
export function isMicFault(message: string): boolean {
  return /not-authorized|not authorized|microphone|permission|denied/i.test(message);
}

/** The System Settings → Privacy & Security pane that fixes a permission fault. */
export type PrivacyPane = "microphone" | "speech" | "screen";
export type PermissionFault = { pane: PrivacyPane; text: string };

const SPECIFIC: Record<string, string> = {
  "microphone:denied": STR5.micAccessDenied,
  "microphone:restricted": STR5.micAccessRestricted,
  "speech:denied": STR5.speechAccessDenied,
  "speech:restricted": STR5.speechAccessRestricted,
};

/**
 * Bug 99: a permission failure never ends silently — it maps to the message to show AND the pane
 * the "Open System Settings" button opens. The main process (microphone, checked before the helper
 * is spawned) and the helper (speech, and microphone again as a backstop) report
 * `permission:<microphone|speech>:<denied|restricted>`; an older helper's bare `not-authorized`
 * (its speech check) and an audio engine that won't start still map, with the generic text.
 */
export function permissionFault(message: string): PermissionFault | null {
  const m = /^permission:(microphone|speech):(denied|restricted)$/.exec(message.trim());
  if (m) return { pane: m[1] as PrivacyPane, text: SPECIFIC[`${m[1]}:${m[2]}`]! };
  if (!isMicFault(message)) return null;
  return { pane: /not-authorized|not authorized|speech/i.test(message) ? "speech" : "microphone", text: STR5.micDenied };
}

/**
 * Bug 101: what a helper `error` means to the user. The helper now sends a `code` with every error
 * (no-speech, no-audio, recognizer, helper-exit, permission…); only a permission fault gets the
 * permission wording and a settings button, every other failure shows the helper's own reason.
 * "Nobody spoke" is a notice, not an alarm, but it is always said: dictation never just stops.
 */
export type DictationFault = { text: string; pane: PrivacyPane | null; notice: boolean; serverOptIn?: boolean };
export function dictationFault(message: string, code?: string): DictationFault {
  if (code === "no-speech" || (!code && isBenignSpeechEnd(message))) return { text: STR5.dictationNoSpeech, pane: null, notice: true };
  // 0.1.4 first-run: no on-device recognition here; nothing was sent. Ask once, with the opt-in beside it.
  if (code === "server-speech") return { text: STR5.speechServerNeeded, pane: null, notice: false, serverOptIn: true };
  if (code && code !== "permission") return { text: message, pane: null, notice: false };
  const p = permissionFault(message);
  return p ? { text: p.text, pane: p.pane, notice: false } : { text: message, pane: null, notice: false };
}
