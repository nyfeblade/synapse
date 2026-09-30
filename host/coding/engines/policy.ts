import path from "node:path";
import type { PermissionDecision, PreToolDecision, ToolCall } from "../../brain/types";
import { plainPathInfo, type PathInfo } from "../../walls/home-fs";

/**
 * The one safety path every coding engine takes (spec §8: "every engine must use gateForCoding for commands, realInside
 * for writes, and the hostPrivate deny"). The claude-code engine asks it from the SDK's canUseTool, the provider-loop
 * engine from its ToolLoop wiring, an ACP engine from each permission the vendor CLI asks; the tool names are the
 * Claude Code CLI's (Bash, Read, Write, Edit, Glob, Grep, …) in all three, so the same call gets the same decision.
 */

/** C2: the coding agent's commands are decided by the Bot's approval gate, like any Shell (null = not wired: refuse). */
export type CodingGate = (botId: string, call: ToolCall, signal: AbortSignal) => Promise<PermissionDecision>;

/** Adapts the Bot's ApprovalGate (PreToolUse, then canUseTool on "ask") to one decision for a coding agent's command. */
export function gateForCoding(gate: { preToolUse(botId: string, call: ToolCall): Promise<PreToolDecision>; canUseTool(botId: string, call: ToolCall, signal: AbortSignal): Promise<PermissionDecision> }): CodingGate {
  return async (botId, call, signal) => {
    const pre = await gate.preToolUse(botId, call);
    if (pre.decision === "allow") return pre.updatedInput ? { behavior: "allow", updatedInput: pre.updatedInput } : { behavior: "allow" };
    if (pre.decision === "ask") return gate.canUseTool(botId, call, signal);
    return { behavior: "deny", message: pre.reason };
  };
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

/**
 * Fix rounds 1–2, finding 1: a command is otherwise unrestricted by cwd, so its raw text is scanned for path-shaped
 * substrings (absolute paths, or anything starting with "..") and refused if any resolves outside the worktree. A
 * candidate is a run of non-space/quote/paren/comma characters starting with "/" or "..", preceded only by the start of
 * the string or a delimiter (whitespace, quote, paren, "=", ","), so a path inside a quoted `sh -c '…'` or a
 * `python3 -c "open('/…')"` is caught, and a relative "src/foo.test.ts" is never misread as "/foo.test.ts". A
 * heuristic, not a sandbox: the gate (and on the box the Bot's own uid) is the wall.
 */
const PATH_RE = /(?:^|[\s'"(=,])((?:\.\.\/|\/)[^\s'"(),]*)/g;
export function commandTouchesOutside(cwd: string, command: string): boolean {
  const inside = (p: string) => { const r = path.resolve(cwd, p); return r === cwd || r.startsWith(cwd + path.sep); };
  for (const m of command.matchAll(PATH_RE)) if (!inside(m[1]!)) return true;
  return false;
}

export const OFF_LIMITS = "That path is off-limits.";
export const WRITE_OUTSIDE = "Coding agents only write inside their worktree.";
export const BASH_OUTSIDE = "Coding agents can only run Bash commands inside their worktree.";
export const NO_GATE = "Coding agents can't run commands right now (no approval gate).";

export interface CodingPolicyDeps { hostPrivate: string; gate: CodingGate | null; realpaths?: Realpaths }
export type CodingDecision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };
/** `cwd`: where a command will run, when the engine knows it (its shell's folder, a vendor CLI's terminal folder); the
 *  gate reads the scripts a command runs from there. It must be inside the worktree. */
export type CodingPolicy = (tool: string, input: Record<string, unknown>, signal: AbortSignal, toolUseId: string, cwd?: string) => Promise<CodingDecision>;

/**
 * The launch itself passed Auto-review (surface cloud_agent); inside the worktree the agent works freely, but never
 * writes outside it, never touches host-private data, and runs no command the Bot's gate hasn't allowed.
 *  - anything naming the host's private folder: refused;
 *  - Write / Edit: only inside the worktree, by text and by real path;
 *  - Bash: no path outside the worktree in its text, and then the Bot's approval gate decides (auto-review, cards);
 *  - Read, Glob, Grep, TodoWrite, WebFetch, WebSearch: allowed (the Bot's own walls still apply to what they reach).
 */
export function codingPolicy(d: CodingPolicyDeps, botId: string, cwd: string): CodingPolicy {
  const inside = (p: unknown) => typeof p === "string" && (path.resolve(cwd, p) === cwd || path.resolve(cwd, p).startsWith(cwd + path.sep));
  return async (tool, inp, signal, toolUseId, runIn) => {
    if (JSON.stringify(inp).includes(d.hostPrivate)) return { behavior: "deny", message: OFF_LIMITS };
    if ((tool === "Write" || tool === "Edit") && (!inside(inp.file_path) || !(await realInside(d.realpaths ?? plainRealpaths, botId, cwd, inp.file_path)))) {
      return { behavior: "deny", message: WRITE_OUTSIDE };
    }
    if (tool === "Bash" && typeof inp.command === "string" && commandTouchesOutside(cwd, inp.command)) return { behavior: "deny", message: BASH_OUTSIDE };
    if (tool === "Bash" && runIn !== undefined && !inside(runIn)) return { behavior: "deny", message: BASH_OUTSIDE };
    if (tool === "Bash") {
      if (!d.gate) return { behavior: "deny", message: NO_GATE };
      const r = await d.gate(botId, { toolName: "Bash", input: inp, toolUseId, ...(runIn !== undefined ? { cwd: path.resolve(cwd, runIn) } : {}) }, signal);
      if (r.behavior === "allow") return { behavior: "allow", updatedInput: r.updatedInput ?? inp };
      return { behavior: "deny", message: r.message };
    }
    return { behavior: "allow", updatedInput: inp };
  };
}
