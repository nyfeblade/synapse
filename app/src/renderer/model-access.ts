import { create } from "zustand";
import { MODEL_IDS, type ModelAccessView, type ModelId } from "@synapse/shared";
import { call } from "./bridge";
import { subscribeChannel } from "./feature-store";

/**
 * P4: which models the saved Anthropic API key can reach (the host probes them with free count_tokens calls after a key
 * is saved and on demand). The picker hides a model only when the host says the key can't use it; an unchecked model
 * stays listed.
 */
interface ModelAccessState {
  view: ModelAccessView | null;
  load(): Promise<void>;
  refresh(): Promise<void>;
}

export const useModelAccess = create<ModelAccessState>((set) => ({
  view: null,
  load: async () => {
    try { set({ view: await call("getModelAccess", {}) }); } catch { /* an older host: every model stays listed */ }
  },
  refresh: async () => {
    try { set({ view: await call("getModelAccess", { refresh: true }) }); } catch { /* the Account section shows nothing new */ }
  },
}));

let unsub: (() => void) | null = null;
/** Loads once and follows the host's "model-access" channel (the payload is a ModelAccessView). */
export function startModelAccessSync(): void {
  unsub ??= subscribeChannel("model-access", (v) => useModelAccess.setState({ view: v }));
  void useModelAccess.getState().load();
}

/** The models the picker offers: every model the key isn't known to be unable to use, plus the current one. */
export function pickableModels(view: ModelAccessView | null, current: ModelId): ModelId[] {
  return MODEL_IDS.filter((m) => m === current || view?.models?.[m] !== false);
}

/** Tests: forget the subscription. */
export function resetModelAccessSync(): void { unsub?.(); unsub = null; }
