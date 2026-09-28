import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_MODEL, HELPER_MODEL } from "@synapse/shared";
import { fillTemplate, loadPrompt } from "../../prompts/index";
import { SdkFrontSession, type FrontTurn } from "../../voice/front-session";

/**
 * The user's option (c): Haiku for the call voice only — MEASURED against Sonnet on call-style turns, never switched
 * on here (voice-smooth plan item 28). Same prompt the voice gets on a call, each model on its own warm session:
 *   - "sonnet": today's voice (the Bot's own model, low effort, thinking off);
 *   - "haiku": Haiku 4.5 with that same prompt — ~2.6k tokens, under Haiku's 4,096-token cache floor, so every turn
 *     is billed and read uncached;
 *   - "haiku-padded": Haiku with the prompt padded past the floor by the chat before the call (what `[earlier]`
 *     carries on a real call), so its prefix can cache.
 * Scored by turn type, in code (no judge model): small talk answered without delegating; a request delegated with
 * a complete task and a spoken "on it"; no claim that something is done before a [result]; a [result] turned into
 * a short spoken gist; an [approval] change delegated. Plus first-text latency, words spoken and tokens.
 *
 * Run (real model calls, ~150k tokens, the user's own sign-in):
 *   RUN_HAIKU_EVAL=1 npx vitest run --project host host/test/voice/haiku-eval.live.test.ts --silent=false
 * Report: test-reports/voice-smooth/haiku-eval.json and .md
 */

type Kind = "chat" | "task" | "followup" | "result" | "approval";
interface Case { kind: Kind; msg: string; /** the reply must NOT contain this (made-up detail) */ mustNot?: RegExp }

const CASES: Case[] = [
  { kind: "chat", msg: "User: hey, how's it going" },
  { kind: "chat", msg: "User: did you get a chance to look at the retainer numbers" },
  { kind: "task", msg: "User: text Sam that I'm running ten minutes late", mustNot: /\b(sent|texted him|done)\b/i },
  { kind: "chat", msg: "User: thanks" },
  { kind: "task", msg: "User: what's on my calendar tomorrow", mustNot: /\b\d{1,2}(:\d\d)?\s?(am|pm)\b/i },
  { kind: "followup", msg: "User: is the afternoon one the one with the lawyers", mustNot: /\byes, it is\b/i },
  { kind: "task", msg: "User: okay, open the deck for it" },
  { kind: "result", msg: "[result] Tomorrow: 9:30 standup with the team; 2:00 call with Harlow & Finch LLP about the retainer; 4:30 dentist." },
  { kind: "chat", msg: "User: nice, that's a light day" },
  { kind: "approval", msg: "[approval] Waiting for the user's OK: Send iMessage to Sam Lee: \"Running 10 minutes late\"\nUser: make it fifteen minutes, not ten" },
  { kind: "task", msg: "User: one more thing, remind me to call the bank on Friday", mustNot: /\b(reminder is set|i've set|all set)\b/i },
  { kind: "result", msg: "[result] Reminder created: \"Call the bank\" on Friday at 9:00 AM." },
  { kind: "chat", msg: "User: what do you think, should I push the lawyers call to next week" },
  { kind: "chat", msg: "User: that's everything, talk later" },
];

/** The chat before the call, as a real call seeds it ([earlier]); ~1,700 tokens, to take Haiku past its cache floor. */
const EARLIER = Array.from({ length: 24 }, (_, i) => i % 2 === 0
  ? `User: Can you keep an eye on the retainer numbers for Harlow & Finch, and flag anything over the ${4 + i} thousand mark before the quarterly review? Also remind me what we agreed about the travel budget for the Denver trip.`
  : `Nova: Will do. The retainer is tracking at ${60 + i} percent of the quarter so far, and the Denver travel budget we agreed was two thousand, flights included; I'll flag anything that goes over.`).join("\n");

function score(c: Case, t: FrontTurn): { ok: boolean; why: string[] } {
  const why: string[] = [];
  const delegated = t.delegations.length > 0;
  const text = t.text;
  if (!text.trim()) why.push("said nothing");
  if (c.kind === "chat" || c.kind === "followup" || c.kind === "result") { if (delegated) why.push("delegated a turn it should answer"); }
  if (c.kind === "task" || c.kind === "approval") {
    if (!delegated) why.push("didn't delegate the request");
    else if (t.delegations.some((d) => d.trim().split(/\s+/).length < 5)) why.push("delegated an incomplete task");
  }
  if (c.kind === "approval" && delegated && !t.delegations.some((d) => /fifteen|15/i.test(d))) why.push("the change (fifteen) isn't in the task");
  if (c.mustNot?.test(text)) why.push(`made something up: ${JSON.stringify(text.match(c.mustNot)?.[0])}`);
  if (c.kind === "result" && text.split(/\s+/).length > 45) why.push("the gist ran long");
  if (text.split(/(?<=[.!?])\s+/).length > 3) why.push("more than three sentences");
  if (/[*#`]|https?:\/\//.test(text)) why.push("markdown or a link");
  return { ok: why.length === 0, why };
}

const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null; };

describe.skipIf(process.env.RUN_HAIKU_EVAL !== "1")("Haiku for the call voice (REAL model; measured, not switched on)", () => {
  it("scores Sonnet and Haiku on the same call-style turns", async () => {
    const env: Record<string, string> = {
      HOME: os.homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin", USER: process.env.USER ?? "user", LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh", TMPDIR: os.tmpdir(), ENABLE_TOOL_SEARCH: "false",
    };
    const system = fillTemplate(loadPrompt("voice-front.md"), { BOT_NAME: "Nova", USER_NAME: "Alex", PERSONA: "Chief of Staff. Warm, quick, a little dry; keeps things moving." });
    const configs = [
      { name: "sonnet", model: DEFAULT_BOT_MODEL, pad: false },
      { name: "haiku", model: HELPER_MODEL, pad: false },
      { name: "haiku-padded", model: HELPER_MODEL, pad: true },
    ];
    const out: Record<string, unknown> = {};
    for (const cfg of configs) {
      const s = new SdkFrontSession({ botId: "eval", model: cfg.model, system: cfg.pad ? `${system}\n\n[the chat before this call]\n${EARLIER}` : system }, { env, cwd: os.tmpdir() });
      const rows: { kind: Kind; msg: string; text: string; delegations: string[]; firstTextMs: number | null; tokens: number; cacheRead: number; costUsd: number; ok: boolean; why: string[] }[] = [];
      for (const c of CASES) {
        const t = await s.turn(c.msg, () => {}, () => {});
        const sc = score(c, t);
        rows.push({ kind: c.kind, msg: c.msg, text: t.text, delegations: t.delegations, firstTextMs: t.firstTextMs, tokens: t.usage.inputTokens + t.usage.outputTokens + t.usage.cacheReadTokens + t.usage.cacheWriteTokens, cacheRead: t.usage.cacheReadTokens, costUsd: t.usage.costUsd, ...sc });
        if (t.error) { rows.at(-1)!.why.push(`error: ${t.error}`); break; }
      }
      s.close();
      const ft = rows.map((r) => r.firstTextMs).filter((x): x is number => x !== null);
      const byKind: Record<string, string> = {};
      for (const k of ["chat", "task", "followup", "result", "approval"]) { const r = rows.filter((x) => x.kind === k); byKind[k] = `${r.filter((x) => x.ok).length}/${r.length}`; }
      out[cfg.name] = {
        model: cfg.model, padded: cfg.pad, passed: `${rows.filter((r) => r.ok).length}/${rows.length}`, byKind,
        firstTextP50: pct(ft, 0.5), firstTextP90: pct(ft, 0.9), tokens: rows.reduce((a, r) => a + r.tokens, 0),
        cacheRead: rows.reduce((a, r) => a + r.cacheRead, 0), costUsd: Number(rows.reduce((a, r) => a + r.costUsd, 0).toFixed(4)), rows,
      };
    }
    const dir = path.resolve(__dirname, "../../../test-reports/voice-smooth");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "haiku-eval.json"), `${JSON.stringify(out, null, 1)}\n`);
    const md = ["# Haiku for the call voice: measured against Sonnet (not switched on)", "", "| config | passed | chat | task | followup | result | approval | first text p50 / p90 ms | tokens | cache read | cost $ |", "|---|---|---|---|---|---|---|---|---|---|---|"];
    for (const [k, v] of Object.entries(out) as [string, { passed: string; byKind: Record<string, string>; firstTextP50: number; firstTextP90: number; tokens: number; cacheRead: number; costUsd: number }][]) {
      md.push(`| ${k} | ${v.passed} | ${v.byKind.chat} | ${v.byKind.task} | ${v.byKind.followup} | ${v.byKind.result} | ${v.byKind.approval} | ${v.firstTextP50} / ${v.firstTextP90} | ${v.tokens} | ${v.cacheRead} | ${v.costUsd} |`);
    }
    md.push("", "Failures:");
    for (const [k, v] of Object.entries(out) as [string, { rows: { msg: string; text: string; why: string[]; ok: boolean }[] }][]) {
      for (const r of v.rows.filter((x) => !x.ok)) md.push(`- **${k}** — ${JSON.stringify(r.msg.slice(0, 70))}: ${r.why.join("; ")} — said ${JSON.stringify(r.text.slice(0, 140))}`);
    }
    fs.writeFileSync(path.join(dir, "haiku-eval.md"), `${md.join("\n")}\n`);
    console.log(md.join("\n"));
    expect(Object.keys(out)).toHaveLength(3);
  }, 900_000);
});
