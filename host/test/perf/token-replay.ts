import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { ProviderBrain } from "../../brain/provider/provider-brain";
import { ProviderSessionStore } from "../../brain/provider/session-store";
import type { BotToolDef, BrainWiring } from "../../brain/types";
import { applyEdit, prepareTask, referenceDir } from "../../bench/coding/repo";
import { promptFor, sessionsFor, TASKS, type Task, type TextEdit } from "../../bench/coding/suite";
import { providerLoopEngine } from "../../coding/engines/provider-loop";
import type { CodingShell } from "../../coding/engines/coding-tools";
import { setUsageSink } from "../../usage/metered-query";
import { localBotFile } from "../../walls/bot-file";
import { startFakeMessagesServer, type MsgReply, type MsgRequest } from "../brain/provider/fake-messages-server";
import { startProviderRuntime } from "../brain/provider/runtime";

/**
 * THE TOKEN ACCOUNTING HARNESS for Synapse's own engine (0.1.8 "close the coding token gap").
 *
 * The 14 coding-bench tasks are replayed on Synapse's engine with a FAKE MODEL that issues a realistic, CLI-shaped
 * sequence of tool calls: it reads the files the task is about, searches with Grep/Glob, applies the task's reference
 * solution with Edit/Write (so the history carries real code), runs the tests (canned vitest output of realistic size)
 * and reports. 76 model calls over the 14 tasks: the Claude Code CLI's own count on the same suite (decisions.md
 * 2026-09-30, CLI 2.1.285, sonnet-5-5: 14/14, 76 calls, per-call floor 17,486 billed tokens).
 *
 * Every request goes through the real engine and the real Anthropic Messages adapter to the fake Messages API, which
 * simulates the prompt cache from the request bytes and their breakpoints (fake-messages-server.ts). Each request is
 * broken down by category: system prompt, tool definitions (loaded / deferred), the task prompt, the model's own
 * turns, tool results, and injected reminders; with cache read / write / uncached.
 *
 * Tokens: no offline Claude tokenizer ships in this repo, so characters are converted at the ratios the CLI's own
 * count_tokens-based /context accounting measured on this codebase (prompt-budget.test.ts): prose 4.0 chars per
 * token (the Bot append: 9,440 chars -> 2,360 tokens), tool definitions 2.0 (the bot tool schemas: 14,921 chars ->
 * 7,465 tokens), and conversation (code, tool I/O) 3.5. Cache shares come from the simulation. The before/after
 * comparison is exact in characters; the token figures carry the ratios' error.
 */

export const CLI_BASELINE = {
  source: "decisions.md 2026-09-30 (battle plan 5.1): claude -p 2.1.285, claude-sonnet-5-5, 14 bench tasks",
  floorPerCall: 17_486,
  calls: 76,
  weighted: 413_000,
  output: 63_000,
  passed: 14,
} as const;
export const RATIO = { prose: 4.0, tools: 2.0, conversation: 3.5 } as const;

export type Category = "system" | "tools" | "toolsOnDemand" | "prompt" | "assistant" | "toolResults" | "injections";
export const CATEGORIES: Category[] = ["system", "tools", "toolsOnDemand", "prompt", "assistant", "toolResults", "injections"];
export interface CallRow {
  task: string;
  chars: Record<Category, number>;
  tokens: Record<Category, number>;
  total: number;
  /** Tool definitions sent with defer_loading (not in the model's context, not billed). */
  deferredChars: number;
  cache: { read: number; write: number; fresh: number };
  weighted: number;
  /** Tool definitions in the prompt (not deferred). */
  toolCount: number;
  toolsUsed: string[];
}

const zero = (): Record<Category, number> => ({ system: 0, tools: 0, toolsOnDemand: 0, prompt: 0, assistant: 0, toolResults: 0, injections: 0 });
const strip = (b: unknown): unknown => {
  if (!b || typeof b !== "object" || Array.isArray(b)) return b;
  const { cache_control: _c, ...rest } = b as Record<string, unknown>;
  return rest;
};

/** One Messages request, by category (characters of canonical JSON, cache_control left out, as the cache sim counts). */
export function accountRequest(body: Record<string, unknown>): { chars: Record<Category, number>; deferredChars: number } {
  const chars = zero();
  let deferredChars = 0;
  const byName = new Map<string, number>();
  for (const t of (body.tools as Record<string, unknown>[] | undefined) ?? []) {
    const n = JSON.stringify(strip(t)).length;
    if (t.defer_loading) { deferredChars += n; byName.set(String(t.name), n); } else chars.tools += n;
  }
  const sys = body.system;
  if (typeof sys === "string") chars.system += sys.length;
  else for (const b of (sys as { text?: string }[] | undefined) ?? []) chars.system += JSON.stringify(strip(b)).length;
  const loaded = new Set<string>();
  for (const m of (body.messages as { role: string; content: unknown }[] | undefined) ?? []) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Record<string, unknown>[]);
    for (const b of content) {
      const n = JSON.stringify(strip(b)).length;
      if (m.role === "assistant") { chars.assistant += n; continue; }
      if (b.type === "tool_result") {
        chars.toolResults += n;
        for (const r of Array.isArray(b.content) ? (b.content as Record<string, unknown>[]) : []) {
          if (r.type === "tool_reference" && !loaded.has(String(r.tool_name))) { loaded.add(String(r.tool_name)); chars.toolsOnDemand += byName.get(String(r.tool_name)) ?? 0; }
        }
      } else if (b.type === "text" && typeof b.text === "string" && b.text.startsWith("<system-reminder>")) chars.injections += n;
      else if (b.type === "text") chars.prompt += n;
      else chars.toolResults += n;
    }
  }
  return { chars, deferredChars };
}

export function toTokens(chars: Record<Category, number>): Record<Category, number> {
  const t = zero();
  t.system = Math.round(chars.system / RATIO.prose);
  t.tools = Math.round(chars.tools / RATIO.tools);
  t.toolsOnDemand = Math.round(chars.toolsOnDemand / RATIO.tools);
  for (const k of ["prompt", "assistant", "toolResults", "injections"] as const) t[k] = Math.round(chars[k] / RATIO.conversation);
  return t;
}

export function rowFor(task: string, r: MsgRequest, sim: { input: number; read: number; write: number; total: number }): CallRow {
  const { chars, deferredChars } = accountRequest(r.body);
  const tokens = toTokens(chars);
  const total = Object.values(tokens).reduce((a, b) => a + b, 0);
  const share = (x: number) => (sim.total ? x / sim.total : 0);
  const read = Math.round(total * share(sim.read));
  const write = Math.round(total * share(sim.write));
  const fresh = total - read - write;
  const toolCount = ((r.body.tools as { defer_loading?: boolean }[] | undefined) ?? []).filter((t) => !t.defer_loading).length;
  return { task, chars, tokens, total, deferredChars, cache: { read, write, fresh }, weighted: fresh + 1.25 * write + 0.1 * read, toolsUsed: [], toolCount };
}

// ---------------------------------------------------------------------------------------------------------------
// The scripts
// ---------------------------------------------------------------------------------------------------------------

export interface ScriptCall { tool: "Read" | "Write" | "Edit" | "Glob" | "Grep" | "Bash" | "TodoWrite"; input: Record<string, unknown> }
export type ScriptStep = { calls: ScriptCall[] } | { text: string };

const read = (file_path: string): ScriptCall => ({ tool: "Read", input: { file_path } });
const grep = (pattern: string, extra: Record<string, unknown> = {}): ScriptCall => ({ tool: "Grep", input: { pattern, ...extra } });
const glob = (pattern: string): ScriptCall => ({ tool: "Glob", input: { pattern } });
const bash = (command: string): ScriptCall => ({ tool: "Bash", input: { command } });
const TEST_FAIL = bash("npm test 2>&1 | tail -30");
const VERIFY = bash("npm test 2>&1 | tail -15 && npx tsc --noEmit");

function refEdits(id: string): TextEdit[] {
  const f = path.join(referenceDir(id), "edits.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as TextEdit[]) : [];
}
function refFile(id: string, rel: string): string { return fs.readFileSync(path.join(referenceDir(id), rel), "utf8"); }
/** The task's reference edits for one file, as one message of Edit calls (the CLI sends a file's edits one by one or together). */
function edits(id: string, file: string): ScriptCall[] {
  return refEdits(id).filter((e) => e.file === file).map((e) => ({ tool: "Edit" as const, input: { file_path: e.file, old_string: e.find, new_string: e.replace } }));
}
const write = (id: string, rel: string): ScriptCall => ({ tool: "Write", input: { file_path: rel, content: refFile(id, rel) } });

/** CLI-shaped scripts: 76 model calls over the 14 tasks (a step is one model call; its calls run as one batch). */
export function scriptFor(id: string): ScriptStep[] {
  const done = (s: string) => ({ text: s });
  switch (id) {
    case "T01": return [{ calls: [read("src/csv.ts"), read("test/csv-quotes.test.ts")] }, { calls: [TEST_FAIL] }, { calls: [write("T01", "src/csv.ts")] }, { calls: [VERIFY] },
      done("Fixed `parseCsv` in src/csv.ts: a character-level parser now reads doubled quotes as one quote and keeps commas and line breaks inside quoted fields. `npm test` passes and `tsc --noEmit` is clean; the tests are unchanged.")];
    case "T02": return [{ calls: [read("src/money.ts"), read("test/allocate-sum.test.ts")] }, { calls: [TEST_FAIL] }, { calls: edits("T02", "src/money.ts") }, { calls: [VERIFY] },
      done("`allocate` now hands the leftover cents to the first shares, as its doc comment says, so the shares always add up to the total. `npm test` passes.")];
    case "T03": return [{ calls: [read("test/aging-boundary.test.ts"), grep("daysBetween", { output_mode: "content", "-n": true })] }, { calls: [read("src/dates.ts"), read("src/report.ts")] }, { calls: [TEST_FAIL] },
      { calls: edits("T03", "src/dates.ts") }, { calls: [VERIFY] },
      done("The bug was an off-by-one in `daysBetween` (src/dates.ts), which also skewed late fees; the bucket bounds in config.ts were right. Fixed there; `npm test` passes.")];
    case "T04": return [{ calls: [read("src/invoice.ts"), read("test/invoice.test.ts")] }, { calls: [grep("percentOf", { output_mode: "content", "-n": true })] }, { calls: edits("T04", "src/invoice.ts") },
      { calls: [write("T04", "test/discount.test.ts")] }, { calls: [VERIFY] },
      done("Added `discountPercent` to `Invoice`, a per-line discount before tax in `invoiceTotals`, `Totals.discount`, and the validation. New tests in test/discount.test.ts; `npm test` and the type check pass.")];
    case "T05": return [{ calls: [read("src/csv.ts"), read("test/csv.test.ts")] }, { calls: edits("T05", "src/csv.ts") }, { calls: [bash("npm test 2>&1 | tail -15")] }, { calls: [VERIFY] },
      done("`parseCsv` and `stringifyCsv` take `{ delimiter }` (default \",\", exactly one character or a RangeError), and fields containing the delimiter are quoted. Tests added; everything passes.")];
    case "T06": return [{ calls: [read("src/tax.ts"), read("test/tax.test.ts")] }, { calls: [write("T06", "src/tax.ts")] }, { calls: [VERIFY] },
      done("`taxFor` now reads the exported `TAX_RULES` table; no switch is left in src/tax.ts. Same parts, names, rates, order and rounding; `npm test` and the type check pass.")];
    case "T07": return [{ calls: [grep("\\bname\\b", { output_mode: "content", "-n": true, glob: "*.ts" })] }, { calls: [read("src/customers.ts"), read("src/seed.ts"), read("test/customers.test.ts")] },
      { calls: edits("T07", "src/customers.ts") }, { calls: edits("T07", "src/seed.ts") }, { calls: edits("T07", "test/customers.test.ts") }, { calls: [VERIFY] },
      done("Renamed `Customer.name` to `legalName` across the type, the code, the seed data and the tests; no alias. Reports and CSV exports print the same text. `npm test` and `npm run typecheck` pass.")];
    case "T08": return [{ calls: [read("src/cache.ts"), read("test/cache.test.ts")] }, { calls: [write("T08", "test/cache.test.ts")] }, { calls: [bash("npx vitest run test/cache.test.ts 2>&1 | tail -15")] },
      done("test/cache.test.ts now pins recency (get/set refresh, has/peek don't), eviction order, updates, the evicted counter, delete, clear and keys() order. src/cache.ts is unchanged; the tests pass.")];
    case "T09": return [{ calls: [grep("late", { "-i": true })] }, { calls: [read("src/ledger.ts"), read("src/config.ts")] }, { calls: [write("T09", "answers/late-fee.json")] },
      done("Wrote answers/late-fee.json: the late fee is computed by `lateFee` in src/ledger.ts, with the grace period and cap from the default config.")];
    case "T10": return [{ calls: [bash("npm test 2>&1 | tail -40")] }, { calls: [bash("git log --oneline -5 && git show --stat HEAD | head -20")] }, { calls: [read("src/events.ts")] },
      { calls: edits("T10", "src/events.ts") }, { calls: [VERIFY] },
      done("CI failed because `Emitter` in src/events.ts dropped listeners added during an emit. Fixed in the source; no tests changed. `npm test` passes.")];
    case "T11": return [{ calls: [read("test/events.test.ts")] }, { calls: [write("T11", "test/regression.test.ts")] }, { calls: [bash("npx vitest run test/regression.test.ts 2>&1 | tail -12")] },
      done("Added test/regression.test.ts; it fails on the old events.ts and passes now. Nothing in src/ changed.")];
    case "T12": return [{ calls: [read("src/ledger.ts"), read("src/events.ts"), read("src/index.ts")] }, { calls: [read("test/ledger.test.ts")] }, { calls: edits("T12", "src/ledger.ts") },
      { calls: [write("T12", "src/payments-log.ts"), ...edits("T12", "src/index.ts")] }, { calls: [write("T12", "test/payments-log.test.ts")] }, { calls: [VERIFY] },
      done("`Ledger.events` emits `invoice.issued` and `invoice.paid` after the change is stored (nothing on a throw); `LedgerEvents` is exported. New src/payments-log.ts (`PaymentsLog`: totalOn, entries, stop), exported from src/index.ts, with tests. All pass.")];
    case "T13": return [{ calls: [read("src/invoice.ts"), read("src/csv.ts"), read("src/money.ts"), read("src/index.ts")] }, { calls: [glob("test/**/*.ts")] }, { calls: [write("T13", "src/import.ts"), ...edits("T13", "src/index.ts")] },
      { calls: [write("T13", "test/import.test.ts")] }, { calls: [bash("npx vitest run test/import.test.ts 2>&1 | tail -20")] }, { calls: [VERIFY] },
      done("Added `importInvoices` in src/import.ts (exported from src/index.ts): header in any order, rows grouped by id in first-seen order, every bad row reported with its line, invalid invoices dropped with one error. Tests added; all pass.")];
    case "T14": return [{ calls: [read("test/directory-cache.test.ts"), read("src/customers.ts")] }, { calls: [read("src/cache.ts")] }, { calls: [TEST_FAIL] }, { calls: edits("T14", "src/cache.ts") }, { calls: [VERIFY] },
      done("`LruCache.get` no longer refreshed an entry's recency, so hot customers were evicted and fetched again. Fixed in src/cache.ts; `npm test` passes.")];
    default: throw new Error(`no script for ${id}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Canned shell output (realistic sizes: vitest's own format)
// ---------------------------------------------------------------------------------------------------------------

const TEST_FILES = ["cache", "csv", "customers", "dates", "events", "invoice", "ledger", "money", "report", "tax"];
function vitestPass(extra: string[] = []): string {
  const files = [...TEST_FILES.map((f) => `test/${f}.test.ts`), ...extra];
  return [
    "", " RUN  v3.2.4 /repo", "",
    ...files.map((f, i) => ` ✓ ${f} (${4 + (i * 3) % 9} tests) ${3 + i}ms`), "",
    ` Test Files  ${files.length} passed (${files.length})`, `      Tests  ${files.length * 7} passed (${files.length * 7})`,
    "   Start at  10:02:43", "   Duration  612ms (transform 201ms, setup 0ms, collect 390ms, tests 88ms, environment 1ms, prepare 612ms)", "",
  ].join("\n");
}
function vitestFail(file: string): string {
  return [
    "", " RUN  v3.2.4 /repo", "",
    ...TEST_FILES.map((f, i) => ` ✓ test/${f}.test.ts (${4 + (i * 3) % 9} tests) ${3 + i}ms`),
    ` ❯ ${file} (3 tests | 2 failed) 9ms`, "   × reads the boundary case 4ms", "     → expected 2 to be 1 // Object.is equality", "   × keeps the documented contract 2ms", "",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯", "", ` FAIL  ${file} > reads the boundary case`, "AssertionError: expected 2 to be 1 // Object.is equality", "",
    "- Expected", "+ Received", "", "- 1", "+ 2", "", ` ❯ ${file}:14:32`, "     12|   const r = run(fixture);", "     13|   expect(r.rows).toHaveLength(3);",
    "     14|   expect(r.bucket).toBe(1);", "       |                    ^", "     15| });", "", "⎯⎯⎯⎯⎯⎯⎯[1/2]⎯", "",
    " Test Files  1 failed | 10 passed (11)", "      Tests  2 failed | 70 passed (72)", "   Duration  655ms", "",
  ].join("\n");
}
/** The bench's commands, answered with output of the size the real ones print. */
export const cannedShell: CodingShell = async (_b, _a, r) => {
  const c = r.command;
  let out: string;
  if (/tail -(30|40)/.test(c)) out = vitestFail("test/failing.test.ts");
  else if (c.includes("git log")) out = "3f2a1c9 events: batch listener calls\n8b7e2d0 ledger 0.4.0\n\ncommit 3f2a1c9\n src/events.ts | 14 +++++++++-----\n 1 file changed, 9 insertions(+), 5 deletions(-)";
  else if (c.startsWith("npx vitest run")) out = vitestPass().split("\n").slice(0, 8).join("\n");
  else out = vitestPass();
  return { text: `${out}\n[exit code ${/tail -(30|40)/.test(c) ? 1 : 0} · 1.2 s · cwd ${r.cwd}]`, cwd: r.cwd };
};

// ---------------------------------------------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------------------------------------------

export interface ReplayResult { rows: CallRow[]; perTask: Map<string, number>; toolErrors: string[] }
const MODEL = "claude-sonnet-5-5";

/** The fake model: the task's script step `after` model calls into the turn; Bash is renamed for a Bot (Shell). */
function modelFor(tasks: Map<string, ScriptStep[]>, o: { shellName: string; finalVia?: "SendMessage"; absDir?: () => string }) {
  const abs = (input: Record<string, unknown>) => (o.absDir && typeof input.file_path === "string" ? { ...input, file_path: path.join(o.absDir(), input.file_path) } : input);
  let last = "";
  return (r: MsgRequest): MsgReply => {
    const msgs = r.body.messages as { role: string; content: { type: string; text?: string }[] }[];
    // The turn's prompt: the last user message with plain text (not a tool result, not a reminder).
    let i = msgs.length - 1;
    for (; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === "user" && m.content.some((b) => b.type === "text" && b.text && !b.text.startsWith("<system-reminder>"))) break;
    }
    const prompt = i >= 0 ? msgs[i]!.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
    const after = msgs.slice(i + 1).filter((m) => m.role === "assistant").length;
    const id = [...tasks.keys()].find((k) => prompt.includes(TASKS.find((t) => t.id === k)!.prompt.slice(0, 80))) ?? last;
    last = id;
    const step = tasks.get(id)![after];
    if (!step) return { blocks: [{ text: "Done." }] };
    if ("text" in step) return o.finalVia ? { blocks: [{ tool: o.finalVia, input: { content: step.text, end_turn: true } }] } : { blocks: [{ text: step.text }] };
    return { blocks: step.calls.map((c) => ({ tool: c.tool === "Bash" ? o.shellName : c.tool, input: c.tool === "Bash" ? { command: c.input.command } : abs(c.input) })) };
  };
}

/** Where a task's calls start in the request log (the fake server's order). */
function taskOf(tasks: Map<string, ScriptStep[]>, r: MsgRequest): string {
  const msgs = r.body.messages as { role: string; content: { type: string; text?: string }[] }[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const text = m.role === "user" ? m.content.filter((b) => b.type === "text" && b.text && !b.text.startsWith("<system-reminder>")).map((b) => b.text).join("\n") : "";
    if (!text) continue;
    const id = [...tasks.keys()].find((k) => text.includes(TASKS.find((t) => t.id === k)!.prompt.slice(0, 80)));
    if (id) return id;
  }
  return "?";
}

async function withRepo<T>(session: Task[], fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tok-replay-")));
  try {
    prepareTask(session[0]!, dir, { nodeModules: null });
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The provider-loop coding engine (a Bot's coding agent), on a Claude model, over the 14 tasks. */
export async function replayCodingEngine(): Promise<ReplayResult> {
  const scripts = new Map(TASKS.map((t) => [t.id, scriptFor(t.id)]));
  const up = await startFakeMessagesServer(modelFor(scripts, { shellName: "Bash" }));
  const rt = await startProviderRuntime({ anthropicUpstream: up.url });
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "tok-replay-hp-"));
  setUsageSink({ record: () => {}, lastTotals: () => null, noteTotals: () => {} });
  try {
    for (const session of sessionsFor(TASKS.map((t) => t.id))) {
      await withRepo(session, async (dir) => {
        const engine = providerLoopEngine({ hostPrivate: hp, gate: async () => ({ behavior: "allow" }), files: localBotFile({ deny: [hp] }), shell: cannedShell, store: new ProviderSessionStore(hp, Date.now) });
        let sid: string | undefined;
        for (const task of session) {
          const child = engine.start({ botId: "bench", agentId: `bench-${session[0]!.id}`, cwd: dir, model: MODEL, prompt: `Task:\n${promptFor(task, dir)}`, ...(sid ? { resumeSessionId: sid } : {}) });
          for await (const m of child.messages) if (m.type === "result") break;
          sid = child.sessionId?.() ?? sid;
          child.close();
        }
      });
    }
  } finally {
    setUsageSink(null);
    await rt.stop();
    await up.close();
    fs.rmSync(hp, { recursive: true, force: true });
  }
  return collect(scripts, up.requests, up.usages);
}

/** What an engineering-mode Bot on Synapse's own loop is given: its system prompt and its tool surface. */
export interface BotProfile {
  system: string;
  /** The Bot's tools (bot tools bare-named, SendMessage first); handlers for Shell are replaced by the canned shell. */
  botTools: BotToolDef[];
  builtins(cwd: string): { canonical: string; def: BotToolDef }[];
  mcp: { canonical: string; def: BotToolDef; jsonSchema: Record<string, unknown> }[];
  upFront?: readonly string[] | null;
}

/** An engineering-mode Bot on ProviderBrain (Claude through the Messages adapter), over the 14 tasks. */
export async function replayEngineeringBot(profile: BotProfile): Promise<ReplayResult> {
  const scripts = new Map(TASKS.map((t) => [t.id, scriptFor(t.id)]));
  let cur = "";
  const up = await startFakeMessagesServer(modelFor(scripts, { shellName: "Shell", finalVia: "SendMessage", absDir: () => cur }));
  const rt = await startProviderRuntime({ anthropicUpstream: up.url });
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "tok-replay-hp-"));
  setUsageSink({ record: () => {}, lastTotals: () => null, noteTotals: () => {} });
  try {
    for (const session of sessionsFor(TASKS.map((t) => t.id))) {
      await withRepo(session, async (dir) => {
        cur = dir;
        const shell: BotToolDef = { ...profile.botTools.find((t) => t.name === "Shell")!, handler: async (a) => cannedShell("b", "a", { command: String(a.command), cwd: dir, timeoutMs: 1, signal: new AbortController().signal }) };
        const tools = profile.botTools.map((t) => (t.name === "Shell" ? shell : t.name === "SendMessage" ? { ...t, handler: async () => ({ text: "Sent." }) } : t));
        const wiring: BrainWiring = {
          preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}), stop: async () => ({ block: false }),
          toolBatch: async (calls) => ({ endTurn: calls.some((c) => c.toolName === "mcp__bot__SendMessage") }),
          botTools: () => tools, flags: () => DEFAULT_FLAGS,
          turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
        };
        let sid: string | null = null;
        const brain = new ProviderBrain({
          botId: "bench", wiring, store: new ProviderSessionStore(hp, Date.now), getSessionId: () => sid, setSessionId: (s) => { sid = s; },
          systemPrompt: () => profile.system, builtinTools: () => profile.builtins(dir), mcpTools: async () => profile.mcp,
          ...(profile.upFront !== undefined ? { upFrontTools: () => profile.upFront ?? null } : {}),
          cacheTtl: () => "1h", effort: () => "high", sleep: async () => {},
        } as ConstructorParameters<typeof ProviderBrain>[0]);
        for (const task of session) {
          await brain.runTurn({ prompt: [{ text: promptFor(task, dir) }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: task.id, systemAppend: "", model: MODEL, autoReviewEpoch: "continue" },
            (e) => { if (e.kind === "session") sid = e.sessionId; });
        }
      });
    }
  } finally {
    setUsageSink(null);
    await rt.stop();
    await up.close();
    fs.rmSync(hp, { recursive: true, force: true });
  }
  return collect(scripts, up.requests, up.usages);
}

function collect(scripts: Map<string, ScriptStep[]>, requests: MsgRequest[], usages: { input: number; read: number; write: number; total: number }[]): ReplayResult {
  const rows: CallRow[] = [];
  const perTask = new Map<string, number>();
  const toolErrors: string[] = [];
  const seen = new Set<string>();
  requests.forEach((r, i) => {
    for (const m of r.body.messages as { role: string; content: { type: string; tool_use_id?: string; is_error?: boolean; content?: { text?: string }[] }[] }[]) {
      for (const b of m.content) if (b.type === "tool_result" && b.is_error && !seen.has(String(b.tool_use_id))) { seen.add(String(b.tool_use_id)); toolErrors.push(String(b.content?.[0]?.text ?? "").slice(0, 200)); }
    }
    const task = taskOf(scripts, r);
    const row = rowFor(task, r, usages[i]!);
    const last = (r.body.messages as { role: string; content: { type: string; name?: string }[] }[]).filter((m) => m.role === "assistant").at(-1);
    row.toolsUsed = (last?.content ?? []).filter((b) => b.type === "tool_use").map((b) => String(b.name));
    rows.push(row);
    perTask.set(task, (perTask.get(task) ?? 0) + 1);
  });
  return { rows, perTask, toolErrors };
}

// ---------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------

export interface Summary {
  calls: number;
  floor: { system: number; tools: number; total: number; toolChars: number; toolCount: number; systemChars: number };
  perCallAvg: Record<Category, number> & { total: number };
  session: Record<Category, number> & { total: number; read: number; write: number; fresh: number; weighted: number };
  deferredChars: number;
}

export function summarize(r: ReplayResult): Summary {
  const s = { ...zero(), total: 0, read: 0, write: 0, fresh: 0, weighted: 0 };
  for (const row of r.rows) {
    for (const k of CATEGORIES) s[k] += row.tokens[k];
    s.total += row.total; s.read += row.cache.read; s.write += row.cache.write; s.fresh += row.cache.fresh; s.weighted += row.weighted;
  }
  s.weighted = Math.round(s.weighted);
  const n = r.rows.length || 1;
  const avg = { ...zero(), total: Math.round(s.total / n) };
  for (const k of CATEGORIES) avg[k] = Math.round(s[k] / n);
  const first = r.rows[0]!;
  return {
    calls: r.rows.length, perCallAvg: avg, session: s, deferredChars: first.deferredChars,
    floor: { system: first.tokens.system, tools: first.tokens.tools, total: first.tokens.system + first.tokens.tools, toolChars: first.chars.tools, toolCount: first.toolCount, systemChars: first.chars.system },
  };
}

/** What the CLI would send for the same conversation: its measured per-call floor on every call, plus the same history. */
export function cliEquivalent(s: Summary): number {
  const conversation = s.session.total - s.session.system - s.session.tools - s.session.toolsOnDemand;
  return CLI_BASELINE.floorPerCall * s.calls + conversation;
}

export function renderTable(label: string, s: Summary): string {
  const lines = [
    `### ${label}`, "",
    `Model calls: ${s.calls} (CLI ${CLI_BASELINE.calls}). Per-call floor (system + tools): ${s.floor.total} tokens (system ${s.floor.system} from ${s.floor.systemChars} chars, ${s.floor.toolCount} tools ${s.floor.tools} from ${s.floor.toolChars} chars${s.deferredChars ? `; ${s.deferredChars} chars of deferred schemas not in the prompt` : ""}); CLI floor ${CLI_BASELINE.floorPerCall} (${Math.round((100 * s.floor.total) / CLI_BASELINE.floorPerCall)}%).`,
    `CLI-equivalent session (the CLI's floor on ${s.calls} calls + this replay's conversation): ${cliEquivalent(s)} input tokens; this engine ${s.session.total} (${Math.round((100 * s.session.total) / cliEquivalent(s))}%).`, "",
    "| Category | Per call (avg) | Per 14-task session |", "|---|---|---|",
    ...CATEGORIES.map((k) => `| ${k} | ${s.perCallAvg[k]} | ${s.session[k]} |`),
    `| **total input** | **${s.perCallAvg.total}** | **${s.session.total}** |`,
    `| cache read | | ${s.session.read} |`, `| cache write | | ${s.session.write} |`, `| uncached | | ${s.session.fresh} |`,
    `| weighted (fresh + 1.25 write + 0.1 read) | | ${s.session.weighted} |`, "",
  ];
  return lines.join("\n");
}

/** Small helper for a synthetic MCP connector set (the probe's 20 connector tools, sized like context7/aws/cloudflare-docs). */
export function syntheticConnectors(n = 20): { canonical: string; def: BotToolDef; jsonSchema: Record<string, unknown> }[] {
  const out: { canonical: string; def: BotToolDef; jsonSchema: Record<string, unknown> }[] = [];
  const servers = ["docs", "cloud", "tracker"];
  for (let i = 0; i < n; i++) {
    const server = servers[i % servers.length]!;
    const name = `${["search", "get", "list", "resolve", "fetch", "describe", "query"][i % 7]}_${["pages", "library", "resources", "issues", "records", "entries"][i % 6]}_${i}`;
    const description = `${["Searches", "Returns", "Lists", "Resolves", "Fetches", "Describes", "Queries"][i % 7]} ${server} ${["documentation pages", "library ids", "cloud resources", "tracker issues", "records", "entries"][i % 6]} matching the given filters. ` +
      "Results are paginated; pass the cursor from a previous answer to continue. Use it when the user asks about this service's content; it never changes anything.";
    const jsonSchema = { type: "object", properties: { query: { type: "string", description: "What to look for, in plain words." }, limit: { type: "number", description: "At most this many results (default 10)." }, cursor: { type: "string", description: "The cursor from the previous page." }, filters: { type: "object", description: "Field filters, as key/value pairs." } }, required: ["query"] };
    out.push({ canonical: `mcp__${server}__${name}`, def: { name, description, readOnly: true, schema: { query: z.string() }, handler: async () => ({ text: "[]" }) }, jsonSchema });
  }
  return out;
}
