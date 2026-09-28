import { HELPER_MODEL } from "@synapse/shared";
import type { Lane, WakeSource } from "./types";

/**
 * cost-diet-2 lever 1: MODEL ROUTING ("Save usage: use a faster model for simple messages").
 * OFF by default, per Bot and account-wide (decisions.md). A simple turn runs on Haiku 4.5; everything
 * else, and every doubt, runs on the Bot's own model. The signal is deterministic (no model call):
 *
 *   simple = a message the user typed (or a reaction), short, one line, no attachment, no work cue, not
 *            engineering mode, not right after a turn that did work, and a context the cheap model can
 *            hold. Everything else is hard.
 *
 * Escalation: (1) a routed turn that reaches for any tool other than SendMessage switches to the main model
 * for the rest of that turn, from the PreToolUse hook (Query.setModel; set-model-midturn.cli.integration
 * test), so work is never done by the cheap model; (2) a routed turn that fails before doing anything reruns
 * on the main model; (3) after either, the Bot stays on its own model for STICKY_MS.
 *
 * Cache: models do not share a prompt cache, so a switch writes the cheap model's copy of the context. The
 * simulator (host/bench/compare, "route:always") nets that out: -11% weighted input a month on a casual
 * Sonnet 5 Bot, -25% on Opus 5, 0 on tool-heavy work (nothing routes), with a 10% escalation rate.
 */
export const ROUTED_MODEL = HELPER_MODEL;
/** A typed message longer than this is not "quick chat". */
export const SIMPLE_MAX_CHARS = 280;
/** After a turn that did work (or escalated), follow-ups stay on the main model this long: "yes, do it" is work. */
export const STICKY_MS = 10 * 60_000;
/** The cheap model's window is 200k; route only while the session's context is under this (its tokens). */
export const ROUTE_MAX_CONTEXT = 150_000;

/** Words and shapes that mean "do something", not "talk": a match is never simple. */
const WORK_CUE = new RegExp([
  "```", "`[^`]+`", "https?://", "\\bwww\\.", "\\S+@\\S+\\.\\w+", "(?:^|\\s)[~./][\\w.-]*/", "\\b[\\w-]+\\.(?:ts|tsx|js|py|json|md|csv|pdf|docx?|xlsx?|pptx?|txt|html|yaml|yml|sh)\\b",
  "\\b(?:fix|debug|build|deploy|install|run|execute|write|draft|code|implement|refactor|test|search|look\\s+up|find|research|investigate|analy[sz]e|compare|summari[sz]e|translate|book|schedule|remind|email|mail|send|forward|reply|post|publish|order|buy|pay|create|make|generate|edit|update|change|rename|move|copy|delete|remove|open|download|upload|fetch|check|monitor|track|plan|calculate|convert|set\\s+up|configure|connect|install|browse|click|fill|sign|log\\s+in|remember|forget|cancel|add|list|show\\s+me|tell\\s+\\w+\\s+to)\\b",
  // Live facts need a tool (search, a connector) even when the words are chatty.
  "\\b(?:latest|news|weather|forecast|right\\s+now|today'?s|tonight|stock|prices?|scores?|traffic)\\b",
  "\\b(?:can|could|would|will)\\s+you\\b", "\\bplease\\b", "\\bi\\s+(?:need|want)\\b", "\\bhow\\s+(?:do|can|should)\\s+i\\b",
].join("|"), "i");

export interface RouteTurn {
  source: WakeSource;
  lane: Lane;
  /** The user's text for this turn (all messages it answers). */
  text: string;
  images: number;
}
export type TurnClass = { kind: "simple"; reason: string } | { kind: "hard"; reason: string };

/** The deterministic signal. Pure: no state, no clock. */
export function classifyTurn(t: RouteTurn): TurnClass {
  if (t.source === "reaction") return { kind: "simple", reason: "a reaction" };
  if (t.source !== "user" || t.lane !== "user") return { kind: "hard", reason: `wake: ${t.source}` };
  if (t.images > 0) return { kind: "hard", reason: "an attachment" };
  const text = t.text.trim();
  if (!text) return { kind: "hard", reason: "no text" };
  if (text.length > SIMPLE_MAX_CHARS) return { kind: "hard", reason: "a long message" };
  if (/\n/.test(text)) return { kind: "hard", reason: "several lines" };
  if (WORK_CUE.test(text)) return { kind: "hard", reason: "a work cue" };
  return { kind: "simple", reason: "quick chat" };
}

export interface RouterDeps {
  /** "Save usage" for this Bot: its own switch, else the account's. */
  enabled(botId: string): boolean;
  engineering(botId: string): boolean;
  /** The session's last reported context (the Bot model's tokens); 0 = unknown / fresh. */
  contextTokens(botId: string): number;
  now(): number;
}
export interface RouteDecision { model: string; reason: string }

export class ModelRouter {
  private hardUntil = new Map<string, number>();
  constructor(private d: RouterDeps) {}

  /** The model for this turn, or null = the Bot's own model. */
  decide(botId: string, t: RouteTurn): RouteDecision | null {
    if (!this.d.enabled(botId) || this.d.engineering(botId)) return null;
    if ((this.hardUntil.get(botId) ?? 0) > this.d.now()) return null;
    if (this.d.contextTokens(botId) > ROUTE_MAX_CONTEXT) return null;
    const c = classifyTurn(t);
    return c.kind === "simple" ? { model: ROUTED_MODEL, reason: c.reason } : null;
  }

  /** After every turn: work, an escalation or a failure keeps this Bot on its own model for a while. */
  settled(botId: string, r: { escalated: boolean; failed: boolean; workTools: number }): void {
    if (r.escalated || r.failed || r.workTools > 0) this.hardUntil.set(botId, this.d.now() + STICKY_MS);
  }

  forget(botId: string): void {
    this.hardUntil.delete(botId);
  }
}

/** "Save usage" for a Bot: its own switch, else the account-wide setting (default off). */
export function saveUsageOn(bot: { saveUsage?: boolean }, account: boolean | undefined): boolean {
  return bot.saveUsage ?? !!account;
}
