import type { RoutineView, Trigger } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { BotToolResult } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import { appendRoutineEvent } from "../routines/routine-events";
import { formatWhen } from "../routines/routine-turn";
import type { RoutineService } from "../routines/routine-service";
import type { StateTargetHandler } from "../runner/turn-runner";
import { formatSavedResult } from "../schedule/normalize";

const err = (text: string): BotToolResult => ({ text, isError: true });
const ACTIONS = "create, update, pause, resume, delete, run or list";

function triggerArg(v: unknown): Trigger | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") return JSON.parse(v) as Trigger;
  return v as Trigger;
}
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
/** quiet_hours: "" clears; daily_cap: a number of runs per 24 h. */
function extrasArg(a: Record<string, unknown>): { quietHours?: string | null; catchUp?: boolean; dailyCap?: number | null } {
  return {
    ...(a.quiet_hours !== undefined ? { quietHours: a.quiet_hours === null || a.quiet_hours === "" ? null : String(a.quiet_hours) } : {}),
    ...(a.catch_up !== undefined ? { catchUp: Boolean(a.catch_up) } : {}),
    ...(a.daily_cap !== undefined ? { dailyCap: a.daily_cap === null ? null : Number(a.daily_cap) } : {}),
  };
}

/** TOOL-15 `update_state target:"routine"` (RTN-02, RTN-22; ORIG-17 adds action "run"). Review happens earlier, in PreToolUse (APR-03). */
export function routineStateTarget(d: { routines: RoutineService; bots: BotService; now(): number }): StateTargetHandler {
  const tz = () => d.routines.d.settings.timeZone();
  const saved = (v: RoutineView, key: string | null, normalizedText: string | null): string => {
    const lines = [normalizedText ?? `Saved routine "${v.name}" (${v.enabled ? "active" : "paused"}).\nTrigger: ${v.description}`];
    if (v.quietHours) lines.push(`Quiet hours: ${v.quietHours} (no runs start then)`);
    if (v.dailyCap) lines.push(`Daily cap: ${v.dailyCap} runs per 24 hours`);
    // I5: the raw key never enters tool output (the scanner would redact it anyway); the user copies it from the app.
    if (key && v.webhook) lines.push(`POST to: ${v.webhook.url}\nKey: bot_…${v.webhook.keyPreview} (masked — the user copies the full key from the routine's page in the app)\nHeader: Authorization: Bearer <key>`);
    return lines.join("\n");
  };
  const own = (botId: string, id: string | undefined): RoutineView | string => {
    if (!id) return "id is required.";
    try {
      return d.routines.view(botId, id);
    } catch (e) {
      if (e instanceof GatewayError && e.code === "NOT_FOUND") return `No routine "${id}". You can only manage your own routines; ask the Bot that owns it to change it.`;
      throw e;
    }
  };

  return async (botId, slot, args) => {
    const action = String(args.action ?? "");
    try {
      switch (action) {
        case "create": {
          const res = await d.routines.create(botId, {
            name: String(args.name ?? ""), prompt: String(args.prompt ?? ""), schedule: str(args.schedule), trigger: triggerArg(args.trigger),
            enabled: args.enabled === undefined ? undefined : Boolean(args.enabled), ...extrasArg(args),
          });
          appendRoutineEvent(d.bots, botId, slot, { type: "routine-created", routineId: res.view.id, name: res.view.name, nextRunAt: res.view.nextRunAt });
          const text = res.normalized && res.view.schedule !== null && !res.view.trigger ? formatSavedResult(res.view.name, res.view.enabled, res.normalized) : null;
          return { text: saved(res.view, res.key, text) };
        }
        case "update": {
          const v = own(botId, str(args.id));
          if (typeof v === "string") return err(v);
          const res = await d.routines.update(botId, v.id, {
            name: str(args.name), prompt: str(args.prompt), schedule: str(args.schedule), trigger: triggerArg(args.trigger),
            enabled: args.enabled === undefined ? undefined : Boolean(args.enabled), ...extrasArg(args),
          });
          appendRoutineEvent(d.bots, botId, slot, { type: "routine-updated", routineId: res.view.id, name: res.view.name, nextRunAt: res.view.nextRunAt });
          const text = res.normalized && !res.view.trigger ? formatSavedResult(res.view.name, res.view.enabled, res.normalized) : `Updated routine "${res.view.name}".`;
          return { text: saved(res.view, res.key, text) };
        }
        case "pause":
        case "resume": {
          const v = own(botId, str(args.id));
          if (typeof v === "string") return err(v);
          const on = action === "resume";
          const nv = d.routines.setEnabled(botId, v.id, on);
          appendRoutineEvent(d.bots, botId, slot, { type: on ? "routine-enabled" : "routine-disabled", routineId: nv.id, name: nv.name });
          if (!on) return { text: `Paused routine "${nv.name}".` };
          return { text: `Resumed routine "${nv.name}".${nv.nextRunAt !== null ? ` Next run: ${formatWhen(nv.nextRunAt, tz())}.` : ""}` };
        }
        case "delete": {
          const v = own(botId, str(args.id));
          if (typeof v === "string") return err(v);
          d.routines.remove(botId, v.id);
          appendRoutineEvent(d.bots, botId, slot, { type: "routine-deleted", routineId: v.id, name: v.name });
          return { text: `Deleted routine "${v.name}".` };
        }
        case "run": {
          const v = own(botId, str(args.id));
          if (typeof v === "string") return err(v);
          const runId = d.routines.botRun(botId, v.id, { chainId: slot?.context.chainId ?? null }); // C1: reviewed, guarded, capped
          return { text: `Started a run of "${v.name}" (run ${runId}). It does real work; its result arrives in this conversation.` };
        }
        case "list": {
          const all = d.routines.list(botId);
          if (!all.length) return { text: "No current routines." };
          return { text: all.map((v) => `- "${v.name}" (id ${v.id}): ${v.description} — ${v.enabled ? "active" : "paused"}${v.enabled && v.nextRunAt !== null ? `, next ${formatWhen(v.nextRunAt, tz())}` : ""}${v.quietHours ? `, quiet ${v.quietHours}` : ""}`).join("\n") };
        }
        default:
          return err(`Unknown routine action "${action}". Use ${ACTIONS}.`);
      }
    } catch (e) {
      if (e instanceof GatewayError || e instanceof SyntaxError) return err(e.message);
      throw e;
    }
  };
}
