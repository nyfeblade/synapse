import { isAcpModelRef, isClaudeModel, isProviderModelRef, type BotEngine } from "@synapse/shared";
import { isAcpSessionId } from "./acp/acp-sessions";
import type { ModelMessage, ProcState, SupervisedBrain, TurnEventSink, TurnInput, TurnResult } from "./types";
import { isProviderSessionId } from "./provider/session-store";

/**
 * BrainSwitch (spec §2): a Bot's one SupervisedBrain, which runs each turn on the Claude brain or the provider brain
 * according to the Bot's model. A Claude model ("claude-sonnet-5") keeps today's brain exactly; a provider ref
 * ("openai:gpt-…") runs on ProviderBrain.
 *
 * When the kind changes it cools the old brain, clears the session id (a Claude session can't be resumed by a provider
 * or the other way round) and puts the restore block (context/restore.ts) in front of the first turn on the new brain.
 * The switch is read from the stored session id as well, so it holds across a host restart.
 */
export type BrainKind = "claude" | "provider" | "acp";
/**
 * A Claude model runs on the Claude Code CLI ("claude") unless the Bot's engine is "synapse" (2026-09-30): then it runs
 * on Synapse's own loop, ProviderBrain on the Messages API, like any other provider's model.
 */
export function brainKindOf(model: string | undefined, engine?: BotEngine): BrainKind {
  if (isAcpModelRef(model)) return "acp";
  if (isProviderModelRef(model)) return "provider";
  return engine === "synapse" && (model === undefined || isClaudeModel(model.replace(/\[1m\]$/, ""))) ? "provider" : "claude";
}
/** Which brain a stored session id belongs to (prov-acp-… before prov-…). */
export function sessionKindOf(sid: string): BrainKind {
  return isAcpSessionId(sid) ? "acp" : isProviderSessionId(sid) ? "provider" : "claude";
}

export interface BrainSwitchDeps {
  botId: string;
  /** The Bot's model now (the turn's own `model` wins when set). */
  model(): string;
  /** The Bot's engine for Claude models; absent = the Claude Code CLI (every Bot before 2026-09-30). */
  engine?(): BotEngine;
  claude(): SupervisedBrain;
  provider(): SupervisedBrain;
  /** Wave 3: a vendor's own coding CLI over ACP (acp:<vendor>). Absent = such a model fails the turn. */
  acp?(): SupervisedBrain;
  getSessionId(): string | null;
  clearSessionId(): void;
  /** The restore block for the first turn on a new brain. */
  restoreBlock(): string;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}

export class BrainSwitch implements SupervisedBrain {
  readonly botId: string;
  private inner: Partial<Record<BrainKind, SupervisedBrain>> = {};
  private kind: BrainKind;
  private listeners = new Set<(s: ProcState, prev: ProcState) => void>();

  constructor(private d: BrainSwitchDeps) {
    this.botId = d.botId;
    this.kind = brainKindOf(d.model(), d.engine?.());
  }

  /** The brain that runs the current kind (built on first use). */
  private brain(kind: BrainKind = this.kind): SupervisedBrain {
    let b = this.inner[kind];
    if (!b) {
      if (kind === "acp" && !this.d.acp) throw new Error("no coding CLI brain is wired");
      b = kind === "provider" ? this.d.provider() : kind === "acp" ? this.d.acp!() : this.d.claude();
      b.onStateChange((s, prev) => { if (this.inner[this.kind] === b) for (const l of this.listeners) l(s, prev); });
      this.inner[kind] = b;
    }
    return b;
  }
  get active(): BrainKind { return this.kind; }

  get sessionId(): string | null { return this.brain().sessionId; }
  get procState(): ProcState { return this.inner[this.kind]?.procState ?? "cold"; }
  get lastActiveAt(): number { return this.inner[this.kind]?.lastActiveAt ?? 0; }
  get lastEventAt(): number { return this.inner[this.kind]?.lastEventAt ?? 0; }
  get turnStartedAt(): number { return this.inner[this.kind]?.turnStartedAt ?? 0; }
  get toolInFlight(): boolean { return this.inner[this.kind]?.toolInFlight ?? false; }
  get pid(): number | null { return this.inner[this.kind]?.pid ?? null; }
  get processless(): boolean { return this.inner[this.kind]?.processless === true; }

  onStateChange(cb: (s: ProcState, prev: ProcState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async runTurn(input: TurnInput, sink: TurnEventSink): Promise<TurnResult> {
    const want = brainKindOf(input.model ?? this.d.model(), this.d.engine?.());
    const sid = this.d.getSessionId();
    // A stored session of the other kind is a switch too (e.g. the model changed while the host was down).
    const mismatched = sid !== null && sessionKindOf(sid) !== want;
    let prompt = input.prompt;
    if (want !== this.kind || mismatched) {
      const from = this.kind;
      const old = this.inner[from];
      const prevState = this.procState;
      if (old && want !== from) await old.cool("brain kind changed");
      this.kind = want;
      if (sid !== null) this.d.clearSessionId();
      this.d.log?.("brain switch: the Bot's model moved to another brain; a new conversation starts with the restore block", { botId: this.botId, from, to: want });
      prompt = [{ text: this.d.restoreBlock() }, ...prompt];
      const now = this.procState;
      if (now !== prevState) for (const l of this.listeners) l(now, prevState);
    }
    return this.brain().runTurn(prompt === input.prompt ? input : { ...input, prompt }, sink);
  }

  pushUserMessage(msg: ModelMessage): void { this.brain().pushUserMessage(msg); }
  async interrupt(reason: string): Promise<void> { await this.inner[this.kind]?.interrupt(reason); }

  async cool(reason: string, force?: boolean): Promise<void> {
    for (const b of Object.values(this.inner)) await b.cool(reason, force);
  }

  async dispose(): Promise<void> {
    for (const b of Object.values(this.inner)) await b.dispose();
  }
}
