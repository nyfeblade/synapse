import { AVATAR_ANIM_HELP, parseAvatarClip, upsertClip } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { BotToolResult } from "../brain/types";

const err = (text: string): BotToolResult => ({ text, isError: true });
const ACTIONS = "help, set, list, delete, reset, play";

/**
 * update_state target "avatar": the Bot's own avatar animations (docs/differentiators.md,
 * "Bot-authored avatar animations"). The DSL reference is the `help` action's result, not the tool
 * description, so it costs nothing on the calls that don't need it (the bot tool schemas are held
 * under 15,000 chars by host/test/perf/prompt-budget.test.ts).
 */
export function avatarAnimTarget(bots: BotService, botId: string, a: Record<string, unknown>): BotToolResult {
  const clips = bots.summary(botId).profile.avatarAnimations ?? [];
  const name = typeof a.name === "string" ? a.name.trim() : "";
  switch (a.action) {
    case "help": return { text: AVATAR_ANIM_HELP };
    case "set": {
      const r = parseAvatarClip(typeof a.body === "string" ? a.body : "");
      if (!r.ok) return err(`Not saved. Fix: ${r.errors.join("; ")}. (action "help" has the format)`);
      const u = upsertClip(clips, r.clip);
      if (u.error) return err(`Not saved. ${u.error}`);
      bots.setAvatarAnimations(botId, u.clips);
      return { text: `Saved "${r.clip.name}" (${r.clip.on === "manual" ? "plays when you use play" : `plays on ${r.clip.on}`}).` };
    }
    case "list":
      return { text: clips.length ? clips.map((c) => `${c.name}: ${c.on}, ${c.duration_ms} ms, ${c.keys.length} keys`).join("\n") : "You have no animations yet." };
    case "delete": {
      if (!clips.some((c) => c.name === name)) return err(`No animation named "${name}".`);
      bots.setAvatarAnimations(botId, clips.filter((c) => c.name !== name));
      return { text: `Deleted "${name}".` };
    }
    case "reset":
      bots.setAvatarAnimations(botId, []);
      return { text: "Deleted all your animations; your avatar is back to its defaults." };
    case "play": {
      if (!clips.some((c) => c.name === name)) return err(`No animation named "${name}".`);
      bots.setAvatarAnimations(botId, clips, { name });
      return { text: `Playing "${name}".` };
    }
    default:
      return err(`Unknown action "${String(a.action)}" for target "avatar". Use one of: ${ACTIONS}.`);
  }
}
