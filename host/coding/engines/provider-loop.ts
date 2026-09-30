import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { EffortLevel } from "@synapse/shared";
import { ProviderBrain, providerRoute, type ModelRoute } from "../../brain/provider/provider-brain";
import type { ProviderSessionStore } from "../../brain/provider/session-store";
import { fillTemplate, loadPrompt } from "../../prompts";
import type { BotFileRunner } from "../../walls/bot-file";
import { claudeRoute } from "./claude-route";
import { createCodingTools, type CodingShell } from "./coding-tools";
import { LoopChild } from "./loop-child";
import { codingPolicy, type CodingGate, type Realpaths } from "./policy";
import type { CodingEngine } from "./types";
import { codingWiring } from "./wiring";

/**
 * The `provider-loop` engine (spec §8 (b)): a coding agent on Synapse's own tool loop — ProviderBrain on the Bot's own
 * model, any provider or Claude — with Synapse's coding tools (coding-tools.ts) and its own coding prompt
 * (prompts/coding-provider.md). Every call is metered as "coding" for the Bot and asks the spend budget first
 * (providerFetch, which sends a Claude model through the auth proxy); every tool call goes through the shared coding policy and the Bot's approval gate;
 * the runner's loop guard watches it (loop-child.ts).
 */
export interface ProviderLoopDeps {
  hostPrivate: string;
  gate: CodingGate | null;
  realpaths?: Realpaths;
  files: BotFileRunner;
  shell: CodingShell;
  store: ProviderSessionStore;
  /** WebFetch's fetch; default the host's guarded fetch. */
  fetch?: FetchLike;
  /** Whether this model takes a reasoning effort (conformance). */
  reasoning?(ref: string): boolean;
  effort?(botId: string): EffortLevel | undefined;
  /** How a model is called; default: a provider model's route, else Claude's Messages route. */
  route?(ref: string): ModelRoute | null;
  /** Model calls for the whole task (default 300). */
  maxModelCalls?: number;
  now?(): number;
  log?(m: string, f?: Record<string, unknown>): void;
}

export const DEFAULT_CODING_MODEL_CALLS = 300;
export const defaultCodingRoute = (ref: string): ModelRoute | null => providerRoute(ref) ?? claudeRoute(ref);

/** The system prompt: Synapse's own coding prompt, with where the agent works. */
export function codingSystemPrompt(worktree: string): string {
  return fillTemplate(loadPrompt("coding-provider.md"), { worktree }).trim();
}

export function providerLoopEngine(d: ProviderLoopDeps): CodingEngine {
  const route = d.route ?? defaultCodingRoute;
  const cap = d.maxModelCalls ?? DEFAULT_CODING_MODEL_CALLS;
  return {
    id: "provider-loop",
    runs: (model) => route(model) !== null,
    start: ({ botId, agentId, cwd, model, prompt, resumeSessionId }) => {
      let signal = new AbortController().signal;
      let sid: string | null = resumeSessionId ?? null;
      const { tools, shellDir } = createCodingTools({ botId, agentId, cwd, files: d.files, shell: d.shell, signal: () => signal, ...(d.fetch ? { fetch: d.fetch } : {}) });
      const brain = new ProviderBrain({
        botId, storeKey: botId, store: d.store, route,
        wiring: codingWiring({ policy: codingPolicy({ hostPrivate: d.hostPrivate, gate: d.gate, ...(d.realpaths ? { realpaths: d.realpaths } : {}) }, botId, cwd), cwd, shellDir }),
        getSessionId: () => sid, setSessionId: (s) => { sid = s; },
        meter: { purpose: "coding", botId },
        systemPrompt: () => codingSystemPrompt(cwd),
        builtinTools: () => tools.map((def) => ({ canonical: def.name, def })),
        effort: () => d.effort?.(botId),
        ...(d.reasoning ? { reasoning: d.reasoning } : {}),
        maxModelCalls: cap,
        ...(d.now ? { now: d.now } : {}),
        ...(d.log ? { log: d.log } : {}),
      });
      return new LoopChild({ engine: "provider-loop", key: agentId, model, brain, maxModelCalls: cap, onStep: (s) => { signal = s; }, session: () => sid, ...(d.now ? { now: d.now } : {}) }, prompt);
    },
  };
}
