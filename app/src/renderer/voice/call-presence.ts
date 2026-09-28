import { create } from "zustand";

/**
 * Bug 134: who is on the live call, for the sidebar's presence ("On a call") and the mini call pill; and
 * where the full call screen goes (the call's chat pane, when it is the one on screen). The call itself
 * lives at the app level, so it keeps running while the user looks at other chats.
 */
export const useCallPresence = create<{ chatId: string | null; members: string[]; set(chatId: string | null, members: string[]): void }>((set) => ({
  chatId: null, members: [], set: (chatId, members) => set({ chatId, members }),
}));

/** The chat pane on screen registers itself here; the call screen is portalled into it when it is the call's chat. */
export const useCallSlot = create<{ el: HTMLElement | null; botId: string | null; set(el: HTMLElement | null, botId: string | null): void }>((set) => ({
  el: null, botId: null, set: (el, botId) => set({ el, botId }),
}));
