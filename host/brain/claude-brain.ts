import { randomUUID } from "node:crypto";
import type { McpServerConfig, Query, SDKAssistantMessageError, SDKMessage, SDKResultMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { meteredQuery, runUsageOf, type QueryFn } from "../usage/metered-query";
import { LIMITS } from "@synapse/shared";
import type { HostConfig } from "../config";
import { AsyncQueue } from "../util/async-queue";
import { sleep } from "../util/sleep";
import { classifyResult, classifyThrown } from "./errors";
import { EventTranslator } from "./event-translator";
import { isExpectedPostInterruptThrow } from "./interrupt-throw";
import { toSdkCanUseTool, toSdkHooks, toSdkMcpServer, toSdkUserMessage } from "./sdk-wiring";
import { buildBotQueryOptions, systemPromptModeFor } from "./spawn-options";
import { ttft } from "../util/ttft-trace";
import { SEND_TOOL } from "./tool-policy";
import type { BrainWiring, ModelMessage, ProcState, SpawnConfig, SupervisedBrain, TurnEventSink, TurnInput, TurnResult } from "./types";
import { ZERO_USAGE } from "./types";
import { spawnClaudeProcess } from "../claude/spawn";

/** TOOL-13: children get their own built-in tool list and MCP servers (restricted `bot` + `computer`), never the normal per-Bot `["bot"]` set. */
export interface SpawnProfile {
  tools: string[];
  mcpServers(): Record<string, McpServerConfig>;
}

export interface ClaudeBrainDeps {
  botId: string;
  cfg: HostConfig;
  wiring: BrainWiring;
  getSessionId(): string | null;
  setSessionId(id: string): void;
  spawnConfig(): SpawnConfig;
  queryFn?: QueryFn;
  now?: () => number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** Children (TOOL-13): their own built-in tool list and MCP servers (restricted `bot` + `computer`). */
  profile?: SpawnProfile;
}

interface ActiveTurn {
  sink: TurnEventSink;
  resolve(r: TurnResult): void;
  toolCalls: number;
  lastError: SDKAssistantMessageError | null;
  rateLimited: boolean;
  /** The last wait the CLI announced before retrying (api_retry): a rate limit's retry-after. */
  retryAfterMs?: number;
  aborted: boolean;
}

export class ClaudeBrain implements SupervisedBrain {
  procState: ProcState = "cold";
  lastActiveAt = 0;
  lastEventAt = 0;
  turnStartedAt = 0;
  toolInFlight = false;
  pid: number | null = null;
  readonly botId: string;
  private q: Query | null = null;
  /** cost-diet-2 lever 1: the Bot's own model while this turn runs on a routed (cheaper) one; null = not routed. */
  private turnMain: string | null = null;
  private turnEscalated = false;
  private input: AsyncQueue<SDKUserMessage> | null = null;
  private pumpDone: Promise<void> = Promise.resolve();
  private translator = new EventTranslator();
  private turn: ActiveTurn | null = null;
  private spawnKey: string | null = null;
  private model: string | null = null;
  /** Bumped on every start(); lets a stale pump/watchdog recognize it no longer speaks for the live query. */
  private gen = 0;
  /** Set by interrupt() to the generation it interrupted; cleared once pump() consumes it (forgiving
   *  the expected post-interrupt throw) or a new generation starts. Narrows the CT-03 forgiveness in
   *  pump() to "this generation was just interrupted", not "no turn is currently active". */
  private interruptGen: number | null = null;
  private listeners = new Set<(s: ProcState, prev: ProcState) => void>();
  /** The cool() currently tearing this CLI down, if any (ENG-01). Everything that needs the brain to
   *  be quiescent — a second cool(), or a turn admitted mid-transition — awaits this one instead of
   *  acting on a half-torn-down query. */
  private coolInFlight: Promise<void> | null = null;
  private now: () => number;

  constructor(private deps: ClaudeBrainDeps) {
    this.botId = deps.botId;
    this.now = deps.now ?? Date.now;
  }

  get sessionId(): string | null {
    return this.deps.getSessionId();
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

  /** saving-settings: the turn's long-context escalation line (Only when needed), and the newest context a model call reported. */
  private longAt: { from: string; model: string; atTokens: number } | null = null;
  private lastContext = 0;

  /**
   * saving-settings, "Long-context model: Only when needed": once the context reaches the line, the rest of the turn runs
   * on [1m] (Query.setModel from PreToolUse, before the next model call, like the router's escalation). Once per
   * process: the host marks the chat escalated from the same context event, so the next spawn config is [1m] too.
   */
  private async escalateLongContext(): Promise<void> {
    const l = this.longAt;
    if (!l || !this.q || this.model !== l.from || this.lastContext < l.atTokens) return;
    if (this.deps.wiring.flags().modelChange !== "setModel") return; // the next turn respawns on [1m] instead
    try {
      await this.q.setModel(l.model);
      this.model = l.model;
      this.deps.log?.("long context: switched to the 1M-context model", { botId: this.botId, context: this.lastContext });
    } catch (err) {
      this.deps.log?.("long context: could not switch to the 1M-context model", { botId: this.botId, error: String(err) });
    }
  }

  /** Whether the live process is currently set to a voice turn's low effort. */
  private voiceLow = false;
  /**
   * Voice calls: low effort for a spoken turn, as a per-turn flag setting on the live process (the
   * SDK's applyFlagSettings), and the Bot's own effort again for the next turn that isn't. A fresh
   * process starts at the Bot's own effort. Best effort: an SDK without it just runs the turn as is.
   */
  private async applyVoiceEffort(voice: boolean, own: SpawnConfig["effort"]): Promise<void> {
    if (voice === this.voiceLow || !this.q) return;
    const q = this.q as { applyFlagSettings?: (s: { effortLevel: string | null }) => Promise<void> };
    try {
      await q.applyFlagSettings?.({ effortLevel: voice ? "low" : own ?? null });
      this.voiceLow = voice;
      // A top-level effort change re-keys the messages cache, so the next request re-writes the whole history (the
      // cache-rewrites investigation, ~$6/week). Logged so the live cost of switching can be counted; the user's
      // "Call replies" setting decides how often it happens.
      this.deps.log?.("effort switched on the live process (prompt cache: history re-written)", { botId: this.botId, to: voice ? "low" : own ?? "default" });
    } catch { /* keep the Bot's effort */ }
  }

  async runTurn(input: TurnInput, sink: TurnEventSink): Promise<TurnResult> {
    const own = this.deps.spawnConfig();
    // cost-diet-2 lever 1: a routed turn runs on the router's model; a warm process switches with setModel (CT-17),
    // exactly like a profile model change, and the next unrouted turn switches back the same way.
    const sc: SpawnConfig = input.routedModel && !this.deps.profile ? { ...own, model: input.routedModel } : own;
    this.turnMain = sc.model !== own.model ? own.model : null;
    this.turnEscalated = false;
    // saving-settings, Long-context "Only when needed": read at the turn's start like everything else in the spawn config.
    this.longAt = own.longContext ? { from: own.model, ...own.longContext } : null;
    const flags = this.deps.wiring.flags();
    // ENG-01: a turn can be admitted while cool() is still tearing the CLI down — Supervisor.tryAdmit
    // treats only "cold"/"crashed" as not live, and cool()'s await spans the whole CLI exit (up to
    // coolExitMs + coolTermGraceMs). The input queue is already end()ed by then, so pushing the prompt
    // into it would throw and lose the user message (or a peer batch already taken out of its mailbox).
    // Wait the teardown out; the cold branch below then spawns a fresh query on the resumed session.
    if (this.procState === "cooling") await this.coolSettled();
    if (this.procState === "warm_idle" && this.spawnKey !== sc.spawnKey) await this.cool("spawn-time state changed");
    if (this.procState === "warm_idle" && this.model !== sc.model) {
      if (flags.modelChange === "setModel" && this.q) {
        await this.q.setModel(sc.model);
        this.model = sc.model;
      } else await this.cool("model changed");
    }
    // The single invariant every turn depends on: by this line there is a live input queue to push
    // into. A closed or missing queue means the last generation is gone, whatever procState says.
    const spawning = this.procState === "cold" || this.procState === "crashed" || !this.input || this.input.isClosed;
    ttft.mark(this.botId, spawning ? "brain: cold spawn" : "brain: warm reuse", { procState: this.procState });
    if (spawning) this.start(sc);

    // Only awaited when there is something to change: an extra await here opens a race window (ENG-01).
    if ((input.voiceTurn === true) !== this.voiceLow && this.q) await this.applyVoiceEffort(input.voiceTurn === true, sc.effort);

    this.translator.resetTurn();
    this.turnStartedAt = this.now();
    const result = new Promise<TurnResult>((resolve) => {
      this.turn = { sink, resolve, toolCalls: 0, lastError: null, rateLimited: false, aborted: false };
    });
    if (this.procState === "warm_idle") this.setState("running");
    this.input?.push(toSdkUserMessage(input.prompt));

    if (this.procState === "spawning") {
      const g = this.gen;
      void sleep(LIMITS.spawnInitTimeoutMs).then(() => {
        if (g !== this.gen) {
          this.deps.log?.("stale spawn-init watchdog ignored", { botId: this.botId, gen: g, currentGen: this.gen });
          return;
        }
        if (this.procState === "spawning") void this.crash(new Error("timed out waiting for init"), g);
      });
    }
    const r = await result;
    this.lastActiveAt = this.now();
    if (!flags.warmSessions && this.procState === "warm_idle") await this.cool("cold-only mode");
    return r;
  }

  private start(sc: SpawnConfig): void {
    this.setState("spawning");
    const flags = this.deps.wiring.flags();
    const existing = this.deps.getSessionId();
    const newId = existing ? null : randomUUID();
    this.input = new AsyncQueue<SDKUserMessage>();
    const options = buildBotQueryOptions({
      cfg: this.deps.cfg, flags, resumeSessionId: existing, newSessionId: newId, systemAppend: sc.systemAppend, model: sc.model, effort: sc.effort, env: sc.env,
      // BRAIN-03: only a Bot's own session can run the standalone prompt. A child (`profile` set)
      // carries a subagent prompt written as an append, and keeps the preset under it.
      // The spawn config names the Bot's mode (Engineering mode ON = preset); absent, the config default.
      systemPromptMode: this.deps.profile ? "preset" : (sc.systemPromptMode ?? systemPromptModeFor(this.deps.cfg, this.botId)),
      // A child subagent profile brings its own servers; a Bot gets Phase 5's connector/plugin servers plus "bot".
      mcpServers: this.deps.profile ? this.deps.profile.mcpServers() : { ...(sc.mcpServers ?? {}), bot: toSdkMcpServer(this.deps.wiring, sc.upFrontBotTools) },
      botToolNames: this.deps.wiring.botTools().map((t) => t.name), tools: this.deps.profile?.tools,
      hooks: toSdkHooks(this.escalatingWiring()), canUseTool: toSdkCanUseTool(this.deps.wiring),
      abortController: new AbortController(),
      extraDisallowed: sc.extraDisallowed,
      plugins: this.deps.profile ? undefined : sc.plugins,
      skillOverrides: this.deps.profile ? undefined : sc.skillOverrides,
      builtinTools: this.deps.profile ? undefined : sc.builtinTools,
      spawnProcess: (o: SpawnOptions): SpawnedProcess => {
        // Review round 3 (S6): started through the one claude spawn helper, which checks the env it hands the CLI.
        const child = spawnClaudeProcess(o, { onStderr: (line) => this.deps.log?.("claude stderr", { botId: this.botId, line: line.slice(0, 500) }) });
        this.pid = (child as unknown as { pid?: number }).pid ?? null;
        return child;
      },
    });
    const q = meteredQuery({ purpose: "turn", botId: this.botId }, { prompt: this.input, options }, this.deps.queryFn);
    this.q = q;
    this.voiceLow = false; // a fresh process runs at the Bot's own effort
    this.lastContext = 0;
    this.spawnKey = sc.spawnKey;
    this.model = sc.model;
    this.interruptGen = null; // a fresh generation starts with no pending interrupt to forgive
    const g = ++this.gen;
    this.pumpDone = this.pump(q, g);
  }

  /** True while `q`/`g` still identify the live generation — false once a newer start() or a cool()/crash() has moved past it. */
  private isCurrentPump(q: Query, g: number): boolean {
    return g === this.gen && q === this.q;
  }

  private async pump(q: Query, g: number): Promise<void> {
    let settleError: unknown = null;
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (!this.isCurrentPump(q, g)) {
          // A newer generation has already taken over (e.g. cool() gave up on this slow-to-exit
          // process and a subsequent runTurn() spawned again). Stop acting for it entirely: don't
          // touch the live turn/query, and don't keep draining — just log and return.
          this.deps.log?.("stale claude pump message dropped", { botId: this.botId, gen: g, currentGen: this.gen });
          return;
        }
        this.lastEventAt = this.now();
        if (ttft.enabled) {
          const s = m as { type: string; subtype?: string; status?: string; event?: { type?: string } };
          if (s.type === "system" && s.subtype === "init") ttft.mark(this.botId, "CLI init message");
          if (s.type === "system" && s.subtype === "status" && s.status === "requesting") ttft.mark(this.botId, "CLI API request sent (status requesting)");
          if (s.type === "stream_event" && s.event?.type === "message_start") ttft.mark(this.botId, "model first byte (message_start)");
        }
        this.observe(m);
        const events = this.translator.translate(m);
        for (const e of events) {
          if (e.kind === "context") this.lastContext = e.tokens;
          if (e.kind === "session" && e.sessionId && e.sessionId !== this.deps.getSessionId()) this.deps.setSessionId(e.sessionId);
          if (e.kind === "tool_start" && this.turn) this.turn.toolCalls += 1;
          if (e.kind === "tool_start") this.toolInFlight = true;
          if (e.kind === "tool_end") this.toolInFlight = false;
          this.turn?.sink(e);
        }
        if (m.type === "system" && (m as { subtype?: string }).subtype === "init" && this.procState === "spawning") this.setState("running");
        if (m.type === "result") this.finishTurn(m as SDKResultMessage, g);
      }
    } catch (e) {
      settleError = e;
    }
    if (!this.isCurrentPump(q, g)) {
      this.deps.log?.("stale claude pump settled, ignoring", { botId: this.botId, gen: g, currentGen: this.gen, error: settleError ? String(settleError) : undefined });
      return;
    }
    if (this.procState === "cooling") {
      // Expected: cool()/dispose() ended the input or force-closed the query for this same generation.
      this.deps.log?.("claude pump settled during cool", { botId: this.botId, gen: g, error: settleError ? String(settleError) : undefined });
      return;
    }
    if (settleError !== null && this.interruptGen === g && isExpectedPostInterruptThrow(settleError)) {
      // Expected (CT-03): the CLI already delivered its final result normally above (finishTurn()
      // resolved the turn correctly, aborted:true); the SDK then throws this documented shape out of
      // the async iterator. The installed SDK's Query wraps a real `async *` generator — once it
      // throws, it is PERMANENTLY completed (its own catch has already called inputStream.error() +
      // cleanup(), closing the transport), so there is nothing to "forgive and resume". End this
      // query cleanly instead: no crash() call, no crash record, no backoff. The already-resolved
      // turn stays resolved as interrupted; the next runTurn() spawns fresh (with `resume`, same as
      // any other cold -> spawning transition).
      this.endInterruptedQuery(g, settleError);
      return;
    }
    await this.crash(settleError ?? new Error("Claude exited unexpectedly"), g);
  }

  /** CT-03 clean end (not a crash) for the interrupted generation's expected post-interrupt throw. */
  private endInterruptedQuery(g: number, e: unknown): void {
    if (g !== this.gen) return; // defense in depth; the isCurrentPump check above already covers this
    this.interruptGen = null;
    const t = this.turn; // normally already null (finishTurn resolved it above); resolve defensively if not
    this.turn = null;
    this.q?.close();
    this.q = null;
    this.input = null;
    this.pid = null;
    this.toolInFlight = false;
    this.deps.log?.("claude query ended cleanly after interrupt (expected post-interrupt throw)", { botId: this.botId, gen: g, error: String(e) });
    t?.resolve({ ...this.deps.wiring.turnCounters(), aborted: true, quiesced: false, usage: ZERO_USAGE, finalText: this.translator.lastAssistantText, toolCallCount: t.toolCalls, model: this.model });
    this.setState("cold");
  }

  private observe(m: SDKMessage): void {
    const t = this.turn;
    if (!t) return;
    if (m.type === "assistant" && (m as { error?: SDKAssistantMessageError }).error) t.lastError = (m as { error: SDKAssistantMessageError }).error;
    const retry = m as { type: string; subtype?: string; retry_delay_ms?: number };
    if (retry.type === "system" && retry.subtype === "api_retry" && typeof retry.retry_delay_ms === "number") t.retryAfterMs = retry.retry_delay_ms;
    if (m.type === "rate_limit_event" && (m as { rate_limit_info?: { status?: string } }).rate_limit_info?.status === "rejected") t.rateLimited = true;
  }

  private finishTurn(m: SDKResultMessage, g: number): void {
    if (g !== this.gen) return; // defense in depth; pump()'s loop guard already keeps stale generations from reaching here
    const t = this.turn;
    if (!t) return;
    this.turn = null;
    this.toolInFlight = false;
    // The result's total_cost_usd/modelUsage are RUNNING totals for the session; the metered query has
    // already worked out this run's own share (usage/metered-query.ts).
    const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    const usage = runUsageOf(m) ?? {
      inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, costUsd: 0,
    };
    const error = t.aborted ? undefined : classifyResult(m, t.lastError, t.rateLimited, t.retryAfterMs ? { retryAfterMs: t.retryAfterMs } : {});
    this.setState("warm_idle");
    t.resolve({ ...this.deps.wiring.turnCounters(), aborted: t.aborted, quiesced: false, usage, error, finalText: this.translator.lastAssistantText, toolCallCount: t.toolCalls, model: this.model, ...(this.turnEscalated ? { escalated: true } : {}) });
  }

  /**
   * cost-diet-2 lever 1, escalation: the moment a routed turn reaches for any tool but SendMessage, the rest of the
   * turn runs on the Bot's own model (Query.setModel from the PreToolUse hook; the next model call already uses it,
   * set-model-midturn.cli.integration.test.ts). The cheap model only ever answers; it never does the work.
   */
  private escalatingWiring(): BrainWiring {
    const w = this.deps.wiring;
    const wrapped: BrainWiring = Object.create(w) as BrainWiring;
    wrapped.preToolUse = async (call) => {
      if (this.turnMain && !this.turnEscalated && call.toolName !== SEND_TOOL && this.q) {
        this.turnEscalated = true;
        try {
          await this.q.setModel(this.turnMain);
          this.model = this.turnMain;
        } catch (e) {
          this.deps.log?.("routed turn could not switch to the main model", { botId: this.botId, error: String(e) });
        }
      }
      await this.escalateLongContext();
      return w.preToolUse(call);
    };
    return wrapped;
  }

  /** `g` defaults to the live generation so an unguarded caller behaves as before; pump() and the
   *  spawn-init watchdog always pass the generation they were started for, so a crash() call that
   *  arrives after a newer generation has taken over is a no-op — it only ever closes the query
   *  (and resolves the turn) it was called for. */
  private async crash(e: unknown, g: number = this.gen): Promise<void> {
    if (g !== this.gen) {
      this.deps.log?.("stale claude crash ignored", { botId: this.botId, gen: g, currentGen: this.gen });
      return;
    }
    const t = this.turn;
    const idleDeath = t === null && this.procState === "warm_idle";
    this.turn = null;
    this.interruptGen = null;
    this.q?.close();
    this.q = null;
    this.input = null;
    this.pid = null;
    this.toolInFlight = false;
    if (idleDeath) {
      // Review fix round 1: a warm process that dies between turns (OOM-killed, the box's reaper, a CLI self-exit) lost no
      // work: it goes cold, and the next turn spawns fresh with --resume. It is not a crash, so it never counts toward the
      // Supervisor's crash backoff (3 in 10 min would park the Bot for 60 s over processes nobody was using).
      this.deps.log?.("warm claude process exited while idle", { botId: this.botId, gen: g, error: String(e) });
      this.setState("cold");
      return;
    }
    this.setState("crashed");
    t?.resolve({ ...this.deps.wiring.turnCounters(), aborted: false, quiesced: false, usage: ZERO_USAGE, error: classifyThrown(e), finalText: "", toolCallCount: t.toolCalls, model: this.model });
    this.setState("cold");
  }

  pushUserMessage(msg: ModelMessage): void {
    this.input?.push(toSdkUserMessage([msg]));
  }

  async interrupt(_reason: string): Promise<void> {
    if (this.procState !== "running" && this.procState !== "spawning") return;
    if (this.turn) this.turn.aborted = true;
    this.interruptGen = this.gen; // marks this generation as having an interrupt pending (CT-03)
    this.setState("interrupted");
    const q = this.q;
    // ENG-04: Query.interrupt() REJECTS whenever the CLI answers the control request with an error
    // ("control_request_failed") or dies while the request is pending — exactly the states an
    // interrupt is for. A rejection escaping here would skip the cool() fallback below and blow up
    // every caller (Supervisor.tick, TurnRunner.beginDelete, the `void`-called sites), so a failed
    // control request is just "not acknowledged".
    const ack = q
      ? q.interrupt().then(() => true, (e: unknown) => {
        this.deps.log?.("interrupt control request failed", { botId: this.botId, error: String(e) });
        return false;
      })
      : Promise.resolve(false);
    const acked = await Promise.race([ack, sleep(LIMITS.interruptAckMs).then(() => false)]);
    if (!acked || (this.procState as ProcState) === "interrupted") {
      const settled = await Promise.race([new Promise<boolean>((r) => { const check = () => (this.turn === null ? r(true) : setTimeout(check, 20)); check(); }), sleep(LIMITS.interruptAckMs).then(() => false)]);
      if (!settled) await this.cool("interrupt not acknowledged", true);
    }
  }

  /** `force` (interrupt()'s own hard-timeout fallback) closes the transport the instant `coolExitMs`
   *  elapses, same as always — that path has already given up on the turn. Every other call site
   *  (cold-only mode's post-turn teardown, a spawn-time/model change, dispose()) is not forced, and
   *  can be racing a turn that's still genuinely in flight — one the CLI may have already
   *  Stop-hook-approved and billed. Force-closing at the first timeout there can sever the transport
   *  before its trailing SendMessage/result arrives, and the fallback below would then resolve the
   *  turn as `aborted: true` with `usage: ZERO_USAGE`, silently discarding an already-paid reply
   *  (Task 34 Bug 2). So a still-pending, non-forced turn gets the FULL coolExitMs + coolTermGraceMs
   *  window before this ever closes anything. */
  async cool(reason: string, force = false): Promise<void> {
    if (this.procState === "cold") return;
    // ENG-01: a cool() is already tearing this CLI down. Returning here (as this used to) told the
    // caller the brain was quiescent while the transport was still closing, which is how a turn got
    // admitted onto a closed input queue. Await the teardown instead — a forced caller still gets its
    // hard close immediately rather than waiting out the graceful window.
    if (this.coolInFlight) {
      if (force) this.q?.close();
      await this.coolSettled();
      return;
    }
    const p = this.doCool(reason, force);
    this.coolInFlight = p;
    try {
      await p;
    } finally {
      this.coolInFlight = null;
    }
  }

  /** Awaits the in-flight cool() without inheriting its failure: callers only need the brain quiescent. */
  private async coolSettled(): Promise<void> {
    while (this.coolInFlight) await this.coolInFlight.catch(() => {});
  }

  private async doCool(_reason: string, force: boolean): Promise<void> {
    this.setState("cooling");
    const q = this.q;
    this.input?.end();
    let closed = false;
    if (force) { q?.close(); closed = true; }
    const exited = await Promise.race([this.pumpDone.then(() => true), sleep(LIMITS.coolExitMs).then(() => false)]);
    if (!exited) {
      if (!closed && (force || !this.turn)) { q?.close(); closed = true; }
      const exited2 = await Promise.race([this.pumpDone.then(() => true), sleep(LIMITS.coolTermGraceMs).then(() => false)]);
      if (!exited2 && !closed) q?.close();
    }
    const t = this.turn;
    this.turn = null;
    this.interruptGen = null;
    t?.resolve({ ...this.deps.wiring.turnCounters(), aborted: true, quiesced: false, usage: ZERO_USAGE, finalText: this.translator.lastAssistantText, toolCallCount: t.toolCalls, model: this.model });
    this.q = null;
    this.input = null;
    this.pid = null;
    this.setState("cold");
  }

  async dispose(): Promise<void> {
    await this.cool("dispose");
  }
}
