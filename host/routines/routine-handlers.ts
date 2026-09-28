import type { CommandHandlers } from "../gateway/server";
import { appendRoutineEvent } from "./routine-events";
import type { RoutineService } from "./routine-service";

type Names = "getAgentAutomations" | "listAllAutomations" | "setAgentAutomationEnabled" | "createAgentAutomation" | "updateAgentAutomation" | "deleteAgentAutomation" | "runAgentAutomationNow" | "getAutomationWebhook" | "rotateAutomationWebhookKey";

/** §4.5 routine commands. UI edits post the same CHAT-03 rows a Bot's edits do (ORIG-17 §17.2). */
export function routineHandlers(r: RoutineService): Pick<CommandHandlers, Names> {
  const bots = r.d.bots;
  return {
    getAgentAutomations: (a) => ({ routines: r.list(a.id) }),
    listAllAutomations: () => ({ routines: r.listAll() }),
    setAgentAutomationEnabled: (a) => {
      const v = r.setEnabled(a.id, a.routineId, a.enabled);
      appendRoutineEvent(bots, a.id, null, { type: a.enabled ? "routine-enabled" : "routine-disabled", routineId: v.id, name: v.name });
      return { routine: v };
    },
    createAgentAutomation: async (a) => {
      const res = await r.create(a.id, { name: a.name, prompt: a.prompt, schedule: a.schedule, trigger: a.trigger, enabled: a.enabled, quietHours: a.quietHours, catchUp: a.catchUp, dailyCap: a.dailyCap });
      appendRoutineEvent(bots, a.id, null, { type: "routine-created", routineId: res.view.id, name: res.view.name, nextRunAt: res.view.nextRunAt });
      return { routine: res.view, key: res.key };
    },
    updateAgentAutomation: async (a) => {
      const res = await r.update(a.id, a.routineId, { name: a.name, prompt: a.prompt, schedule: a.schedule, trigger: a.trigger, quietHours: a.quietHours, catchUp: a.catchUp, dailyCap: a.dailyCap });
      appendRoutineEvent(bots, a.id, null, { type: "routine-updated", routineId: res.view.id, name: res.view.name, nextRunAt: res.view.nextRunAt });
      return { routine: res.view };
    },
    deleteAgentAutomation: (a) => {
      const v = r.view(a.id, a.routineId);
      r.remove(a.id, a.routineId);
      appendRoutineEvent(bots, a.id, null, { type: "routine-deleted", routineId: v.id, name: v.name });
      return {};
    },
    runAgentAutomationNow: (a) => ({ runId: r.runNow(a.id, a.routineId) }),
    getAutomationWebhook: (a) => r.webhook(a.id, a.routineId),
    rotateAutomationWebhookKey: (a) => r.rotateKey(a.id, a.routineId),
  };
}
