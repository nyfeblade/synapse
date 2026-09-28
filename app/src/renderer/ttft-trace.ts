import type { SseEvent } from "@synapse/shared";

/**
 * TTFT war room: opt-in renderer timing (localStorage "ttftTrace" = "1", then reload). For each Bot, from the
 * moment the renderer receives the user's own message back from the host (append, role user) it logs the ms to:
 * the first typing event, the first partial text, and the first frame painted after that partial (double rAF).
 * Off by default: one guarded localStorage read at start-up.
 */
export function installTtftTrace(onEvent: (cb: (e: SseEvent) => void) => () => void): void {
  let on = false;
  try { on = localStorage.getItem("ttftTrace") === "1"; } catch { /* storage unavailable */ }
  if (!on) return;
  const turns = new Map<string, { t0: number; seen: Set<string> }>();
  const mark = (botId: string, hop: string) => {
    const t = turns.get(botId);
    if (!t || t.seen.has(hop)) return;
    t.seen.add(hop);
    console.info(`[ttft] ${botId.slice(0, 8)} ${hop} +${Math.round(performance.now() - t.t0)} ms`);
  };
  onEvent((e) => {
    if (e.channel !== "transcript") return;
    const p = e.payload as { botId: string; op: string; entry?: { kind?: string; role?: string }; typing?: boolean; partialText?: string | null };
    if (p.op === "append" && p.entry?.kind === "message" && p.entry.role === "user") turns.set(p.botId, { t0: performance.now(), seen: new Set() });
    else if (p.op === "typing" && p.typing) {
      mark(p.botId, "typing event received");
      if (p.partialText) {
        mark(p.botId, "first partial received");
        requestAnimationFrame(() => requestAnimationFrame(() => mark(p.botId, "first partial painted")));
      }
    } else if (p.op === "append" && p.entry?.kind === "send-message") mark(p.botId, "reply appended");
  });
}
