import { z } from "zod";
import type { BotToolDef, BotToolResult } from "../brain/types";
import type { HostModule, ModuleContext } from "../phase5/types";
import type { Heartbeat } from "./heartbeat";
import { formatLocal, localToEpoch, type FollowupStore } from "./store";

const err = (text: string): BotToolResult => ({ text, isError: true });

function wrapUpdateState(orig: BotToolDef, botId: string, store: FollowupStore, tz: () => string): BotToolDef {
  const targets = (orig.schema.target as unknown as { options: string[] }).options;
  return {
    ...orig,
    description: `${orig.description} Target "followup" (only when proactive follow-ups are on): action "add" {what, due_at: "YYYY-MM-DDTHH:MM" local}, "done" {id}, "drop" {id}.`,
    schema: { ...orig.schema, target: z.enum([...targets, "followup"] as unknown as [string, ...string[]]), id: z.string().optional(), what: z.string().optional(), due_at: z.string().optional() },
    handler: async (a) => {
      if (a.target !== "followup") return orig.handler(a);
      if (a.action === "add") {
        const due = localToEpoch(String(a.due_at ?? ""), tz());
        if (!a.what || Number.isNaN(due)) return err('add needs what and due_at as "YYYY-MM-DDTHH:MM".');
        let f;
        try { f = store.add(botId, { what: String(a.what), dueAt: due }); } catch (e) { return err((e as Error).message); }
        return { text: `Follow-up saved (id ${f.id}, due ${formatLocal(f.dueAt, tz())}).` };
      }
      if (a.action === "done" || a.action === "drop") {
        const ok = store.mark(botId, String(a.id ?? ""), a.action === "done" ? "done" : "dropped");
        return ok ? { text: a.action === "done" ? `Marked ${String(a.id)} done.` : `Dropped ${String(a.id)}.` } : err(`No open follow-up ${String(a.id)}.`);
      }
      return err('action must be "add", "done" or "drop".');
    },
  };
}

export function createFollowupsModule(ctx: ModuleContext, o: { store: FollowupStore; heartbeat: Heartbeat }): HostModule {
  return {
    name: "followups",
    observers: [o.heartbeat],
    start: () => o.heartbeat.start(),
    stop: () => o.heartbeat.stop(),
    botTools: (botId, _slot, base) => {
      const orig = (base ?? []).find((t) => t.name === "update_state");
      return orig ? [wrapUpdateState(orig, botId, o.store, () => ctx.settings.timeZone())] : [];
    },
    handlers: {
      setAgentFollowups: (a) => {
        const cur = ctx.bots.summary(a.id).settings;
        return { agent: ctx.bots.updateSettings(a.id, { advanced: { ...(cur.advanced ?? {}), followups: !!a.enabled } }) };
      },
    },
    wrapHandlers: (base) => ({
      sendPrompt: async (a) => { o.heartbeat.noteUserActive(); return base.sendPrompt!(a); },
      openAgent: async (a) => { o.heartbeat.noteUserActive(); return base.openAgent!(a); },
    }),
  };
}
