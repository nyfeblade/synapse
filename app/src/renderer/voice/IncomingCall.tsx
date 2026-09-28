import { useEffect, useRef, useState } from "react";
import { STRV, type IncomingCallView } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { HangUpIcon, HeadsetIcon } from "../components/Icons";
import { ShapeAvatar } from "../components/ShapeAvatar";
import { nativeCall } from "../native";
import { useUi } from "../store";
import { useBotCalls, wireBotCalls } from "./bot-calls-store";
import { startRing, useCallSoundsEnabled } from "./call-sounds";
import { useVoice } from "./VoiceOverlay";

/**
 * The ring while a Bot's call sits unanswered (call-sounds.ts): starts the instant the ring shows,
 * stops with a quick fade the instant it doesn't — answered, declined, timed out (the host's own
 * ring timeout), or withdrawn all clear it the same way, since each just removes this call from
 * `calls`. Silent when Settings → Voice, "Call sounds" is off.
 */
function useRingTone(on: boolean): void {
  const soundsOn = useCallSoundsEnabled();
  useEffect(() => {
    if (!on || !soundsOn) return;
    const ring = startRing();
    return () => ring.stop();
  }, [on, soundsOn]);
}

/**
 * A Bot calling the user: the in-app ring (the Bot's avatar, its reason; Accept, Decline, Message
 * instead) plus a Mac notification when the app isn't in front. Quiet hours and Focus are checked
 * first: then there is no ring at all, and the host records a missed call with the reason why.
 */
export function IncomingCall() {
  useEffect(() => wireBotCalls(), []);
  const calls = useBotCalls((s) => s.calls);
  const bots = useUi((s) => s.bots);
  const [ready, setReady] = useState<string[]>([]);
  // Decide once per ring: ring it, or answer "missed" with the reason.
  useEffect(() => {
    const handled = useBotCalls.getState().handled;
    for (const c of calls) {
      if (handled.has(c.callId)) continue;
      handled.add(c.callId);
      void nativeCall<{ ring: boolean; why?: string }>("calls.policy").then((p) => {
        if (p && p.ring === false) {
          void callQuiet("answerBotCall", { callId: c.callId, answer: "missed", why: p.why ?? "" }).catch(() => {});
          return;
        }
        setReady((r) => [...r, c.callId]);
        const name = useUi.getState().bots[c.botId]?.profile.name ?? "A Bot";
        void nativeCall("calls.ring", { botId: c.botId, title: STRV.incomingCall(name), body: c.reason }).catch(() => {});
      }, () => setReady((r) => [...r, c.callId]));
    }
  }, [calls, setReady]);
  const ring: IncomingCallView | undefined = calls.find((c) => ready.includes(c.callId) && bots[c.botId]);
  useRingTone(Boolean(ring));
  const accept = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (ring) accept.current?.focus(); }, [ring?.callId]);
  const bot = ring ? bots[ring.botId] : undefined;
  if (!ring || !bot) return null;
  const name = bot.profile.name;
  const answer = (answer: "accept" | "decline" | "message", allow?: boolean) => {
    useBotCalls.getState().set(useBotCalls.getState().calls.filter((c) => c.callId !== ring.callId));
    const acceptedAt = performance.now();
    return callQuiet("answerBotCall", { callId: ring.callId, answer, ...(allow === false ? { allow } : {}) }).then(async () => {
      if (answer === "decline") return;
      await useUi.getState().openBot(ring.botId);
      if (answer === "message") { setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus(), 0); return; }
      useBotCalls.setState({ opening: { botId: ring.botId, text: ring.reason, acceptedAt } });
      useVoice.getState().open(ring.botId);
    }, () => {});
  };
  return (
    <div className="incoming-call" role="alertdialog" aria-label={STRV.incomingCall(name)} aria-describedby="incoming-call-reason">
      <div className="incoming-call-avatar"><ShapeAvatar shape={bot.profile.avatarShape} color={bot.profile.avatarColor} size={48} /></div>
      <div className="incoming-call-text">
        <b>{STRV.incomingCall(name)}</b>
        <p id="incoming-call-reason">{ring.reason}</p>
        {ring.firstCall && <p className="muted incoming-call-first">{STRV.firstCallNote(name)} <button type="button" className="link-btn" onClick={() => void answer("decline", false)}>{STRV.dontAllowCalls(name)}</button></p>}
      </div>
      <div className="incoming-call-actions">
        <button type="button" className="btn-outline small" onClick={() => void answer("message")}>{STRV.messageInstead}</button>
        <button type="button" className="round-btn hang-up" aria-label={STRV.declineCall} title={STRV.declineCall} onClick={() => void answer("decline")}><HangUpIcon /></button>
        <button ref={accept} type="button" className="round-btn accept-call" aria-label={STRV.acceptCall} title={STRV.acceptCall} onClick={() => void answer("accept")}><HeadsetIcon /></button>
      </div>
    </div>
  );
}
