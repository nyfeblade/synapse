import { z } from "zod";
import type { BotToolDef } from "../brain/types";

/**
 * Smarter approvals (plan): the host's approval gate raises the plan card and keeps the grant
 * (host/approvals/approval-gate.ts, host/approvals/smarter.ts); this handler only runs once the user approved it.
 * Mounted only for a Bot with a connector (host/phase5/wire.ts): without one there is nothing a plan could cover.
 */
export function createPlanTool(): BotToolDef {
  return {
    name: "ProposePlan",
    description: "Get one approval for several connector actions the user asked for. Each step: the exact tool (mcp__server__tool), its recipients (addresses, #channels) and/or targets (ids, pages). Approved steps then run without a card until the task ends; payments and deletions still ask.",
    readOnly: false,
    schema: {
      title: z.string(),
      steps: z.array(z.object({ tool: z.string(), summary: z.string(), recipients: z.array(z.string()).optional(), targets: z.array(z.string()).optional() })),
    },
    handler: async () => ({ text: "Approved. Run the steps; matching calls need no card. Anything else still asks." }),
  };
}
