import { create } from "zustand";
import type { IncomingCallView } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { subscribeChannel } from "../feature-store";

/**
 * A Bot calling the user. `calls` = the host's live rings (SSE "bot-calls"); `opening` = the line a
 * just-accepted call opens with (the Bot's reason), spoken by the call screen once its helper is up;
 * `handled` = rings this window already decided on (policy checked, answered), so a re-publish of the
 * same ring never rings or answers twice.
 */
export const useBotCalls = create<{
  calls: IncomingCallView[];
  opening: { botId: string; text: string; acceptedAt: number } | null;
  handled: Set<string>;
  set(calls: IncomingCallView[]): void;
  takeOpening(botId: string): { text: string; acceptedAt: number } | null;
}>((set, get) => ({
  calls: [],
  opening: null,
  handled: new Set(),
  set: (calls) => set({ calls }),
  takeOpening: (botId) => {
    const o = get().opening;
    if (!o || o.botId !== botId) return null;
    set({ opening: null });
    return { text: o.text, acceptedAt: o.acceptedAt };
  },
}));

let wired = false;
/** Live rings over SSE, plus the current list on every (re)connect. */
export function wireBotCalls(): void {
  if (wired || typeof window === "undefined" || !window.synapse?.onEvent) return;
  wired = true;
  subscribeChannel("bot-calls", (v) => useBotCalls.getState().set(Array.isArray(v?.calls) ? v.calls : []));
  window.synapse.onConnection((s) => {
    if (s.kind !== "connected") return;
    void callQuiet("listBotCalls", {}).then((v) => useBotCalls.getState().set(Array.isArray(v?.calls) ? v.calls : []), () => {});
  });
}
