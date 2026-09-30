import type { Surface } from "@synapse/shared";

/** `external`: an outside app over Synapse's MCP server (0.1.4): outside text, never the owner's words. */
export type OriginKind = "user" | "routine" | "peer" | "revival" | "group" | "teach" | "external";
/**
 * I2: what woke the Bot, for the reviewer. The routine's saved prompt is the user's own (trusted);
 * `untrusted` is outside text that arrived with the wake (event payloads, peer or group messages, task reports).
 * For a non-user wake the 1:1 user messages are stale — they are moved here, not shown as the current request.
 */
/** `unread` (bug 432): the outside text that woke the Bot is longer than Auto-review reads, so it can't vouch for the turn. */
export interface ReviewWake { origin: OriginKind; routine: { name: string; saved_prompt: string } | null; untrusted: string[]; stale_user_messages: string[]; unread?: boolean }
export interface RiskTarget { action: string; arguments: Record<string, unknown>; enrichment: { file: string; hash: string; head: string } | null }
/** devFastPath: the S1 lean engineering profile's dev command (static.ts engineeringDevCommand), set by the gate for an engineering-mode Bot only. */
export interface StaticResult { tierHint: 0 | 1 | 2 | 3 | 4; signals: string[]; floorHits: string[]; readOnly: boolean; segments?: number; devFastPath?: boolean }
export interface ReviewContext { user_messages: string[]; assistant_messages: string[]; question_answers: string[]; untrusted_excerpts: string[] }

export interface Verdict {
  decision: "allow" | "block";
  risk_tier: number;
  floor_category: string | null;
  matched_ask_rule_ids: string[];
  matched_allow_rule_ids: string[];
  injection_suspected: boolean;
  confidence: number;
  reason: string;
  proposed_allow_rule: string | null;
}

export type ReviewStage = "guard" | "floor" | "fast" | "exact" | "cache" | "model";

export interface ReviewRequest {
  botId: string;
  botName: string;
  botDescription: string;
  surface: Surface;
  toolName: string;
  target: RiskTarget;
  origin: OriginKind;
  /** I2: the wake block (origin, trusted saved prompt, untrusted wake text). */
  wake?: ReviewWake;
  context: ReviewContext;
  userMessageEpoch: number;
  staticResult: StaticResult;
  fingerprint: string;
  paths: string[];
  /** Bug 410: Full auto's intent check — the host already ruled out deletion, money, bulk, outside content and
   *  non-owner wakes; the reviewer allows a send only when it clearly matches the owner's latest message. */
  fullAutoIntent?: boolean;
  /** Safety v2: the owner's standing guidelines (global and this Bot's), for the reviewer's judgement. */
  guidelines?: string[];
}

export type ReviewOutcome =
  | { kind: "allow"; stage: ReviewStage; verdict: Verdict | null }
  | { kind: "block"; stage: ReviewStage; reason: string; proposedRule: string | null; verdict: Verdict | null }
  | { kind: "error"; message: string }
  | { kind: "degraded"; reason: string };

export interface RuleCard {
  id: string;
  text: string;
  behavior: "allow" | "ask";
  surfaces: string[];
  services: string[];
  verbs: string[];
  targets: { paths: string[]; hosts: string[]; domains: string[]; recipients: string[]; channels: string[]; repos: string[] };
  conditions: string[];
  breadth: "narrow" | "moderate" | "broad";
}
