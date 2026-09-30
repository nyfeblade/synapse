import type { EffortLevel, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ZodRawShape } from "zod";
import type { ConformanceFlags } from "./conformance/flags";

export type Lane = "user" | "agent" | "background";
export type WakeSource =
  | "user" | "kickstart" | "reply-nudge" | "closing-nudge" | "ack-redrive" | "approval-resume" | "restart-resume"
  // Phase 2
  | "maintenance" | "reaction" | "widget-answer" | "session-handoff"
  // Phase 3 (EVT-02 #9, #10, #12, #15, #20; SEC-04 answers are wake #2's shape)
  | "subagent-done" | "shell-done" | "shell-notify" | "box-handback" | "secret-provided" | "form-answer" | "disk-saver"
  // Phase 4 (EVT-02): new wake sources #6, #7, #14, #17, #21, #23, group-member #4.
  | "agent" | "agent-error" | "routine" | "group-member" | "listener-connected" | "spend-guard" | "broadcast" | "teach"
  // Phase 5: wakes #22, #11, #13
  | "heartbeat" | "coding-agent" | "mcp-auth"
  // Bug 142: the voice fast path — the Bot's voice on a call handed its full self a task.
  | "voice-delegate"
  // 0.1.4: an outside app asked over Synapse's MCP server (host/mcp-server). Never an owner source.
  | "mcp"
  // 5.7: the user pressed Continue on "Stopped: <Bot> kept failing at <step>".
  | "loop-continue";

/** CHAT-09: images ≤ LIMITS.imageBlockMaxBytes go to the model as image content blocks. */
export interface ImagePart { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; dataBase64: string }
export type ModelMessage = { text: string } | { image: ImagePart };
export function messageText(m: ModelMessage): string {
  return "text" in m ? m.text : "[image]";
}

export interface TurnInput {
  prompt: ModelMessage[];
  hidden: boolean;
  lane: Lane;
  source: WakeSource;
  silenceAllowed: boolean;
  requestId: string;
  systemAppend: string;
  model?: string;
  autoReviewEpoch: "new" | "continue";
  /** cost-diet-2 lever 1: run this turn on this model (a spawn id) instead of the Bot's own. Absent = the Bot's model. */
  routedModel?: string;
  /** Voice calls (and, under "Call replies", every turn of a live call or none): run this turn at low effort (a per-turn setting
   * on the warm process, never a respawn); the next turn without it goes back to the Bot's own. */
  voiceTurn?: true;
}

export type ErrorCode =
  | "BOT-E0401" | "BOT-E0402" | "BOT-E0403" | "BOT-E0404" | "BOT-E0405" | "BOT-E0406" | "BOT-E0407" | "BOT-E0408"
  | "BOT-E0414" | "BOT-E0420" | "BOT-E0421" | "BOT-MODEL";

export interface ClassifiedError { code: ErrorCode; message: string; retryable: boolean; trayTitle: string }

export interface TurnUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number }
export const ZERO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export interface TurnResult {
  sentMessageCount: number;
  reacted: boolean;
  aborted: boolean;
  awaitingUserSelection: boolean;
  endedOnSilentToolCalls: boolean;
  quiesced: boolean;
  usage: TurnUsage;
  error?: ClassifiedError;
  finalText: string;
  toolCallCount: number;
  model: string | null;
  /** cost-diet-2 lever 1: a routed turn reached for a work tool and finished on the Bot's own model. */
  escalated?: boolean;
}

export type TurnEvent =
  /** mcpServers: the CLI's own MCP connection states at init (4.4 connector health), when it reports them. */
  | { kind: "session"; sessionId: string; model: string; tools: string[]; cliVersion: string; mcpServers?: { name: string; status: string }[] }
  | { kind: "dispatched" }
  | { kind: "thinking"; active: boolean }
  | { kind: "text_delta"; text: string }
  | { kind: "tool_start"; toolUseId: string; name: string; input: Record<string, unknown>; messageId: string }
  | { kind: "tool_end"; toolUseId: string; name: string; isError: boolean; output: string }
  | { kind: "send_message_delta"; toolUseId: string; partialJson: string }
  /** resetStream: the streamed reply so far was discarded (a provider stream that failed partway, spec §6). */
  | { kind: "retry"; attempt: number; errorStatus: number | null; resetStream?: true }
  | { kind: "compact_boundary" }
  | { kind: "rate_limit"; status: string; windows: Record<string, { utilization: number | null; resetsAt: number | null }> }
  /** 5.7: this turn's spend so far, in API dollars at list price, cumulative (any brain may emit it; the header meter
   *  and the loop guard read it). The turn's recorded cost in usage.db replaces it when the turn settles. */
  | { kind: "spend"; turnUsd: number }
  | { kind: "context"; tokens: number }; // ORIG-07 §07.1: input + cache read + cache creation of the newest main-thread assistant message
export type TurnEventSink = (e: TurnEvent) => void;

export interface BrainSession {
  botId: string;
  readonly sessionId: string | null;
  runTurn(input: TurnInput, sink: TurnEventSink): Promise<TurnResult>;
  pushUserMessage(msg: ModelMessage): void;
  interrupt(reason: string): Promise<void>;
  dispose(): Promise<void>;
}

export type ProcState = "cold" | "spawning" | "running" | "interrupted" | "warm_idle" | "cooling" | "crashed";

export interface SupervisedBrain extends BrainSession {
  readonly procState: ProcState;
  readonly lastActiveAt: number;
  readonly lastEventAt: number;
  readonly turnStartedAt: number;
  readonly toolInFlight: boolean;
  readonly pid: number | null;
  /** Holds no process (ProviderBrain): not counted toward the supervisor's process caps. Absent = false. */
  readonly processless?: boolean;
  cool(reason: string, force?: boolean): Promise<void>;
  onStateChange(cb: (s: ProcState, prev: ProcState) => void): () => void;
}

export interface ToolCall {
  toolName: string; input: Record<string, unknown>; toolUseId: string; childTaskId?: string;
  /** The CLI's current working directory as its PreToolUse hook reports it: for the built-in Bash, where the command
   *  will run (it follows a `cd` in an earlier call; bash-cwd.cli.integration.test.ts). Absent outside PreToolUse. */
  cwd?: string;
}
export type PreToolDecision =
  | { decision: "allow"; updatedInput?: Record<string, unknown> }
  /** additionalContext: a note for the model beside the denial (bug 198: the user's steering message). */
  | { decision: "deny"; reason: string; additionalContext?: string }
  | { decision: "ask"; reason: string }
  | { decision: "defer"; reason: string };
export type PermissionDecision = { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string };
export interface PostToolOutcome { additionalContext?: string; replaceOutput?: string }
export type StopOutcome = { block: false } | { block: true; reason: string };
/** Token diet (1): after a batch of tool calls, whether the turn ends here with no further model call. */
export interface ToolBatchOutcome { endTurn: boolean }
export interface ToolImage { data: string; mimeType: "image/webp" | "image/png" | "image/jpeg" }
export interface BotToolResult { text: string; isError?: boolean; images?: ToolImage[] }
export interface BotToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  readOnly: boolean;
  handler(args: Record<string, unknown>): Promise<BotToolResult>;
}
export interface TurnCounters { sentMessageCount: number; reacted: boolean; awaitingUserSelection: boolean; endedOnSilentToolCalls: boolean }

export interface BrainWiring {
  preToolUse(call: ToolCall): Promise<PreToolDecision>;
  canUseTool(call: ToolCall, signal: AbortSignal): Promise<PermissionDecision>;
  postToolUse(call: ToolCall, output: string): Promise<PostToolOutcome>;
  stop(info: { lastAssistantText: string; stopHookActive: boolean }): Promise<StopOutcome>;
  /** Token diet (1): called once a batch of tool calls has run (the CLI's PostToolBatch). Absent = never ends a turn early. */
  toolBatch?(calls: ToolCall[]): Promise<ToolBatchOutcome>;
  botTools(): BotToolDef[];
  turnCounters(): TurnCounters;
  flags(): ConformanceFlags;
}

export interface SpawnConfig {
  model: string;
  effort?: EffortLevel;
  systemAppend: string;
  /** Standalone or preset (Engineering mode ON / the box owner's escape hatch); absent = the config default. */
  systemPromptMode?: "preset" | "standalone";
  env: Record<string, string>;
  spawnKey: string;
  mcpServers?: Record<string, McpServerConfig>;
  extraDisallowed?: string[];
  /** Ruling B: managed skills plugin dirs (SDK `plugins`). */
  plugins?: string[];
  /** Lean engineering profile (engineering mode ON only): the "bot" tools that load up front; the rest are deferred. */
  upFrontBotTools?: string[];
  /** Lean engineering profile: per-skill listing overrides (the CLI's skillOverrides setting). */
  skillOverrides?: Record<string, "on" | "name-only" | "user-invocable-only" | "off">;
  /** cost-diet-2 lever 2: the CLI built-ins this Bot gets; absent = BOT_BUILTIN_TOOLS (with Bash). */
  builtinTools?: string[];
  /** saving-settings "Long-context model: Only when needed": set while the Bot runs standard context. Once a model call
   *  reports a context of `atTokens` or more, the live process switches to `model` (the [1m] id) at the turn's next tool
   *  call, before its next model call. Absent = no mid-turn escalation (Long context On, or already escalated). */
  longContext?: { model: string; atTokens: number };
}
