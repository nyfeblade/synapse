import type { Presence } from "@synapse/shared";
import type { TranscriptItem } from "./transcript-items";

/** The presences that mean "composing a reply". sending/loading/orbit are other jobs with their own signals. */
const COMPOSING: ReadonlySet<Presence> = new Set(["thinking", "working", "searching"]);

/**
 * What the Bot-side typing bubble shows, if anything (decisions.md, "the typing indicator and the
 * tool-step rows"):
 *
 * - An open stream always wins: dots until its first chunk, then the streamed text. That is the same
 *   element either way, which is what lets the dots grow into the message instead of cutting to it.
 * - Otherwise dots while the Bot is thinking / working / searching and has sent no text since the
 *   user's latest message ("this turn").
 * - …unless a tool-step row in this turn is running. That row already shimmers "Running npm test";
 *   a second live signal under it would say the same thing twice. The dots come back when the step
 *   finishes and the Bot is still composing.
 */
export function typingIndicator(
  presence: Presence | undefined,
  typing: { typing: boolean; partialText: string | null } | undefined,
  items: readonly TranscriptItem[],
): "dots" | "text" | null {
  if (typing?.typing) return typing.partialText ? "text" : "dots";
  if (!presence || !COMPOSING.has(presence)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "user") break;
    if (it.kind === "bot") return null;
    if (it.kind === "activity" && it.running) return null;
  }
  return "dots";
}
