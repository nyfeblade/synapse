import { DEFAULT_BOT_MODEL, STRC, STR_ACP, isModelId, isProviderModelRef, parseAcpModelRef, type AcpVendorId, type BotEngine } from "@synapse/shared";
import type { CodingChild, CodingEngine, CodingEngineId, CodingStart } from "./types";

/** Which engine runs a Bot's coding agent, and on which model; or why none can start. */
export interface CodingChoice { engine: CodingEngineId; model: string }
export type CodingPick = CodingChoice | { refused: string };

/**
 * The engine for a Bot's coding agents (spec §8, owner rule 2026-09-30: no feature requires Claude):
 *  - a provider model ("openai:…", "gemini:…", "ollama:…"): `provider-loop` on that same model;
 *  - a Claude model: the Bot's own engine (2026-09-30): Engine "Synapse" runs `provider-loop` on the same Claude model,
 *    Engine "Claude Code" (and every Bot without one) runs `claude-code`; either needs the Anthropic key the Bot runs on;
 *  - a coding CLI ("acp:cursor"): that vendor's CLI as the engine (`acp:cursor`), once its data-sharing consent is given.
 * A badge or a conformance result never refuses a model: What works and the picker inform, the owner decides. A model
 * that can't take tools at all fails on its first call with a plain reason (brain/provider/errors.ts, noTools).
 */
export function pickCodingEngine(botModel: string | undefined, botEngine: BotEngine | undefined, o: { claudeReady(): boolean; acpConsented?(v: AcpVendorId): boolean }): CodingPick {
  const model = botModel ?? DEFAULT_BOT_MODEL;
  if (isProviderModelRef(model)) return { engine: "provider-loop", model };
  const vendor = parseAcpModelRef(model);
  if (vendor) {
    if (o.acpConsented && !o.acpConsented(vendor)) return { refused: STR_ACP.noConsent(vendor) };
    return { engine: `acp:${vendor}`, model };
  }
  if (isModelId(model)) {
    if (!o.claudeReady()) return { refused: STRC.codingClaudeNoKey };
    return { engine: botEngine === "synapse" ? "provider-loop" : "claude-code", model };
  }
  return { refused: STRC.codingNoModel };
}

/** The engines this host has, by id; an ACP engine is made per vendor on first use. */
export class CodingEngineRegistry {
  private acpMade = new Map<AcpVendorId, CodingEngine>();
  constructor(private e: { claudeCode?: CodingEngine | null; providerLoop?: CodingEngine | null; acp?: ((v: AcpVendorId) => CodingEngine) | null }) {}

  get(id: CodingEngineId): CodingEngine | null {
    if (id === "claude-code") return this.e.claudeCode ?? null;
    if (id === "provider-loop") return this.e.providerLoop ?? null;
    const v = id.slice(4) as AcpVendorId;
    if (!this.e.acp) return null;
    let made = this.acpMade.get(v);
    if (!made) { made = this.e.acp(v); this.acpMade.set(v, made); }
    return made;
  }

  /** Starts the chosen engine; a missing engine, or one that can't run the model, is an error the launch reports. */
  start(choice: CodingChoice, o: CodingStart): CodingChild {
    const engine = this.get(choice.engine);
    if (!engine) throw new Error(`The ${choice.engine} coding engine isn't available on this computer.`);
    if (!engine.runs(choice.model)) throw new Error(`The ${choice.engine} coding engine can't run ${choice.model}.`);
    return engine.start({ ...o, model: choice.model });
  }
}
