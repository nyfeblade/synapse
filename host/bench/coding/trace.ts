import { weightedInput } from "./score";
import type { Usage } from "./types";

/**
 * Per-call trace of one run (bug-log 75: the gap analysis needs the call sequence, which deleting a bench
 * Bot used to destroy). Read from Claude Code's own events, the same shape on both runners: the CLI's
 * stream-json lines, and the Bot's session JSONL copied off the box before the Bot is deleted. An
 * assistant message's usage repeats on each of its lines (one per content block): counted once per id.
 */
export interface CallRow {
  /** Input tokens of this call: fresh + cache read + cache write (the context it was sent). */
  input: number;
  usage: Usage;
  /** Tool names this call asked for, in order (short names: mcp__bot__SendMessage -> SendMessage). */
  tools: string[];
}

export interface RunTrace {
  /** Main-model calls = distinct assistant message ids. */
  calls: number;
  perCall: CallRow[];
  usage: Usage;
  weighted: number;
  avgInput: number;
  maxInput: number;
  /** Calls whose only tool use is SendMessage and that did not end the run: an ack or progress note paid as a model call. */
  sendOnlyCalls: number;
  toolCalls: Record<string, number>;
  /** Characters of tool results sent back to the model. */
  toolResultChars: number;
  /** Host reminders (<system_reminder>) the run was handed in user messages and tool results. */
  reminders: number;
  /** Bash commands, first 160 chars each (which ones a reviewer may have held up). */
  commands: string[];
  /** Time between a tool call and its result (the command, its hooks, any review); null without timestamps (CLI stream). */
  toolWaitMs: number | null;
}

type Json = Record<string, any>;
const short = (name: string) => name.replace(/^mcp__.+?__/, "");
export const SEND_TOOL_SHORT = "SendMessage";

/** `skipIds`: message ids already counted (an earlier task of the same session); they are left out. */
export function traceOf(lines: string[], skipIds: ReadonlySet<string> = new Set()): RunTrace & { ids: string[] } {
  const rows = new Map<string, CallRow>();
  const toolCalls: Record<string, number> = {};
  const commands: string[] = [];
  let toolResultChars = 0, reminders = 0, pendingReminders = 0;
  let lastAsstAt: number | null = null, toolWaitMs = 0, stamped = false;
  let open = false; // inside a message this trace counts (so its tool results are ours too)
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: Json;
    try { ev = JSON.parse(line) as Json; } catch { continue; }
    if (ev.parent_tool_use_id || ev.isSidechain) continue; // a subagent's own calls are not the main loop's
    const m = ev.message as Json | undefined;
    if (!m) continue;
    const content: Json[] = Array.isArray(m.content) ? m.content : [];
    const at = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
    if (ev.type === "assistant" && m.id) {
      const id = String(m.id);
      open = !skipIds.has(id);
      if (open) reminders += pendingReminders;
      pendingReminders = 0;
      if (!open) continue;
      if (Number.isFinite(at)) lastAsstAt = at;
      let row = rows.get(id);
      if (!row) {
        const u = m.usage ?? {};
        const usage: Usage = { fresh: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 };
        row = { input: usage.fresh + usage.cacheRead + usage.cacheWrite, usage, tools: [] };
        rows.set(id, row);
      }
      for (const b of content) {
        if (b?.type !== "tool_use" || !b.name) continue;
        const n = short(String(b.name));
        row.tools.push(n);
        toolCalls[n] = (toolCalls[n] ?? 0) + 1;
        if (n === "Bash" && typeof b.input?.command === "string") commands.push(String(b.input.command).slice(0, 160));
      }
    } else if (ev.type === "user") {
      const texts: string[] = typeof m.content === "string" ? [m.content] : [];
      let results = 0;
      for (const b of content) {
        if (b?.type === "text") texts.push(String(b.text ?? ""));
        if (b?.type === "tool_result") {
          const c = b.content;
          const s = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: Json) => (x?.type === "text" ? String(x.text ?? "") : "")).join("") : "";
          results += s.length;
          texts.push(s);
        }
      }
      const n = texts.reduce((a, t) => a + t.split("<system_reminder>").length - 1, 0);
      // A tool result belongs to the call before it; a new prompt to the call after it (counted when that one is ours).
      if (results > 0 || content.some((b) => b?.type === "tool_result")) {
        if (open) {
          toolResultChars += results; reminders += n;
          if (Number.isFinite(at) && lastAsstAt !== null) { toolWaitMs += Math.max(0, at - lastAsstAt); stamped = true; lastAsstAt = null; }
        }
      } else {
        pendingReminders += n;
      }
    }
  }
  const perCall = [...rows.values()];
  const usage = perCall.reduce<Usage>((a, r) => ({ fresh: a.fresh + r.usage.fresh, cacheRead: a.cacheRead + r.usage.cacheRead, cacheWrite: a.cacheWrite + r.usage.cacheWrite, output: a.output + r.usage.output }), { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  const inputs = perCall.map((r) => r.input);
  // The last call's send is the result itself; any earlier send-only call was paid for as a call of its own.
  const sendOnlyCalls = perCall.slice(0, -1).filter((r) => r.tools.length > 0 && r.tools.every((t) => t === SEND_TOOL_SHORT)).length;
  return {
    calls: perCall.length, perCall, usage, weighted: weightedInput(usage),
    avgInput: inputs.length ? Math.round(inputs.reduce((a, b) => a + b, 0) / inputs.length) : 0,
    maxInput: inputs.length ? Math.max(...inputs) : 0,
    sendOnlyCalls, toolCalls, toolResultChars, reminders, commands, toolWaitMs: stamped ? toolWaitMs : null,
    ids: [...rows.keys()],
  };
}

/** One line for the report: the numbers the gap analysis reads. */
export function traceLine(t: RunTrace): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const tools = Object.entries(t.toolCalls).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(" ") || "none";
  return `${t.calls} calls · input/call avg ${k(t.avgInput)} max ${k(t.maxInput)} · send-only calls ${t.sendOnlyCalls} · reminders ${t.reminders} · tool results ${k(t.toolResultChars)} chars${t.toolWaitMs !== null ? ` · tool waits ${(t.toolWaitMs / 1000).toFixed(0)}s` : ""} · tools ${tools}`;
}
