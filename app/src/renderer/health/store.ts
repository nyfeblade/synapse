import { useEffect } from "react";
import { create } from "zustand";
import type { ConnectorHealthView, HealthFix } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { subscribeChannel } from "../feature-store";
import { authorize } from "../marketplace/store";
import { useComposio } from "../composio/store";
import { useGoogle } from "../google/store";
import { useUi } from "../store";

interface HealthStore {
  connectors: ConnectorHealthView[] | null;
  error: string | null;
  load(): Promise<void>;
}

/** 4.4: every connector's health (host/health). Kept current by useHealthSync while it is on screen. */
export const useHealth = create<HealthStore>((set) => ({
  connectors: null,
  error: null,
  load: async () => {
    try { set({ connectors: (await callQuiet("getConnectorHealth", {})).connectors, error: null }); }
    catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); }
  },
}));

/** The host's "connector-health" events, for as long as the caller is mounted. */
export function useHealthSync(): void {
  useEffect(() => subscribeChannel("connector-health", (p) => useHealth.setState({ connectors: p.connectors, error: null })), []);
}

/**
 * 4.4: Fix runs the connector's existing reconnect flow, the same one its own settings use:
 * Google's sign-in sheet, an MCP server's OAuth (startMcpAuth) or restart, Composio's hosted sign-in,
 * Telegram's settings, the Bot's GitHub sign-in, or Settings → Account for the API key.
 */
export async function runFix(fix: HealthFix): Promise<void> {
  const ui = useUi.getState();
  switch (fix.kind) {
    case "google": useGoogle.getState().openSheet({ reconnect: true }); return;
    case "mcp-auth": await authorize(fix.serverId); return;
    case "mcp-restart": await callQuiet("restartMcpServers", { serverId: fix.serverId }); return;
    case "composio-app": await useComposio.getState().connect(fix.toolkit); return;
    case "telegram": ui.openSettings("telegram"); return;
    case "github": ui.closeSettings(); await ui.openBot(fix.botId); useUi.getState().setPanel("settings"); return;
    case "provider": ui.openSettings("account"); return;
  }
}

/** The tray's Fix: the connector by id (the list may not be loaded yet). */
export async function fixConnector(id: string): Promise<void> {
  let c = useHealth.getState().connectors?.find((x) => x.id === id);
  if (!c) { await useHealth.getState().load(); c = useHealth.getState().connectors?.find((x) => x.id === id); }
  if (c?.fix) await runFix(c.fix);
}
