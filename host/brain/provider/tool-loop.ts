import type { BotToolResult, BrainWiring, ToolCall, TurnEventSink } from "../types";
import type { CanonMessage } from "./adapters/types";
import { handlerForTicket, type RegisteredTool, type ToolRegistry } from "./tool-registry";

/**
 * ToolLoop (spec §2, §12.4): the ONLY place a provider Bot's tool handler runs. It does exactly what FakeBrain.runTool
 * does, in the CLI's permission order, for every call the model makes:
 *   1. parse the arguments and validate them with zod — invalid input gets an error result and never reaches the gate;
 *   2. wiring.preToolUse (steer gate → hooks → ApprovalGate); on `ask`, wiring.canUseTool;
 *   3. on `defer`, a synthetic result for the call, and the turn ends as aborted (the approval-resume wake continues);
 *   4. execute with the gate's updatedInput — only with a GateTicket, which only step 2 mints;
 *   5. wiring.postToolUse: additionalContext becomes a note after the results, replaceOutput replaces the output;
 *   6. wiring.toolBatch: endTurn ends the turn unless a note is pending.
 * Calls run in model order, one at a time. An invented tool name gets an error result.
 */
export type ToolResultMessage = Extract<CanonMessage, { role: "tool" }>;
export interface ModelToolCall { id: string; wireName: string; arguments: string }
export interface BatchOutcome {
  /** One per model call, in order: every tool_call_id gets a result. */
  results: ToolResultMessage[];
  /** additionalContext notes for the model, shown after the results. */
  notes: string[];
  /** A call was deferred to an approval card: the turn ends aborted. */
  deferred: boolean;
  /** The batch asked to end the turn (token diet) and no note is pending. */
  endTurn: boolean;
  /** Calls that reached a handler. */
  executed: number;
}
export interface ToolLoopDeps {
  wiring: BrainWiring;
  registry: ToolRegistry;
  emit: TurnEventSink;
  signal: AbortSignal;
  /** Aborts the turn (a deferred call). */
  abortTurn(): void;
  setInFlight(v: boolean): void;
}

/** Spec §12.10: caps on tool calls per message and on argument size. */
export const MAX_CALLS_PER_MESSAGE = 64;
export const MAX_ARGUMENT_BYTES = 1024 * 1024;
export const INTERRUPTED_TEXT = "[Request interrupted by user for tool use]";
const toolError = (s: string) => `<tool_use_error>${s}</tool_use_error>`;

// ---- GateTicket: proof that the gate decided `allow` for exactly this call ----
declare const TICKET: unique symbol;
export interface GateTicket { readonly [TICKET]: true; readonly toolUseId: string }
interface TicketBody { toolUseId: string; tool: RegisteredTool; input: Record<string, unknown> }
const issued = new WeakMap<object, TicketBody>();
/** Minted only by the gate step below, after an allow; spent on use. */
function mintTicket(body: TicketBody): GateTicket {
  const t = Object.freeze({ toolUseId: body.toolUseId }) as unknown as GateTicket;
  issued.set(t, body);
  return t;
}

/** Runs a gated call. A ticket this module didn't mint, or one already spent, is refused. */
export async function executeGated(ticket: GateTicket, signal: AbortSignal): Promise<BotToolResult> {
  const body = issued.get(ticket as object);
  if (!body) throw new Error("refused: a tool call without the approval gate's decision");
  issued.delete(ticket as object);
  const parsed = body.tool.validator.safeParse(body.input);
  if (!parsed.success) return { text: toolError(`InputValidationError: ${issuesText(parsed.error)}`), isError: true };
  if (signal.aborted) return { text: INTERRUPTED_TEXT, isError: true };
  let onAbort: () => void = () => {};
  const aborted = new Promise<BotToolResult>((res) => { onAbort = () => res({ text: INTERRUPTED_TEXT, isError: true }); signal.addEventListener("abort", onAbort, { once: true }); });
  try {
    const run = handlerForTicket(body.tool)(parsed.data as Record<string, unknown>).catch((e: unknown) => ({ text: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true }));
    return await Promise.race([run, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function issuesText(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return e.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`).join("; ");
}

/** Phase 0 unknown 3c: models send null for optional fields (and zod's .optional() rejects null). */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = stripNulls(x);
  return out;
}

type Prepared =
  | { ok: true; tool: RegisteredTool; call: ToolCall }
  | { ok: false; call: ToolCall; error: string };

function prepare(reg: ToolRegistry, c: ModelToolCall, index: number): Prepared {
  const tool = reg.fromWire(c.wireName);
  const name = tool?.canonical ?? c.wireName;
  const base = { toolName: name, input: {} as Record<string, unknown>, toolUseId: c.id };
  if (index >= MAX_CALLS_PER_MESSAGE) return { ok: false, call: base, error: toolError(`Too many tool calls in one message (the limit is ${MAX_CALLS_PER_MESSAGE}).`) };
  if (!tool) return { ok: false, call: base, error: toolError(`Error: No such tool available: ${c.wireName}`) };
  if (Buffer.byteLength(c.arguments) > MAX_ARGUMENT_BYTES) return { ok: false, call: base, error: toolError("InputValidationError: the arguments are larger than 1 MB.") };
  let raw: unknown;
  try { raw = c.arguments.trim() ? JSON.parse(c.arguments) : {}; } catch { return { ok: false, call: base, error: toolError("InputValidationError: the arguments are not valid JSON.") }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, call: base, error: toolError("InputValidationError: the arguments must be a JSON object.") };
  let input = raw as Record<string, unknown>;
  let check = tool.validator.safeParse(input);
  if (!check.success) {
    const stripped = stripNulls(input) as Record<string, unknown>;
    const again = tool.validator.safeParse(stripped);
    if (again.success) { input = stripped; check = again; }
  }
  const call = { ...base, input };
  if (!check.success) return { ok: false, call, error: toolError(`InputValidationError: ${issuesText(check.error)}`) };
  return { ok: true, tool, call };
}

export async function runToolBatch(d: ToolLoopDeps, calls: ModelToolCall[], messageId: string): Promise<BatchOutcome> {
  const prepared = calls.map((c, i) => prepare(d.registry, c, i));
  // As the CLI does: every tool_use of the assistant message is announced before any hook runs.
  for (const p of prepared) d.emit({ kind: "tool_start", toolUseId: p.call.toolUseId, name: p.call.toolName, input: p.call.input, messageId });
  // As ClaudeBrain: a tool is in flight from its tool_start (a card may be waiting on the user) until the batch ends, so
  // the supervisor's stall check never interrupts a turn waiting on an approval.
  d.setInFlight(true);
  try {
    return await runCalls(d, prepared);
  } finally {
    d.setInFlight(false);
  }
}

async function runCalls(d: ToolLoopDeps, prepared: Prepared[]): Promise<BatchOutcome> {
  const results: ToolResultMessage[] = [];
  const notes: string[] = [];
  let deferred = false;
  let executed = 0;
  const result = (p: Prepared, text: string, isError: boolean, images?: ToolResultMessage["images"], toolRefs?: string[]) =>
    results.push({ role: "tool", toolCallId: p.call.toolUseId, name: p.call.toolName, text, isError, ...(images?.length ? { images } : {}), ...(toolRefs?.length ? { toolRefs } : {}) });

  for (const p of prepared) {
    if (deferred) { result(p, "Not run: an earlier action in this message is waiting for the user's approval.", true); continue; }
    if (d.signal.aborted) { result(p, INTERRUPTED_TEXT, true); continue; }
    if (!p.ok) {
      d.emit({ kind: "tool_end", toolUseId: p.call.toolUseId, name: p.call.toolName, isError: true, output: p.error });
      result(p, p.error, true);
      continue;
    }
    // ---- the gate (steps 2–3) ----
    const pre = await d.wiring.preToolUse(p.call);
    let input = p.call.input;
    let denied: string | null = null;
    if (pre.decision === "allow") input = pre.updatedInput ?? input;
    else if (pre.decision === "deny") { denied = pre.reason; if (pre.additionalContext) notes.push(pre.additionalContext); }
    else if (pre.decision === "defer") {
      d.emit({ kind: "tool_end", toolUseId: p.call.toolUseId, name: p.call.toolName, isError: true, output: pre.reason });
      result(p, pre.reason, true);
      deferred = true;
      d.abortTurn();
      continue;
    } else {
      const perm = await d.wiring.canUseTool(p.call, d.signal);
      if (perm.behavior === "allow") input = perm.updatedInput ?? input;
      else denied = perm.message;
    }
    if (denied !== null) {
      d.emit({ kind: "tool_end", toolUseId: p.call.toolUseId, name: p.call.toolName, isError: true, output: denied });
      result(p, denied, true);
      continue;
    }
    // ---- execute (step 4): only with the ticket the allow above just minted ----
    const ticket = mintTicket({ toolUseId: p.call.toolUseId, tool: p.tool, input });
    const r: BotToolResult = await executeGated(ticket, d.signal);
    executed++;
    const output = r.text;
    const isError = Boolean(r.isError);
    // ---- post (step 5) ----
    const post = isError ? {} : await d.wiring.postToolUse({ ...p.call, input }, output);
    if (post.additionalContext) notes.push(post.additionalContext);
    const shown = post.replaceOutput ?? output;
    d.emit({ kind: "tool_end", toolUseId: p.call.toolUseId, name: p.call.toolName, isError, output: shown });
    result(p, shown, isError, r.images, isError ? undefined : r.toolRefs);
  }
  // ---- batch end (step 6) ----
  let endTurn = false;
  if (!deferred && !d.signal.aborted && d.wiring.toolBatch) {
    const b = await d.wiring.toolBatch(prepared.map((p) => p.call));
    endTurn = b.endTurn && notes.length === 0;
  }
  return { results, notes, deferred, endTurn, executed };
}
