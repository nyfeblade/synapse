import type { HostModule, ModuleContext } from "../phase5/types";
import { createTemplateTool } from "../tools/template-tool";
import type { TemplatePackager } from "./packager";

export function createTemplatesModule(ctx: ModuleContext, packager: TemplatePackager, extra: Partial<HostModule["handlers"]> = {}): HostModule {
  return {
    name: "templates",
    botTools: (botId) => [createTemplateTool({ botId, packager, workspace: ctx.cfg.workspace })],
    handlers: {
      draftTemplate: async (a) => ({ draft: await packager.draft(a.id) }),
      exportTemplate: (a) => { const r = packager.export(a.id, a.manifest); ctx.bots.publish(a.id); return { template: r.template, fileName: r.fileName, bytesBase64: Buffer.from(r.bytes).toString("base64") }; },
      getTemplate: (a) => ({ template: packager.get(a.id) }),
      deleteTemplate: (a) => { packager.delete(a.templateId); return {}; },
      ...extra,
    },
  };
}
