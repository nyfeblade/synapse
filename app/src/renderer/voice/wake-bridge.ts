import { useEffect } from "react";
import type { BotSummary } from "@synapse/shared";
import { nativeCall, onNative } from "../native";
import { useUi } from "../store";
import { useVoice } from "./VoiceOverlay";

type Bots = Record<string, BotSummary>;
const callable = (b: BotSummary) => !b.archived && !b.group;

/** Every live Bot's name ("Hey <name>"); group chats and archived Bots are not listened for. */
export function wakeNames(bots: Bots): string[] {
  return Object.values(bots).filter(callable).map((b) => b.profile.name);
}

/** The Bot a heard name belongs to (case-insensitive), or null. */
export function botForWakeName(bots: Bots, name: string): string | null {
  const n = name.trim().toLowerCase();
  return Object.values(bots).find((b) => callable(b) && b.profile.name.trim().toLowerCase() === n)?.id ?? null;
}

/**
 * Phase 2 (bug 213): a detection → the call to start: the first name's Bot, and the others heard
 * ("Hey Nova and Scout") to bring in as soon as it connects. Null when the first name is no Bot.
 */
export function wakeCall(bots: Bots, e: { name: string; also?: string[] }): { id: string; adding: string[] } | null {
  const id = botForWakeName(bots, e.name);
  if (!id) return null;
  const adding: string[] = [];
  for (const n of e.also ?? []) { const x = botForWakeName(bots, n); if (x && x !== id && !adding.includes(x)) adding.push(x); }
  return { id, adding };
}

/** Hands main the Bot names, and turns a detection into a call with that Bot (and any others named). Mounted once, in App. */
export function useWakeBridge(): void {
  const key = useUi((s) => wakeNames(s.bots).join("\n"));
  useEffect(() => { void nativeCall("wake.names", { names: key ? key.split("\n") : [] }).catch(() => {}); }, [key]);
  useEffect(() => {
    const offWake = onNative<{ type: string; name?: string; also?: string[] }>("wake", (e) => {
      if (e.type !== "wake" || !e.name) return;
      const c = wakeCall(useUi.getState().bots, { name: e.name, also: Array.isArray(e.also) ? e.also : [] });
      if (!c) return;
      // A call that is already open is left alone: the wake word never hangs one up.
      if (useVoice.getState().openFor) return;
      void useUi.getState().openBot(c.id).then(() => useVoice.getState().open(c.id, c.adding));
    });
    const offSettings = onNative<{ section?: string }>("open-settings", (p) => useUi.getState().openSettings(p?.section ?? "voice"));
    return () => { offWake(); offSettings(); };
  }, []);
}
