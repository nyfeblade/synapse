import { envSetting } from "@synapse/shared";
import { log } from "./log";

/**
 * TTFT war room: opt-in per-hop timing for a turn (SYNAPSE_TTFT_TRACE=1). Each Bot has at most one open trace,
 * started when its user message is accepted; every later mark logs the ms since that start, once per hop.
 * Off by default: one env read and a Map lookup per mark.
 */
const on = envSetting(process.env, "TTFT_TRACE") === "1";
const open = new Map<string, { t0: number; seen: Set<string> }>();

export const ttft = {
  enabled: on,
  start(botId: string): void {
    if (!on) return;
    open.set(botId, { t0: performance.now(), seen: new Set() });
    log.info("ttft", { botId, hop: "accepted", ms: 0 });
  },
  mark(botId: string | null | undefined, hop: string, extra?: Record<string, unknown>): void {
    if (!on || !botId) return;
    const t = open.get(botId);
    if (!t || t.seen.has(hop)) return;
    t.seen.add(hop);
    log.info("ttft", { botId, hop, ms: Math.round(performance.now() - t.t0), ...extra });
  },
  end(botId: string): void {
    if (on) open.delete(botId);
  },
};
