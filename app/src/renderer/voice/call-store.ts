import { create } from "zustand";

const KEY = "bots.call.interrupted";
const MAX = 200;

function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
}

/**
 * Voice calls: replies the user talked over. The chat keeps such a reply cut at the last sentence
 * that was spoken, marked "(interrupted)". Kept in this browser (a per-viewer display detail); the
 * full reply stays in the transcript itself.
 */
export const useCall = create<{ interrupted: Record<string, string>; markInterrupted(entryId: string, said: string): void }>((set) => ({
  interrupted: load(),
  markInterrupted: (entryId, said) => set((s) => {
    const next = { ...s.interrupted, [entryId]: said };
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete next[k];
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window: this session only */ }
    return { interrupted: next };
  }),
}));
