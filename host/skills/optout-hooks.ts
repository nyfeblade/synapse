import type { TurnHooks } from "../runner/hooks";
import type { SkillLibrary } from "./library";

/** SKL-01: a skill turned off for a Bot can't be loaded through Claude Code's Skill tool. */
export function createSkillOptOutHooks(d: { library: SkillLibrary }): TurnHooks {
  return {
    preToolUse: (botId, call) => {
      if (call.toolName !== "Skill") return null;
      const named = String(call.input.skill ?? call.input.command ?? call.input.name ?? "").replace(/^\//, "").trim();
      // A plugin's own skill ("plugin:skill") lives in the managed plugin tree, not the shared skills folder.
      if (named.includes(":")) return null;
      // Re-review: every skill with that id or name counts (not the first match), and a name that is no skill here
      // is refused rather than let through to whatever the CLI would find under it.
      const ids = d.library.findAllByName(named);
      if (!ids.length) return { decision: "deny", reason: `There is no skill called "${named}".` };
      const off = new Set(d.library.disabledFor(botId));
      const hit = ids.find((id) => off.has(id));
      if (!hit) return null;
      return { decision: "deny", reason: `The user turned off the skill "${d.library.read(hit)!.file.name}" for you.` };
    },
  };
}
