import { classifyTool } from "../review/classify";

/** CHAT-23 / ORIG-18 §18.2: what woke a hidden turn (null for user-lane turns). */
export type WakeOrigin =
  | { kind: "agent"; senderIds: string[] }
  | { kind: "routine"; routineId: string; routineName: string; via?: "schedule" | "event" | "manual" | "bot"; caughtUp?: boolean }
  | { kind: "revival"; taskId: string; title: string }
  | { kind: "followup" }
  /** 0.1.4: an outside app asked over Synapse's MCP server; `client` is the name the owner approved. */
  | { kind: "mcp"; client: string };

/** Per-turn Phase 4 context carried on the TurnSlot. */
export interface TurnContext {
  chainId: string | null;                                              // ORIG-09 §09.5
  wake: WakeOrigin | null;                                             // CHAT-23
  group: { groupId: string; roomTurnId: string; epoch: number } | null; // GRP-06 member turn
  routineRun: { routineId: string; runId: string; startedAt: number } | null; // ORIG-02
  rehearsal: boolean;                                                  // ORIG-08 §08.3
  sideEffects: number;                                                 // ORIG-02 §02.7
}

export function emptyContext(): TurnContext {
  return { chainId: null, wake: null, group: null, routineRun: null, rehearsal: false, sideEffects: 0 };
}

/**
 * ORIG-02 §02.7 rule 2: a side-effecting call is one on a reviewed surface (APR-02), any SendMessage,
 * any SendToAgent, or any update_state except memory.
 */
export function countsAsSideEffect(name: string, input: Record<string, unknown>, o: { workspace: string; hostPrivate: string }): boolean {
  if (name === "mcp__bot__SendMessage" || name === "mcp__bot__SendToAgent") return true;
  if (name === "mcp__bot__update_state") return input.target !== "memory";
  // Counting only (not a security decision): Google reads don't count as side effects.
  return classifyTool({ toolName: name, input, toolUseId: "fx" }, { ...o, googleBuiltin: true }).surface !== null;
}
