import { create } from "zustand";
import { onNative } from "../native";

export type UpdateState = { version: string; track: "stable"; auto: boolean; feed?: string | null; status: string; latest: string | null; error: string | null };

interface UpdatesStoreState { state: UpdateState | null }

export const useUpdates = create<UpdatesStoreState>(() => ({ state: null }));

let unsub: (() => void) | null = null;
/** Fix round 1, finding 2 (UI-03): mirrors usage/store.ts's startUsageSync — a module-scope
 * subscription to the native "updates" channel, kept live for the app's lifetime instead of a
 * render-local variable, so the account-menu badge reflects a background auto-check/download
 * (registerUpdater's 6-hour tick) even when the user never opened Settings → Updates. Idempotent:
 * call it from anywhere that wants the store fresh (App.tsx at mount, and UpdatesSection too). */
export function startUpdatesSync(): void {
  unsub ??= onNative<UpdateState>("updates", (s) => useUpdates.setState({ state: s }));
}
