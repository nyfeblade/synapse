import type { HookCallback, PreCompactHookInput, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../../util/async-queue";
import { sleep } from "../../../util/sleep";
import { buildSystemPrompt, systemPromptModeFor } from "../../spawn-options";
import { claudeExecutableFor, DISALLOWED_TOOLS } from "../../tool-policy";
import type { ConformanceFlags } from "../flags";
import { allowAll, countingSpawn, runProbe, userMessage } from "../probe";
import type { CheckOutcome, ConformanceCheck, ConformanceContext } from "../types";

// ---------- CT-07 · /compact with instructions (ORIG-07) ----------
export function judgeCt07(o: { compactBoundary: boolean; hookInstructions: string | null }): CheckOutcome {
  return o.compactBoundary && (o.hookInstructions ?? "").includes("RESTORE-END")
    ? { status: "pass", detail: "compact_boundary seen; PreCompact received the instructions" }
    : { status: "fail", detail: `boundary=${o.compactBoundary} instructions=${o.hookInstructions ?? "none"}`, flags: { compactPath: "auto-only" } };
}
export const ct07: ConformanceCheck = {
  id: "CT-07", title: "/compact <instructions> and PreCompact", onThrow: { compactPath: "auto-only" },
  async run(ctx) {
    const first = await runProbe(ctx, { prompt: "Remember the word PINEAPPLE. Reply OK.", options: { tools: [], persistSession: true } });
    const sid = first.init?.session_id as string;
    let hookInstructions: string | null = null;
    const preCompact: HookCallback = async (i) => { hookInstructions = (i as PreCompactHookInput).custom_instructions; return {}; };
    const run = await runProbe(ctx, {
      prompt: "/compact Keep the word PINEAPPLE. End the summary with the line: RESTORE-END",
      options: { tools: [], resume: sid, persistSession: true, hooks: { PreCompact: [{ hooks: [preCompact] }] } },
    });
    const compactBoundary = run.messages.some((m) => (m as { type: string; subtype?: string }).type === "system" && (m as { subtype?: string }).subtype === "compact_boundary");
    return judgeCt07({ compactBoundary, hookInstructions });
  },
};

// ---------- CT-08 · prompt cache across resumes with a byte-identical append (BRAIN-03) ----------
const CACHE_APPEND = Array.from({ length: 90 }, (_, i) => `Standing rule ${i + 1}: keep answers short, precise and in plain English; never invent facts.`).join("\n");
export function judgeCt08(o: { appendChars: number; cacheReads: number[] }): CheckOutcome {
  const need = Math.floor((0.8 * o.appendChars) / 4);
  const ok = o.cacheReads.length >= 2 && o.cacheReads.every((c) => c >= need);
  return ok
    ? { status: "pass", detail: `cache_read ${o.cacheReads.join(", ")} ≥ ${need}` }
    : { status: "fail", detail: `cache_read ${o.cacheReads.join(", ")} < ${need}`, flags: { promptCacheOk: false } };
}
export const ct08: ConformanceCheck = {
  id: "CT-08", title: "Prompt cache holds across resumes", onThrow: { promptCacheOk: false },
  async run(ctx) {
    // The prompt a Bot actually runs under: standalone by default since 2026-09-21, the preset under
    // the box owner's SYNAPSE_SYSTEM_PROMPT=preset. Either way the append is the byte-identical tail.
    const sys = buildSystemPrompt(systemPromptModeFor(ctx.cfg, "conformance"), CACHE_APPEND);
    const t1 = await runProbe(ctx, { prompt: "Reply OK.", options: { tools: [], persistSession: true, systemPrompt: sys } });
    const sid = t1.init?.session_id as string;
    const reads: number[] = [];
    for (const text of ["Reply TWO.", "Reply THREE."]) {
      const r = await runProbe(ctx, { prompt: text, options: { tools: [], persistSession: true, resume: sid, systemPrompt: sys } });
      reads.push(Number(r.results.at(-1)?.usage?.cache_read_input_tokens ?? 0));
    }
    return judgeCt08({ appendChars: CACHE_APPEND.length, cacheReads: reads });
  },
};

// ---------- CT-09 · tool-less one-shot really has no tools (reviewer, rule compiler) ----------
export function judgeCt09(o: { tools: string[] }): CheckOutcome {
  const extra = o.tools.filter((t) => t !== "StructuredOutput");
  return extra.length === 0
    ? { status: "pass", detail: "no tools besides StructuredOutput" }
    : { status: "fail", detail: `unexpected tools: ${extra.join(", ")}`, flags: { extraDisallowed: extra } };
}
export const ct09: ConformanceCheck = {
  id: "CT-09", title: "Tool-less one-shot has no tools", onThrow: {},
  async run(ctx) {
    const run = await runProbe(ctx, {
      prompt: 'Return {"ok": true}.',
      options: {
        tools: [], mcpServers: {}, maxTurns: 2, systemPrompt: "You return JSON only.",
        outputFormat: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
      },
    });
    return judgeCt09({ tools: run.init?.tools ?? [] });
  },
};

// ---------- CT-10 · a process opened ahead of its message hides CLI start-up (reviewer prewarm, ORIG-01 §01.9) ----------
// rev 2 (TTFT war room): rev 1 waited for a system/init before the first message, but the CLI emits init at the start
// of each turn, so it failed although the process had started (bench: push → API request 52 ms prewarmed, ~330 ms cold).
// Now: the process must start before the push (countingSpawn) and answer the push in under half a cold start's time.
// Review fix round 1: both times must be finite and both runs must reach a result (an instantly exiting CLI is not a
// fast one); a cold start under CT10_MIN_COLD_MS is not believable either. A timeout is transient (no verdict).
export const CT10_MIN_COLD_MS = 50;
export interface Ct10Run { ms: number; spawnedBeforePush: boolean; answered: boolean }
export function judgeCt10(o: { cold: Ct10Run; prewarmed: Ct10Run }): CheckOutcome {
  const { cold, prewarmed } = o;
  const detail = `spawned before push: ${prewarmed.spawnedBeforePush}; push → first message ${Math.round(prewarmed.ms)} ms prewarmed vs ${Math.round(cold.ms)} ms cold`;
  if (!Number.isFinite(cold.ms) || !Number.isFinite(prewarmed.ms)) return { status: "fail", detail: `timed out — ${detail}`, flags: { prewarm: false }, transient: true };
  if (!cold.answered || !prewarmed.answered) return { status: "fail", detail: `the CLI ended without a result — ${detail}`, flags: { prewarm: false } };
  const ok = prewarmed.spawnedBeforePush && cold.ms >= CT10_MIN_COLD_MS && prewarmed.ms <= 0.5 * cold.ms;
  return ok ? { status: "pass", detail } : { status: "fail", detail, flags: { prewarm: false } };
}
/** Opens a query, optionally waits, pushes one message; push → first SDK message (ms), whether the CLI started before
 *  the push, and whether a result arrived at all (an early end is `answered: false`, never a fast answer). */
async function timeFirstMessage(ctx: ConformanceContext, waitMs: number): Promise<Ct10Run> {
  const input = new AsyncQueue<SDKUserMessage>();
  const spawned = countingSpawn(ctx);
  const q = ctx.queryFn({ prompt: input, options: ctx.baseOptions({ tools: [], spawnClaudeCodeProcess: spawned.spawnClaudeCodeProcess }) });
  if (waitMs > 0) await sleep(waitMs);
  const spawnedBeforePush = spawned.count() > 0;
  const t0 = Date.now();
  input.push(userMessage("Reply OK."));
  input.end();
  const it = q[Symbol.asyncIterator]();
  let answered = false;
  const first = await Promise.race([
    it.next().then((r) => { if (!r.done && (r.value as { type?: string }).type === "result") answered = true; return r.done ? Number.NaN : Date.now() - t0; }),
    sleep(60_000).then(() => Number.POSITIVE_INFINITY),
  ]);
  const drain = (async () => { for (;;) { const r = await it.next(); if (r.done) break; if ((r.value as { type?: string }).type === "result") answered = true; } })().catch(() => {});
  await Promise.race([drain, sleep(60_000)]);
  q.close();
  // An iterator that ended before any message: no answer at all (NaN is not finite, so mark it unanswered, not timed out).
  return { ms: Number.isNaN(first) ? 0 : first, spawnedBeforePush, answered: answered && !Number.isNaN(first) };
}
export const ct10: ConformanceCheck = {
  id: "CT-10", title: "Prewarm: an opened process hides start-up", onThrow: { prewarm: false },
  rev: 2,
  async run(ctx) {
    await timeFirstMessage(ctx, 0); // warm-up, discarded: the first CLI start of a boot pays disk and cache costs the rest don't
    const wait = ctx.prewarmWaitMs ?? 6000;
    const coldFirst = (ctx.random ?? Math.random)() < 0.5; // no systematic order bias between the two measured runs
    const a = await timeFirstMessage(ctx, coldFirst ? 0 : wait);
    const b = await timeFirstMessage(ctx, coldFirst ? wait : 0);
    return judgeCt10({ cold: coldFirst ? a : b, prewarmed: coldFirst ? b : a });
  },
};

// ---------- CT-11 · CLI as another Unix user (SEC-08, §13.6) ----------
export function judgeCt11(runAs: ConformanceFlags["runAs"], o: { output: string; boxUid: number | null }): boolean {
  const uid = o.output.split("\n")[0]?.trim();
  if (runAs === "setpriv") return uid === String(o.boxUid) && /Permission denied/.test(o.output);
  if (runAs === "bwrap") return /No such file|Permission denied/.test(o.output);
  return true; // same-uid: last resort, isolated only by the PreToolUse path guard
}
export const ct11: ConformanceCheck = {
  id: "CT-11", title: "Run the CLI as user box", onThrow: { runAs: "same-uid" },
  async run(ctx) {
    const boxUid = await ctx.boxUid();
    for (const runAs of ["setpriv", "bwrap", "same-uid"] as const) {
      const run = await runProbe(ctx, {
        prompt: "Run exactly this Bash command and reply with its complete output and nothing else: id -u; cat /home/box/.host/gateway.json 2>&1 | head -c 120",
        options: { tools: ["Bash"], canUseTool: allowAll, pathToClaudeCodeExecutable: claudeExecutableFor(runAs, ctx.cfg) },
      }).catch(() => null);
      const output = run?.toolResults.at(-1)?.text ?? "";
      if (run && judgeCt11(runAs, { output, boxUid })) {
        if (runAs === "setpriv") return { status: "pass", detail: `child uid ${boxUid}; .host unreadable` };
        return { status: "fail", detail: runAs === "bwrap" ? "setpriv failed; using bwrap" : "setpriv and bwrap failed; same uid with path guard only (reduced isolation)", flags: { runAs } };
      }
    }
    return { status: "fail", detail: "no run-as option worked", flags: { runAs: "same-uid" } };
  },
};

// ---------- CT-12 · per-tool disable for claude.ai connectors (PLG-02) ----------
export function judgeCt12(o: { connectorTool: string | null; goneWithSettings: boolean; goneWithDisallowed: boolean }): CheckOutcome {
  if (!o.connectorTool) return { status: "n/a", detail: "no claude.ai connector tools in this session" };
  if (o.goneWithSettings) return { status: "pass", detail: `${o.connectorTool} removed by a managed-settings deny rule` };
  return o.goneWithDisallowed
    ? { status: "fail", detail: "settings deny ignored; disallowedTools works", flags: { connectorToolDisable: "disallowedTools" } }
    : { status: "fail", detail: "tool stays listed; PreToolUse deny only", flags: { connectorToolDisable: "hook" } };
}
export const ct12: ConformanceCheck = {
  id: "CT-12", title: "Per-tool disable for claude.ai connectors", onThrow: { connectorToolDisable: "hook" },
  async run(ctx) {
    const d = await runProbe(ctx, { prompt: "Reply OK.", options: { tools: [] } });
    const connectorTool = ((d.init?.tools ?? []) as string[]).find((t) => t.startsWith("mcp__claude_ai_")) ?? null;
    if (!connectorTool) return judgeCt12({ connectorTool: null, goneWithSettings: false, goneWithDisallowed: false });
    const s = await runProbe(ctx, { prompt: "Reply OK.", options: { tools: [], managedSettings: { permissions: { deny: [connectorTool] } } as never } });
    const x = await runProbe(ctx, { prompt: "Reply OK.", options: { tools: [], disallowedTools: [...DISALLOWED_TOOLS, connectorTool] } });
    return judgeCt12({
      connectorTool,
      goneWithSettings: !((s.init?.tools ?? []) as string[]).includes(connectorTool),
      goneWithDisallowed: !((x.init?.tools ?? []) as string[]).includes(connectorTool),
    });
  },
};
