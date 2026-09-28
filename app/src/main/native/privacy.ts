/**
 * Bug 99: microphone / speech-recognition permission. Pure (Electron is injected), so the
 * status → decision mapping is unit-tested; index.ts wires in systemPreferences and shell.
 *
 * The TCC "responsible process" for the dictation helper is Synapse.app (the helper is a plain
 * child process, not a bundle), so the prompts, the usage strings and the grant all belong to the
 * app: NSMicrophoneUsageDescription / NSSpeechRecognitionUsageDescription live in the app's
 * Info.plist (scripts/package.mjs), and the grant survives a rebuild only if the app's code
 * signature is stable (scripts/signing-identity.mjs).
 */

export type MicAccess = "granted" | "denied" | "restricted";

export interface MediaAccess {
  getMediaAccessStatus(media: "microphone"): string;
  askForMediaAccess(media: "microphone"): Promise<boolean>;
}

/**
 * Check first; ask only when macOS has never asked (that is the one state in which the system
 * prompt appears). Denied / restricted are reported, never swallowed — the renderer turns them
 * into a message with a button to the Microphone pane. An unknown status lets the helper try:
 * it checks again itself and reports its own failure.
 */
export async function ensureMicAccess(sp: MediaAccess): Promise<MicAccess> {
  const status = sp.getMediaAccessStatus("microphone");
  if (status === "denied" || status === "restricted") return status;
  if (status !== "not-determined") return "granted";
  try {
    return (await sp.askForMediaAccess("microphone")) ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export const PRIVACY_URLS = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  speech: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

export type PrivacyPane = keyof typeof PRIVACY_URLS;

/** Only the fixed deep links; the renderer names a pane, never a URL. */
export function privacySettingsUrl(pane: unknown): string {
  if (pane !== "microphone" && pane !== "speech" && pane !== "screen") throw new Error("Unknown privacy settings pane.");
  return PRIVACY_URLS[pane];
}
