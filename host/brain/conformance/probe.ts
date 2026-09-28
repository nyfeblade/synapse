import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { isExpectedPostInterruptThrow } from "../interrupt-throw";
import type { ConformanceContext } from "./types";
import { spawnClaudeProcess } from "../../claude/spawn";

/** The CLI process start ClaudeBrain uses (brain/claude-brain.ts), for checks that run their own. */
export function nodeSpawn(o: SpawnOptions): SpawnedProcess {
  // Review fix round 1: nobody reads a probe's stderr; left undrained, a chatty CLI fills the pipe and blocks.
  // Review round 3 (S6): through the one claude spawn helper, which checks the env.
  return spawnClaudeProcess(o, { drainStderr: true });
}

/**
 * Counts real CLI process starts. `system/init` is NOT a process start: the CLI emits one at the start of every
 * turn (SDK docs, SDKSystemMessage), so counting inits read one warm process as one process per turn.
 */
export function countingSpawn(ctx: ConformanceContext): { spawnClaudeCodeProcess: (o: SpawnOptions) => SpawnedProcess; count(): number; firstAt(): number | null } {
  let n = 0;
  let first: number | null = null;
  const inner = ctx.spawnProcess ?? nodeSpawn;
  return {
    spawnClaudeCodeProcess: (o) => { n++; first ??= Date.now(); return inner(o); },
    count: () => n,
    firstAt: () => first,
  };
}

export const allowAll: CanUseTool = async (_name, input) => ({ behavior: "allow", updatedInput: input });

export function userMessage(text: string): SDKUserMessage {
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } };
}

export interface ProbeRun {
  messages: SDKMessage[];
  init: Record<string, any> | null;
  results: Record<string, any>[];
  toolUses: { id: string; name: string; input: Record<string, unknown>; at: number }[];
  toolResults: { toolUseId: string; text: string; isError: boolean; at: number }[];
  /** Set (to Date.now()) the moment `q.interrupt()` is called through the `onMessage` callback's `q`. */
  interruptedAt: number | null;
}

export async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/** Runs one query against the real CLI and records what came back. Closes the query on timeout. */
export async function runProbe(
  ctx: ConformanceContext,
  p: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Partial<Options>; onMessage?: (m: SDKMessage, q: Query, run: ProbeRun) => void | Promise<void>; timeoutMs?: number },
): Promise<ProbeRun> {
  const run: ProbeRun = { messages: [], init: null, results: [], toolUses: [], toolResults: [], interruptedAt: null };
  const q = ctx.queryFn({ prompt: p.prompt, options: ctx.baseOptions(p.options) });
  // Wraps `interrupt()` so a call made through `onMessage`'s `q` records `run.interruptedAt`, without
  // otherwise changing the query's behavior (everything else forwards untouched via Reflect).
  const interruptTrackingQ = new Proxy(q, {
    get(target, prop, receiver) {
      if (prop === "interrupt") return (...args: unknown[]) => { run.interruptedAt = Date.now(); return (target.interrupt as (...a: unknown[]) => unknown)(...args); };
      return Reflect.get(target, prop, receiver);
    },
  });
  const timer = setTimeout(() => q.close(), p.timeoutMs ?? 180_000);
  try {
    for await (const m of q) {
      run.messages.push(m);
      const msg = m as unknown as Record<string, any>;
      if (msg.type === "system" && msg.subtype === "init") run.init = msg;
      if (msg.type === "result") run.results.push(msg);
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        for (const b of msg.message.content ?? []) if (b.type === "tool_use") run.toolUses.push({ id: b.id, name: b.name, input: b.input ?? {}, at: Date.now() });
      }
      if (msg.type === "user" && Array.isArray(msg.message?.content)) {
        for (const b of msg.message.content) {
          if (b.type === "tool_result") {
            const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
            run.toolResults.push({ toolUseId: b.tool_use_id, text, isError: Boolean(b.is_error), at: Date.now() });
          }
        }
      }
      await p.onMessage?.(m, interruptTrackingQ, run);
    }
  } catch (e) {
    if (run.interruptedAt === null || !isExpectedPostInterruptThrow(e)) throw e;
    // Expected (CT-03): the final result already arrived above via the `for await` loop; the run is
    // otherwise complete.
  } finally {
    clearTimeout(timer);
  }
  return run;
}
