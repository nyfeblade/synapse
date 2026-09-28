import type { CodingAgentView } from "@synapse/shared";
import { updateCard } from "../phase5/cards";
import type { HostModule, ModuleContext } from "../phase5/types";
import { fillTemplate, loadPrompt } from "../prompts";
import { createCodingAgentTool } from "../tools/coding-agent-tool";
import type { CodingAgents } from "./coding-agents";

/** Ruling (c): how often a done-wake held by the usage ladder is retried (the ladder can drop with no event). */
export const CODING_WAKE_RETRY_MS = 60_000;

export function codingHooks(ctx: ModuleContext, cardIds: Map<string, { botId: string; entryId: string }>, agents: () => CodingAgents) {
  const deferred = new Map<string, CodingAgentView>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => { if (timer) clearInterval(timer); timer = null; };
  const wake = (a: CodingAgentView) => ctx.enqueueHidden(a.botId, {
    source: "coding-agent", lane: "background", silenceAllowed: true,
    text: fillTemplate(loadPrompt("wakes/coding-agent-done.md"), { title: a.title, id: a.id, status: a.status, branch: a.branch, summary: a.summary ?? "", transcript: agents().dumpPath(a.id) }),
  });
  const flushDeferred = () => {
    for (const [id, a] of deferred) {
      if (!ctx.bots.has(a.botId)) { deferred.delete(id); continue; } // the Bot was deleted meanwhile
      if (!ctx.ladder().allowsBackground("coding")) break;
      deferred.delete(id);
      wake(a);
    }
    if (deferred.size === 0) stopTimer();
  };
  return {
    onChange: (a: CodingAgentView) => {
      const c = cardIds.get(a.id);
      if (c && ctx.bots.has(c.botId)) updateCard(ctx.bots, c.botId, c.entryId, { kind: "coding-agent", agent: a });
    },
    onDone: (a: CodingAgentView) => {
      if (!ctx.bots.has(a.botId)) return;
      // I13 + ruling (c): the wake is background model work. While the ladder holds it, the card still shows the
      // result and the wake is DEFERRED — delivered on the next ladder change or retry tick that allows it.
      if (!ctx.ladder().allowsBackground("coding")) {
        deferred.set(a.id, a);
        if (!timer) { timer = setInterval(flushDeferred, CODING_WAKE_RETRY_MS); timer.unref?.(); }
        return;
      }
      wake(a);
    },
    flushDeferred,
    dispose: () => { stopTimer(); deferred.clear(); },
  };
}

export function createCodingModule(ctx: ModuleContext, agents: CodingAgents, cardIds: Map<string, { botId: string; entryId: string }>, hooks: ReturnType<typeof codingHooks> = codingHooks(ctx, cardIds, () => agents)): HostModule {
  return {
    name: "coding",
    botTools: (botId, slot) => [createCodingAgentTool({ botId, slot, agents, bots: ctx.bots, now: ctx.now, cardIds })],
    start: () => { for (const a of agents.markInterruptedAtBoot()) hooks.onDone(a); },
    stop: () => hooks.dispose(),
    handlers: { listCodingAgents: (a) => ({ agents: agents.list(a.id) }) },
  };
}
