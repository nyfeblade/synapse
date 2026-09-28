import { useEffect, useRef, useState } from "react";
import type { Presence } from "@synapse/shared";

/** motion-spec §4.4: ack uses --motion-sheet (340ms); settle uses --motion-spring (300ms). The
 *  longer of the two is the class lifetime so neither one-shot is cut off. */
export const PRESENCE_BEAT_MS = 340;

export function presenceBeat(from: Presence | undefined, to: Presence): "ack" | "settle" | null {
  if (!from || from === to) return null;
  if (from === "idle" && to !== "idle") return "ack";
  if (from !== "idle" && to === "idle") return "settle";
  return null;
}

/** `presence-<state>` plus a one-shot `presence-ack` / `presence-settle` while the beat plays. */
export function usePresenceClass(id: string, presence: Presence): string {
  const [beat, setBeat] = useState<"ack" | "settle" | null>(null);
  const prev = useRef<{ id: string; presence: Presence } | undefined>(undefined);
  useEffect(() => {
    const last = prev.current;
    prev.current = { id, presence };
    const next = last?.id === id ? presenceBeat(last.presence, presence) : null;
    if (!next) return;
    setBeat(next);
    const t = window.setTimeout(() => setBeat(null), PRESENCE_BEAT_MS);
    return () => window.clearTimeout(t);
  }, [id, presence]);
  return [`presence-${presence}`, beat ? `presence-${beat}` : ""].filter(Boolean).join(" ");
}
