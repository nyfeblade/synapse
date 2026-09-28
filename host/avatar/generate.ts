import { meteredQuery, type QueryFn } from "../usage/metered-query";
import { HELPER_MODEL } from "@synapse/shared";
import { fillTemplate, loadPrompt } from "../prompts";

export interface AvatarGenerator { generate(botId: string, prompt: string, color: string): Promise<string> }

/** FUZZ / tests: a deterministic blob in the requested color with the standard eyes. */
export class StubAvatarGenerator implements AvatarGenerator {
  async generate(_b: string, _p: string, color: string): Promise<string> {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="52" r="42" fill="${color}"/><rect x="58" y="30" width="5" height="15" rx="2.5" fill="#ffffff"/><rect x="70" y="30" width="5" height="15" rx="2.5" fill="#ffffff"/></svg>`;
  }
}

/** D11-A: Claude can't draw raster images; a one-shot HELPER_MODEL call returns an SVG instead. */
export class SdkAvatarGenerator implements AvatarGenerator {
  constructor(private o: { env: Record<string, string>; cwd: string; pathToClaudeCodeExecutable?: string; queryFn?: QueryFn }) {}
  async generate(botId: string, prompt: string, color: string): Promise<string> {
    const q = meteredQuery({ purpose: "avatar", botId }, {
      prompt: fillTemplate(loadPrompt("orig/avatar-svg.md"), { prompt: prompt.slice(0, 300), color }),
      options: {
        cwd: this.o.cwd, env: this.o.env, model: HELPER_MODEL, tools: [], settingSources: [], maxTurns: 1, persistSession: false,
        pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable,
        outputFormat: { type: "json_schema", schema: { type: "object", properties: { svg: { type: "string" } }, required: ["svg"], additionalProperties: false } },
      } as never,
    }, this.o.queryFn);
    for await (const m of q) {
      const r = m as { type: string; structured_output?: { svg?: string } };
      if (r.type === "result" && r.structured_output?.svg) return r.structured_output.svg;
    }
    throw new Error("The avatar couldn't be generated. Try a different description.");
  }
}
