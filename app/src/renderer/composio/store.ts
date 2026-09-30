import { useEffect } from "react";
import { create } from "zustand";
import { isComposioLink, type ComposioStatusView } from "@synapse/shared";
import { call } from "../bridge";
import { subscribeChannel } from "../feature-store";
import { nativeCall } from "../native";

interface ComposioState {
  open: boolean;
  status: ComposioStatusView | null;
  error: string | null;
  busy: string | null;
  /** The toolkit waiting on the one-time data note before its Connect goes ahead. */
  disclosureFor: string | null;
  /** The last redirect per toolkit, for Reopen while waiting. */
  links: Record<string, string>;
  openSheet(): void;
  close(): void;
  load(): Promise<void>;
  /** Paste key: Electron main reads the clipboard on this click and sends the key to the host; it never comes here. */
  pasteKey(): Promise<void>;
  clearKey(): Promise<void>;
  connect(toolkit: string): Promise<void>;
  acceptAndConnect(): Promise<void>;
  cancelDisclosure(): void;
  reopen(toolkit: string): void;
  /** 4.3b: with accountId, only that account. */
  disconnect(toolkit: string, accountId?: string): Promise<void>;
  /** 4.3b: with accountId, that account; without, every connected account of the app. */
  setGrant(toolkit: string, botId: string, enabled: boolean, accountId?: string): Promise<void>;
  /** 4.3b: the account's name, as the Bot and the card use it. */
  rename(toolkit: string, accountId: string, label: string): Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useComposioSync(): void {
  useEffect(() => subscribeChannel("composio", (status) => useComposio.setState({ status })), []);
}

export const useComposio = create<ComposioState>((set, get) => {
  const run = async (tag: string, fn: () => Promise<void>) => {
    if (get().busy) return;
    set({ busy: tag, error: null });
    try { await fn(); } catch (e) { set({ error: message(e) }); } finally { set({ busy: null }); }
  };
  const doConnect = async (toolkit: string) => {
    const { redirectUrl, status } = await call("connectComposioApp", { toolkit });
    // Bug 401: only an https Composio link ever reaches the browser (the host checks it too).
    if (!isComposioLink(redirectUrl)) throw new Error("Composio didn't return a sign-in link.");
    set({ status, links: { ...get().links, [toolkit]: redirectUrl } });
    await nativeCall("openExternal", { url: redirectUrl });
  };
  return {
    open: false, status: null, error: null, busy: null, disclosureFor: null, links: {},
    openSheet: () => { set({ open: true, error: null }); void get().load(); },
    close: () => set({ open: false, error: null, disclosureFor: null }),
    load: async () => { try { set({ status: await call("getComposioStatus", {}) }); } catch (e) { set({ error: message(e) }); } },
    pasteKey: () => run("key", async () => { set({ status: await nativeCall<ComposioStatusView>("composio.pasteKey") }); }),
    clearKey: () => run("key", async () => { set({ status: await call("clearComposioKey", {}) }); }),
    connect: async (toolkit) => {
      if (!get().status?.disclosureAccepted) { set({ disclosureFor: toolkit, error: null }); return; }
      await run(toolkit, () => doConnect(toolkit));
    },
    acceptAndConnect: async () => {
      const toolkit = get().disclosureFor;
      if (!toolkit) return;
      await run(toolkit, async () => {
        set({ status: await call("acceptComposioDisclosure", {}), disclosureFor: null });
        await doConnect(toolkit);
      });
    },
    cancelDisclosure: () => set({ disclosureFor: null }),
    reopen: (toolkit) => { const url = get().links[toolkit]; if (url) void nativeCall("openExternal", { url }).catch(() => {}); else void get().connect(toolkit); },
    disconnect: (toolkit, accountId) => run(toolkit, async () => { set({ status: await call("disconnectComposioApp", { toolkit, ...(accountId ? { accountId } : {}) }) }); }),
    rename: async (toolkit, accountId, label) => {
      try { set({ status: await call("renameComposioAccount", { toolkit, accountId, label }), error: null }); } catch (e) { set({ error: message(e) }); }
    },
    setGrant: async (toolkit, botId, enabled, accountId) => {
      try { set({ status: await call("setComposioGrant", { toolkit, botId, enabled, ...(accountId ? { accountId } : {}) }), error: null }); } catch (e) { set({ error: message(e) }); }
    },
  };
});
