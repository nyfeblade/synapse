import { create } from "zustand";
import type { ModelCatalogView } from "@synapse/shared";
import { call } from "./bridge";

/**
 * Spec §10: the model picker's data — models grouped by provider with the badges their measured evidence gives them.
 * An older host (or a test without it) answers nothing usable: the pickers then offer the Claude models as before.
 */
interface ModelCatalogState { view: ModelCatalogView | null; load(): Promise<void> }
export const useModelCatalog = create<ModelCatalogState>((set) => ({
  view: null,
  load: async () => {
    try {
      const v = await call("getModelCatalog", {});
      set({ view: v && Array.isArray((v as ModelCatalogView).groups) ? v : null });
    } catch { /* keep the Claude-only picker */ }
  },
}));

/** True when the picker has more than Claude to offer (a provider is set up). */
export function hasProviders(v: ModelCatalogView | null): v is ModelCatalogView {
  return !!v && v.groups.some((g) => g.provider !== "anthropic");
}
