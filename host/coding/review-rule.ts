import type { ReviewRequest } from "../review/types";

/** TOOL-20: destructive lifecycle actions need confirm:true and always ask (a ForceAskRule, Task 12). */
export const codingAgentRule = (req: ReviewRequest): string | "allow" | null =>
  req.surface === "cloud_agent" && (req.target.action === "coding_agent_cancel" || req.target.action === "coding_agent_delete")
    ? "Stopping or deleting a coding agent can lose its work, so it needs your confirmation."
    : null;
