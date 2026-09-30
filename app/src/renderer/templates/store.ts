import { create } from "zustand";
import { GatewayCallError, LIMITS5, SHARE_SITE, shareLinks, STRSH, type CatalogEntry, type TemplateManifest, type TemplatePreview, type TemplateRecord } from "@synapse/shared";
import { call, callQuiet } from "../bridge";
import { registerTemplateAdder } from "../marketplace/store";
import { nativeCall } from "../native";
import { useUi } from "../store";
import { copyWithConfirmation } from "../toast";

// Task 34 fuzz: a rejected .botpack (unsafe names, damaged, too large) used to fail silently.
const showError = (e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) });

type Sheet = null
  | { kind: "export"; botId: string; draft: TemplateManifest | null; savedPath: string | null; error: string | null }
  | { kind: "import"; preview: TemplatePreview; fragment?: string }
  | { kind: "details"; template: TemplateRecord }
  /** Bot sharing: the Share sheet (`website`: the owner's Export for website, the same sheet plus a blurb). */
  | { kind: "share"; botId: string; website: boolean }
  /** Bot sharing: a link that can't be opened, as one calm line (`newer` offers Update). */
  | { kind: "share-error"; message: string; newer: boolean };
interface TemplatesState {
  sheet: Sheet;
  openExport(botId: string): Promise<void>;
  openDetails(botId: string): Promise<void>;
  importBytes(b64: string): Promise<void>;
  importFromFile(): Promise<void>;
  importFromOpenedPath(path: string): Promise<void>;
  importEntry(e: CatalogEntry): Promise<void>;
  close(): void;
  /** Bot sharing: open the Share sheet for a Bot. */
  openShare(botId: string, website?: boolean): void;
  /** Bot sharing: a share link's fragment → the Import sheet (held while setup or onboarding isn't finished). */
  importShare(fragment: string, o?: { now?: boolean }): Promise<void>;
  /** Bot sharing: the menu's one-click Copy link (the last copied link, while the Bot is unchanged). */
  copyShareLink(botId: string): Promise<void>;
  /** A link's one calm line (unknown routes, a failed copy). */
  shareError(message: string, newer?: boolean): void;
  /** False while first-run setup or onboarding is on screen: a link waits for it (App.tsx sets this). */
  importReady: boolean;
  pendingShare: string | null;
  setImportReady(ready: boolean): void;
  /** Onboarding's "Paste a Bot link": what to do once the pasted Bot is added (finish onboarding with it). */
  afterAdd: ((id: string) => void) | null;
}

/** Twenty fast clicks on a link are one sheet: one preview in flight, and only the newest waiting behind it. */
let inFlight: string | null = null;
let queued: string | null = null;

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
  close: () => set({ sheet: null, afterAdd: null }),
  openShare: (botId, website = false) => set({ sheet: { kind: "share", botId, website } }),
  importShare: async (fragment, o) => {
    // `now`: onboarding's own Paste a Bot link, which shows the sheet over onboarding instead of waiting for it.
    if (!get().importReady && !o?.now) { set({ pendingShare: fragment }); return; }
    const cur = get().sheet;
    if (fragment === inFlight || (cur?.kind === "import" && cur.fragment === fragment)) return;
    if (inFlight) { queued = fragment; return; }
    inFlight = fragment;
    try {
      // callQuiet: a bad link is presented here, in the sheet, as its one line (not the sidebar banner).
      const preview = await callQuiet("previewShareImport", { payload: fragment });
      set({ sheet: { kind: "import", preview, fragment } });
    } catch (e) {
      const newer = e instanceof GatewayCallError && e.code === "SHARE_NEWER";
      set({ sheet: { kind: "share-error", message: e instanceof GatewayCallError && e.code.startsWith("SHARE_") ? e.message : STRSH.damaged, newer } });
    } finally {
      inFlight = null;
      const next = queued;
      queued = null;
      if (next && next !== fragment) void get().importShare(next);
    }
  },
  copyShareLink: async (botId) => {
    try {
      const s = await call("sharePayload", { id: botId, remember: true });
      if (s.fragment) await copyWithConfirmation(shareLinks(s.fragment, SHARE_SITE).web, STRSH.copied);
      else get().openShare(botId);
    } catch { /* reported by call() */ }
  },
  shareError: (message, newer = false) => set({ sheet: { kind: "share-error", message, newer } }),
  // False until App.tsx knows the app proper is on screen (connected, set up, onboarded).
  importReady: false,
  pendingShare: null,
  setImportReady: (ready) => {
    set({ importReady: ready });
    const p = get().pendingShare;
    if (ready && p) { set({ pendingShare: null }); void get().importShare(p); }
  },
  afterAdd: null,
}));

registerTemplateAdder((e) => void useTemplates.getState().importEntry(e));
