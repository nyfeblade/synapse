import { create } from "zustand";
import type { SpendMeterMode, SpendMeterView } from "@synapse/shared";
import { call, callQuiet } from "../bridge";
import { subscribeChannel } from "../feature-store";

/** An older host (or a stand-in) answers with something else: the meter then stays hidden rather than throwing. */
const isMeter = (v: unknown): v is SpendMeterView => {
  const x = v as SpendMeterView | null;
  return !!x && typeof x.mode === "string" && typeof x.todayUsd === "number" && typeof x.monthUsd === "number" && !!x.turns && typeof x.turns === "object";
};
const take = (v: unknown) => useSpendMeter.setState({ view: isMeter(v) ? v : null });

interface MeterState { view: SpendMeterView | null; setMode(mode: SpendMeterMode): Promise<void> }

/** 5.7: the header's spend meter. The host pushes it ("spend-meter", a few times a second at most); nothing polls. */
export const useSpendMeter = create<MeterState>((set) => ({
  view: null,
  setMode: async (mode) => { const v = await call("setSpendMeter", { mode }); set({ view: isMeter(v) ? v : null }); },
}));

let unsub: (() => void) | null = null;
export function startSpendMeterSync(): void {
  unsub ??= subscribeChannel("spend-meter", take);
  // An older host has no meter: it simply stays hidden.
  void callQuiet("getSpendMeter", {}).then(take).catch(() => {});
}
