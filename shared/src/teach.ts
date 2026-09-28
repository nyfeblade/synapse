/** ORIG-08 §08.3 state machine. */
export type TeachState = "IDLE" | "RECORDING" | "PAUSED" | "FINALIZING" | "ANALYZING" | "DRAFTED" | "REHEARSING" | "TESTED" | "NEEDS_FIX" | "ACCEPTED" | "DISCARDED";
export interface TeachStatus {
  state: TeachState;
  botId: string | null;
  sessionId: string | null;
  sessionDir: string | null;
  startedAtMs: number | null;
  elapsedMs: number;
  goal: string | null;
  /** Bug 47: the event sidecar was asked for and failed to start, so only video is being captured. */
  videoOnly?: boolean;
}
