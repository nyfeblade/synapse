import path from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ConformanceFlags } from "../brain/conformance/flags";
import { buildBotEnv } from "../brain/spawn-options";
import { CODING_BUILTIN_TOOLS, DISALLOWED_TOOLS, claudeExecutableFor } from "../brain/tool-policy";
import type { PermissionDecision, PreToolDecision, ToolCall } from "../brain/types";
import type { HostConfig } from "../config";
import { meteredQuery } from "../usage/metered-query";
import { AsyncQueue } from "../util/async-queue";
import { botOsUser } from "../walls/bot-uid";
import { plainPathInfo, type PathInfo } from "../walls/home-fs";
import type { ChildFactory } from "./coding-agents";

const user = (text: string): SDKUserMessage => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } });

/** TOOL-20: a fresh background Claude Code session (D6-A host-managed) in the worktree, running as user box. */
/** C2: the coding agent's Bash is decided by the Bot's approval gate, like any Shell (null = not wired: refuse). */
export type CodingGate = (botId: string, call: ToolCall, signal: AbortSignal) => Promise<PermissionDecision>;

/** Adapts the Bot's ApprovalGate (PreToolUse, then canUseTool on "ask") to one decision for a coding agent's Bash. */
export function gateForCoding(gate: { preToolUse(botId: string, call: ToolCall): Promise<PreToolDecision>; canUseTool(botId: string, call: ToolCall, signal: AbortSignal): Promise<PermissionDecision> }): CodingGate {
  return async (botId, call, signal) => {
    const pre = await gate.preToolUse(botId, call);
    if (pre.decision === "allow") return pre.updatedInput ? { behavior: "allow", updatedInput: pre.updatedInput } : { behavior: "allow" };
    if (pre.decision === "ask") return gate.canUseTool(botId, call, signal);
    return { behavior: "deny", message: pre.reason };
  };
}

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

/** Each path's real path and whether anything is there, as the Bot sees it; null overall = the resolver failed. */
export type Realpaths = (botId: string, paths: string[]) => Promise<PathInfo[] | null>;

/** Plain fs (a worktree bothost can read: /workspace/repos, FUZZ, tests). */
export const plainRealpaths: Realpaths = async (_botId, paths) => paths.map(plainPathInfo);

/**
 * Bug 231 round 1: a Write/Edit lands inside the worktree by its REAL path, not its text: a link in the repo
 * (`evil -> ../../../.claude/...`) must not carry a write out of the tree. The deepest part of the path that exists is
 * resolved (as the Bot, for a worktree in its home) and the rest appended; the worktree itself is resolved the same way.
 * Anything unresolvable is outside, and so is a part that is there but doesn't resolve (a dangling link: writing
 * through it would create its target, wherever that is).
 */
export async function realInside(realpaths: Realpaths, botId: string, cwd: string, file: unknown): Promise<boolean> {
  if (typeof file !== "string" || !file) return false;
  const abs = path.resolve(cwd, file);
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) return false;
  const chain: string[] = [];
  for (let d = abs; ; d = path.dirname(d)) { chain.push(d); if (d === cwd || d === path.dirname(d)) break; }
  const r = await realpaths(botId, [cwd, ...chain]).catch(() => null);
  const realCwd = r?.[0]?.real;
  if (!r || !realCwd) return false;
  for (let i = 0; i < chain.length; i++) {
    const real = r[i + 1]?.real;
    if (!real) { if (r[i + 1]?.exists !== false) return false; continue; }
    const full = path.join(real, path.relative(chain[i] as string, abs));
    return full === realCwd || full.startsWith(realCwd + path.sep);
  }
  return false;
}

export function sdkChildFactory(o: { cfg: HostConfig; flags(): ConformanceFlags; gate: CodingGate | null; realpaths?: Realpaths }): ChildFactory {
  return ({ botId, cwd, model, prompt }) => {
    const input = new AsyncQueue<SDKUserMessage>();
    input.push(user(prompt));
    const inside = (p: unknown) => {
      if (typeof p !== "string") return false;
      const resolved = path.resolve(cwd, p);
      return resolved === cwd || resolved.startsWith(cwd + path.sep);
    };
    // fix round 1, finding 1: Bash is in CODING_BUILTIN_TOOLS and is otherwise unrestricted by cwd —
    // heuristically scan the command text for path-shaped substrings (absolute paths, or anything
    // starting with "..") and deny if any of them resolve outside the worktree. This is a heuristic,
    // not a sandbox: it catches the common case (another agent's worktree, the shared bare clone,
    // arbitrary absolute paths) without trying to fully parse shell syntax.
    //
    // fix round 2, finding 1: the round-1 version only split the command into whitespace/quote
    // TOKENS and checked whether each whole token started with "/" or contained "..". That misses
    // a path nested inside a quoted subshell/interpreter argument — `sh -c '...'`, `bash -c "..."`,
    // `python3 -c "..."`, `perl -e '...'`, `node -e "..."` — because the entire quoted script becomes
    // ONE token (e.g. "rm -rf /workspace/...") whose own first character is "r", not "/", and a
    // python-style `open('/workspace/...','w')` argument has no whitespace at all to even re-split
    // on. Scan the raw command text directly for path-shaped substrings instead of relying on
    // token boundaries: a candidate is a run of non-space/quote/paren/comma characters starting
    // with "/" or "..", itself preceded only by the start of the string or a delimiter (whitespace,
    // quote, paren, "=", ",") — never by an ordinary word character — so an embedded relative path
    // like "src/foo.test.ts" is not misread as the absolute path "/foo.test.ts".
    const PATH_RE = /(?:^|[\s'"(=,])((?:\.\.\/|\/)[^\s'"(),]*)/g;
    const commandTouchesOutside = (command: string) => {
      for (const m of command.matchAll(PATH_RE)) {
        if (!inside(m[1])) return true;
      }
      return false;
    };
    const spawnAt = childSpawnCwd(o.cfg, o.flags().runAs, botId, cwd);
    const q = meteredQuery({ purpose: "coding", botId }, {
      prompt: input,
      options: {
        cwd: spawnAt.cwd, model, settingSources: [], tools: [...CODING_BUILTIN_TOOLS], disallowedTools: [...DISALLOWED_TOOLS],
        systemPrompt: { type: "preset", preset: "claude_code" }, permissionMode: "default", persistSession: false,
        env: { ...buildBotEnv({ cfg: o.cfg, botId: `${botId}-coding`, asBot: botId }), ...spawnAt.env }, pathToClaudeCodeExecutable: claudeExecutableFor(o.flags().runAs, o.cfg),
        // The launch itself passed Auto-review (surface cloud_agent); inside the worktree the agent works freely,
        // but never writes outside it and never touches host-private data.
        canUseTool: async (tool, inp, opts) => {
          const blob = JSON.stringify(inp);
          if (blob.includes(o.cfg.hostPrivate)) return { behavior: "deny", message: "That path is off-limits." };
          if ((tool === "Write" || tool === "Edit") && (!inside((inp as { file_path?: string }).file_path)
            || !(await realInside(o.realpaths ?? plainRealpaths, botId, cwd, (inp as { file_path?: string }).file_path)))) return { behavior: "deny", message: "Coding agents only write inside their worktree." };
          if (tool === "Bash" && typeof (inp as { command?: unknown }).command === "string" && commandTouchesOutside((inp as { command: string }).command)) {
            return { behavior: "deny", message: "Coding agents can only run Bash commands inside their worktree." };
          }
          if (tool === "Bash") {
            if (!o.gate) return { behavior: "deny", message: "Coding agents can't run commands right now (no approval gate)." };
            const signal = (opts as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal;
            const toolUseId = String((opts as { toolUseID?: string } | undefined)?.toolUseID ?? `coding-${Math.random().toString(36).slice(2)}`);
            const d = await o.gate(botId, { toolName: "Bash", input: inp as Record<string, unknown>, toolUseId }, signal);
            if (d.behavior === "allow") return { behavior: "allow", updatedInput: d.updatedInput ?? (inp as Record<string, unknown>) };
            return { behavior: "deny", message: d.message };
          }
          return { behavior: "allow", updatedInput: inp };
        },
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
