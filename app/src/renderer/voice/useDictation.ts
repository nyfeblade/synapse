import { useEffect, useRef, useState } from "react";
import { nativeCall, onNative } from "../native";
import { dictationFault, type PrivacyPane } from "./dictation-errors";
import { isOwnSession, newDictationSessionId } from "./session";
import { sttContextFor } from "./stt-context";
import { useUi } from "../store";

type Ev = (
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string; code?: string }
  | { type: "end" }
) & { sessionId?: string };

/**
 * CHAT-08 dictation — "just dictation" (bug 101): one utterance, live. `onPartial` gets the words as
 * they are recognised (the composer shows them in place), `onFinal` the finished text; the helper
 * ends the session on a second press or on silence. Nothing is ever sent.
 */
export function useDictation(onFinal: (text: string) => void, onPartial?: (text: string) => void): { listening: boolean; partial: string; error: string | null; notice: string | null; privacyPane: PrivacyPane | null; serverOptIn: boolean; start(locale?: string): void; stop(): void } {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [privacyPane, setPrivacyPane] = useState<PrivacyPane | null>(null);
  /** 0.1.4 first-run: the fault is "no on-device recognition", so the opt-in to Apple's servers goes beside it. */
  const [serverOptIn, setServerOptIn] = useState(false);
  const cb = useRef(onFinal);
  cb.current = onFinal;
  const partialCb = useRef(onPartial);
  partialCb.current = onPartial;
  // Tracks whether a session is currently in progress, read (not just written) by the effect's
  // cleanup below — state updates aren't visible to a closure set up on mount, so this ref is the
  // only reliable way for that cleanup to know whether it needs to stop a live session.
  const listeningRef = useRef(false);
  // The dictation session this composer owns. The native "dictation" channel is shared with the
  // voice overlay, so anything stamped with another session is somebody else's speech.
  const sessionRef = useRef<string | null>(null);
  useEffect(() => {
    const unsubscribe = onNative<Ev>("dictation", (e) => {
      if (!isOwnSession(e.sessionId, sessionRef.current)) return; // the voice overlay's session, not ours
      if (e.type === "partial") { setPartial(e.text); partialCb.current?.(e.text); }
      if (e.type === "final") {
        // A `final` doesn't mean the helper process has exited — only `end` (the child's `close`
        // event in the main process) does, so listening stays true until then.
        setPartial("");
        if (e.text.trim()) cb.current(e.text.trim());
      }
      if (e.type === "error") {
        setListening(false);
        listeningRef.current = false;
        setPartial("");
        // Bug 99/101: every stop says why. A permission fault names its switch and carries the pane
        // that fixes it; "nobody spoke" is a quiet notice; anything else is the helper's own reason.
        const f = dictationFault(e.message, e.code);
        setPrivacyPane(f.pane);
        setServerOptIn(f.serverOptIn === true);
        setError(f.notice ? null : f.text);
        setNotice(f.notice ? f.text : null);
      }
      if (e.type === "end") {
        setListening(false);
        listeningRef.current = false;
      }
    });
    return () => {
      unsubscribe();
      // Unmounting (e.g. navigating away from this bot's chat) while a session is still listening
      // must not leave the native helper process — and the microphone — running with no UI
      // affordance left to stop it.
      if (listeningRef.current) {
        listeningRef.current = false;
        void nativeCall("dictation.stop", { sessionId: sessionRef.current });
      }
    };
  }, []);
  return {
    listening,
    partial,
    error,
    notice,
    privacyPane,
    serverOptIn,
    start: (locale) => {
      setError(null);
      setNotice(null);
      setPrivacyPane(null);
      setServerOptIn(false);
      setListening(true);
      listeningRef.current = true;
      const sessionId = newDictationSessionId();
      sessionRef.current = sessionId;
      // Bug 162: tell the recognizer which names to expect — the Bot names and the open chat's own
      // vocabulary. Read at start, never subscribed to, so this costs nothing while idle.
      const { bots, transcripts, activeBotId } = useUi.getState();
      const context = sttContextFor(bots, transcripts, activeBotId);
      void nativeCall("dictation.start", { sessionId, ...(locale ? { locale } : {}), ...(context.length ? { context } : {}) });
    },
    stop: () => {
      listeningRef.current = false;
      // Scoped: stopping must never take the microphone away from the voice overlay's session.
      void nativeCall("dictation.stop", { sessionId: sessionRef.current });
    },
  };
}
