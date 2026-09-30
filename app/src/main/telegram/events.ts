import type { SseEvent } from "@synapse/shared";

/**
 * Wave 4.1: the only events the coordinator forwards to main's Telegram bridge (and only while it is on): transcript
 * appends and updates of send-message entries — the Bots' replies and their approval cards.
 */
export function forTelegram(ev: SseEvent): boolean {
  return ev.channel === "transcript" && ev.payload.op !== "typing" && ev.payload.entry.kind === "send-message";
}
