import { create } from "zustand";
import type { UsageView } from "@synapse/shared";
import { call } from "../bridge";
import { subscribeChannel } from "../feature-store";
import { useUi } from "../store";

/** Spend and billing live in the Anthropic Console (the API key is the only sign-in). */
export const BILLING_URLS = {
  consoleBilling: "https://console.anthropic.com/settings/billing",
} as const;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

interface UsageState { view: UsageView | null; error: string | null; load(): Promise<void> }

export const useUsage = create<UsageState>((set) => ({
  view: null,
  error: null,
  // Hand-testing round: the load's rejection used to be swallowed by startUsageSync's
  // `.catch(() => {})`, so `view` stayed null forever and Settings -> Usage & Billing rendered as
  // a heading over nothing — the same on screen whether it was still loading or permanently
  // broken. The failure is kept here so the section can show it and offer a retry.
  load: async () => {
    set({ error: null });
    try {
      set({ view: await call("getUsage", {}) });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

let unsub: (() => void) | null = null;
export function startUsageSync(): void {
  unsub ??= subscribeChannel("usage", (v) => useUsage.setState({ view: v }));
  void useUsage.getState().load();
}
