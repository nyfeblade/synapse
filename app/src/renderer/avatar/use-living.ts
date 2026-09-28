import { useEffect, useState, useSyncExternalStore } from "react";
import type { BotSummary } from "@synapse/shared";
import { useUi } from "../store";
import { leadBot, livingAct, restAt, type LivingAct } from "./living-pose";
import { subscribeTransient, transientFor } from "./living-events";

/**
 * Living Bots (bug 226): a Bot's work pose and whether it leads, for its avatar. Re-renders when the
 * presence stream, a transient moment (stuck, remembering) or the lead changes, and once when a quiet
 * Bot crosses into rest — no polling.
 */
export function useLiving(bot: BotSummary): { act: LivingAct; lead: boolean } {
  const t = useSyncExternalStore(subscribeTransient, () => transientFor(bot.id), () => transientFor(bot.id));
  const lead = useUi((s) => leadBot(s.bots, s.activeBotId));
  const open = useUi((s) => s.activeBotId === bot.id);
  const [, setTick] = useState(0);
  const raw = livingAct(bot, Date.now(), t);
  // The chat the user has open is never asleep: they are looking at it.
  const act = raw === "rest" && open ? "idle" : raw;
  const restsAt = restAt(bot);
  useEffect(() => {
    if (raw !== "idle") return; // only a Bot still awake needs the one timer to its rest
    const ms = restsAt - Date.now();
    if (ms > 2 ** 31 - 1) return;
    const id = setTimeout(() => setTick((n) => n + 1), Math.max(0, ms) + 50);
    return () => clearTimeout(id);
  }, [raw, restsAt]);
  return { act, lead: lead === null || lead === bot.id };
}
