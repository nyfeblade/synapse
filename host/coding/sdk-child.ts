import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ConformanceFlags } from "../brain/conformance/flags";
import { buildBotEnv } from "../brain/spawn-options";
import { CODING_BUILTIN_TOOLS, DISALLOWED_TOOLS, claudeExecutableFor } from "../brain/tool-policy";
import type { HostConfig } from "../config";
import { meteredQuery } from "../usage/metered-query";
import { AsyncQueue } from "../util/async-queue";
import { botOsUser } from "../walls/bot-uid";
import type { ChildFactory, CodingChild } from "./coding-agents";
import { codingPolicy, type CodingGate, type Realpaths } from "./engines/policy";

const user = (text: string): SDKUserMessage => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } });

/** TOOL-20: a fresh background Claude Code session (D6-A host-managed) in the worktree, running as user box. The
 *  claude-code coding engine (engines/claude-code.ts); its safety decisions are engines/policy.ts, shared by every engine. */
export { gateForCoding, plainRealpaths, realInside, type CodingGate, type Realpaths } from "./engines/policy";

/**
 * Bug 231: where the coding child's process is spawned. A worktree in the Bot's own 0700 home (~/code) can't be the
 * spawn cwd on the box: bothost spawns the helper and can't enter that home. So the helper is spawned in /workspace and
 * enters the worktree itself, after dropping to the Bot's uid (BOT_CWD, box/files/bot-claude-as-box).
 */
export function childSpawnCwd(cfg: HostConfig, runAs: ConformanceFlags["runAs"], botId: string, cwd: string): { cwd: string; env: Record<string, string> } {
  const u = botOsUser(cfg, botId);
  if (runAs === "setpriv" && u && cwd.startsWith(`${u.home}/`)) return { cwd: cfg.workspace, env: { BOT_CWD: cwd } };
  return { cwd, env: {} };
}

/** The SDK's canUseTool for one coding child: the shared coding policy, in the SDK's shape. */
export function sdkCanUseTool(o: { cfg: Pick<HostConfig, "hostPrivate">; gate: CodingGate | null; realpaths?: Realpaths }, botId: string, cwd: string) {
  const policy = codingPolicy({ hostPrivate: o.cfg.hostPrivate, gate: o.gate, ...(o.realpaths ? { realpaths: o.realpaths } : {}) }, botId, cwd);
  return async (tool: string, inp: Record<string, unknown>, opts?: { signal?: AbortSignal; toolUseID?: string }): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> => {
    const signal = opts?.signal ?? new AbortController().signal;
    const toolUseId = String(opts?.toolUseID ?? `coding-${Math.random().toString(36).slice(2)}`);
    return policy(tool, inp, signal, toolUseId);
  };
}

export function sdkChildFactory(o: { cfg: HostConfig; flags(): ConformanceFlags; gate: CodingGate | null; realpaths?: Realpaths }): (o: Pick<Parameters<ChildFactory>[0], "botId" | "cwd" | "model" | "prompt">) => CodingChild {
  return ({ botId, cwd, model, prompt }) => {
    const input = new AsyncQueue<SDKUserMessage>();
    input.push(user(prompt));
    const spawnAt = childSpawnCwd(o.cfg, o.flags().runAs, botId, cwd);
    const q = meteredQuery({ purpose: "coding", botId }, {
      prompt: input,
      options: {
        cwd: spawnAt.cwd, model, settingSources: [], tools: [...CODING_BUILTIN_TOOLS], disallowedTools: [...DISALLOWED_TOOLS],
        systemPrompt: { type: "preset", preset: "claude_code" }, permissionMode: "default", persistSession: false,
        env: { ...buildBotEnv({ cfg: o.cfg, botId: `${botId}-coding`, asBot: botId }), ...spawnAt.env }, pathToClaudeCodeExecutable: claudeExecutableFor(o.flags().runAs, o.cfg),
        // The launch itself passed Auto-review (surface cloud_agent); inside the worktree the agent works freely,
        // but never writes outside it and never touches host-private data.
        canUseTool: sdkCanUseTool(o, botId, cwd) as never,
      },
    });
    return {
      push: (text) => input.push(user(text)),
      interrupt: async () => { await q.interrupt(); },
      close: () => { input.end(); q.close(); },
      messages: q as unknown as AsyncIterable<{ type: string; [k: string]: unknown }>,
    };
  };
}
