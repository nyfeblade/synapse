import { STRS } from "@synapse/shared";
import type { ForceAskRule } from "../review/force-ask";

/**
 * A Bot's first schedule or trigger always shows the user a card (it will start turns on its own from then on).
 * Once the user has confirmed one (RoutineStore.markConfirmed on the first save), later saves go through the
 * normal automation_write review. Approvals still apply to everything a triggered turn then does.
 */
export function firstScheduleRule(confirmed: (botId: string) => boolean): ForceAskRule {
  return (req) => {
    if (req.surface !== "automation_write") return null;
    if (String(req.target.arguments?.action ?? "") !== "create") return null;
    return confirmed(req.botId) ? null : STRS.firstScheduleConfirm;
  };
}
