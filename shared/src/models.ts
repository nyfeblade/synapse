export const MODEL_IDS = ["claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const DEFAULT_BOT_MODEL: ModelId = "claude-sonnet-5";
export const HELPER_MODEL: ModelId = "claude-haiku-4-5-20251001";

const LABELS: Record<ModelId, string> = {
  "claude-sonnet-5": "Sonnet 5",
  "claude-opus-5-5": "Opus 5.5",
  "claude-opus-5": "Opus 5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-fable-5-1": "Fable 5.1",
};

export function isModelId(x: unknown): x is ModelId {
  return typeof x === "string" && (MODEL_IDS as readonly string[]).includes(x);
}

export function modelLabel(id: ModelId): string {
  return LABELS[id];
}

/** ORIG-07 §07.1: W is 200,000 tokens, or 1,000,000 for `[1m]` models. */
export function contextWindow(model: string): number {
  return model.endsWith("[1m]") ? 1_000_000 : 200_000;
}

/**
 * The 1M-context experiment arm, mapped to Claude: Sonnet 5 and Opus 5 spawn with the
 * `[1m]` suffix so the thread can run far past 200k. Haiku / Fable stay on 200k.
 * Profile ids stay unsuffixed; only the spawn / meter path uses this.
 *
 * saving-settings, "Long-context model": `longContext: "when-needed"` spawns standard context until the chat has
 * `escalated` (its context passed LONG_CONTEXT_ESCALATE_TOKENS once; it then stays on [1m] for that chat).
 */
export function spawnModelId(model: string, o: { longContext?: "on" | "when-needed"; escalated?: boolean } = {}): string {
  if (model.endsWith("[1m]")) return model;
  if (!hasLongContextArm(model)) return model;
  return o.longContext === "when-needed" && !o.escalated ? model : `${model}[1m]`;
}

/** The models that have a [1m] spawn arm. */
export function hasLongContextArm(model: string): boolean {
  return model === "claude-sonnet-5" || model === "claude-opus-5" || model === "claude-opus-5-5";
}
