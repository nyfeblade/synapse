import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createSdkMcpServer, tool, type HookCallback, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AsyncQueue } from "../../../util/async-queue";
import { log } from "../../../util/log";
import { sleep } from "../../../util/sleep";
import { allowAll, countingSpawn, runProbe, userMessage, waitFor } from "../probe";
import { isTransientError } from "../transient";
import { readSessionFile, removeBoxSession, writeSessionFile } from "../session-file";
import type { CheckOutcome, ConformanceCheck, ConformanceContext } from "../types";

const sessionFile = (ctx: ConformanceContext, sid: string) =>
  path.join(ctx.cfg.claudeConfigDir, "projects", ctx.cfg.workspace.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
// CT-15: the transcript is box-owned (0600 box:bots); bothost has no read bits on it even via the
// shared `bots` group, so this goes through the root-owned bot-claude-read-session helper.
export const sha = (f: string) => createHash("sha256").update(readSessionFile(f)).digest("hex");

// ---------- CT-13 · warm push: two results from one process (ORIG-16) ----------
// "Reply with exactly ONE" is genuinely ambiguous without an object ("one *what*?") — reproduced
// live, the model asked for clarification on every turn. This phrasing removes the ambiguity while
// still matching the judge's /ONE/, /TWO/, /FOUR/ regexes unchanged.
export const CT13_PROMPT_ONE = "Reply with exactly the word ONE, and nothing else.";
export const CT13_PROMPT_TWO = "Reply with exactly the word TWO, and nothing else.";
export const CT13_PROMPT_FOUR = "Reply with exactly the word FOUR, and nothing else.";
/** `spawns`: real CLI process starts (countingSpawn), never `system/init` messages, which come once per turn. */
export function judgeCt13(o: { texts: string[]; spawns: number }): CheckOutcome {
  // Review fix round 1: a run cut short (a turn never answered: rate limit, network, timeout) reached no verdict, unless
  // it had already respawned — that is a real failure whatever else happened.
  if (o.texts.length < 4 && o.spawns <= 1) return { status: "fail", detail: `incomplete: ${o.texts.length} of 4 results`, flags: { warmSessions: false }, transient: true };
  const ok = o.spawns === 1 && o.texts.length === 4 && /ONE/.test(o.texts[0] ?? "") && /TWO/.test(o.texts[1] ?? "") && /FOUR/.test(o.texts[3] ?? "");
  return ok ? { status: "pass", detail: "4 results from one process, including after interrupt" } : { status: "fail", detail: `results: ${JSON.stringify(o.texts)}`, flags: { warmSessions: false } };
}
export const ct13: ConformanceCheck = {
  id: "CT-13", title: "Warm push after result", onThrow: { warmSessions: false },
  // rev 2 (TTFT war room): counts process starts, not per-turn init messages (rev 1 failed every warm run).
  rev: 2,
  async run(ctx) {
    const input = new AsyncQueue<SDKUserMessage>();
    const spawned = countingSpawn(ctx);
    const q = ctx.queryFn({ prompt: input, options: ctx.baseOptions({ tools: ["Bash"], canUseTool: allowAll, persistSession: false, spawnClaudeCodeProcess: spawned.spawnClaudeCodeProcess }) });
    const texts: string[] = [];
    const apiErrors: string[] = [];
    let interrupted = false;
    const pump = (async () => {
      for await (const m of q) {
        const r = m as unknown as { type: string; subtype?: string; result?: string; message?: { content?: { type: string; name?: string }[] }; parent_tool_use_id?: string | null };
        if (r.type === "assistant" && !r.parent_tool_use_id && !interrupted && texts.length === 2 && r.message?.content?.some((b) => b.type === "tool_use")) {
          interrupted = true;
          await q.interrupt();
        }
        if (r.type === "result") {
          texts.push(String(r.result ?? ""));
          if ((r as { is_error?: boolean }).is_error) apiErrors.push(String(r.result ?? ""));
        }
      }
    })().catch((e: unknown) => { apiErrors.push(String(e)); });
    input.push(userMessage(CT13_PROMPT_ONE));
    await waitFor(() => texts.length >= 1, 90_000);
    input.push(userMessage(CT13_PROMPT_TWO));
    await waitFor(() => texts.length >= 2, 90_000);
    input.push(userMessage("Run the Bash command `sleep 15`, then reply DONE."));
    await waitFor(() => texts.length >= 3, 90_000);
    input.push(userMessage(CT13_PROMPT_FOUR));
    await waitFor(() => texts.length >= 4, 90_000);
    input.end();
    await Promise.race([pump, sleep(10_000)]);
    q.close();
    // Review fix round 1: a rate-limited or network-failed turn says nothing about warm push.
    const transientErr = apiErrors.find(isTransientError);
    if (transientErr && spawned.count() <= 1) return { status: "fail", detail: `transient: ${transientErr.slice(0, 120)}`, flags: { warmSessions: false }, transient: true };
    return judgeCt13({ texts, spawns: spawned.count() });
  },
};

// ---------- CT-14 · resume latency vs session size (ORIG-07 §07.5), slow ----------
const MB = 1024 * 1024;
export function judgeCt14(o: { sizes: { bytes: number; ms: number | null }[] }): CheckOutcome {
  const limit = (bytes: number) => (bytes <= 20e6 ? 3000 : 8000);
  const ok = o.sizes.every((s) => s.ms !== null && s.ms < limit(s.bytes));
  if (ok) return { status: "pass", detail: o.sizes.map((s) => `${Math.round(s.bytes / MB)} MB: ${s.ms} ms`).join("; ") };
  const under = o.sizes.filter((s) => s.ms !== null && s.ms < 8000).map((s) => s.bytes);
  return { status: "fail", detail: o.sizes.map((s) => `${Math.round(s.bytes / MB)} MB: ${s.ms ?? "timeout"} ms`).join("; "), flags: { rolloverBytes: under.length ? Math.max(...under) : 8 * MB } };
}
/** Copies a real session under a new id and pads it with extra linked turns until it reaches
 *  targetBytes. `src` is a box-owned session transcript (0600 box:bots), so by default it's read via
 *  the same CT-15 helper (readSessionFile); tests inject a plain fs reader for a locally-created,
 *  non-box-owned template file. `dst` is a NEW box-owned session transcript under the same
 *  `~/.claude/projects` tree, which bothost has no write bits under, so by default it's written via
 *  the CT-14 helper (writeSessionFile); tests inject a plain fs writer for a locally-created,
 *  non-box-owned destination. */
export function synthesizeSession(
  src: string, dst: string, newSessionId: string, targetBytes: number,
  readSrc: (f: string) => string = (f) => readSessionFile(f).toString("utf8"),
  writeDst: (f: string, content: string) => void = writeSessionFile,
): void {
  const recs = readSrc(src).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const out: Record<string, unknown>[] = recs.map((r) => ({ ...r, sessionId: newSessionId }));
  const user = [...recs].reverse().find((r) => r.type === "user");
  const asst = [...recs].reverse().find((r) => r.type === "assistant");
  if (!user || !asst) throw new Error("template session has no user/assistant pair");
  let size = out.reduce((n, r) => n + JSON.stringify(r).length + 1, 0);
  let parent = (out.at(-1)?.uuid as string | undefined) ?? null;
  const pad = "x".repeat(256 * 1024);
  while (size < targetBytes) {
    for (const tmpl of [user, asst]) {
      const uuid = randomUUID();
      const rec = { ...tmpl, uuid, parentUuid: parent, sessionId: newSessionId, botsPadding: pad };
      out.push(rec);
      parent = uuid;
      size += JSON.stringify(rec).length + 1;
    }
  }
  writeDst(dst, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
/** Default CT-14 remover (gate L-5): the root-owned bot-claude-delete-session helper; best-effort, never throws. */
const boxSessionRm = (f: string): void => { removeBoxSession(f); };
/** Best-effort cleanup of a CT-14 synthesized session. `dst` is written by the root-owned
 *  bot-claude-write-session helper as a box:box 0600 file inside a directory bothost provably
 *  cannot write into (that's the entire premise of that helper), so `unlink()` is subject to the
 *  same directory-permission barrier as the `open(O_CREAT)` that created it and can throw EACCES
 *  against the real box. `{ force: true }` alone only suppresses ENOENT, not EACCES, so that case
 *  is caught explicitly here and downgraded to a warning instead of failing the check; any other
 *  error still propagates. */
export function cleanupSynthesizedSession(dst: string, rm: (f: string, opts: { force: boolean }) => void = boxSessionRm): void {
  try {
    rm(dst, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      log.warn("could not remove synthesized CT-14 session (bothost has no write bits there)", { dst, error: String(err) });
      return;
    }
    throw err;
  }
}
export const ct14: ConformanceCheck = {
  id: "CT-14", title: "Resume latency vs session size", slow: true, onThrow: {},
  async run(ctx) {
    const base = await runProbe(ctx, { prompt: "Reply OK.", options: { tools: [], persistSession: true } });
    const src = sessionFile(ctx, base.init?.session_id as string);
    const sizes: { bytes: number; ms: number | null }[] = [];
    for (const bytes of [20e6, 64e6]) {
      const sid = randomUUID();
      const dst = sessionFile(ctx, sid);
      synthesizeSession(src, dst, sid, bytes);
      const t0 = Date.now();
      let ms: number | null = null;
      await runProbe(ctx, {
        prompt: "Reply OK.", options: { tools: [], resume: sid, persistSession: false, includePartialMessages: true }, timeoutMs: 60_000,
        onMessage: (m) => { if (ms === null && (m as { type: string }).type === "stream_event") ms = Date.now() - t0; },
      }).catch(() => null);
      sizes.push({ bytes, ms });
      cleanupSynthesizedSession(dst);
    }
    cleanupSynthesizedSession(src);
    return judgeCt14({ sizes });
  },
};

// ---------- CT-15 · forkSession leaves the parent unchanged (ORIG-07 §07.6) ----------
export function judgeCt15(o: { before: string; after: string }): CheckOutcome {
  return o.before === o.after ? { status: "pass", detail: "parent JSONL byte-identical" } : { status: "fail", detail: "parent JSONL changed", flags: { forkPath: "fresh" } };
}
export const ct15: ConformanceCheck = {
  id: "CT-15", title: "forkSession + persistSession:false", onThrow: { forkPath: "fresh" },
  async run(ctx) {
    const base = await runProbe(ctx, { prompt: "Reply OK.", options: { tools: [], persistSession: true } });
    const file = sessionFile(ctx, base.init?.session_id as string);
    const before = sha(file);
    await runProbe(ctx, { prompt: "Reply AGAIN.", options: { tools: [], resume: base.init?.session_id as string, forkSession: true, persistSession: false } });
    return judgeCt15({ before, after: sha(file) });
  },
};

// ---------- CT-16 · a parked approval survives 15 minutes (APR-10, §13.2), slow ----------
export function judgeCt16(o: { canUseToolOk: boolean; hookOk: boolean }): CheckOutcome {
  if (o.canUseToolOk) return { status: "pass", detail: "canUseTool pending 15 min, then the tool ran" };
  return o.hookOk
    ? { status: "fail", detail: "canUseTool park failed; hook park works", flags: { approvalPath: "hook" } }
    : { status: "fail", detail: "neither canUseTool nor the hook can park 15 min", flags: { approvalPath: "defer" } };
}
export const ct16: ConformanceCheck = {
  id: "CT-16", title: "Long parked approvals", slow: true, onThrow: { approvalPath: "defer" },
  async run(ctx) {
    const waitMs = Number(process.env.CT16_WAIT_MS ?? 15 * 60_000);
    const a = await runProbe(ctx, {
      prompt: "Run the Bash command `echo ct16-a` and reply with its output.", timeoutMs: waitMs + 180_000,
      options: { tools: ["Bash"], canUseTool: async (_n, input) => { await sleep(waitMs); return { behavior: "allow", updatedInput: input }; } },
    }).catch(() => null);
    const hookWait: HookCallback = async () => { await sleep(waitMs); return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }; };
    const b = await runProbe(ctx, {
      prompt: "Run the Bash command `echo ct16-b` and reply with its output.", timeoutMs: waitMs + 180_000,
      options: { tools: ["Bash"], canUseTool: allowAll, hooks: { PreToolUse: [{ hooks: [hookWait], timeout: 86_400 }] } },
    }).catch(() => null);
    return judgeCt16({
      canUseToolOk: Boolean(a?.toolResults.some((r) => r.text.includes("ct16-a"))),
      hookOk: Boolean(b?.toolResults.some((r) => r.text.includes("ct16-b"))),
    });
  },
};

// ---------- CT-17 · setModel on a warm process (BOT-25) ----------
export function judgeCt17(o: { secondModels: string[]; target: string }): CheckOutcome {
  return o.secondModels.some((m) => m.startsWith(o.target))
    ? { status: "pass", detail: `second turn ran on ${o.target}` }
    : { status: "fail", detail: `second turn models: ${o.secondModels.join(", ") || "none"}`, flags: { modelChange: "respawn" } };
}
export const ct17: ConformanceCheck = {
  id: "CT-17", title: "setModel applies to the next pushed turn", onThrow: { modelChange: "respawn" },
  async run(ctx) {
    const target = "claude-sonnet-5";
    const input = new AsyncQueue<SDKUserMessage>();
    const q = ctx.queryFn({ prompt: input, options: ctx.baseOptions({ tools: [] }) });
    const results: Record<string, unknown>[] = [];
    const pump = (async () => { for await (const m of q) if ((m as { type: string }).type === "result") results.push(m as unknown as Record<string, unknown>); })();
    input.push(userMessage("Reply OK."));
    await waitFor(() => results.length >= 1, 90_000);
    await q.setModel(target);
    input.push(userMessage("Reply OK again."));
    await waitFor(() => results.length >= 2, 90_000);
    input.end();
    await Promise.race([pump, sleep(10_000)]);
    q.close();
    return judgeCt17({ secondModels: Object.keys((results[1]?.modelUsage as Record<string, unknown>) ?? {}), target });
  },
};

// ---------- CT-18 · Options.sessionId (spec §2.9 said no such option exists) ----------
export function judgeCt18(o: { requested: string; got: string | null }): CheckOutcome {
  return o.requested === o.got ? { status: "pass", detail: "sessionId honored" } : { status: "fail", detail: `got ${o.got}`, flags: { sessionIdOption: false } };
}
export const ct18: ConformanceCheck = {
  id: "CT-18", title: "Options.sessionId is honored", onThrow: { sessionIdOption: false },
  async run(ctx) {
    const requested = randomUUID();
    const run = await runProbe(ctx, { prompt: "Reply OK.", options: { tools: [], sessionId: requested, persistSession: true } });
    return judgeCt18({ requested, got: (run.init?.session_id as string) ?? null });
  },
};

// ---------- CT-19 · do asks from one assistant message overlap? (APR-19 precondition; informational) ----------
export function judgeCt19(o: { maxConcurrent: number }): CheckOutcome {
  return { status: "pass", detail: `max concurrent canUseTool calls: ${o.maxConcurrent}`, flags: { parallelAsks: o.maxConcurrent >= 2 } };
}
export const ct19: ConformanceCheck = {
  id: "CT-19", title: "Parallel asks from one message", onThrow: { parallelAsks: false },
  async run(ctx) {
    let inFlight = 0;
    let max = 0;
    const probe = createSdkMcpServer({ name: "probe", version: "1", tools: [tool("note", "Record a note.", { text: z.string() }, async () => ({ content: [{ type: "text", text: "noted" }] }))] });
    await runProbe(ctx, {
      prompt: "In a single message, call mcp__probe__note three times in parallel with the texts a, b and c. Then reply DONE.",
      options: {
        tools: [], mcpServers: { probe },
        canUseTool: async (_n, input) => { inFlight++; max = Math.max(max, inFlight); await sleep(1000); inFlight--; return { behavior: "allow", updatedInput: input }; },
      },
    });
    return judgeCt19({ maxConcurrent: max });
  },
};
