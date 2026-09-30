import { createHash } from "node:crypto";
import path from "node:path";
import {
  ACP_PROTOCOL_VERSION, STR_ACP, acpTouchesVendorDir, parseAcpModelRef, type AcpVendorId,
} from "@synapse/shared";
import { SEND_TOOL } from "../tool-policy";
import type {
  BotToolDef, BrainWiring, ClassifiedError, ModelMessage, PermissionDecision, ProcState, SupervisedBrain, ToolCall, TurnEvent, TurnEventSink, TurnInput, TurnResult,
} from "../types";
import type { CanonMessage } from "../provider/adapters/types";
import type { ProviderSessionStore } from "../provider/session-store";
import { runToolBatch } from "../provider/tool-loop";
import { BOT_PREFIX, ToolRegistry } from "../provider/tool-registry";
import type { BotFileRunner } from "../../walls/bot-file";
import { ACP_SESSION_PREFIX, isAcpSessionId, type AcpSessionMap } from "./acp-sessions";
import { JsonRpcPeer, RPC, RpcError } from "./jsonrpc";
import { displayOf, gateCallsFor, pickOutcome, shq, type AcpToolCall, type GateCall } from "./permission";
import { AcpNotAvailable, type AcpProcess, type AcpSpawn } from "./spawn";

/**
 * AcpBrain (Wave 3, battle plan 3.3): a Bot whose brain is a vendor's own coding CLI (GitHub Copilot, Cursor, Kimi Code,
 * Mistral Vibe), signed in with the user's own subscription and driven over the Agent Client Protocol.
 *
 * Safety model — the vendor agent never gets around Synapse:
 *  - It runs as the Bot's own uid in the Bot's own home (spawn.ts → bot-acp-as-box); the kernel walls apply to it.
 *  - Every `session/request_permission` is answered ONLY by the Bot's approval gate (wiring.preToolUse, then
 *    canUseTool on "ask"): the floor rules, walls, the reviewer and the card, exactly as for every other tool call.
 *    A kind Synapse can't map is denied. An allow is always "allow_once", never "allow_always".
 *  - The file system and terminal the client offers go through Synapse's own walled tools: fs reads and writes through
 *    the gate plus `bot-file` (as the Bot), terminals through the gate plus the Bot's Shell tool (ToolLoop).
 *  - Any other request from the agent (elicitation, MCP tunnels, extensions, anything new) is refused.
 *  - The vendor keeps its own login in the Bot's home. This brain never reads it, and no environment carries it.
 *
 * Metering: a vendor plan reports no per-token cost, so a turn records zero tokens and $0 with its duration (the turn
 * runner's usage row); budgets are unaffected.
 *
 * The reply: the agent's last message becomes the Bot's SendMessage, sent through ToolLoop like any other call, and
 * streams to the typing indicator as it is written. The conversation's text is mirrored in the Bot's provider-style
 * session file (prov-acp-…), so history search and handoffs keep working.
 */
export interface AcpBrainDeps {
  botId: string;
  wiring: BrainWiring;
  spawn: AcpSpawn;
  /** The conversation's text mirror (spec §7 files, prefix prov-acp-). */
  store: ProviderSessionStore;
  sessions: AcpSessionMap;
  getSessionId(): string | null;
  setSessionId(id: string): void;
  /** The Bot's model now (the turn's own `model` wins). */
  model(): string;
  /** Where the agent's session works: the Bot's own folder. */
  cwd(): string;
  /** bot-file as the Bot on the box, same-uid behind walls elsewhere. */
  files: BotFileRunner;
  /** A short note on who the Bot is (name, the user's standing instructions, time zone) for the start of a vendor
   *  session. Not the Claude prompt: that one's rules (SendMessage, Synapse's tools) don't fit a vendor CLI. */
  preamble?(): string;
  /** The Bot's own home (where the vendor keeps its login and settings); null before per-Bot accounts. */
  home?(): string | null;
  /** The one-time data-sharing consent for this vendor. */
  consented(v: AcpVendorId): boolean;
  newId(): string;
  now?: () => number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** Test seams. */
  timeouts?: { startMs?: number; cancelGraceMs?: number };
}

const DEFAULT_START_MS = 60_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
const MAX_STOP_ROUNDS = 3;
const MAX_TERMINAL_OUTPUT = 1024 * 1024;
const TERMINAL_BLOCK_MS = 600_000;
const RECAP_CHARS = 8_000;
const VENDOR_DIR_DENIED = "That folder holds the coding CLI's own sign-in and settings; it can't be used from here.";
/** bot-file's longest line before it cuts one (LINE_MAX there). */
const LINE_CAP = 2_000;

interface Terminal { output: string; truncated: boolean; limit: number; exit: { exitCode: number | null; signal: string | null } | null; done: Promise<void>; ac: AbortController }
interface Turn {
  emit: TurnEventSink;
  ac: AbortController;
  /** The agent's reply so far (text after its last tool call). */
  text: string;
  sendId: string;
  streamed: boolean;
  calls: Map<string, AcpToolCall>;
  started: Set<string>;
  deferred: boolean;
  toolCallCount: number;
  /** Gate allows from a permission request, spent by the fs/terminal request that carries them out (no second card). */
  allowedOnce: string[];
}

const onceKey = (c: GateCall) => `${c.toolName}\u0000${String(c.input.command ?? c.input.file_path ?? "")}`;
const textOf = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "content") return textOf(o.content);
    if (o.type === "text" && typeof o.text === "string") return o.text;
    if (o.type === "diff" && typeof o.path === "string") return `(edited ${o.path})`;
  }
  return "";
};

export class AcpBrain implements SupervisedBrain {
  procState: ProcState = "cold";
  lastActiveAt = 0;
  lastEventAt = 0;
  turnStartedAt = 0;
  toolInFlight = false;
  readonly botId: string;
  private listeners = new Set<(s: ProcState, prev: ProcState) => void>();
  private proc: AcpProcess | null = null;
  private peer: JsonRpcPeer | null = null;
  private vendor: AcpVendorId | null = null;
  private caps: { loadSession: boolean; image: boolean } = { loadSession: false, image: false };
  private vendorSid: string | null = null;
  private sidOf: string | null = null;
  private turn: Turn | null = null;
  private pushed: ModelMessage[] = [];
  private terminals = new Map<string, Terminal>();
  private termSeq = 0;
  private stderrTail = "";
  private pendingPreamble = false;
  private now: () => number;

  constructor(private d: AcpBrainDeps) {
    this.botId = d.botId;
    this.now = d.now ?? Date.now;
  }

  get pid(): number | null { return this.proc?.pid ?? null; }
  get sessionId(): string | null {
    const s = this.d.getSessionId();
    return isAcpSessionId(s) ? s : null;
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

  pushUserMessage(msg: ModelMessage): void { this.pushed.push(msg); }

  async interrupt(_reason: string): Promise<void> {
    if (this.procState !== "running" || !this.turn) return;
    this.setState("interrupted");
    this.turn.ac.abort();
    if (this.peer && this.vendorSid) this.peer.notify("session/cancel", { sessionId: this.vendorSid });
    for (const t of this.terminals.values()) t.ac.abort();
    // An agent that doesn't end the prompt after a cancel is stopped.
    const turn = this.turn;
    const grace = setTimeout(() => { if (this.turn === turn) this.stop("the coding CLI didn't stop after a cancel"); }, this.d.timeouts?.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    grace.unref?.();
  }

  async cool(_reason: string): Promise<void> {
    if (this.procState === "cold") return;
    this.setState("cooling");
    this.stop("cooled");
    this.setState("cold");
  }
  async dispose(): Promise<void> { await this.cool("dispose"); }

  private stop(reason: string): void {
    this.turn?.ac.abort();
    for (const t of this.terminals.values()) t.ac.abort();
    this.terminals.clear();
    const p = this.proc;
    this.peer?.close(new Error(reason));
    this.peer = null;
    this.proc = null;
    this.vendorSid = null;
    this.sidOf = null;
    if (p) {
      p.kill("SIGTERM");
      const k = setTimeout(() => p.kill("SIGKILL"), 3_000);
      k.unref?.();
    }
  }

  // ---------------------------------------------------------------- the turn

  async runTurn(input: TurnInput, sink: TurnEventSink): Promise<TurnResult> {
    const emit: TurnEventSink = (e: TurnEvent) => { this.lastEventAt = this.now(); sink(e); };
    const ref = input.model ?? this.d.model();
    const vendor = parseAcpModelRef(ref);
    const counters = () => this.d.wiring.turnCounters();
    const result = (o: { error?: ClassifiedError; aborted?: boolean; finalText?: string; toolCallCount?: number }): TurnResult => ({
      ...counters(), aborted: o.aborted ?? false, quiesced: false, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      ...(o.error ? { error: o.error } : {}), finalText: o.finalText ?? "", toolCallCount: o.toolCallCount ?? 0, model: ref || null,
    });
    if (!vendor) return result({ error: { code: "BOT-MODEL", message: `Not a coding CLI model: ${ref}`, retryable: false, trayTitle: "Model not available" } });
    // Spec §4 (defense in depth; the gateway already refuses the model without it).
    if (!this.d.consented(vendor)) return result({ error: { code: "BOT-E0421", message: STR_ACP.noConsent(vendor), retryable: false, trayTitle: STR_ACP.noConsentTitle } });

    this.turnStartedAt = this.now();
    const started = await this.ensureSession(vendor, emit);
    if ("error" in started) {
      this.lastActiveAt = this.now();
      this.setState(this.proc ? "warm_idle" : "cold");
      return result({ error: started.error });
    }
    const sid = started.sid;

    const ac = new AbortController();
    const turn: Turn = { emit, ac, text: "", sendId: `acp_send_${this.d.newId()}`, streamed: false, calls: new Map(), started: new Set(), deferred: false, toolCallCount: 0, allowedOnce: [] };
    this.turn = turn;
    this.setState("running");
    emit({ kind: "dispatched" });

    const prompts = [...input.prompt, ...this.pushed.splice(0)];
    const userText = prompts.map((m) => ("text" in m ? m.text : "[image]")).join("\n");
    let blocks = this.blocksFor(prompts, sid);
    let finalText = "";
    let error: ClassifiedError | undefined;
    let stopHookActive = false;
    try {
      for (let round = 0; ; round++) {
        emit({ kind: "thinking", active: true });
        let res: { stopReason?: unknown };
        try {
          res = await this.peer!.request<{ stopReason?: unknown }>("session/prompt", { sessionId: this.vendorSid, prompt: blocks });
        } finally {
          emit({ kind: "thinking", active: false });
        }
        if (ac.signal.aborted || turn.deferred) break;
        const stop = String(res?.stopReason ?? "end_turn");
        if (stop === "cancelled") break;
        if (stop === "refusal") { error = { code: "BOT-E0407", message: STR_ACP.refused(vendor), retryable: false, trayTitle: STR_ACP.refusedTitle }; break; }
        // Each round's last message is the Bot's reply, sent before the stop hook looks (it checks a reply was sent).
        const text = turn.text.trim();
        if (text) {
          finalText = text;
          await this.sendReply(turn, text);
          if (ac.signal.aborted || turn.deferred) break;
        }
        turn.text = "";
        turn.streamed = false;
        turn.sendId = `acp_send_${this.d.newId()}`;
        if (this.pushed.length) { blocks = this.blocksFor(this.pushed.splice(0), sid); continue; }
        if (round + 1 >= MAX_STOP_ROUNDS) break;
        const s = await this.d.wiring.stop({ lastAssistantText: finalText, stopHookActive });
        if (!s.block) break;
        stopHookActive = true;
        blocks = [{ type: "text", text: s.reason }];
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        const died = this.peer === null || this.peer.closed;
        this.d.log?.("acp brain: turn failed", { botId: this.botId, vendor, error: String(e), stderr: this.stderrTail.slice(-400) });
        error = e instanceof RpcError && e.code === RPC.authRequired
          ? { code: "BOT-E0421", message: STR_ACP.needsSignIn(vendor), retryable: false, trayTitle: STR_ACP.needsSignInTitle }
          : { code: "BOT-E0403", message: died ? STR_ACP.stopped(vendor) : (e instanceof Error ? e.message : String(e)), retryable: false, trayTitle: STR_ACP.stoppedTitle };
        if (died) this.stop("the coding CLI stopped");
      }
    } finally {
      this.turn = null;
      for (const [id, t] of this.terminals) { t.ac.abort(); this.terminals.delete(id); }
    }
    // The text mirror: what the user asked and what the Bot answered (tool traffic stays with the vendor's session).
    const mirror: CanonMessage[] = [{ role: "user", parts: [{ type: "text", text: userText }] }];
    if (finalText) mirror.push({ role: "assistant", text: finalText, toolCalls: [] });
    try { this.d.store.append(this.botId, sid, mirror, { model: ref }); } catch (e) { this.d.log?.("acp brain: mirror write failed", { botId: this.botId, error: String(e) }); }

    this.lastActiveAt = this.now();
    const aborted = ac.signal.aborted || turn.deferred;
    if (this.proc) this.setState("warm_idle");
    else this.setState(error ? "crashed" : "cold");
    return result({ ...(error ? { error } : {}), aborted, finalText, toolCallCount: turn.toolCallCount });
  }

  private blocksFor(prompts: ModelMessage[], sid: string): Record<string, unknown>[] {
    const blocks: Record<string, unknown>[] = [];
    if (this.pendingPreamble) {
      this.pendingPreamble = false;
      const recap = this.recap(sid);
      const note = [
        (this.d.preamble?.() ?? "").trim(),
        "You are running as a Synapse Bot. Your last message in each turn is sent to the user as your reply; keep it to what they need.",
        recap ? `The conversation so far (most recent last):\n${recap}` : "",
      ].filter(Boolean).join("\n\n");
      blocks.push({ type: "text", text: `<system-reminder>\n${note}\n</system-reminder>` });
    }
    for (const m of prompts) {
      if ("text" in m) blocks.push({ type: "text", text: m.text });
      else if (this.caps.image) blocks.push({ type: "image", mimeType: m.image.mediaType, data: m.image.dataBase64 });
      else blocks.push({ type: "text", text: "[an image the user sent; this coding CLI can't read images]" });
    }
    return blocks;
  }

  /** On a new vendor session for a conversation that already has history: its last messages, as text. */
  private recap(sid: string): string {
    let hist: CanonMessage[] = [];
    try { hist = this.d.store.load(this.botId, sid); } catch { return ""; }
    const lines: string[] = [];
    for (const m of hist) {
      if (m.role === "user") lines.push(`User: ${m.parts.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ")}`);
      else if (m.role === "assistant" && m.text) lines.push(`You: ${m.text}`);
    }
    let out = lines.join("\n");
    if (out.length > RECAP_CHARS) out = `…${out.slice(-RECAP_CHARS)}`;
    return out;
  }

  // ---------------------------------------------------------------- process and session

  private async ensureSession(vendor: AcpVendorId, emit: TurnEventSink): Promise<{ sid: string } | { error: ClassifiedError }> {
    if (this.proc && this.vendor !== vendor) this.stop("vendor changed");
    let sid = this.d.getSessionId();
    if (!isAcpSessionId(sid)) { sid = `${ACP_SESSION_PREFIX}${this.d.newId()}`; this.d.setSessionId(sid); }
    if (this.proc && this.peer && !this.peer.closed && this.vendorSid && this.sidOf === sid) return { sid };
    if (this.proc && this.sidOf !== sid) this.stop("conversation changed");

    this.setState("spawning");
    const startMs = this.d.timeouts?.startMs ?? DEFAULT_START_MS;
    try {
      if (!this.proc) {
        let proc: AcpProcess;
        try { proc = this.d.spawn({ botId: this.botId, vendor, mode: "acp" }); } catch (e) {
          if (e instanceof AcpNotAvailable) return { error: { code: "BOT-MODEL", message: e.message, retryable: false, trayTitle: "Model not available" } };
          throw e;
        }
        this.proc = proc;
        this.vendor = vendor;
        this.stderrTail = "";
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (c: string) => { this.stderrTail = (this.stderrTail + c).slice(-4_000); });
        const peer = new JsonRpcPeer(proc.stdout, proc.stdin, { request: (m, p) => this.onRequest(m, p), notification: (m, p) => this.onNotification(m, p) });
        this.peer = peer;
        const spawnFailed = new Promise<never>((_, rej) => proc.onError((e) => { peer.close(e); rej(e); }));
        spawnFailed.catch(() => {});
        proc.onExit(() => { if (this.proc === proc) { peer.close(new Error("the coding CLI exited")); this.proc = null; this.peer = null; this.vendorSid = null; this.sidOf = null; if (!this.turn && this.procState !== "cold" && this.procState !== "cooling") this.setState("crashed"); } });
        const init = await Promise.race([peer.request<Record<string, unknown>>("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // Files and terminals go through Synapse's own walled tools. No auth.terminal: sign-in is a separate step.
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: this.shellTool() !== null },
          clientInfo: { name: "synapse", title: "Synapse", version: "1" },
        }, startMs), spawnFailed]);
        if (Number(init?.protocolVersion) !== ACP_PROTOCOL_VERSION) {
          this.stop("protocol version");
          return { error: { code: "BOT-MODEL", message: STR_ACP.badProtocol(vendor), retryable: false, trayTitle: "Model not available" } };
        }
        const ac = (init.agentCapabilities ?? {}) as { loadSession?: unknown; promptCapabilities?: { image?: unknown } };
        this.caps = { loadSession: ac.loadSession === true, image: ac.promptCapabilities?.image === true };
      }
      const cwd = this.d.cwd();
      const known = this.d.sessions.get(this.botId, sid, vendor);
      let vendorSid: string | null = null;
      if (known && this.caps.loadSession) {
        try {
          await this.peer!.request("session/load", { sessionId: known, cwd, mcpServers: [] }, startMs);
          vendorSid = known;
        } catch (e) {
          if (e instanceof RpcError && e.code === RPC.authRequired) throw e;
          this.d.log?.("acp brain: the vendor session couldn't be loaded; starting a new one", { botId: this.botId, vendor });
        }
      }
      if (!vendorSid) {
        // No MCP servers: the agent gets no tools from Synapse that would skip the gate.
        const r = await this.peer!.request<{ sessionId?: unknown }>("session/new", { cwd, mcpServers: [] }, startMs);
        if (typeof r?.sessionId !== "string" || !r.sessionId) throw new Error("the coding CLI gave no session id");
        vendorSid = r.sessionId;
        this.pendingPreamble = true;
        this.d.sessions.set(this.botId, { sid, vendor, vendorSid });
      }
      this.vendorSid = vendorSid;
      this.sidOf = sid;
      emit({ kind: "session", sessionId: sid, model: `acp:${vendor}`, tools: [], cliVersion: `acp:${vendor}` });
      return { sid };
    } catch (e) {
      const auth = e instanceof RpcError && e.code === RPC.authRequired;
      const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
      this.d.log?.("acp brain: couldn't start the coding CLI", { botId: this.botId, vendor, error: String(e), stderr: this.stderrTail.slice(-400) });
      this.stop("start failed");
      if (auth) return { error: { code: "BOT-E0421", message: STR_ACP.needsSignIn(vendor), retryable: false, trayTitle: STR_ACP.needsSignInTitle } };
      if (missing) return { error: { code: "BOT-MODEL", message: STR_ACP.notInstalled(vendor), retryable: false, trayTitle: "Model not available" } };
      return { error: { code: "BOT-E0403", message: STR_ACP.stopped(vendor), retryable: false, trayTitle: STR_ACP.stoppedTitle } };
    }
  }

  // ---------------------------------------------------------------- the agent's notifications

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const p = (params ?? {}) as { sessionId?: unknown; update?: Record<string, unknown> };
    const t = this.turn;
    if (!t || p.sessionId !== this.vendorSid || !p.update) return;
    this.lastEventAt = this.now();
    const u = p.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOf(u.content);
        if (!text) return;
        t.text += text;
        if (!t.streamed) { t.streamed = true; t.emit({ kind: "send_message_delta", toolUseId: t.sendId, partialJson: '{"content":"' }); }
        t.emit({ kind: "send_message_delta", toolUseId: t.sendId, partialJson: JSON.stringify(text).slice(1, -1) });
        return;
      }
      case "agent_thought_chunk":
        t.emit({ kind: "thinking", active: true });
        return;
      case "tool_call":
      case "tool_call_update": {
        const id = typeof u.toolCallId === "string" ? u.toolCallId : null;
        if (!id) return;
        const merged = { ...(t.calls.get(id) ?? { toolCallId: id }), ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== null && v !== undefined)) } as AcpToolCall;
        t.calls.set(id, merged);
        this.noteToolCall(t, merged);
        return;
      }
      case "usage_update":
        if (typeof u.used === "number") t.emit({ kind: "context", tokens: u.used });
        return;
      default:
        return; // plan, modes, commands, notices: nothing the transcript needs
    }
  }

  /** A vendor tool call in the transcript: started once, ended when it completes or fails. */
  private noteToolCall(t: Turn, c: AcpToolCall): void {
    const toolUseId = `acp_${c.toolCallId}`;
    const shown = displayOf(c, this.d.cwd());
    if (!t.started.has(c.toolCallId)) {
      t.started.add(c.toolCallId);
      t.toolCallCount++;
      // Text before a tool call was narration, not the reply: the reply starts again after it.
      this.resetReply(t);
      t.emit({ kind: "tool_start", toolUseId, name: shown.name, input: shown.input, messageId: `msg_acp_${c.toolCallId}` });
    }
    if (c.status === "completed" || c.status === "failed") {
      if (t.started.has(`${c.toolCallId}#end`)) return;
      t.started.add(`${c.toolCallId}#end`);
      const out = textOf(c.content ?? []) || (typeof c.rawOutput === "string" ? c.rawOutput : c.rawOutput ? JSON.stringify(c.rawOutput) : "");
      t.emit({ kind: "tool_end", toolUseId, name: shown.name, isError: c.status === "failed", output: out.slice(0, 16_000) });
    }
  }

  private resetReply(t: Turn): void {
    t.text = "";
    if (t.streamed) {
      t.streamed = false;
      t.sendId = `acp_send_${this.d.newId()}`;
      t.emit({ kind: "retry", attempt: 0, errorStatus: null, resetStream: true });
    }
  }

  // ---------------------------------------------------------------- the agent's requests

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const t = this.turn;
    // Only inside a turn, only for our session.
    if (!t || p.sessionId !== this.vendorSid) {
      if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
      throw new RpcError(RPC.invalidRequest, "No turn is running.");
    }
    switch (method) {
      case "session/request_permission": return this.permission(t, p);
      case "fs/read_text_file": return this.readFile(t, p);
      case "fs/write_text_file": return this.writeFile(t, p);
      case "terminal/create": return this.terminalCreate(t, p);
      case "terminal/output": return this.terminalOutput(p);
      case "terminal/wait_for_exit": return this.terminalWait(p);
      case "terminal/kill": { this.term(p).ac.abort(); return {}; }
      case "terminal/release": { const id = String(p.terminalId ?? ""); this.terminals.get(id)?.ac.abort(); this.terminals.delete(id); return {}; }
      default:
        // Fail closed: elicitation, MCP tunnels, extension methods and anything added to ACP later.
        this.d.log?.("acp brain: refused an unknown request from the coding CLI", { botId: this.botId, method: method.slice(0, 80) });
        throw new RpcError(RPC.methodNotFound, "Method not found");
    }
  }

  /** One gate decision for one call, as ToolLoop makes it: preToolUse, then canUseTool on "ask". */
  private async decide(t: Turn, call: ToolCall): Promise<{ allow: true } | { allow: false; reason: string; deferred?: true }> {
    // Before the gate: the vendor's own folder (its login, its "ask me" settings) is never reached through Synapse.
    if (acpTouchesVendorDir(JSON.stringify(call.input), this.d.home?.() ?? null)) return { allow: false, reason: VENDOR_DIR_DENIED };
    const pre = await this.d.wiring.preToolUse(call);
    if (pre.decision === "allow") return { allow: true };
    if (pre.decision === "deny") return { allow: false, reason: pre.reason };
    if (pre.decision === "defer") return { allow: false, reason: pre.reason, deferred: true };
    const perm: PermissionDecision = await this.d.wiring.canUseTool(call, t.ac.signal);
    return perm.behavior === "allow" ? { allow: true } : { allow: false, reason: perm.message };
  }

  private async permission(t: Turn, p: Record<string, unknown>): Promise<unknown> {
    const raw = (p.toolCall ?? {}) as Record<string, unknown>;
    const id = typeof raw.toolCallId === "string" ? raw.toolCallId : `perm_${this.d.newId()}`;
    const tc = { ...(t.calls.get(id) ?? { toolCallId: id }), ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== undefined)) } as AcpToolCall;
    t.calls.set(id, tc);
    this.noteToolCall(t, tc);
    if (t.ac.signal.aborted) return { outcome: { outcome: "cancelled" } };
    const cwd = this.d.cwd();
    const calls = gateCallsFor(tc, cwd);
    if (!calls) {
      this.d.log?.("acp brain: denied a permission request of a kind Synapse can't check", { botId: this.botId, kind: String(tc.kind ?? "").slice(0, 40) });
      return { outcome: pickOutcome(p.options, false) };
    }
    this.toolInFlight = true;
    try {
      for (const c of calls) {
        const d = await this.decide(t, { toolName: c.toolName, input: c.input, toolUseId: `acp_${id}`, cwd });
        if (t.ac.signal.aborted) return { outcome: { outcome: "cancelled" } };
        if (!d.allow) {
          if (d.deferred) {
            // The card waits for the user; this turn ends and the approval-resume wake carries on (as ToolLoop does).
            t.deferred = true;
            queueMicrotask(() => { if (this.peer && this.vendorSid) this.peer.notify("session/cancel", { sessionId: this.vendorSid }); });
          }
          return { outcome: pickOutcome(p.options, false) };
        }
      }
    } finally {
      this.toolInFlight = false;
    }
    const outcome = pickOutcome(p.options, true);
    if (outcome.outcome === "selected" && (p.options as { optionId: string; kind: string }[]).find((o) => o.optionId === outcome.optionId)?.kind === "allow_once") {
      for (const c of calls) t.allowedOnce.push(onceKey(c));
    }
    return { outcome };
  }

  /** A permission the gate just gave for exactly this call is spent here, so the user isn't asked twice. */
  private spendOnce(t: Turn, c: GateCall): boolean {
    const i = t.allowedOnce.indexOf(onceKey(c));
    if (i < 0) return false;
    t.allowedOnce.splice(i, 1);
    return true;
  }

  private absPath(v: unknown): string {
    if (typeof v !== "string" || !v) throw new RpcError(RPC.invalidParams, "A path is required.");
    return path.resolve(this.d.cwd(), v);
  }

  private async readFile(t: Turn, p: Record<string, unknown>): Promise<unknown> {
    const file = this.absPath(p.path);
    const call: GateCall = { toolName: "Read", input: { file_path: file } };
    if (!this.spendOnce(t, call)) {
      const d = await this.decide(t, { ...call, toolUseId: `acp_fs_${this.d.newId()}`, cwd: this.d.cwd() });
      if (!d.allow) throw new RpcError(RPC.internal, d.reason);
    }
    const line = typeof p.line === "number" && p.line > 0 ? Math.floor(p.line) : undefined;
    const limit = typeof p.limit === "number" && p.limit > 0 ? Math.floor(p.limit) : undefined;
    const r = await this.d.files(this.botId, { op: "read", path: file, ...(line ? { offset: line } : {}), ...(limit ? { limit } : {}) });
    if (!r.ok) throw new RpcError(RPC.internal, r.error);
    if (!("kind" in r) || r.kind !== "text") throw new RpcError(RPC.internal, "Not a text file.");
    // bot-file answers numbered lines (the Read tool's shape) with its caps. The agent gets the text itself; a file
    // past the caps must be read in ranges, and a cut long line is refused, so a write-back can never truncate a file.
    const lines = r.text ? r.text.split("\n").map((l) => l.replace(/^\s*\d+\t/, "")) : [];
    if (lines.some((l) => l.length > LINE_CAP && l.endsWith("…"))) throw new RpcError(RPC.internal, "The file has a line too long to read here.");
    if (r.cut && !limit) throw new RpcError(RPC.internal, `The file is longer than one read allows (${r.total} lines); read it in ranges with line and limit.`);
    let content = lines.join("\n");
    // A whole-file read ends with a newline exactly when the file does (its sha tells).
    if (!r.cut && !line && lines.length && createHash("sha256").update(`${content}\n`).digest("hex") === r.sha) content += "\n";
    return { content };
  }

  private async writeFile(t: Turn, p: Record<string, unknown>): Promise<unknown> {
    const file = this.absPath(p.path);
    if (typeof p.content !== "string") throw new RpcError(RPC.invalidParams, "Content is required.");
    const call: GateCall = { toolName: "Write", input: { file_path: file, content: p.content } };
    if (!this.spendOnce(t, call) && !this.spendOnce(t, { toolName: "Edit", input: { file_path: file } })) {
      const d = await this.decide(t, { ...call, toolUseId: `acp_fs_${this.d.newId()}`, cwd: this.d.cwd() });
      if (!d.allow) throw new RpcError(RPC.internal, d.reason);
    }
    // bot-file, as the Bot: a file that is there must be the one it holds now (its sha), a new one is created.
    const before = await this.d.files(this.botId, { op: "read", path: file, limit: 1 });
    const expect = before.ok && "sha" in before ? before.sha : null;
    const w = await this.d.files(this.botId, { op: "write", path: file, content: p.content, expect });
    if (!w.ok) throw new RpcError(RPC.internal, w.error);
    return null;
  }

  private shellTool(): BotToolDef | null {
    return this.d.wiring.botTools().find((d) => d.name === "Shell") ?? null;
  }

  private term(p: Record<string, unknown>): Terminal {
    const t = this.terminals.get(String(p.terminalId ?? ""));
    if (!t) throw new RpcError(RPC.invalidParams, "No such terminal.");
    return t;
  }

  /** A terminal is one run of the Bot's own Shell tool, through ToolLoop (the gate, then the Shell as the Bot). */
  private async terminalCreate(t: Turn, p: Record<string, unknown>): Promise<unknown> {
    const shell = this.shellTool();
    if (!shell) throw new RpcError(RPC.methodNotFound, "This Bot can't run commands.");
    if (typeof p.command !== "string" || !p.command.trim()) throw new RpcError(RPC.invalidParams, "A command is required.");
    const args = Array.isArray(p.args) ? p.args.filter((a): a is string => typeof a === "string") : [];
    // `sh -c "<script>"` is the script itself; otherwise every word is quoted. The agent's env is not passed on.
    const command = args.length === 2 && /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh$/.test(p.command) && args[0] === "-c" ? args[1]! : [p.command, ...args].map((a, i) => (i === 0 && !args.length ? a : shq(a))).join(" ");
    const cwd = typeof p.cwd === "string" && p.cwd ? path.resolve(this.d.cwd(), p.cwd) : this.d.cwd();
    const limit = typeof p.outputByteLimit === "number" && p.outputByteLimit > 0 ? Math.min(p.outputByteLimit, MAX_TERMINAL_OUTPUT) : MAX_TERMINAL_OUTPUT;
    const id = `term_${++this.termSeq}`;
    const ac = new AbortController();
    const onTurnAbort = () => ac.abort();
    t.ac.signal.addEventListener("abort", onTurnAbort, { once: true });
    if (acpTouchesVendorDir(JSON.stringify({ command, cwd }), this.d.home?.() ?? null)) throw new RpcError(RPC.internal, VENDOR_DIR_DENIED);
    const spend = this.spendOnce(t, { toolName: "Bash", input: { command } });
    const registry = ToolRegistry.forBotTools([shell], "loose");
    const wiring: BrainWiring = spend ? { ...this.d.wiring, preToolUse: async () => ({ decision: "allow" }) } : this.d.wiring;
    const term: Terminal = { output: "", truncated: false, limit, exit: null, ac, done: Promise.resolve() };
    term.done = (async () => {
      try {
        const out = await runToolBatch({
          wiring, registry, emit: t.emit, signal: ac.signal, abortTurn: () => { t.deferred = true; t.ac.abort(); }, setInFlight: (v) => { this.toolInFlight = v; },
        }, [{ id: `acp_term_${this.d.newId()}`, wireName: registry.wireName(`${BOT_PREFIX}Shell`), arguments: JSON.stringify({ command, working_directory: cwd, block_until_ms: TERMINAL_BLOCK_MS }) }], `msg_acp_${id}`);
        const r = out.results[0];
        let text = r?.text ?? "";
        const m = /\n?\[exit code (-?\d+)[^\]]*\]\s*$/.exec(text);
        if (m) text = text.slice(0, m.index);
        this.setOutput(term, text);
        term.exit = { exitCode: m ? Number(m[1]) : r?.isError ? 1 : null, signal: ac.signal.aborted ? "SIGTERM" : null };
      } catch (e) {
        this.setOutput(term, `Error: ${e instanceof Error ? e.message : String(e)}`);
        term.exit = { exitCode: 1, signal: null };
      } finally {
        t.ac.signal.removeEventListener("abort", onTurnAbort);
      }
    })();
    this.terminals.set(id, term);
    return { terminalId: id };
  }

  private setOutput(term: Terminal, text: string): void {
    const b = Buffer.from(text);
    if (b.length <= term.limit) { term.output = text; return; }
    term.truncated = true;
    let cut = b.subarray(b.length - term.limit).toString("utf8");
    if (cut.startsWith("�")) cut = cut.slice(1); // never a split character at the front
    term.output = cut;
  }

  private async terminalOutput(p: Record<string, unknown>): Promise<unknown> {
    const t = this.term(p);
    return { output: t.output, truncated: t.truncated, ...(t.exit ? { exitStatus: t.exit } : {}) };
  }

  private async terminalWait(p: Record<string, unknown>): Promise<unknown> {
    const t = this.term(p);
    await t.done;
    return t.exit ?? { exitCode: null, signal: null };
  }

  /** The reply: the agent's last message, sent as the Bot's SendMessage through ToolLoop (the gate sees it too). */
  private async sendReply(t: Turn, text: string): Promise<void> {
    const send = this.d.wiring.botTools().find((d) => `${BOT_PREFIX}${d.name}` === SEND_TOOL);
    if (!send) return;
    const registry = ToolRegistry.forBotTools([send], "loose");
    await runToolBatch({
      wiring: this.d.wiring, registry, emit: t.emit, signal: t.ac.signal, abortTurn: () => { t.deferred = true; t.ac.abort(); }, setInFlight: (v) => { this.toolInFlight = v; },
    }, [{ id: t.sendId, wireName: registry.wireName(SEND_TOOL), arguments: JSON.stringify({ content: text }) }], `msg_acp_reply_${t.sendId}`);
  }
}
