import { contextWindow, historyCaps, parseProviderModelRef, type EffortLevel, type HistoryKeep } from "@synapse/shared";
import { loadPrompt } from "../../prompts/index";
import { providerFetch, ProviderCallError } from "../../usage/metered-provider";
import { SPEND_STEP_USD } from "../event-translator";
import { SEND_TOOL } from "../tool-policy";
import type {
  BotToolDef, BrainWiring, ClassifiedError, ModelMessage, ProcState, SupervisedBrain, TurnEvent, TurnEventSink, TurnInput, TurnResult, TurnUsage,
} from "../types";
import { ChatCompletionsAdapter } from "./adapters/chat-completions";
import { quirksFor } from "./adapters/quirks";
import type { CanonMessage, CanonPart, ReasoningEffort } from "./adapters/types";
import { backoffMs, MAX_ATTEMPTS, type ProviderErrorClass } from "./errors";
import { isProviderSessionId, newProviderSessionId, type ProviderSessionStore } from "./session-store";
import { runToolBatch } from "./tool-loop";
import { summarize } from "./compaction";
import { BOT_PREFIX, ToolRegistry } from "./tool-registry";

/**
 * ProviderBrain (spec §2): a Bot's brain on any OpenAI-compatible provider. It implements the same SupervisedBrain as
 * ClaudeBrain and FakeBrain, speaks to the model only through providerFetch (metered, budgeted), runs tools only
 * through ToolLoop (gated), and keeps the conversation in ProviderSessionStore. There is no process: `pid` is null,
 * `cool()` drops the cached history, and it doesn't count toward the supervisor's process caps (`processless`).
 */
export interface ProviderBrainDeps {
  botId: string;
  wiring: BrainWiring;
  store: ProviderSessionStore;
  getSessionId(): string | null;
  /** The Bot's own effort (profile); only sent where the model takes a reasoning effort. */
  effort?(): EffortLevel | undefined;
  /** Whether this model takes a reasoning effort (catalog/conformance, P1b); absent = never sent. */
  reasoning?(ref: string): boolean;
  /** The system prompt for a turn; default: prompts/standalone.md + the turn's systemAppend. */
  systemPrompt?(append: string): string;
  now?: () => number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** Test seam for the retry backoff. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A runaway model can't loop forever: at most this many model calls per turn. */
  maxModelCalls?: number;
  /** A Task subagent (spec P2): its session files live under the parent Bot, and a new session is reported back. */
  storeKey?: string;
  setSessionId?(id: string): void;
  /** How its model calls are metered; default a "turn" of this brain's own Bot (the runner records turns). A child
   *  isn't a runner turn, so it meters as "subagent" for its parent Bot. */
  meter?: { purpose: string; botId: string | null };
  /** Spec §3: the CLI-named built-ins (Read, Write, Edit, WebFetch, TodoWrite, Skill) this Bot gets; absent = none. */
  builtinTools?(): { canonical: string; def: BotToolDef }[];
  /** Spec P2: the Bot's MCP servers' tools (sdk in memory, stdio through the MCP user); absent = none. */
  mcpTools?(): Promise<{ canonical: string; def: BotToolDef; jsonSchema: Record<string, unknown> }[]>;
  /** Compaction (spec §7): the summary instructions (orig/compact.md for this Bot); absent = no mid-turn compaction. */
  compactInstructions?(): string;
  /** The Bot's "History kept" setting, for the mid-turn compaction line. */
  historyKeep?(): HistoryKeep | undefined;
}

const DEFAULT_MAX_MODEL_CALLS = 100;
const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  if (signal.aborted) { res(); return; }
  const t = setTimeout(() => { signal.removeEventListener("abort", done); res(); }, ms);
  const done = () => { clearTimeout(t); res(); };
  signal.addEventListener("abort", done, { once: true });
});

function toParts(prompt: ModelMessage[]): CanonPart[] {
  return prompt.map((m) => ("text" in m ? { type: "text" as const, text: m.text } : { type: "image" as const, mediaType: m.image.mediaType, dataBase64: m.image.dataBase64 }));
}
function effortFor(e: EffortLevel | undefined): ReasoningEffort | undefined {
  if (!e) return undefined;
  return e === "low" ? "low" : e === "medium" ? "medium" : "high";
}
export function defaultSystemPrompt(append: string): string {
  const standalone = loadPrompt("standalone.md").trim();
  return append.trim() ? `${standalone}\n\n${append}` : standalone;
}

export class ProviderBrain implements SupervisedBrain {
  procState: ProcState = "cold";
  lastActiveAt = 0;
  lastEventAt = 0;
  turnStartedAt = 0;
  toolInFlight = false;
  readonly pid = null;
  readonly processless = true;
  readonly botId: string;
  private listeners = new Set<(s: ProcState, prev: ProcState) => void>();
  private abort: AbortController | null = null;
  /** The committed conversation of `historyOf` (dropped on cool). */
  private history: CanonMessage[] | null = null;
  private historyOf: string | null = null;
  private historyVersion = 0;
  private pushed: ModelMessage[] = [];
  private seq = 0;
  private now: () => number;
  /** 5.7: the turn's spend last emitted as a `spend` event (the header meter and the loop guard read it). */
  private spendEmitted = 0;

  private get storeKey(): string { return this.d.storeKey ?? this.botId; }

  constructor(private d: ProviderBrainDeps) {
    this.botId = d.botId;
    this.now = d.now ?? Date.now;
  }

  get sessionId(): string | null {
    const s = this.d.getSessionId();
    return isProviderSessionId(s) ? s : null;
  }

  onStateChange(cb: (s: ProcState, prev: ProcState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private setState(s: ProcState): void {
    const prev = this.procState;
    if (prev === s) return;
    this.procState = s;
    for (const l of this.listeners) l(s, prev);
  }

  pushUserMessage(msg: ModelMessage): void {
    this.pushed.push(msg);
  }

  async interrupt(_reason: string): Promise<void> {
    if (this.procState !== "running") return;
    this.setState("interrupted");
    this.abort?.abort();
  }

  async cool(_reason: string): Promise<void> {
    if (this.procState === "cold") return;
    this.abort?.abort();
    this.setState("cooling");
    this.history = null;
    this.historyOf = null;
    this.setState("cold");
  }

  async dispose(): Promise<void> {
    await this.cool("dispose");
  }

  async runTurn(input: TurnInput, sink: TurnEventSink): Promise<TurnResult> {
    const emit: TurnEventSink = (e: TurnEvent) => { this.lastEventAt = this.now(); sink(e); };
    const own = input.model ?? "";
    const ownRef = parseProviderModelRef(own);
    // cost-diet-2's router picks a Claude helper today; a routed model is only taken on the Bot's own provider (§7a).
    const routed = input.routedModel ? parseProviderModelRef(input.routedModel) : null;
    const ref = routed && ownRef && routed.provider === ownRef.provider ? input.routedModel! : own;
    const parsed = parseProviderModelRef(ref);
    const usage: TurnUsage & { costUsd: number } = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    const counters = () => this.d.wiring.turnCounters();
    if (!parsed) {
      const error: ClassifiedError = { code: "BOT-MODEL", message: `Not a provider model: ${own}`, retryable: false, trayTitle: "Model not available" };
      return { ...counters(), aborted: false, quiesced: false, usage, error, finalText: "", toolCallCount: 0, model: own || null };
    }
    const quirks = quirksFor(parsed.provider);
    const adapter = new ChatCompletionsAdapter(parsed.provider);
    // Past the provider's tool cap the rest are dropped, so SendMessage (the only way the user hears) always comes first.
    const botTools = this.d.wiring.botTools().map((def) => ({ canonical: `${BOT_PREFIX}${def.name}`, def }));
    const registry = new ToolRegistry([
      ...botTools.filter((t) => t.canonical === SEND_TOOL),
      ...(this.d.builtinTools?.() ?? []),
      ...botTools.filter((t) => t.canonical !== SEND_TOOL),
      ...(this.d.mcpTools ? await this.d.mcpTools().catch(() => []) : []),
    ], quirks.schemaDialect, quirks.maxTools);

    // ---- session ----
    let sid = this.d.getSessionId();
    const fresh = !isProviderSessionId(sid);
    if (fresh) { sid = newProviderSessionId(); this.d.setSessionId?.(sid); }
    if (this.procState === "cold" || this.procState === "crashed" || fresh) {
      this.setState("spawning");
      emit({ kind: "session", sessionId: sid!, model: ref, tools: registry.canonicalNames(), cliVersion: `provider:${parsed.provider}` });
    }
    // A compaction outside the turn (the Compactor's compactFn) moved the boundary: reload.
    if (this.historyOf !== sid || this.historyVersion !== this.d.store.version(sid!)) {
      this.history = fresh ? [] : this.d.store.load(this.storeKey, sid!);
      this.historyOf = sid!;
      this.historyVersion = this.d.store.version(sid!);
    }
    let committed = this.history!;
    let working: CanonMessage[] = [...committed];
    const commit = (extra: { model?: string; usage?: Record<string, number> } = {}) => {
      const add = working.slice(committed.length);
      if (!add.length) return;
      this.d.store.append(this.storeKey, sid!, add, extra);
      committed.push(...add);
    };

    this.setState("running");
    this.turnStartedAt = this.now();
    this.spendEmitted = 0;
    const ac = new AbortController();
    this.abort = ac;
    const signal = ac.signal;
    working.push({ role: "user", parts: toParts([...input.prompt, ...this.pushed.splice(0)]) });
    emit({ kind: "dispatched" });

    const system = (this.d.systemPrompt ?? defaultSystemPrompt)(input.systemAppend);
    const effort = input.voiceTurn ? "low" : effortFor(this.d.effort?.());
    const sendEffort = effort && quirks.reasoningParam && this.d.reasoning?.(ref) ? effort : undefined;
    const sleep = this.d.sleep ?? abortableSleep;
    let finalText = "";
    let toolCallCount = 0;
    let error: ClassifiedError | undefined;
    let stopHookActive = false;
    let modelCalls = 0;
    let deferred = false;
    let compactedThisTurn = false;
    // Spec §7: compact before a request would pass the line (the Bot's mid-task history cap, at most 85% of the window).
    const caps = historyCaps(this.d.historyKeep?.(), contextWindow(ref));
    const line = Math.min(caps.hardTokens ?? Number.POSITIVE_INFINITY, Math.floor(0.85 * contextWindow(ref)));

    try {
      for (;;) {
        if (signal.aborted) break;
        if (++modelCalls > (this.d.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS)) {
          this.d.log?.("provider brain: model-call cap reached; ending the turn", { botId: this.botId, calls: modelCalls - 1 });
          break;
        }
        // Steering messages (pushUserMessage) join at the next model-call boundary.
        if (this.pushed.length) working.push({ role: "user", parts: toParts(this.pushed.splice(0)) });
        const encode = () => adapter.encode({
          model: parsed.model, system, messages: working, tools: registry.wireTools(), wireName: (n) => registry.wireName(n),
          ...(sendEffort ? { effort: sendEffort } : {}), cacheKey: this.botId,
        });
        let body = encode();
        if (!compactedThisTurn && this.d.compactInstructions && Math.ceil(JSON.stringify(body).length / 4) > line) {
          compactedThisTurn = true;
          const next = await this.compactMidTurn(sid!, ref, committed, commit, signal, emit);
          if (next) { committed = next; working = [...next]; body = encode(); }
        }
        const call = await this.modelCall(adapter, ref, body, signal, emit, usage, registry, sleep);
        if ("error" in call) {
          error = call.error;
          break;
        }
        if (call.aborted) break;
        const msg = call.message;
        if (msg.finishReason === "content_filter" && !msg.text && !msg.toolCalls.length) {
          error = { code: "BOT-E0407", message: `${quirks.id}'s safety filter stopped this reply.`, retryable: false, trayTitle: "The provider refused" };
          break;
        }
        const toolCalls = msg.toolCalls.map((c) => ({ id: c.id, name: registry.fromWire(c.name)?.canonical ?? c.name, arguments: c.arguments, ...(c.providerMeta !== undefined ? { providerMeta: c.providerMeta } : {}) }));
        working.push({ role: "assistant", text: msg.text, toolCalls, ...(msg.providerMeta !== undefined ? { providerMeta: msg.providerMeta } : {}) });
        if (msg.text) finalText = msg.text;
        const callUsage = call.usage ? { input_tokens: call.usage.inputTokens, output_tokens: call.usage.outputTokens, cache_read_input_tokens: call.usage.cacheReadTokens } : undefined;
        if (!toolCalls.length) {
          commit({ model: ref, ...(callUsage ? { usage: callUsage } : {}) });
          const stop = await this.d.wiring.stop({ lastAssistantText: finalText, stopHookActive });
          if (!stop.block) break;
          stopHookActive = true;
          working.push({ role: "user", parts: [{ type: "text", text: stop.reason }] });
          continue;
        }
        const messageId = `msg_prov_${++this.seq}`;
        const out = await runToolBatch({
          wiring: this.d.wiring, registry, emit, signal,
          abortTurn: () => ac.abort(), setInFlight: (v) => { this.toolInFlight = v; },
        }, msg.toolCalls.map((c) => ({ id: c.id, wireName: c.name, arguments: c.arguments })), messageId);
        toolCallCount += toolCalls.length;
        working.push(...out.results);
        if (out.notes.length) working.push({ role: "user", parts: [{ type: "text", text: out.notes.map((n) => `<system-reminder>\n${n}\n</system-reminder>`).join("\n") }] });
        commit({ model: ref, ...(callUsage ? { usage: callUsage } : {}) });
        if (out.deferred) { deferred = true; break; }
        if (signal.aborted || out.endTurn) break;
      }
    } catch (e) {
      if (!signal.aborted) {
        this.d.log?.("provider brain: turn failed", { botId: this.botId, error: String(e) });
        error = { code: "BOT-E0403", message: e instanceof Error ? e.message : String(e), retryable: false, trayTitle: "Bot failed to respond" };
      }
    }
    // What happened stays in the conversation. The one exception: a retryable failure before anything was done rolls the
    // prompt back, because the turn runner will send it again.
    const nothingDone = toolCallCount === 0 && working.length === committed.length + 1;
    if (!(error?.retryable && nothingDone)) {
      // Drop an unanswered trailing assistant turn only if it is incomplete (never happens: assistants commit with results).
      commit();
    }
    this.lastActiveAt = this.now();
    const aborted = signal.aborted || deferred;
    this.abort = null;
    if (this.procState === "running" || this.procState === "interrupted" || this.procState === "spawning") this.setState("warm_idle");
    return {
      ...counters(), aborted, quiesced: false, usage, ...(error ? { error } : {}), finalText, toolCallCount, model: ref,
      ...(ref !== own ? { escalated: false } : {}),
    };
  }

  /**
   * Mid-turn compaction: everything so far is committed, summarized, and replaced after a compact boundary; the turn
   * continues on the summary. A failure leaves the history as it was (the provider's overflow error then takes the
   * Compactor's path).
   */
  private async compactMidTurn(
    sid: string, ref: string, committed: CanonMessage[], commit: () => void, signal: AbortSignal, emit: TurnEventSink,
  ): Promise<CanonMessage[] | null> {
    commit();
    try {
      // The messages the model hasn't answered yet (this turn's prompt, steering) stay as they are, after the summary.
      let cut = committed.length;
      while (cut > 0 && committed[cut - 1]!.role === "user") cut--;
      const summary = await summarize({ botId: this.botId, ref, history: committed.slice(0, cut), instructions: this.d.compactInstructions!(), signal });
      if (!summary || signal.aborted) return null;
      const replacement = [...summary, ...committed.slice(cut)];
      this.d.store.appendBoundary(this.storeKey, sid);
      this.d.store.append(this.storeKey, sid, replacement);
      this.history = [...replacement];
      this.historyVersion = this.d.store.version(sid);
      emit({ kind: "compact_boundary" });
      return this.history;
    } catch (e) {
      this.d.log?.("provider brain: mid-turn compaction failed; continuing", { botId: this.botId, error: String(e) });
      return null;
    }
  }

  /** One model call with the in-loop retries (spec §6). A stream that fails partway is discarded whole and retried. */
  private async modelCall(
    adapter: ChatCompletionsAdapter, ref: string, body: Record<string, unknown>, signal: AbortSignal, emit: TurnEventSink,
    usage: TurnUsage & { costUsd: number }, registry: ToolRegistry, sleep: (ms: number, s: AbortSignal) => Promise<void>,
  ): Promise<{ error: ClassifiedError } | { aborted: true } | { aborted: false; message: ReturnType<ReturnType<ChatCompletionsAdapter["decoder"]>["finish"]>; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null }> {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return { aborted: true };
      const decoder = adapter.decoder();
      let callUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; promptTokens: number } | null = null;
      emit({ kind: "thinking", active: true });
      let thinking = true;
      const endThinking = () => { if (thinking) { thinking = false; emit({ kind: "thinking", active: false }); } };
      try {
        const stream = await providerFetch(this.d.meter ?? { purpose: "turn", botId: this.botId }, adapter, {
          ref, body, signal,
          onUsage: (u) => {
            usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.cacheReadTokens += u.cacheReadTokens;
            usage.cacheWriteTokens += u.cacheWriteTokens; usage.costUsd = Math.round((usage.costUsd + u.costUsd) * 1e10) / 1e10;
            callUsage = u;
            // 5.7 (0.1.6): the same cumulative `spend` event the Claude brain emits, from this call's metered cost, so the
            // live spend meter and the loop guard's "what the loop cost" cover provider Bots too.
            if (usage.costUsd - this.spendEmitted >= SPEND_STEP_USD) {
              this.spendEmitted = usage.costUsd;
              emit({ kind: "spend", turnUsd: Math.round(usage.costUsd * 1e6) / 1e6 });
            }
          },
        });
        const sends = new Map<number, { id?: string; send: boolean }>();
        for await (const chunk of stream.chunks) {
          for (const ev of decoder.push(chunk)) {
            if (ev.kind === "text") { endThinking(); emit({ kind: "text_delta", text: ev.delta }); }
            else if (ev.kind === "reasoning") { /* thinking stays active */ }
            else if (ev.kind === "tool_delta") {
              endThinking();
              const s = sends.get(ev.index) ?? { send: false };
              if (ev.id) s.id = ev.id;
              if (ev.name) s.send = registry.fromWire(ev.name)?.canonical === SEND_TOOL;
              sends.set(ev.index, s);
              // CT-01's equivalent: the reply streams to the typing indicator as the model writes SendMessage's arguments.
              if (s.send && s.id && ev.delta) emit({ kind: "send_message_delta", toolUseId: s.id, partialJson: ev.delta });
            }
          }
        }
        endThinking();
        const message = decoder.finish();
        const u = callUsage as { promptTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
        if (u && u.promptTokens) emit({ kind: "context", tokens: u.promptTokens });
        return { aborted: false, message, usage: u };
      } catch (e) {
        endThinking();
        if (signal.aborted) return { aborted: true };
        const cls: ProviderErrorClass = e instanceof ProviderCallError ? e.cls
          : { code: "BOT-E0403", message: e instanceof Error ? e.message : String(e), retryable: true, trayTitle: "Bot failed to respond", inLoopRetry: true };
        if (!cls.inLoopRetry || attempt + 1 >= MAX_ATTEMPTS) {
          const { inLoopRetry: _i, retryAfterMs: _r, ...err } = cls;
          return { error: err };
        }
        emit({ kind: "retry", attempt: attempt + 1, errorStatus: e instanceof ProviderCallError ? e.status : null, resetStream: true });
        await sleep(backoffMs(attempt, cls.retryAfterMs), signal);
      }
    }
  }
}
