import { create } from "zustand";
import { STRS, type StandupCard, type StandupSettings, type StandupView } from "@synapse/shared";
import { call, callQuiet } from "../bridge";
import { subscribeChannel } from "../feature-store";
import { speak } from "../voice/tts";
import { useVoice } from "../voice/VoiceOverlay";

interface StandupStore {
  view: StandupView | null;
  error: string | null;
  running: boolean;
  load(): Promise<void>;
  update(p: Partial<StandupSettings>): Promise<void>;
  runNow(): Promise<void>;
}

export const useStandup = create<StandupStore>((set, get) => ({
  view: null,
  error: null,
  running: false,
  load: async () => {
    try {
      set({ view: await callQuiet("getStandup", {}), error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  update: async (p) => {
    set({ view: await call("setStandupSettings", p) });
  },
  runNow: async () => {
    if (get().running) return;
    set({ running: true });
    try {
      await call("runStandupNow", {});
    } finally {
      set({ running: false });
    }
  },
}));

/** The spoken version: the page's system voice (the call's own voice engine owns the helper while a call runs). */
export function playStandup(card: StandupCard): Promise<void> {
  return speak(STRS.standupSpokenText(card.lines), {});
}

let wired = false;
/** A new card arrives over SSE; it is read aloud only when the user opted in and a voice call is open. */
export function wireStandup(): void {
  if (wired || typeof window === "undefined" || !window.synapse?.onEvent) return;
  wired = true;
  subscribeChannel("standup", (view) => {
    const prev = useStandup.getState().view?.latest?.id;
    useStandup.setState({ view });
    const card = view.latest;
    if (card && !card.error && card.id !== prev && view.settings.spoken && useVoice.getState().openFor) void playStandup(card);
  });
}
