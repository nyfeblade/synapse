import { useEffect } from "react";
import { create } from "zustand";
import type { GoogleStatusView } from "@synapse/shared";
import { call } from "../bridge";
import { subscribeChannel } from "../feature-store";
import { nativeCall } from "../native";

interface GoogleState {
  open: boolean;
  status: GoogleStatusView | null;
  error: string | null;
  busy: boolean;
  openSheet(): void;
  close(): void;
  load(): Promise<void>;
  /** With a client ID + secret they are saved first (host-private); then Google's consent opens in the browser. */
  connect(client?: { clientId: string; clientSecret: string }): Promise<void>;
  disconnect(): Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Live status from the host's "google" channel while a Google surface is mounted. */
export function useGoogleSync(): void {
  useEffect(() => subscribeChannel("google", (status) => useGoogle.setState({ status })), []);
}

export const useGoogle = create<GoogleState>((set, get) => ({
  open: false, status: null, error: null, busy: false,
  openSheet: () => { set({ open: true, error: null }); void get().load(); },
  close: () => set({ open: false, error: null }),
  load: async () => {
    try { set({ status: await call("getGoogleStatus", {}) }); } catch (e) { set({ error: message(e) }); }
  },
  connect: async (client) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      if (client) set({ status: await call("setGoogleClient", client) });
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
}));
