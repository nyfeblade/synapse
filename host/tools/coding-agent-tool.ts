import { z } from "zod";
import type { BotService } from "../bots/bot-service";
import type { BotToolDef, BotToolResult } from "../brain/types";
import type { CodingAgents } from "../coding/coding-agents";
import { postCard } from "../phase5/cards";
import type { TurnSlot } from "../runner/turn-slot";

const err = (text: string): BotToolResult => ({ text, isError: true });

export function createCodingAgentTool(d: { botId: string; slot(): TurnSlot | null; agents: CodingAgents; bots: BotService; now(): number; cardIds: Map<string, { botId: string; entryId: string }> }): BotToolDef {
  return {
    name: "CodingAgent", readOnly: false,
    description: "Run a background coding agent on a git repository (its own worktree and branch). Actions: launch {repo, task, title?}, list, get {agent_id}, dump {agent_id}, reply {agent_id, message, interrupt?}, cancel {agent_id, confirm:true}, delete {agent_id, confirm:true}. You are woken when it finishes.",
    schema: { action: z.enum(["launch", "list", "get", "dump", "reply", "cancel", "delete"]), repo: z.string().optional(), task: z.string().optional(), title: z.string().optional(), agent_id: z.string().optional(), message: z.string().optional(), interrupt: z.boolean().optional(), confirm: z.boolean().optional() },
    handler: async (a) => {
      try {
        const id = String(a.agent_id ?? "");
        const own = (x: { botId: string } | null) => !!x && x.botId === d.botId;
        switch (a.action) {
          case "launch": {
            if (!a.repo || !a.task) return err("launch needs repo and task.");
            const agent = await d.agents.launch(d.botId, { repo: String(a.repo), task: String(a.task), title: a.title as string | undefined });
            const slot = d.slot();
            if (slot) d.cardIds.set(agent.id, { botId: d.botId, entryId: postCard({ bots: d.bots, now: d.now }, d.botId, slot, { kind: "coding-agent", agent }) });
            return { text: `Launched coding agent ${agent.id} on ${agent.repo}, branch ${agent.branch}. You'll be woken when it finishes.` };
          }
          case "list": return { text: d.agents.list(d.botId).map((x) => `- ${x.id} "${x.title}" ${x.status} (${x.repo}, ${x.branch})`).join("\n") || "No coding agents." };
          case "get": { const x = d.agents.get(id); return own(x) ? { text: JSON.stringify(x, null, 2) } : err(`No coding agent ${id}.`); }
          case "dump": return own(d.agents.get(id)) ? { text: `Transcript: ${d.agents.dumpPath(id)}` } : err(`No coding agent ${id}.`);
          case "reply": {
            if (!own(d.agents.get(id)) || !a.message) return err("reply needs agent_id and message.");
            await d.agents.reply(id, String(a.message), a.interrupt !== false);
            return { text: a.interrupt === false ? "Queued your message for the coding agent." : "Interrupted the coding agent with your message." };
          }
          case "cancel":
          case "delete": {
            if (a.confirm !== true) return err(`${a.action} needs confirm:true.`);
            if (!own(d.agents.get(id))) return err(`No coding agent ${id}.`);
            if (a.action === "cancel") d.agents.cancel(id); else d.agents.remove(id);
            return { text: a.action === "cancel" ? `Cancelled ${id}.` : `Deleted ${id}.` };
          }
        }
        return err("Unknown action.");
      } catch (e) {
        return err((e as Error).message);
      }
    },
  };
}
