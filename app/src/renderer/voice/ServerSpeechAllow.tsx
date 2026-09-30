import { useState } from "react";
import { STR5 } from "@synapse/shared";
import { nativeCall } from "../native";

/**
 * 0.1.4 first-run: the opt-in beside the "can't recognise speech on its own" notice. Nothing was sent before it;
 * after it, this Mac's speech may go to Apple's servers (Settings → Voice turns it off again).
 */
export function ServerSpeechAllow({ onAllowed }: { onAllowed(): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="link-btn" disabled={busy} onClick={() => {
      setBusy(true);
      void nativeCall("speech.server.set", { on: true }).then(() => onAllowed(), () => {}).finally(() => setBusy(false));
    }}>
      {STR5.speechServerAllow}
    </button>
  );
}
