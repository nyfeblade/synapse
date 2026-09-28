import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { HELPER_MODEL } from "@synapse/shared";
import { meteredQuery, type Meter, type QueryFn } from "../usage/metered-query";

/** `tag` says what the call is for and which Bot it served; the call is recorded under it (usage/metered-query.ts). */
export interface OneShotModel { complete(p: { system: string; user: string; signal?: AbortSignal; tag: Meter }): Promise<string> }

/** D4 helper calls (memory extraction, episodes): Haiku 4.5, no tools, nothing persisted (ORIG-07 §07.6). */
export class SdkOneShot implements OneShotModel {
  constructor(private o: { env: Record<string, string>; cwd: string; pathToClaudeCodeExecutable?: string; model?: string; timeoutMs?: number; queryFn?: QueryFn }) {}

  async complete(p: { system: string; user: string; signal?: AbortSignal; tag: Meter }): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 60_000);
    p.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const options: Options = {
      model: this.o.model ?? HELPER_MODEL, systemPrompt: p.system, tools: [], settingSources: [], persistSession: false, maxTurns: 1,
      env: this.o.env, cwd: this.o.cwd, abortController: ac, settings: { autoMemoryEnabled: false } as Options["settings"],
      ...(this.o.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable } : {}),
    };
    try {
      for await (const m of meteredQuery(p.tag, { prompt: p.user, options }, this.o.queryFn)) {
        const r = m as { type: string; subtype?: string; result?: string; errors?: string[] };
        if (r.type !== "result") continue;
        if (r.subtype === "success") return String(r.result ?? "");
        throw new Error(`helper call failed: ${r.subtype} ${(r.errors ?? []).join("; ")}`);
      }
      throw new Error("helper call ended without a result");
    } finally {
      clearTimeout(timer);
    }
  }
}

export class StubOneShot implements OneShotModel {
  constructor(private reply: (p: { system: string; user: string }) => string) {}
  async complete(p: { system: string; user: string }): Promise<string> {
    return this.reply(p);
  }
}
