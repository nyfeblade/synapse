import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HELPER_MODEL } from "@synapse/shared";
import { loadPrompt } from "../prompts";
import { meteredQuery, type QueryFn } from "../usage/metered-query";

export interface DraftInput { botName: string; description: string; memories: string[]; skills: { id: string; name: string; description: string }[]; routines: { name: string; prompt: string; schedule: string | null }[] }
export interface DraftOutput { memories: string[]; description: string }
export interface TemplateDrafter { draft(botId: string, sessionId: string | null, input: DraftInput): Promise<DraftOutput> }

const PERSONAL = /\b(wife|husband|partner|son|daughter|mom|dad|mother|father|kids?|password|ssn|bank|salary|diagnos|doctor|address|lives? (?:at|in)|phone|number is)\b|@[\w.-]+\.\w+|\+?\d[\d\s().-]{7,}\d/i;

/** Deterministic filter for tests, FUZZ mode and the fallback when the helper call fails. */
export class StubTemplateDrafter implements TemplateDrafter {
  async draft(_b: string, _s: string | null, input: DraftInput): Promise<DraftOutput> {
    return { description: input.description, memories: input.memories.filter((m) => !PERSONAL.test(m)) };
  }
}

/** TPL-01 as a one-shot brain task on a fork of the Bot's session (ORIG-07 table: resume + forkSession, persistSession false). */
export class SdkTemplateDrafter implements TemplateDrafter {
  constructor(private o: { env: Record<string, string>; cwd: string; pathToClaudeCodeExecutable?: string; queryFn?: QueryFn }) {}

  async draft(_botId: string, sessionId: string | null, input: DraftInput): Promise<DraftOutput> {
    const schema = { type: "object", properties: { description: { type: "string" }, memories: { type: "array", items: { type: "string" } } }, required: ["description", "memories"], additionalProperties: false };
    async function* prompt(): AsyncIterable<SDKUserMessage> {
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: `${loadPrompt("orig/template-draft.md").trim()}\n\n${JSON.stringify(input)}` }] } };
    }
    const q = meteredQuery({ purpose: "template-draft", botId: _botId }, {
      prompt: prompt(),
      options: {
        cwd: this.o.cwd, env: this.o.env, model: HELPER_MODEL, tools: [], settingSources: [], maxTurns: 1, persistSession: false,
        outputFormat: { type: "json_schema", schema } as never, pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable,
        ...(sessionId ? { resume: sessionId, forkSession: true } : {}),
      },
    }, this.o.queryFn);
    for await (const m of q) {
      if (m.type !== "result") continue;
      const out = (m as { structured_output?: DraftOutput }).structured_output;
      if (!out) break;
      const allowed = new Set(input.memories);
      return { description: out.description.slice(0, 20_000), memories: out.memories.filter((x) => allowed.has(x)) };
    }
    return new StubTemplateDrafter().draft(_botId, sessionId, input);
  }
}
