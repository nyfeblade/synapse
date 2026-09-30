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
import { evaluateFixedRules, fullAutoAsk, type FullAutoAction, type FullAutoContext, type FullAutoResult, type McpToolMeta, type PermAction, type PermContext, type PermResult, type PermMode } from "@synapse/shared";
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
  /** Bug 275: what the host knows about a registry MCP tool (a server Synapse knows; the tool's description). */
  mcpTool?(serverId: string, tool: string): McpToolMeta;
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

/** Bug 441: the most realpath lookups one box decision makes (a few per path named; the classifier walks up). */
export const BOX_REALPATH_BUDGET = 4096;

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
  if (t.action === "mcp") {
    // Bug 275: the raw server id (claude_ai_ kept) from the tool name; nothing known about it = unknown.
    const m = /^mcp__(.+?)__(.+)$/.exec(call.toolName);
    const meta: McpToolMeta = (m && env.mcpTool?.(m[1]!, m[2]!)) || { known: false, description: null };
    return { kind: "tool", action: t.action, args: t.arguments as Record<string, unknown>, mcp: meta };
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
  if (!a) return { ask: false, category: null, rule: "full-auto.quiet", reason: "" };
  // Bug 441: a box file or command is judged by where its paths REALLY are (the host sees the box's files); a Mac path
  // is resolved on the Mac, by the coordinator, never here.
  const box = (a.kind === "file" || a.kind === "command") && a.side === "box";
  if (!box) return fullAutoAsk(a, fullAutoContext(env));
  // Each path resolved once, and at most BOX_REALPATH_BUDGET lookups per call (bug 433's rule): past that, what the
  // classifier found can't be trusted to stay quiet, so it asks.
  const memo = new Map<string, string | Error>();
  let calls = 0;
  let exhausted = false;
  const realpath = (p: string): string => {
    let r = memo.get(p);
    if (r === undefined) {
      if (++calls > BOX_REALPATH_BUDGET) { exhausted = true; throw new Error("realpath budget"); }
      try { r = fs.realpathSync.native(p); } catch (e) { r = e as Error; }
      memo.set(p, r);
    }
    if (r instanceof Error) throw r;
    return r;
  };
  const v = fullAutoAsk(a, { ...fullAutoContext(env), realpath });
  return !v.ask && exhausted ? { ask: true, category: "security", rule: "security.too-long", reason: "This names more paths than can be checked ahead of time." } : v;
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

// ---------------------------------------------------------------------------------------------------------------
// Bug 439: ASK IS NEVER WEAKER THAN FULL AUTO. Ask and Auto-accept edits run the same Full-auto classifier as a
// deterministic floor, before the reviewer model. What Full auto would card, these modes card or hand to the reviewer
// with a floor it can't wave through on its own judgement.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Code from the network run in place, and data sent off this machine (uploads, remote copies, raw sockets, a
 * script's own connection, a command's output put into a request): a card every time, in every mode and with
 * Auto-review off, before the reviewer. No Allow rule, exact rule or reviewer verdict lifts it.
 * Safety v2: these are the preset rules "Uploads to unknown sites" and "Running code from the internet" (Balanced
 * and Careful). The owner can remove or loosen them; with a Bot's network locked, the hard core denies them outright.
 */
export const HARD_FLOOR_RULES: ReadonlySet<string> = new Set([
  "security.pipe-to-shell", "security.fetch-and-run", "send.webhook", "send.network", "send.network-script", "send.exfil", "send.cloud-upload",
]);

/** The reviewer floor each Full-auto category stands for (post-validation blocks an allow without a covering rule). */
const CATEGORY_FLOOR: Record<string, string> = { destruction: "F4", send: "F1", money: "F3", security: "F5" };

export interface AskFloor {
  /** The Full-auto verdict this call would get. */
  result: FullAutoResult;
  /** A card before the reviewer, whatever the rules or the reviewer say. */
  hard: boolean;
  /** The floor code added to the static result. */
  code: string;
}

/** The floor Ask and Auto-accept edits take from the Full-auto classifier, or null when Full auto would stay quiet. */
export function askModeFloor(call: ToolCall, cls: Classification, env: FixedRulesEnv): AskFloor | null {
  return askFloorOf(fullAutoAskFor(call, cls, { ...env, noLimits: false }));
}

/** Safety v2: the Ask floor from a classifier verdict already worked out (No limits off), so the gate classifies once. */
export function askFloorOf(r: FullAutoResult): AskFloor | null {
  if (!r.ask || !r.category) return null;
  const hard = HARD_FLOOR_RULES.has(r.rule);
  return { result: r, hard, code: hard ? "F9" : (CATEGORY_FLOOR[r.category] ?? "F5") };
}

/** The static result with the Ask floor added: the floor code, and a tier the fast path can't take. */
export function withAskFloor<T extends { tierHint: 0 | 1 | 2 | 3 | 4; floorHits: string[]; readOnly: boolean }>(st: T, f: AskFloor | null): T {
  if (!f) return st;
  const tier = (f.hard ? 4 : Math.max(st.tierHint, 3)) as T["tierHint"];
  return { ...st, floorHits: st.floorHits.includes(f.code) ? st.floorHits : [...st.floorHits, f.code], tierHint: tier, readOnly: false };
}
