import { isModelId } from "@synapse/shared";
import type { ConformanceFlags } from "../../brain/conformance/flags";
import type { HostConfig } from "../../config";
import { sdkChildFactory } from "../sdk-child";
import type { CodingGate, Realpaths } from "./policy";
import type { CodingEngine } from "./types";

/**
 * The `claude-code` engine: the Claude Agent SDK driving the Claude Code CLI as the Bot (sdk-child.ts), with the CLI's
 * own preset and tools. A Claude Bot's default; it runs Claude models only. Its canUseTool is the shared coding policy.
 */
export function claudeCodeEngine(o: { cfg: HostConfig; flags(): ConformanceFlags; gate: CodingGate | null; realpaths?: Realpaths }): CodingEngine {
  const child = sdkChildFactory(o);
  return {
    id: "claude-code",
    runs: (model) => isModelId(model),
    start: ({ botId, cwd, model, prompt }) => child({ botId, cwd, model, prompt }),
  };
}
