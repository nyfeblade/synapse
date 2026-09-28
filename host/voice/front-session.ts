import { createSdkMcpServer, tool, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BOT_FLAG_SETTINGS } from "../brain/spawn-options";
import { meteredQuery, runUsageOf, type QueryFn } from "../usage/metered-query";
import { AsyncQueue } from "../util/async-queue";

/**
 * Bug 142 (voice fast path): the Bot's VOICE on a call — a warm, lean Claude session per call participant.
 * Same model as the Bot, low effort, no thinking, a tiny prompt, and ONE tool: delegate(task), which hands real
 * work to the Bot's full session. The session is a streaming-input query kept open for the call (one CLI
 * process, spawned when the call starts), so each utterance is one short model call on a warm, cached context.
 * A turn that calls delegate ends right after the tool runs (PostToolBatch → continue: false): no second model
 * call just to say "ok".
 */
export interface FrontUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }
export const ZERO_FRONT_USAGE: FrontUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
export const totalTokens = (u: FrontUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export interface FrontTurn {
  /** What the voice said (spoken as it streamed). */
  text: string;
  /** Tasks it handed to the full session this turn. */
  delegations: string[];
  usage: FrontUsage;
  /** ms from the message to the first streamed text (null: none). */
  firstTextMs: number | null;
  error?: string;
}

export interface FrontSession {
  /** Turns completed on this session (the coordinator recycles a long one). */
  readonly turns: number;
  /** False once the process has ended (crash, close): the coordinator opens a new one. */
  readonly alive: boolean;
  /**
   * One turn. `onText` gets the text so far as it streams; `onDelegate` fires when the voice hands a task over.
   * Speed plan #8b (bug 216): `signal` aborts a turn that hasn't reached the model yet (it resolves empty, error
   * "interrupted", and costs nothing). A turn already in flight runs to its end: see SdkFrontSession.turn.
   * `onBegin`: the message has gone to the model (review 1: only then has the voice seen a reply it must be told of).
   */
  turn(message: string, onText: (sofar: string) => void, onDelegate: (task: string) => void, signal?: AbortSignal, onBegin?: () => void): Promise<FrontTurn>;
  close(): void;
}

export interface FrontSpec { botId: string; model: string; system: string }
export type FrontFactory = (spec: FrontSpec) => FrontSession;

const DELEGATE_DESC = "Hand a task to your full self, who has all your tools (Mac, files, web, email, calendar, messages, memory) and does it now. Give one clear, complete task: who, what, and the exact wording. Say briefly that you're on it in the same reply.";

interface Current { text: string; delegations: string[]; onText(s: string): void; onDelegate(t: string): void; resolve(r: FrontTurn): void; t0: number; firstText: number | null }

export class SdkFrontSession implements FrontSession {
  turns = 0;
  alive = true;
  private input = new AsyncQueue<SDKUserMessage>();
  private q: Query;
  private cur: Current | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(spec: FrontSpec, o: { env: Record<string, string>; cwd: string; pathToClaudeCodeExecutable?: string; queryFn?: QueryFn; now?: () => number }) {
    const now = o.now ?? Date.now;
    this.now = now;
    const server = createSdkMcpServer({
      name: "front",
      version: "1.0.0",
      tools: [
        tool("delegate", DELEGATE_DESC, { task: z.string().min(2).max(2000) }, async (a) => {
          const task = String((a as { task: unknown }).task ?? "").trim();
          if (this.cur && task) { this.cur.delegations.push(task); this.cur.onDelegate(task); }
          return { content: [{ type: "text" as const, text: "Handed over. Your full self is on it and will report back." }] };
        }, { alwaysLoad: true }),
      ],
    });
    const options: Options = {
      model: spec.model,
      systemPrompt: spec.system,
      settingSources: [],
      settings: { ...BOT_FLAG_SETTINGS } as Options["settings"],
      tools: ["mcp__front__delegate"],
      allowedTools: ["mcp__front__delegate"],
      mcpServers: { front: server },
      permissionMode: "default",
      persistSession: false,
      includePartialMessages: true,
      thinking: { type: "disabled" },
      effort: "low",
      hooks: { PostToolBatch: [{ hooks: [async () => ({ continue: false, stopReason: "handed over" })] }] },
      cwd: o.cwd,
      env: { ...o.env, ENABLE_TOOL_SEARCH: "false", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
      ...(o.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: o.pathToClaudeCodeExecutable } : {}),
    };
    this.q = meteredQuery({ purpose: "voice-front", botId: spec.botId }, { prompt: this.input, options }, o.queryFn);
    void this.pump();
  }

  private now: () => number;

  turn(message: string, onText: (sofar: string) => void, onDelegate: (task: string) => void, signal?: AbortSignal, onBegin?: () => void): Promise<FrontTurn> {
    const run = () => new Promise<FrontTurn>((resolve) => {
      if (!this.alive) return resolve({ text: "", delegations: [], usage: ZERO_FRONT_USAGE, firstTextMs: null, error: "closed" });
      if (signal?.aborted) return resolve({ text: "", delegations: [], usage: ZERO_FRONT_USAGE, firstTextMs: null, error: "interrupted" });
      // NOT interrupted once in flight: after Query.interrupt() the CLI delivers its result and the SDK then throws
      // out of the iterator for good (CT-03, host/brain/interrupt-throw.ts), so the voice would have to be spawned
      // again — a cold start (~1 s) and the call's context gone, to save the ~0.5 s the stale reply has left.
      this.cur = { text: "", delegations: [], onText, onDelegate, resolve, t0: this.now(), firstText: null };
      onBegin?.();
      this.input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: message }] } } as SDKUserMessage);
    });
    const p = this.chain.then(run, run);
    this.chain = p;
    return p;
  }

  private async pump(): Promise<void> {
    let error = "ended";
    try {
      for await (const m of this.q) {
        const c = this.cur;
        if (!c) continue;
        const msg = m as unknown as { type: string; parent_tool_use_id?: string | null; event?: { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string } }; result?: string; is_error?: boolean; subtype?: string };
        if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
          const ev = msg.event ?? {};
          // A second text block (after the tool call) continues the same spoken reply.
          if (ev.type === "content_block_start" && ev.content_block?.type === "text" && c.text && !/\s$/.test(c.text)) c.text += " ";
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            c.text += ev.delta.text;
            if (c.firstText === null) c.firstText = this.now() - c.t0;
            c.onText(c.text);
          }
        }
        if (msg.type === "result") {
          this.cur = null;
          this.turns += 1;
          const u = runUsageOf(m);
          c.resolve({
            text: c.text.trim(), delegations: c.delegations, firstTextMs: c.firstText,
            usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, costUsd: u.costUsd } : ZERO_FRONT_USAGE,
            ...(msg.is_error ? { error: String(msg.subtype ?? "error") } : {}),
          });
        }
      }
    } catch (e) {
      error = String(e).slice(0, 200);
    }
    this.alive = false;
    const c = this.cur;
    this.cur = null;
    c?.resolve({ text: c.text.trim(), delegations: c.delegations, usage: ZERO_FRONT_USAGE, firstTextMs: c.firstText, error });
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.input.end();
    (this.q as { close?: () => void }).close?.();
  }
}

/** FUZZ / E2E / the fake brain: a voice that answers small talk itself and hands anything to do over. */
export function demoFrontScript(message: string): { text: string; delegate?: string } {
  if (message.startsWith("[result]") || message.includes("\n[result]")) return { text: "All done, it's in the chat." };
  const said = /(?:^|\n)User: (.*)$/s.exec(message)?.[1]?.trim() ?? message;
  if (/\b(send|text|message|open|find|check|look up|schedule|email|remind|book|search|write|run)\b/i.test(said)) return { text: "Sure, on it.", delegate: said };
  return { text: "Sure. What else?" };
}

/**
 * Deterministic stand-in (tests, FUZZ, the scripted-call benchmark): `script` decides what the voice says and
 * whether it delegates; tokens are counted from the text sizes the real session would send (see bench).
 */
export class ScriptedFrontSession implements FrontSession {
  turns = 0;
  alive = true;
  readonly messages: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private spec: FrontSpec, private script: (message: string, n: number) => { text: string; delegate?: string; firstTextMs?: number; usage?: FrontUsage }, private o: { chunkMs?: number } = {}) {}

  turn(message: string, onText: (sofar: string) => void, onDelegate: (task: string) => void, signal?: AbortSignal, onBegin?: () => void): Promise<FrontTurn> {
    const run = async (): Promise<FrontTurn> => {
      if (!this.alive) return { text: "", delegations: [], usage: ZERO_FRONT_USAGE, firstTextMs: null, error: "closed" };
      if (signal?.aborted) return { text: "", delegations: [], usage: ZERO_FRONT_USAGE, firstTextMs: null, error: "interrupted" };
      onBegin?.();
      this.messages.push(message);
      const s = this.script(message, this.turns);
      const words = s.text.split(/(?<=\s)/);
      let sofar = "";
      if (s.firstTextMs) await new Promise((r) => setTimeout(r, s.firstTextMs));
      for (const w of words) {
        sofar += w;
        onText(sofar);
        if (this.o.chunkMs) await new Promise((r) => setTimeout(r, this.o.chunkMs));
      }
      if (s.delegate) onDelegate(s.delegate);
      this.turns += 1;
      const inTok = Math.ceil((this.spec.system.length + message.length) / 4);
      return { text: s.text.trim(), delegations: s.delegate ? [s.delegate] : [], firstTextMs: s.firstTextMs ?? 0, usage: s.usage ?? { inputTokens: inTok, outputTokens: Math.ceil(s.text.length / 4) + (s.delegate ? 30 : 0), cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } };
    };
    const p = this.chain.then(run, run);
    this.chain = p;
    return p;
  }

  close(): void { this.alive = false; }
}
