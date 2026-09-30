import { GatewayError } from "../gateway/errors";
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
      // Bot sharing: the Share sheet's link (and the menu's one-click Copy link).
      sharePayload: (a) => {
        const strs = (x: unknown) => Array.isArray(x) && x.length <= 200 && x.every((v) => typeof v === "string");
        if (a.selection !== undefined && !(strs(a.selection?.skills) && strs(a.selection?.tools))) throw new GatewayError("BAD_ARGS", "Bad selection.");
        return packager.sharePayload(a.id, a.selection, a.remember === true);
      },
      ...extra,
    },
  };
}
