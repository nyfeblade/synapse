import { create } from "zustand";
import { LIMITS5, type CatalogEntry, type TemplateManifest, type TemplatePreview, type TemplateRecord } from "@synapse/shared";
import { call } from "../bridge";
import { registerTemplateAdder } from "../marketplace/store";
import { nativeCall } from "../native";
import { useUi } from "../store";

// Task 34 fuzz: a rejected .botpack (unsafe names, damaged, too large) used to fail silently.
const showError = (e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) });

type Sheet = null | { kind: "export"; botId: string; draft: TemplateManifest | null; savedPath: string | null; error: string | null } | { kind: "import"; preview: TemplatePreview } | { kind: "details"; template: TemplateRecord };
interface TemplatesState {
  sheet: Sheet;
  openExport(botId: string): Promise<void>;
  openDetails(botId: string): Promise<void>;
  importBytes(b64: string): Promise<void>;
  importFromFile(): Promise<void>;
  importFromOpenedPath(path: string): Promise<void>;
  importEntry(e: CatalogEntry): Promise<void>;
  close(): void;
}

export const useTemplates = create<TemplatesState>((set, get) => ({
  sheet: null,
  openExport: async (botId) => {
    set({ sheet: { kind: "export", botId, draft: null, savedPath: null, error: null } });
    // The user (or Escape, controller ruling 3) may close the sheet — or open a different one — while this
    // is in flight; a stale response must not reopen or overwrite it (e2e flake: Escape right after Share
    // as Template, before draftTemplate lands).
    const stillOpen = () => { const s = get().sheet; return s?.kind === "export" && s.botId === botId; };
    try {
      const { draft } = await call("draftTemplate", { id: botId });
      if (stillOpen()) set({ sheet: { kind: "export", botId, draft, savedPath: null, error: null } });
    } catch (e) {
      if (stillOpen()) set({ sheet: { kind: "export", botId, draft: null, savedPath: null, error: (e as Error).message } });
    }
  },
  openDetails: async (botId) => {
    const { template } = await call("getTemplate", { id: botId });
    if (template) set({ sheet: { kind: "details", template } });
  },
  importBytes: async (b64) => {
    try { set({ sheet: { kind: "import", preview: await call("previewTemplateImport", { bytesBase64: b64 }) } }); } catch (e) { showError(e); }
  },
  importFromFile: async () => {
    let f: { bytesBase64: string } | null;
    try { f = await nativeCall<{ bytesBase64: string } | null>("openFile", { filters: [{ name: "Bot template", extensions: ["botpack"] }], maxBytes: LIMITS5.templateMaxBytes }); } catch (e) { return showError(e); }
    if (f) await useTemplates.getState().importBytes(f.bytesBase64);
  },
  importFromOpenedPath: async (path) => {
    try {
      const f = await nativeCall<{ bytesBase64: string }>("readDroppedFile", { path, maxBytes: LIMITS5.templateMaxBytes });
      await get().importBytes(f.bytesBase64);
    } catch (e) { showError(e); }
  },
  importEntry: async (e) => {
    try { set({ sheet: { kind: "import", preview: await call("previewTemplateImport", e.source === "starter" ? { starterId: e.id } : { templateId: e.id }) } }); } catch (err) { showError(err); }
  },
  close: () => set({ sheet: null }),
}));

registerTemplateAdder((e) => void useTemplates.getState().importEntry(e));
