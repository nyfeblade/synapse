import type { AcpVendorId } from "@synapse/shared";

/**
 * Coding engines (spec 2026-09-29 §8): what runs a Bot's coding agent. Every engine is started the same way, emits the
 * same stream, and is held to the same safety path: commands through the Bot's approval gate (gateForCoding), writes
 * only inside the worktree by real path (realInside), host-private data never touched (engines/policy.ts).
 *
 *  - `claude-code`: the Claude Agent SDK / Claude Code CLI (a Claude Bot's default).
 *  - `provider-loop`: Synapse's own tool loop (ProviderBrain) on the Bot's own model: any provider, or Claude.
 *  - `acp:<vendor>`: a vendor's coding CLI (Cursor, GitHub Copilot, Kimi Code, …) over the Agent Client Protocol on the
 *    owner's own subscription, every permission it asks answered by the same gate (AcpBrain).
 */
export type CodingEngineId = "claude-code" | "provider-loop" | `acp:${AcpVendorId}`;


/**
 * What a coding child emits. Every message is appended to the agent's transcript as it is; a `result` settles the agent
 * (`subtype` "success" is done, anything else an error), with the run's usage when the engine meters none itself.
 * The claude-code engine passes the SDK's own messages through (its `result` has this shape); the others emit
 * `progress` lines (a tool call, its outcome, the model's text) and one `result`.
 */
export type CodingMessage = { type: string; [k: string]: unknown };
export interface CodingResultMessage { type: "result"; subtype: "success" | "error"; result: string; engine: CodingEngineId; model: string }

export interface CodingChild {
  /** A message for the agent (a reply, the time-up nudge): it joins at the next step. */
  push(text: string): void;
  /** Stops the current step; the agent waits for the next message. */
  interrupt(): Promise<void>;
  /** Ends the agent for good (cancel, finish): nothing more is emitted. */
  close(): void;
  messages: AsyncIterable<CodingMessage>;
  /** The engine's own session id, once it has one (provider-loop, ACP); for resuming it later. */
  sessionId?(): string | null;
}

export interface CodingStart {
  botId: string;
  /** The agent's own id (its session, its loop guard, its Shell's working folder). */
  agentId: string;
  /** The worktree: the agent's current folder, the only place it may write. */
  cwd: string;
  /** The model the engine runs: a Claude id, a provider ref ("openai:…") or a coding CLI ref ("acp:cursor"). */
  model: string;
  /** The task, already in the coding-agent prompt (orig/coding-agent.md). */
  prompt: string;
  /** Continue this earlier session of the same engine (the coding bench's follow-up tasks); absent = a fresh one. */
  resumeSessionId?: string;
}

export interface CodingEngine {
  readonly id: CodingEngineId;
  /** Whether this engine can run this model at all. */
  runs(model: string): boolean;
  start(o: CodingStart): CodingChild;
}
