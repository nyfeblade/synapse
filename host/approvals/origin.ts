import type { WakeSource } from "../brain/types";
import type { OriginKind } from "../review/types";

/** ORIG-01 §01.6 `origin`: what woke the Bot. */
export function originOf(source: WakeSource): OriginKind {
  switch (source) {
    // Bug 142: a voice-delegate task is the user's own spoken request, handed over by the Bot's voice on the call.
    case "user": case "kickstart": case "reply-nudge": case "closing-nudge": case "ack-redrive": case "widget-answer": case "form-answer": case "broadcast": case "voice-delegate":
      return "user";
    case "routine":
      return "routine";
    case "agent": case "agent-error":
      return "peer";
    case "group-member":
      return "group";
    case "teach":
      return "teach"; // I2
    // 0.1.4: an MCP client's request is outside text (like another Bot's message), never the owner's words.
    case "mcp":
      return "external";
    default:
      return "revival"; // approval-resume, restart-resume, listener-connected, spend-guard, teach, Phase 2/3 background wakes
  }
}
