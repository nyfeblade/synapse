import { create } from "zustand";

export type OverlayKind = "palette" | "skills" | "hidden-bots";
export const useOverlays = create<{ open: OverlayKind | null; openOverlay(k: OverlayKind): void; close(): void }>((set) => ({
  open: null,
  openOverlay: (k) => set({ open: k }),
  close: () => set({ open: null }),
}));
