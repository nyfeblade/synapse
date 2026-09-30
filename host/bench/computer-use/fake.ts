import { isProviderModelRef } from "@synapse/shared";
import { isBenchCuName, NONCE_RE, type BoxEvent, type CuBox, type UsageRow } from "./box";
import type { Mode } from "./metrics";
import { TASKS, type CuTask, type PromptCtx, type SystemState } from "./tasks";

/**
 * Offline doubles: a fake model and an in-memory box. They drive the whole runner (setup, Bot per
 * task x mode, events, interventions, state checks, usage, cleanup) with no model call and no box.
 */

export interface FakeCuTurn {
  /** The system state the "Bot" leaves behind (what the checker reads). */
  state: SystemState;
  text: string;
  images?: number;
  calls?: number;
  approvals?: number;
  boxHelp?: number;
  /** Keeps "running" (its transcript's tokens already spent) until interrupted, like a Bot that never stops. */
  hang?: boolean;
}
export type FakeCuModel = (ctx: { task: CuTask; mode: Mode; prompt: string }) => FakeCuTurn;

export class FakeCuBox implements CuBox {
  readonly real: boolean = false;
  readonly bots = new Map<string, { name: string; model: string; mode: Mode | null }>([["user-bot-1", { name: "Research", model: "claude-sonnet-5", mode: null }]]);
  readonly perceptionCalls: { id: string; mode: Mode }[] = [];
  readonly createdModels: string[] = [];
  readonly deleted: string[] = [];
  readonly calls: { cmd: string; args: Record<string, unknown> }[] = [];
  created = 0;
  tornDown = false;
  failSendPrompt = false;
  private listeners = new Set<(ev: BoxEvent) => void>();
  private rows: (UsageRow & { botId: string })[] = [];
  private transcripts = new Map<string, string[]>();
  private state: SystemState = { submissions: {}, files: {}, xfconf: { before: null, after: null } };
  private xml: string | null = null;
  private n = 0;
  private hanging = new Map<string, () => void>();

  constructor(private model: FakeCuModel) {}

  async listBots() { return [...this.bots].map(([id, b]) => ({ id, name: b.name })); }
  async createBot(name: string, model: string) {
    const id = `bot-${++this.n}`;
    this.created += 1;
    this.createdModels.push(model);
    this.bots.set(id, { name, model, mode: null });
    return id;
  }
  async setPerception(id: string, mode: Mode) { this.perceptionCalls.push({ id, mode }); this.bots.get(id)!.mode = mode; }
  async deleteBot(id: string) {
    const b = this.bots.get(id);
    if (!b) return;
    if (!isBenchCuName(b.name)) throw new Error(`refusing to delete ${b.name}`);
    this.bots.delete(id);
    this.deleted.push(id);
  }
  async subscribe(fn: (ev: BoxEvent) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  async usage(botId: string, since: number) { return this.rows.filter((r) => r.botId === botId && r.startedAt >= since); }
  async childTranscripts(botId: string) { return this.transcripts.get(botId) ?? []; }
  async setup(nonce: string, _tasks: CuTask[]): Promise<PromptCtx> {
    if (!NONCE_RE.test(nonce)) throw new Error("bad nonce");
    return { base: "http://127.0.0.1:18999", desk: `/workspace/bench-cu-${nonce}/desk` };
  }
  async resetTask(_nonce: string, task: CuTask) {
    delete this.state.submissions[task.id];
    for (const rel of [...(task.watch ?? []), ...Object.keys(task.files ?? {})]) delete this.state.files[rel];
    for (const [rel, c] of Object.entries(task.files ?? {})) this.state.files[rel] = c;
  }
  async submissions() { return structuredClone(this.state.submissions); }
  async readFiles(_nonce: string, rels: string[]) { return Object.fromEntries(rels.map((r) => [r, this.state.files[r] ?? null])); }
  async xfconf() { return this.xml; }
  async teardown() { this.tornDown = true; }

  private emit(channel: string, payload: unknown) { for (const l of [...this.listeners]) l({ channel, payload }); }

  async call(cmd: string, args: Record<string, any>): Promise<any> {
    this.calls.push({ cmd, args });
    if (cmd === "interruptAgent") { this.hanging.get(String(args.id))?.(); return {}; }
    if (cmd === "sendPrompt") {
      if (this.failSendPrompt) throw new Error("sendPrompt: fake failure");
      void this.simulate(args.id as string, String(args.text), String(args.clientNonce ?? ""));
      return { entryId: `e-${++this.n}` };
    }
    return {};
  }

  private async simulate(id: string, prompt: string, clientNonce: string) {
    await new Promise((r) => setTimeout(r, 5));
    const mode = this.bots.get(id)?.mode ?? "screenshots";
    const task = TASKS.find((t) => clientNonce.endsWith(`-${t.id}`));
    if (!task) throw new Error(`fake box: no task in clientNonce ${clientNonce}`);
    const turn = this.model({ task, mode, prompt });
    const t0 = Date.now();
    this.emit("agent-upserted", { agent: { id, running: true, awaiting: null } });
    for (let i = 0; i < (turn.approvals ?? 0); i++) {
      this.emit("transcript", { botId: id, op: "append", entry: { id: `ap-${i}`, kind: "send-message", message: { type: "auto-review-approval", approval: { approvalId: `a${i}`, status: "pending", command: "click" } } } });
    }
    for (let i = 0; i < (turn.boxHelp ?? 0); i++) this.emit("box-help", { request: { id: `bh-${i}`, botId: id, status: "pending", reason: "fake" } });
    // Apply the state the Bot left.
    for (const [k, v] of Object.entries(turn.state.submissions)) this.state.submissions[k] = [...(this.state.submissions[k] ?? []), ...v];
    Object.assign(this.state.files, turn.state.files);
    if (turn.state.xfconf.after !== null) this.xml = turn.state.xfconf.after;
    // One child transcript: `calls` assistant messages, `images` image tool results. A provider Bot's child writes the
    // provider session shape (no message id, one record per model call, keyed by uuid; host/brain/provider/session-store.ts).
    const lines: string[] = [];
    const calls = turn.calls ?? 3;
    const provider = isProviderModelRef(this.bots.get(id)?.model ?? "");
    for (let i = 0; i < calls; i++) {
      const tool = mode === "live" ? "mcp__computer__Act" : "mcp__computer__Computer";
      const result = { type: "user", message: { content: [{ type: "tool_result", content: i < (turn.images ?? 0) ? [{ type: "image", source: {} }] : [{ type: "text", text: "ok" }] }] } };
      if (provider) {
        lines.push(JSON.stringify({ uuid: `u-${id}-a${i}`, type: "assistant", message: { role: "assistant", model: this.bots.get(id)!.model, usage: { input_tokens: 5_802, output_tokens: 120, cache_read_input_tokens: 5_000 }, content: [{ type: "tool_use", id: `call_${i}`, name: tool, input: {} }] }, provider: { calls: {} } }));
        lines.push(JSON.stringify({ uuid: `u-${id}-r${i}`, ...result, provider: { toolName: tool } }));
      } else {
        lines.push(JSON.stringify({ type: "assistant", message: { id: `m${i}`, usage: { input_tokens: 2, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 800, output_tokens: 120 }, content: [{ type: "tool_use", name: tool }] } }));
        lines.push(JSON.stringify(result));
      }
    }
    this.transcripts.set(id, [lines.join("\n")]);
    if (turn.hang) {
      this.hanging.set(id, () => { this.hanging.delete(id); this.emit("agent-upserted", { agent: { id, running: false, awaiting: null } }); });
      return;
    }
    this.emit("transcript", { botId: id, op: "append", entry: { id: "fin", kind: "send-message", message: { type: "text", content: turn.text } } });
    this.rows.push({ botId: id, model: this.bots.get(id)?.model ?? "m", startedAt: t0, inputTokens: 4, outputTokens: 300, cacheRead: 40_000, cacheWrite: 12_000, costUsd: 0, numTurns: 3, status: "ok", purpose: "turn" });
    this.emit("agent-upserted", { agent: { id, running: false, awaiting: null } });
    this.emit("usage", {});
  }
}
