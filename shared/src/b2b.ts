/** ORIG-09 §09.1–09.5, §4.3. There is deliberately no ack, thanks or fyi kind. */
export const B2B_KINDS = ["request", "question", "blocker", "handoff", "result"] as const;
export type B2BKind = (typeof B2B_KINDS)[number];
export type RequestKind = Exclude<B2BKind, "result">;
export type ResultStatus = "done" | "partial" | "declined" | "failed";

export interface SendToAgentArgs {
  target_id: string;
  kind: B2BKind;
  message: string;           // ≤ 2,000 (bug 432: under what Auto-review reads of a wake)
  expects?: string;          // ≤ 300; required for request, question, handoff
  in_reply_to?: string;      // required for result
  status?: ResultStatus;     // results only; default "done"
  artifacts?: string[];      // ≤ 10
  task_id?: string;          // handoffs
  images?: { url: string; alt?: string }[];
  priority?: boolean;
}

export type RequestState = "open" | "answered" | "expired" | "terminated";
export interface B2BRequest {
  rid: string;
  from: string;
  to: string;
  kind: RequestKind;
  expects: string;
  taskId?: string;
  chainId: string;
  createdAt: number;
  status: RequestState;
  answeredBy?: string;
  answeredAt?: number;
  answerPreview?: string;
}

export type ChainRootKind = "user" | "routine" | "heartbeat" | "system";
export type LoopDetector = "ping_pong" | "repeated_request" | "circular_handoff" | "deadlock" | "chain_too_long" | "budget_exhausted";
export type B2BErrorCode = "b2b_loop_detected" | "b2b_circular_handoff" | "b2b_deadlock" | "b2b_chain_too_long" | "b2b_budget_exhausted";

export interface Chain {
  chainId: string;
  rootKind: ChainRootKind;
  rootBotId: string;
  rootAt: number;
  hops: number;
  peerTurns: number;
  weightedTokens: number;
  costUsd: number;
  lastActivityAt: number;
  groupId?: string;
  ended?: { detector: LoopDetector; at: number };
}

/** ORIG-18 §18.7 `efficiency_week` counters. */
export interface EfficiencyTotals { dropped: number; inboxDelivered: number; resultsBatched: number; coalescedTurns: number; loopsEnded: number }
/** USE-05 tiles: Messages dropped = dropped; Wakes avoided = inbox + batched; Bursts coalesced = coalescedTurns; Loops ended = loopsEnded. */
export interface EfficiencyView { weekStart: number; messagesDropped: number; wakesAvoided: number; burstsCoalesced: number; loopsEnded: number; wakesAvoidedTotal: number }
