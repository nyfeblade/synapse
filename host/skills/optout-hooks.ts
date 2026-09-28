import type { TurnHooks } from "../runner/hooks";
import type { SkillLibrary } from "./library";

/** SKL-01: a skill turned off for a Bot can't be loaded through Claude Code's Skill tool. */
export function createSkillOptOutHooks(d: { library: SkillLibrary }): TurnHooks {
  return {
    preToolUse: (botId, call) => {
      if (call.toolName !== "Skill") return null;
      const named = String(call.input.skill ?? call.input.command ?? call.input.name ?? "").replace(/^\//, "");
      const id = d.library.findByName(named);
      if (!id || !d.library.disabledFor(botId).includes(id)) return null;
      return { decision: "deny", reason: `The user turned off the skill "${d.library.read(id)!.file.name}" for you.` };
    },
  };
}
