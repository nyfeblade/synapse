import fs from "node:fs";
import path from "node:path";
import type { TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { FRONT_REQUEST_PREFIX } from "../../voice/front";
import { CALL_MINUTES, CALL_SCRIPT } from "./call-script";

/**
 * Bug 142: the same scripted call down both paths, on the FAKE model, so the STRUCTURE is exact and repeatable —
 * how many model calls of which kind each path makes. Tokens are that structure times the unit costs MEASURED on
 * the real model (UNIT, below): the fake model's own token counts mean nothing.
 *
 * Run: `npm run bench:voice` (writes test-reports/voice-fast-path/<stamp>/report.md).
 */

/**
 * Measured on this Mac, 2026-09-22, one approved real run (host/test/voice/front-real.live.test.ts, report in
 * test-reports/voice-fast-path/real/). "front" is one turn of the Bot's voice on its own model at low effort;
 * "fullTurn" is one voice-call turn of the full session (its whole prompt: system + built-ins + bot tools), which
 * is what EVERY utterance cost before this change and what a delegated task costs now.
 */
export interface UnitCost { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }
export interface Units { front: UnitCost; frontFirst: UnitCost; fullTurn: UnitCost; fullTurnWork: UnitCost }
export const UNIT: Units = {
  // Measured 2026-09-22 (test-reports/voice-fast-path/real/report.md), Sonnet 5, low effort, thinking off.
  front: { inputTokens: 2, outputTokens: 63, cacheReadTokens: 2_267, cacheWriteTokens: 114, costUsd: 0.0017 },
  frontFirst: { inputTokens: 926, outputTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 1_557, costUsd: 0.0076 },
  // One voice-call turn of a full Bot session, cache warm: its whole prompt is re-read every call.
  fullTurn: { inputTokens: 1_137, outputTokens: 61, cacheReadTokens: 59_645, cacheWriteTokens: 4_058, costUsd: 0.0299 },
  // A turn that actually uses tools: the same prompt on each model call of the turn. ESTIMATED as two calls
  // (not measured: it needs the box). Both paths run the same number of these, so it never flatters the fast path.
  fullTurnWork: { inputTokens: 2_274, outputTokens: 300, cacheReadTokens: 119_290, cacheWriteTokens: 4_058, costUsd: 0.0598 },
};
const total = (u: UnitCost) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export interface PathResult {
  path: "before" | "after";
  fullTurns: number;
  fullWorkTurns: number;
  frontTurns: number;
  delegations: number;
  spokenLines: number;
  tokens: number;
  tokensPerCallMinute: number;
  costUsd: number;
  costPerCallMinute: number;
}

const until = async (f: () => boolean, ms = 15_000) => {
  const t = Date.now() + ms;
  while (!f()) {
    if (Date.now() > t) throw new Error("bench: timed out waiting for the call to settle");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Runs the scripted call against a real host (fake model) with the fast path on or off. */
export async function runScriptedCall(fastPath: boolean, mkApp: (env: Record<string, string>) => Promise<HostApp>): Promise<PathResult> {
  const app = await mkApp(fastPath ? {} : { SYNAPSE_VOICE_FAST_PATH: "off" });
  try {
    const { id } = await app.handlers.createAgent!({ name: "Nova", isKickstartRequested: false });
    const view = await app.handlers.startCall!({ id });
    const tail = () => app.services.bots.tail(id, 500) as TranscriptEntry[];
    const sent = () => tail().filter((e) => e.kind === "send-message" && e.message.type === "text");
    for (const [i, u] of CALL_SCRIPT.entries()) {
      const before = sent().length;
      await app.handlers.sendPrompt!({ id, text: u.text, clientNonce: `b${i}`, voice: { durationMs: 2_000, call: true } });
      await until(() => sent().length > before && app.services.runner.isIdle(id));
    }
    await until(() => app.services.runner.isIdle(id), 20_000);
    const stats = app.services.voiceFronts.stats(id);
    await app.handlers.endCall!({ callId: (view as { callId: string }).callId, durationMs: CALL_MINUTES * 60_000 });
    const entries = tail();
    const frontLines = entries.filter((e) => e.kind === "send-message" && e.message.type === "text" && e.requestId.startsWith(FRONT_REQUEST_PREFIX)).length;
    const fullLines = entries.filter((e) => e.kind === "send-message" && e.message.type === "text" && !e.requestId.startsWith(FRONT_REQUEST_PREFIX)).length;
    const work = CALL_SCRIPT.filter((u) => u.work).length;
    const frontTurns = stats?.turns ?? 0;
    const fullTurns = fastPath ? (stats?.delegations ?? 0) : CALL_SCRIPT.length;
    const fullWorkTurns = fastPath ? (stats?.delegations ?? 0) : work;
    const tokens =
      (frontTurns ? total(UNIT.frontFirst) + Math.max(0, frontTurns - 1) * total(UNIT.front) : 0)
      + fullWorkTurns * total(UNIT.fullTurnWork)
      + Math.max(0, fullTurns - fullWorkTurns) * total(UNIT.fullTurn);
    const costUsd =
      (frontTurns ? UNIT.frontFirst.costUsd + Math.max(0, frontTurns - 1) * UNIT.front.costUsd : 0)
      + fullWorkTurns * UNIT.fullTurnWork.costUsd
      + Math.max(0, fullTurns - fullWorkTurns) * UNIT.fullTurn.costUsd;
    return {
      path: fastPath ? "after" : "before",
      fullTurns, fullWorkTurns, frontTurns, delegations: stats?.delegations ?? 0,
      spokenLines: fastPath ? frontLines : frontLines + fullLines,
      tokens, tokensPerCallMinute: Math.round(tokens / CALL_MINUTES),
      costUsd, costPerCallMinute: costUsd / CALL_MINUTES,
    };
  } finally {
    await app.close();
  }
}

export function report(before: PathResult, after: PathResult): string {
  const pct = (a: number, b: number) => `${b === 0 ? "n/a" : `${Math.round(((a - b) / b) * 100)}%`}`;
  return [
    "# Voice fast path — scripted call (fake model for structure, measured unit costs)",
    "",
    `Call: ${CALL_SCRIPT.length} utterances, ${CALL_MINUTES.toFixed(1)} call-minutes, ${CALL_SCRIPT.filter((u) => u.work).length} of them real work.`,
    "",
    "| | before (a full turn per utterance) | after (the voice + delegated work) |",
    "|---|---|---|",
    `| full-session turns | ${before.fullTurns} | ${after.fullTurns} |`,
    `| of those, with tool work | ${before.fullWorkTurns} | ${after.fullWorkTurns} |`,
    `| voice (front) turns | ${before.frontTurns} | ${after.frontTurns} |`,
    `| lines spoken | ${before.spokenLines} | ${after.spokenLines} |`,
    `| tokens | ${before.tokens.toLocaleString()} | ${after.tokens.toLocaleString()} |`,
    `| tokens per call-minute | ${before.tokensPerCallMinute.toLocaleString()} | ${after.tokensPerCallMinute.toLocaleString()} (${pct(after.tokens, before.tokens)}) |`,
    `| API cost per call-minute | $${before.costPerCallMinute.toFixed(3)} | $${after.costPerCallMinute.toFixed(3)} (${pct(after.costUsd, before.costUsd)}) |`,
    "",
    "Unit costs (measured, one real run): "
      + `front turn ${total(UNIT.front).toLocaleString()} tokens (first turn of a call ${total(UNIT.frontFirst).toLocaleString()}), `
      + `full-session voice turn ${total(UNIT.fullTurn).toLocaleString()}, with tool work ${total(UNIT.fullTurnWork).toLocaleString()}.`,
    "",
  ].join("\n");
}

export function writeReport(dir: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "report.md");
  fs.writeFileSync(file, text);
  return file;
}
