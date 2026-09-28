import {
  createSdkMcpServer, tool,
  type CanUseTool, type HookCallback, type HookCallbackMatcher, type HookEvent, type McpSdkServerConfigWithInstance,
  type PostToolBatchHookInput, type PostToolUseHookInput, type PreToolUseHookInput, type SDKUserMessage, type StopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { BotToolDef, BotToolResult, BrainWiring, ModelMessage } from "./types";

const HOOK_WAIT_7_DAYS_S = 7 * 24 * 3600;

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * T29 box finding: the CLI only takes a replacement for a built-in tool (Bash, Read, …) in that tool's own result
 * shape (an object). The replacement text is the JSON of the original with values redacted, so parse it back.
 */
function sameShape(original: unknown, replacement: string | undefined): unknown {
  if (replacement === undefined || typeof original === "string" || original === null || typeof original !== "object") return replacement;
  try {
    return JSON.parse(replacement) as unknown;
  } catch {
    return replacement;
  }
}

export function toSdkHooks(w: BrainWiring): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const pre: HookCallback = async (raw) => {
    const i = raw as PreToolUseHookInput;
    const d = await w.preToolUse({ toolName: i.tool_name, input: (i.tool_input ?? {}) as Record<string, unknown>, toolUseId: i.tool_use_id, ...(i.cwd ? { cwd: i.cwd } : {}) });
    if (d.decision === "allow") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: d.updatedInput } };
    // Bug 198: a held call carries the user's steering note beside the denial, never inside the tool result,
    // and (like a PostToolUse note) keeps the batch from ending the turn before the model reads it.
    if (d.decision === "deny" && d.additionalContext) {
      noted.add(i.tool_use_id);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason, additionalContext: d.additionalContext } };
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.decision, permissionDecisionReason: d.reason } };
  };
  // Token diet (1): a tool result that carries a note for the model (a reminder, a disk warning) must
  // reach it, so a batch holding one never ends the turn early. Keyed by tool_use_id, cleared per batch.
  const noted = new Set<string>();
  const post: HookCallback = async (raw) => {
    const i = raw as PostToolUseHookInput;
    const r = await w.postToolUse({ toolName: i.tool_name, input: (i.tool_input ?? {}) as Record<string, unknown>, toolUseId: i.tool_use_id }, stringify(i.tool_response));
    if (r.additionalContext) noted.add(i.tool_use_id);
    if (r.additionalContext === undefined && r.replaceOutput === undefined) return {};
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: r.additionalContext, updatedToolOutput: sameShape(i.tool_response, r.replaceOutput) } };
  };
  const stop: HookCallback = async (raw) => {
    const i = raw as StopHookInput;
    const r = await w.stop({ lastAssistantText: i.last_assistant_message ?? "", stopHookActive: i.stop_hook_active });
    return r.block ? { decision: "block", reason: r.reason } : {};
  };
  // Token diet (1): `continue: false` after the batch stops the CLI before its next model call. Without
  // it, every reply sent through SendMessage cost one more full-context call that only said "Sent.".
  const batch: HookCallback = async (raw) => {
    const i = raw as PostToolBatchHookInput;
    const calls = (i.tool_calls ?? []).map((c) => ({ toolName: c.tool_name, input: (c.tool_input ?? {}) as Record<string, unknown>, toolUseId: c.tool_use_id }));
    const hadNote = calls.some((c) => noted.has(c.toolUseId));
    for (const c of calls) noted.delete(c.toolUseId);
    const r = w.toolBatch ? await w.toolBatch(calls) : { endTurn: false };
    return r.endTurn && !hadNote ? { continue: false, stopReason: "reply delivered" } : {};
  };
  // ORIG-13 §13.2 A: when approvals wait inside the hook, the hook must be allowed to wait for days.
  const preTimeout = w.flags().approvalPath === "hook" ? HOOK_WAIT_7_DAYS_S : 600;
  return { PreToolUse: [{ hooks: [pre], timeout: preTimeout }], PostToolUse: [{ hooks: [post] }], PostToolBatch: [{ hooks: [batch] }], Stop: [{ hooks: [stop] }] };
}

export function toSdkCanUseTool(w: BrainWiring): CanUseTool {
  return async (toolName, input, opts) => {
    const r = await w.canUseTool({ toolName, input, toolUseId: opts.toolUseID }, opts.signal);
    return r.behavior === "allow" ? { behavior: "allow", updatedInput: r.updatedInput ?? input } : { behavior: "deny", message: r.message };
  };
}

export function toMcpContent(r: BotToolResult): ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
  return [{ type: "text" as const, text: r.text }, ...(r.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))];
}

/** TOOL-13: a named MCP server for a given tool set — `"bot"` for the normal per-Bot server, and
 *  named restricted servers (e.g. `"computer"`) for children.
 *  Lazy tools: `alwaysLoad` (default true) keeps the schemas in every call; a connector-like server
 *  (Google) passes false so its tools wait behind the CLI's tool search until a turn needs them. */
export function toNamedMcpServer(name: string, tools: BotToolDef[], o: { alwaysLoad?: boolean; upFront?: readonly string[] } = {}): McpSdkServerConfigWithInstance {
  // `upFront` (the lean engineering profile): only these tools load up front; every other one is deferred.
  const loads = (n: string) => (o.upFront ? o.upFront.includes(n) : (o.alwaysLoad ?? true));
  return createSdkMcpServer({
    name,
    version: "1.0.0",
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.schema,
        async (args) => {
          const r = await t.handler(args as Record<string, unknown>);
          return { content: toMcpContent(r), isError: r.isError };
        },
        { annotations: { readOnlyHint: t.readOnly }, ...(loads(t.name) ? { alwaysLoad: true } : {}) },
      ),
    ),
  });
}

/** `upFront`: the lean engineering profile's up-front tools (SpawnConfig.upFrontBotTools); absent = every tool alwaysLoad. */
export function toSdkMcpServer(w: BrainWiring, upFront?: readonly string[]): McpSdkServerConfigWithInstance {
  return toNamedMcpServer("bot", w.botTools(), upFront ? { upFront } : {});
}

export function toSdkUserMessage(prompt: ModelMessage[]): SDKUserMessage {
  const content = prompt.map((p) =>
    "text" in p
      ? { type: "text" as const, text: p.text }
      : { type: "image" as const, source: { type: "base64" as const, media_type: p.image.mediaType, data: p.image.dataBase64 } },
  );
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content } } as SDKUserMessage;
}
