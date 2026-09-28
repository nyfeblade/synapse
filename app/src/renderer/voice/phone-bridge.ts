import { useEffect } from "react";
import { create } from "zustand";
import type { BotSummary } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { nativeCall, onNative } from "../native";
import { useUi } from "../store";
import { useBotCalls } from "./bot-calls-store";
import { useVoice } from "./VoiceOverlay";

/**
 * Bug 198: a call placed from the user's phone (Phone access). The call screen here runs it exactly
 * like a call from the Mac — the only difference is where its microphone and speaker are, which main
 * decides — so all this does is open and close the call screen when the phone says so, and tell the
 * call screen not to make its own sounds on this Mac.
 */
export const usePhoneCall = create<{ botId: string | null; seq: number }>(() => ({ botId: null, seq: 0 }));

/** True while the call with `botId` is the phone's. */
export function isPhoneCall(botId: string): boolean {
  return usePhoneCall.getState().botId === botId;
}

type Bots = Record<string, BotSummary>;
/** What the phone lists: live, 1:1 Bots with their avatar's colour and shape. */
export function phoneBots(bots: Bots): { id: string; name: string; color: string; shape: string }[] {
  return Object.values(bots).filter((b) => !b.archived && !b.group).map((b) => ({ id: b.id, name: b.profile.name, color: b.profile.avatarColor, shape: b.profile.avatarShape }));
}

export function handlePhoneEvent(e: { type?: string; botId?: string; seq?: number }): void {
  if (typeof e?.botId !== "string") return;
  const botId = e.botId;
  if (e.type === "call") {
    usePhoneCall.setState({ botId, seq: typeof e.seq === "number" ? e.seq : 0 });
    const voice = useVoice.getState();
    // The phone call takes over: a call already open here (even with this Bot, on this Mac's own
    // microphone) ends first, and the call screen comes back up on the phone's audio.
    const reopen = voice.openFor !== null;
    if (reopen) voice.close();
    // Answering a Bot's ring from the phone: the ring is answered, and the Bot opens with why it called.
    const ring = useBotCalls.getState().calls.find((c) => c.botId === botId);
    if (ring) {
      useBotCalls.getState().set(useBotCalls.getState().calls.filter((c) => c.callId !== ring.callId));
      void callQuiet("answerBotCall", { callId: ring.callId, answer: "accept" }).catch(() => {});
      useBotCalls.setState({ opening: { botId, text: ring.reason, acceptedAt: performance.now() } });
    }
    const open = () => { if (usePhoneCall.getState().botId === botId) useVoice.getState().open(botId); };
    // A separate tick after a close, so the old call screen unmounts (and lets go of its helper) first.
    const later = () => (reopen ? setTimeout(open, 60) : open());
    void useUi.getState().openBot(botId).then(later, later);
    return;
  }
  if (e.type === "hangup") {
    // The call screen's own cleanup clears the phone flag (it needs it to stay quiet on this Mac).
    if (useVoice.getState().openFor === botId) useVoice.getState().close();
    else if (usePhoneCall.getState().botId === botId) usePhoneCall.setState({ botId: null, seq: 0 });
  }
}

/** Mounted once, in App: the Bot list for the phone, and the phone's call requests. */
export function usePhoneBridge(): void {
  const key = useUi((s) => JSON.stringify(phoneBots(s.bots)));
  useEffect(() => { void nativeCall("phone.bots", { bots: JSON.parse(key) as unknown[] }).catch(() => {}); }, [key]);
  useEffect(() => onNative<{ type?: string; botId?: string; seq?: number }>("phone", handlePhoneEvent), []);
}
