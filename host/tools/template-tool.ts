import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BotToolDef } from "../brain/types";
import type { TemplatePackager } from "../templates/packager";

export function createTemplateTool(d: { botId: string; packager: TemplatePackager; workspace: string }): BotToolDef {
  return {
    name: "Template", readOnly: false,
    description: "Package a Bot as a shareable template (export or update writes /workspace/templates/<name>.botpack), or delete its template record.",
    schema: { action: z.enum(["export", "update", "delete"]), agent_id: z.string() },
    handler: async (a) => {
      const id = String(a.agent_id);
      if (a.action === "delete") {
        const t = d.packager.get(id);
        if (!t) return { text: "That Bot has no template.", isError: true };
        d.packager.delete(t.id);
        return { text: `Deleted the template "${t.name}".` };
      }
      const r = d.packager.export(id, await d.packager.draft(id));
      const out = path.join(d.workspace, "templates", r.fileName);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, r.bytes);
      return { text: `Saved the template to ${out}. The user can share that file; importing it creates a new copy of the Bot.` };
    },
  };
}
