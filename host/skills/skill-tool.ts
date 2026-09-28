import { activityEntryId } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { GatewayError } from "../gateway/errors";
import { toolError, type BotToolExtensions } from "../tools/registry";
import type { SkillLibrary } from "./library";

export function createSkillToolExtension(d: { library: SkillLibrary; bots: BotService; now(): number }): BotToolExtensions {
  return {
    updateState: {
      workflow: ({ botId, slot, args }) => {
        if (args.action === "write") {
          const name = String(args.name ?? "").trim();
          try {
            const { id, created } = d.library.write({ name, description: String(args.description ?? ""), body: String(args.body ?? "") });
            const turn = slot?.turnNo ?? "b";
            const k = slot ? ++slot.nextActK : Date.now() % 100_000;
            d.bots.appendEntry(botId, { kind: "event", id: activityEntryId(turn, k), createdAt: d.now(), event: { type: "skill-saved", skillId: id, name } });
            if (slot) slot.segment += 1;
            return { text: `${created ? "Saved" : "Updated"} the skill "${name}" (${id}). Every Bot can use it; the user can edit it under Skills.` };
          } catch (e) {
            return toolError(`Not saved — ${e instanceof GatewayError ? e.message : String(e)}`);
          }
        }
        if (args.action === "delete") {
          const id = d.library.findByName(String(args.workflow_id ?? args.name ?? ""));
          if (!id) return toolError("Not deleted — no skill with that id or name.");
          d.library.remove(id);
          return { text: `Deleted the skill "${id}".` };
        }
        return toolError(`Not saved — unknown workflow action "${String(args.action)}". Use write or delete.`);
      },
    },
  };
}
