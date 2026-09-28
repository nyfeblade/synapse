import { z } from "zod";
import type { BotToolDef } from "../brain/types";
import type { SubagentService } from "./subagents";

export function createSubagentTools(o: { botId: string; subagents: SubagentService }): BotToolDef[] {
  return [
    {
      name: "Task",
      description: "Start a subagent in the background: generalPurpose (research, files, code), computerUse (the desktop, any app) or browserUse (web pages; preferred for websites). It runs in the background and you're revived with its report; don't wait on it.",
      readOnly: false,
      // I3: rehearsal:true (Teach a task) — the child's reviewed actions are denied at tier ≥ 2 or on any floor, never asked.
      schema: { description: z.string(), prompt: z.string(), subagent_type: z.enum(["generalPurpose", "computerUse", "browserUse"]).optional(), model: z.string().optional(), run_in_background: z.boolean().optional(), rehearsal: z.boolean().optional() },
      handler: (a) => o.subagents.launch(o.botId, a as { description: string; prompt: string; subagent_type?: string; rehearsal?: boolean }),
    },
    { name: "CheckSubagent", description: "Status of a subagent: elapsed time, tool calls, last actions, transcript path.", readOnly: true, schema: { subagent_id: z.string() }, handler: async (a) => o.subagents.check(o.botId, String(a.subagent_id)) },
    { name: "MessageSubagent", description: "Steer a running subagent with extra instructions; it continues without starting over.", readOnly: false, schema: { subagent_id: z.string(), message: z.string() }, handler: (a) => o.subagents.message(o.botId, String(a.subagent_id), String(a.message)) },
    { name: "StopSubagent", description: "Stop a subagent. It won't report back.", readOnly: false, schema: { subagent_id: z.string() }, handler: (a) => o.subagents.stop(o.botId, String(a.subagent_id)) },
  ];
}
