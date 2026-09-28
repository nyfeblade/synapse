import { STR5 } from "@synapse/shared";
import type { ReviewerLike } from "../approvals/approval-gate";
import type { ReviewOutcome, ReviewRequest } from "./types";

/** Returns a card reason, "allow" to skip the model, or null to fall through. */
export type ForceAskRule = (req: ReviewRequest) => string | "allow" | null;

export class ForceAskReviewer implements ReviewerLike {
  constructor(private inner: ReviewerLike, private rules: ForceAskRule[]) {}

  async review(req: ReviewRequest): Promise<ReviewOutcome> {
    for (const rule of this.rules) {
      const r = rule(req);
      if (r === "allow") return { kind: "allow", stage: "fast", verdict: null };
      if (r) return { kind: "block", stage: "floor", reason: r, proposedRule: null, verdict: null };
    }
    return this.inner.review(req);
  }

  clearCache(): void {
    this.inner.clearCache();
  }
}

export function pluginInstallRule(hasCommandServer: (catalogId: string) => boolean): ForceAskRule {
  return (req) => {
    if (req.surface !== "control_plane") return null;
    if (req.target.action === "install_local_mcp_server") return STR5.localServerInstall;
    if (req.target.action === "install_plugin") return hasCommandServer(String(req.target.arguments.plugin_id ?? "")) ? STR5.localServerInstall : "allow";
    return null;
  };
}
