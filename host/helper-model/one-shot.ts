import { HELPER_MODEL } from "@synapse/shared";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { meteredQuery, type QueryFn } from "../usage/metered-query";

export interface OneShotRequest {
  prompt: string;                          // file under host/prompts, e.g. "orig/b2b-gate.md"
  vars?: Record<string, string>;           // fills {{name}} placeholders in the prompt file (fillTemplate)
  input: unknown;                          // sent as the single user message (JSON)
  schema: Record<string, unknown>;         // JSON schema for structured output
  timeoutMs: number;
  allowedTools?: string[];                 // only the email connector poll uses this (ORIG-04 §04.5)
  mcpServers?: Record<string, unknown>;
  /** The Bot this call serves, for usage accounting (null: host-level). The purpose is the prompt's name. */
  botId?: string | null;
  /** Bug 134: false = no extended thinking (short creative or summary calls; measured 10-20x fewer output tokens). */
  thinking?: false;
}
export interface OneShotModel { run<T>(req: OneShotRequest): Promise<T> }

export class OneShotTimeout extends Error {
  constructor(ms: number) {
    super(`one-shot call timed out after ${ms} ms`);
    this.name = "OneShotTimeout";
  }
}

/** "orig/b2b-gate.md" → "b2b-gate": what the call was for, in the usage table. */
export const purposeOfPrompt = (prompt: string): string => prompt.replace(/^.*\//, "").replace(/\.md$/, "");

/** One-shot structured Haiku call (D4). No session is persisted and no built-in tools are exposed. */
export class SdkOneShot implements OneShotModel {
  constructor(private o: { env: Record<string, string>; cwd: string; pathToClaudeCodeExecutable?: string; model?: string; queryFn?: QueryFn }) {}

  async run<T>(req: OneShotRequest): Promise<T> {
    const abortController = new AbortController();
    const tools = req.allowedTools ?? [];
    const q = meteredQuery({ purpose: purposeOfPrompt(req.prompt), botId: req.botId ?? null }, {
      prompt: JSON.stringify(req.input),
      options: {
        model: this.o.model ?? HELPER_MODEL,
        systemPrompt: req.vars ? fillTemplate(loadPrompt(req.prompt), req.vars) : loadPrompt(req.prompt),
        settingSources: [],
        tools: [],
        allowedTools: tools,
        mcpServers: (req.mcpServers ?? {}) as never,
        maxTurns: tools.length ? 4 : 2,
        persistSession: false,
        cwd: this.o.cwd,
        env: { ...this.o.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", ENABLE_TOOL_SEARCH: "false" },
        pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable,
        outputFormat: { type: "json_schema", schema: req.schema },
        ...(req.thinking === false ? { thinking: { type: "disabled" as const } } : {}),
        abortController,
      },
    }, this.o.queryFn);
    const timer = setTimeout(() => abortController.abort(), req.timeoutMs);
    try {
      for await (const m of q) {
        const r = m as { type: string; is_error?: boolean; structured_output?: unknown };
        if (r.type !== "result") continue;
        if (r.is_error || r.structured_output === undefined) throw new Error("one-shot call returned no structured output");
        return r.structured_output as T;
      }
      if (abortController.signal.aborted) throw new OneShotTimeout(req.timeoutMs);
      throw new Error("one-shot call ended without a result");
    } catch (e) {
      if (abortController.signal.aborted && !(e instanceof Error && e.message.includes("no structured output"))) throw new OneShotTimeout(req.timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
      (q as { close?: () => void }).close?.();
    }
  }
}

/** Deterministic stand-in for tests, FUZZ and E2E: handlers keyed by prompt file. */
export class StubOneShot implements OneShotModel {
  readonly calls: { prompt: string; input: unknown }[] = [];

  constructor(private handlers: Record<string, (input: unknown) => unknown | Promise<unknown>>) {}

  async run<T>(req: OneShotRequest): Promise<T> {
    this.calls.push({ prompt: req.prompt, input: req.input });
    const h = this.handlers[req.prompt];
    if (!h) throw new Error(`no stub for ${req.prompt}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OneShotTimeout(req.timeoutMs)), req.timeoutMs); });
    try {
      return (await Promise.race([Promise.resolve(h(req.input)), timeout])) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
