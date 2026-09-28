import { STR5 } from "@synapse/shared";
import { nativeCall } from "../native";
import type { PrivacyPane } from "./dictation-errors";

/** Bug 99: the way out of a denied microphone / speech permission — straight to the pane that fixes it. */
export function PrivacySettingsButton({ pane }: { pane: PrivacyPane }) {
  return (
    <button type="button" className="link-btn" onClick={() => void nativeCall("openPrivacySettings", { pane }).catch(() => {})}>
      {STR5.openPrivacySettings}
    </button>
  );
}
