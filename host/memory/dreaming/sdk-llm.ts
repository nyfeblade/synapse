import { HELPER_MODEL } from "@synapse/shared";
import { fillTemplate, loadPrompt } from "../../prompts";
import { meteredQuery, type QueryFn } from "../../usage/metered-query";
import type { DreamLlm } from "./dreamer";

/** ORIG-06 §06.1: Haiku for both calls; the verifier is a fresh session that never sees the synthesizer's reasoning. */
export class SdkDreamLlm implements DreamLlm {
  constructor(private o: { env: Record<string, string>; cwd: string; pathToClaudeCodeExecutable?: string; queryFn?: QueryFn }) {}

  synthesize(input: object, botId?: string): Promise<unknown> {
    return this.call(fillTemplate(loadPrompt("orig/dream-synthesis.md"), { botName: String((input as { botName?: string }).botName ?? "the assistant") }), input, botId);
  }

  verify(input: object, botId?: string): Promise<unknown> {
    return this.call(loadPrompt("orig/dream-verify.md"), input, botId);
  }

  private async call(system: string, input: object, botId: string | undefined): Promise<unknown> {
    const q = meteredQuery({ purpose: "dreaming", botId: botId ?? null }, {
      prompt: JSON.stringify(input),
      options: { cwd: this.o.cwd, env: this.o.env, model: HELPER_MODEL, tools: [], settingSources: [], maxTurns: 1, persistSession: false, systemPrompt: system, pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable },
    }, this.o.queryFn);
    for await (const m of q) {
      if (m.type !== "result") continue;
      if (m.subtype !== "success") throw new Error(`dreaming call failed: ${m.subtype}`);
      const text = (m as { result?: string }).result ?? "";
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      if (!json) throw new Error("dreaming call returned no JSON");
      return JSON.parse(json);
    }
    throw new Error("dreaming call ended without a result");
  }
}
