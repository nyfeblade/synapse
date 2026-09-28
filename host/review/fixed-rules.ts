/**
 * FIXED RULES — the host-side adapter for the layered permission model (feat-mac-access-parity).
 *
 * The engine itself (shared/src/perm-rules.ts) is pure and shared with the Mac coordinator so both sides agree.
 * This file turns one classified tool call into a PermAction the engine understands, for BOTH the box (Bash/Shell,
 * Write/Edit) and the Mac (ExternalShell, the new Mac file tool). It runs in ApprovalGate.preToolUse, BEFORE the
 * reviewer, and its verdict is the first layer:
 *   never         → a hard deny, un-overridable by any mode or saved rule (credential exfiltration / secret stores)
 *   always-ask    → a card every time, even in Full-auto mode
 *   always-allow  → skip the reviewer entirely (reads, common build/test/git-status/diff in a project dir)
 *   defer         → the fixed rules have nothing to say; fall through to the reviewer / mode logic
 *
 * Deliberately does NOT edit host/review/static.ts (another agent owns it for engineering-mode fast paths).
 */
import fs from "node:fs";
import path from "node:path";
import { evaluateFixedRules, fullAutoAsk, type FullAutoAction, type FullAutoContext, type FullAutoResult, type PermAction, type PermContext, type PermResult, type PermMode } from "@synapse/shared";
import type { Classification } from "./classify";
import type { ToolCall } from "../brain/types";

export interface FixedRulesEnv {
  /** The box workspace (project dir for box actions). */
  workspace: string;
  /** The Mac computer's home and auto-run roots (project dirs), when a Mac is connected. */
  mac: { home: string; projectDirs: readonly string[]; userData?: string | null } | null;
  /** full-auto-quiet: extra roots the Bot owns (its scratch dirs), on top of the workspace and the Mac project dirs. */
  scratch?: readonly string[];
  /** Bug 258: the Bot is in No limits (Full auto only): sends and private-file reads don't ask; the NEVER walls hold. */
  noLimits?: boolean;
}

/** Translate a classified call into the engine's PermAction, or null when the fixed rules don't apply. */
export function toPermAction(call: ToolCall, cls: Classification, env: FixedRulesEnv): { action: PermAction; ctx: PermContext } | null {
  const name = call.toolName;
  const macCtx = (): PermContext | null => env.mac && { home: env.mac.home, projectDirs: env.mac.projectDirs, userData: env.mac.userData ?? null, ...(env.noLimits ? { noLimits: true } : {}) };

  // The BOX is deliberately not judged here: it is a disposable container with its own battle-tested gate — the
  // F7/F8/F9 floors in host/review/* are its NEVER wall, and the reviewer's fast path is its ALWAYS-ALLOW. The fixed
  // rules are the NEW layer for the user's own Mac. (Full auto still respects the box floor via st.floorHits.)

  // ---- Mac tools (host_shell surface) ----
  if (cls.surface === "host_shell") {
    const ctx = macCtx();
    if (!ctx) return null; // no Mac connected: nothing for the fixed rules to say
    const i = call.input;
    if (name === "mcp__bot__ExternalShell") {
      return { action: { side: "mac", kind: "command", command: String(i.command ?? ""), cwd: typeof i.cwd === "string" ? i.cwd : undefined }, ctx };
    }
    if (name === "mcp__bot__ExternalRead") return { action: { side: "mac", kind: "read", path: String(i.path ?? "") }, ctx };
    if (name === "mcp__bot__CopyToBox") return { action: { side: "mac", kind: "read", path: String(i.local_path ?? "") }, ctx };
    if (name === "mcp__bot__CopyFromBox") return { action: { side: "mac", kind: "write", path: String(i.local_path ?? "") }, ctx };
    if (name === "mcp__bot__Mac") {
      const act = String(i.action ?? "");
      if (act === "read" || act === "glob" || act === "grep") return { action: { side: "mac", kind: "read", path: String(i.path ?? "") }, ctx };
      if (act === "write") return { action: { side: "mac", kind: "write", path: String(i.path ?? "") }, ctx };
      if (act === "edit") return { action: { side: "mac", kind: "edit", path: String(i.path ?? "") }, ctx };
    }
  }
  return null;
}

/** Evaluate the fixed rules for a call. Returns "defer" (rule "defer") when they don't apply. */
export function fixedRuleFor(call: ToolCall, cls: Classification, env: FixedRulesEnv): PermResult {
  const t = toPermAction(call, cls, env);
  if (!t) return { verdict: "defer", rule: "defer", reason: "" };
  return evaluateFixedRules(t.action, t.ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// FULL AUTO (full-auto-quiet): one policy, from @synapse/shared. This file only turns a classified tool call into the
// FullAutoAction the shared classifier understands — the Mac coordinator and the Browser classifier do the same,
// so the three agree. The classifier decides CARDS only; the fixed NEVER wall above is still a hard block.
// ---------------------------------------------------------------------------------------------------------------

/** The roots the Bot owns: its box workspace, its scratch dirs, and the Mac's auto-run (project) roots. */
export function fullAutoContext(env: FixedRulesEnv): FullAutoContext {
  return {
    home: env.mac?.home ?? "/home/box",
    workspaces: [env.workspace, "/tmp", ...(env.scratch ?? []), ...(env.mac?.projectDirs ?? [])],
    ...(env.noLimits ? { noLimits: true } : {}),
    exists: (p) => { try { return fs.existsSync(p); } catch { return true; } },
  };
}

/** One classified tool call as the shared Full-auto classifier sees it, or null when there is nothing to judge. */
export function toFullAutoAction(call: ToolCall, cls: Classification, env: FixedRulesEnv): FullAutoAction | null {
  const t = cls.target;
  if (!t) return null;
  const i = call.input;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const mac = cls.surface === "host_shell";
  const side = mac ? "mac" : "box";

  if (call.toolName === "mcp__bot__Browser") {
    return { kind: "browser", action: str(i.action), url: str(i.url) || undefined, label: str(i.value) || undefined, submit: i.submit === true };
  }
  if (t.action === "shell") {
    const a = t.arguments;
    // The Mac file tool and the copy tools are file actions, not commands.
    if (a.tool === "Mac") {
      const act = String(a.mac_action ?? "");
      if (act === "write" || act === "edit") return { kind: "file", side: "mac", op: act, path: String(a.path ?? "") };
      // Bug 256 (review): a read / glob / grep asks only for a credential store (saved logins, cookies, Mail, …).
      return { kind: "file", side: "mac", op: "read", path: String(a.path ?? "") || (env.mac?.home ?? "~") };
    }
    if (a.tool === "ExternalRead") return { kind: "file", side: "mac", op: "read", path: str(i.path) };
    if (a.tool === "CopyFromBox") return { kind: "file", side: "mac", op: "write", path: str(i.local_path) };
    if (a.tool === "CopyToBox") return { kind: "file", side: "box", op: "write", path: path.resolve(env.workspace, str(i.box_path)) };
    const cwd = String(a.working_directory ?? env.workspace);
    return { kind: "command", side, command: String(a.command ?? ""), cwd: cwd === "~" ? (env.mac?.home ?? "~") : cwd };
  }
  if (t.action === "write_file") return { kind: "file", side: "box", op: str(t.arguments.tool) === "Edit" ? "edit" : "write", path: path.resolve(env.workspace, String(t.arguments.path ?? "")) };
  if (t.action === "computer" || t.action === "subagent") return null; // the box's own screen / a child of this Bot
  if (t.action === "browser") {
    const a = t.arguments as Record<string, unknown>;
    return { kind: "browser", action: str(a.tool) || str(a.action), url: str(a.url) || undefined, label: str(a.element) || str(a.value) || undefined };
  }
  return { kind: "tool", action: t.action, args: t.arguments as Record<string, unknown> };
}

/** The Full-auto verdict for one classified tool call. `ask: false` means it runs with no card. */
export function fullAutoAskFor(call: ToolCall, cls: Classification, env: FixedRulesEnv): FullAutoResult {
  const a = toFullAutoAction(call, cls, env);
  // Bug 256 (review): CopyToBox reads a Mac file before it writes the box; a credential store asks.
  if (call.toolName === "mcp__bot__CopyToBox" && typeof call.input.local_path === "string") {
    const read = fullAutoAsk({ kind: "file", side: "mac", op: "read", path: call.input.local_path }, fullAutoContext(env));
    if (read.ask) return read;
  }
  return a ? fullAutoAsk(a, fullAutoContext(env)) : { ask: false, category: null, rule: "full-auto.quiet", reason: "" };
}

/**
 * How a mode changes a would-otherwise-ask outcome, once the fixed rules said "defer" or "always-allow".
 * ALWAYS-ASK and NEVER are decided before this and are never softened here.
 */
export function modeAllowsWithoutCard(mode: PermMode, call: ToolCall, cls: Classification, env: FixedRulesEnv): boolean {
  // full-auto-quiet: Full auto asks only for the five categories; the caller applies fullAutoAskFor itself.
  if (mode === "full-auto") return !fullAutoAskFor(call, cls, env).ask;
  if (mode === "accept-edits") {
    const t = toPermAction(call, cls, env);
    if (!t) return false;
    // Only file edits/writes inside a project dir auto-accept (Claude Code's acceptEdits).
    if (t.action.kind !== "edit" && t.action.kind !== "write") return false;
    const r = evaluateFixedRules(t.action, t.ctx);
    return r.verdict === "always-allow";
  }
  return false;
}
