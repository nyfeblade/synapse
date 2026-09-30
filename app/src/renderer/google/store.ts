import { useEffect } from "react";
import { create } from "zustand";
import type { GoogleSetupMode, GoogleSetupStepId, GoogleStatusView } from "@synapse/shared";
import { call } from "../bridge";
import { subscribeChannel } from "../feature-store";
import { nativeCall } from "../native";

/** google-setup: "Do it yourself" or "Let a Bot do it" (the reconnect flow's Bot option is the same panel). */
export type GoogleSheetMode = "self" | "bot";

interface GoogleState {
  open: boolean;
  status: GoogleStatusView | null;
  error: string | null;
  busy: boolean;
  mode: GoogleSheetMode;
  /** The user's own ticks for the steps the app can't see (project, APIs, consent screen, In production). */
  checks: Partial<Record<GoogleSetupStepId, boolean>>;
  /** Optional: every later console link opens in this project instead of Google's picker. */
  projectId: string;
  openSheet(o?: { mode?: GoogleSheetMode; reconnect?: boolean }): void;
  close(): void;
  load(): Promise<void>;
  setMode(m: GoogleSheetMode): void;
  tick(step: GoogleSetupStepId, on: boolean): void;
  setProjectId(v: string): void;
  /** With a client ID + secret they are saved first (host-private); then Google's consent opens in the browser. */
  connect(client?: { clientId: string; clientSecret: string }): Promise<void>;
  disconnect(): Promise<void>;
  /** 4.3b: another Google sign-in; a new address becomes another account. */
  addAccount(): Promise<void>;
  /** 4.3b: one account out (its tokens revoked, its grants gone). */
  removeAccount(accountId: string): Promise<void>;
  /** 4.3b: tick or untick one account for one Bot. */
  setAccountGrant(botId: string, accountId: string, enabled: boolean): Promise<void>;
  startTask(botId: string, mode: GoogleSetupMode): Promise<void>;
  stopTask(): Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const KEY = "synapse.google-setup";
/** Per-viewer convenience only (ticks and the project id): a missing or blocked store just starts fresh. */
function loadLocal(): Pick<GoogleState, "checks" | "projectId"> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { checks?: unknown; projectId?: unknown };
    return { checks: raw.checks && typeof raw.checks === "object" ? (raw.checks as GoogleState["checks"]) : {}, projectId: typeof raw.projectId === "string" ? raw.projectId : "" };
  } catch { return { checks: {}, projectId: "" }; }
}
function saveLocal(s: Pick<GoogleState, "checks" | "projectId">): void {
  try { localStorage.setItem(KEY, JSON.stringify({ checks: s.checks, projectId: s.projectId })); } catch { /* not kept */ }
}

/** Live status from the host's "google" channel while a Google surface is mounted. */
export function useGoogleSync(): void {
  useEffect(() => subscribeChannel("google", (status) => useGoogle.setState({ status })), []);
}

export const useGoogle = create<GoogleState>((set, get) => ({
  open: false, status: null, error: null, busy: false, mode: "self", ...loadLocal(),
  openSheet: (o) => {
    set({ open: true, error: null, ...(o?.mode ? { mode: o.mode } : {}) });
    // "Reconnect Google" (the notification) goes straight to Google's sign-in; the sheet shows "Click Allow".
    if (o?.reconnect) void get().connect(); else void get().load();
  },
  close: () => set({ open: false, error: null }),
  load: async () => {
    try { set({ status: await call("getGoogleStatus", {}) }); } catch (e) { set({ error: message(e) }); }
  },
  setMode: (mode) => set({ mode }),
  tick: (step, on) => { const checks = { ...get().checks, [step]: on }; set({ checks }); saveLocal({ checks, projectId: get().projectId }); },
  setProjectId: (projectId) => { set({ projectId }); saveLocal({ checks: get().checks, projectId }); },
  connect: async (client) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      // The "In production" tick travels with the client, so the weekly check's default knows about Testing.
      if (client) set({ status: await call("setGoogleClient", { ...client, ...(get().checks.production !== undefined ? { inProduction: get().checks.production === true } : {}) }) });
      const { authorizationUrl } = await call("startGoogleAuth", {});
      await get().load();
      await nativeCall("openExternal", { url: authorizationUrl });
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ busy: false });
    }
  },
  disconnect: async () => {
    set({ busy: true, error: null });
    try { set({ status: await call("disconnectGoogle", {}) }); } catch (e) { set({ error: message(e) }); } finally { set({ busy: false }); }
  },
  addAccount: () => get().connect(),
  removeAccount: async (accountId) => {
    set({ busy: true, error: null });
    try { set({ status: await call("disconnectGoogle", { accountId }) }); } catch (e) { set({ error: message(e) }); } finally { set({ busy: false }); }
  },
  setAccountGrant: async (botId, accountId, enabled) => {
    try { set({ status: await call("setAgentGoogleAccount", { id: botId, accountId, enabled }), error: null }); } catch (e) { set({ error: message(e) }); }
  },
  startTask: async (botId, mode) => {
    set({ busy: true, error: null });
    try { set({ status: await call("startGoogleSetupTask", { botId, mode, projectId: get().projectId.trim() || null }) }); }
    catch (e) { set({ error: message(e) }); } finally { set({ busy: false }); }
  },
  stopTask: async () => {
    try { set({ status: await call("cancelGoogleSetupTask", {}) }); } catch (e) { set({ error: message(e) }); }
  },
}));
