import { isProviderModelRef, parseProviderModelRef } from "@synapse/shared";
import { ChatCompletionsAdapter } from "../brain/provider/adapters/chat-completions";
import type { CanonMessage } from "../brain/provider/adapters/types";
import { providerFetch } from "../usage/metered-provider";
import { ZERO_FRONT_USAGE, type FrontSession, type FrontSpec, type FrontTurn, type FrontUsage } from "./front-session";

/**
 * The voice fast path on a provider model (spec §7a row 8): the provider twin of SdkFrontSession. A warm, in-memory
 * conversation per call participant on the Bot's own model (or its provider's helper, when the Bot picks "faster
 * voice"), a tiny prompt, and ONE tool, delegate(task), which hands real work to the Bot's full self (where every tool
 * call is gated). Text streams to TTS as it arrives. A turn that delegates ends right after the handover, with no
 * second model call, as on the Claude path. Metered as "voice-front".
 *
 * delegate only passes text to the Bot's own turn (it acts on nothing itself), so, as in SdkFrontSession, it isn't a
 * gated tool: the work it asks for is gated when the full session does it.
 */
const DELEGATE_DESC = "Hand a task to your full self, who has all your tools (Mac, files, web, email, calendar, messages, memory) and does it now. Give one clear, complete task: who, what, and the exact wording. Say briefly that you're on it in the same reply.";
const DELEGATE_SCHEMA = { type: "object", properties: { task: { type: "string", minLength: 2, maxLength: 2000 } }, required: ["task"], additionalProperties: false };
/** A long call keeps its last turns; the coordinator recycles the session well before this matters. */
const KEEP_MESSAGES = 60;

export class ProviderFrontSession implements FrontSession {
  turns = 0;
  alive = true;
  private history: CanonMessage[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private ac = new AbortController();
  private adapter: ChatCompletionsAdapter;
  private model: string;

  constructor(private spec: FrontSpec, private o: { now?: () => number } = {}) {
    const p = parseProviderModelRef(spec.model);
    if (!p) throw new Error(`not a provider model: ${spec.model}`);
    this.adapter = new ChatCompletionsAdapter(p.provider);
    this.model = p.model;
  }

  turn(message: string, onText: (sofar: string) => void, onDelegate: (task: string) => void, signal?: AbortSignal, onBegin?: () => void): Promise<FrontTurn> {
    const run = async (): Promise<FrontTurn> => {
      if (!this.alive) return { text: "", delegations: [], usage: ZERO_FRONT_USAGE, firstTextMs: null, error: "closed" };
      if (signal?.aborted) return { text: "", delegations: [], usage: ZERO_FRONT_USAGE, firstTextMs: null, error: "interrupted" };
      const now = this.o.now ?? Date.now;
      const t0 = now();
      onBegin?.();
      this.history.push({ role: "user", parts: [{ type: "text", text: message }] });
      const usage: FrontUsage = { ...ZERO_FRONT_USAGE };
      let text = "";
      let firstText: number | null = null;
      const delegations: string[] = [];
      try {
        const body = this.adapter.encode({
          model: this.model, system: this.spec.system, messages: this.history, wireName: (n) => n, maxOutputTokens: 600,
          tools: [{ name: "delegate", description: DELEGATE_DESC, parameters: DELEGATE_SCHEMA, strict: false }],
        });
        const s = await providerFetch({ purpose: "voice-front", botId: this.spec.botId }, this.adapter, {
          ref: this.spec.model, body, signal: this.ac.signal,
          onUsage: (u) => { usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.cacheReadTokens += u.cacheReadTokens; usage.cacheWriteTokens += u.cacheWriteTokens; usage.costUsd += u.costUsd; },
        });
        const dec = this.adapter.decoder();
        for await (const chunk of s.chunks) {
          for (const ev of dec.push(chunk)) {
            if (ev.kind !== "text") continue;
            text += ev.delta;
            if (firstText === null) firstText = now() - t0;
            onText(text);
          }
        }
        const m = dec.finish();
        this.history.push({ role: "assistant", text: m.text, toolCalls: m.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, ...(c.providerMeta !== undefined ? { providerMeta: c.providerMeta } : {}) })) });
        for (const c of m.toolCalls) {
          let task = "";
          try { task = String((JSON.parse(c.arguments || "{}") as { task?: unknown }).task ?? "").trim(); } catch { /* not JSON */ }
          const ok = c.name === "delegate" && task.length >= 2;
          if (ok) { delegations.push(task.slice(0, 2000)); onDelegate(task.slice(0, 2000)); }
          this.history.push({ role: "tool", toolCallId: c.id, name: c.name, isError: !ok, text: ok ? "Handed over. Your full self is on it and will report back." : "No such tool, or no task given." });
        }
        if (this.history.length > KEEP_MESSAGES) this.history = trimToUser(this.history.slice(-KEEP_MESSAGES));
        this.turns += 1;
        return { text: text.trim(), delegations, usage, firstTextMs: firstText };
      } catch (e) {
        this.history.pop(); // the message never got an answer: the next turn doesn't carry it twice
        return { text: text.trim(), delegations, usage, firstTextMs: firstText, error: String((e as Error).message ?? e).slice(0, 200) };
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p;
    return p;
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.ac.abort();
  }
}

/** A trimmed history starts at a user message (never at a tool result whose call was cut off). */
function trimToUser(h: CanonMessage[]): CanonMessage[] {
  const i = h.findIndex((m) => m.role === "user");
  return i <= 0 ? h : h.slice(i);
}

/**
 * The voice's session for a call participant: a provider Bot's voice runs on its own provider (in both brain modes),
 * a Claude Bot's on Claude as before (spec §7a row 8).
 */
export function frontSessionFor(spec: FrontSpec, claude: (spec: FrontSpec) => FrontSession, o: { now?: () => number } = {}): FrontSession {
  return isProviderModelRef(spec.model) ? new ProviderFrontSession(spec, o) : claude(spec);
}
