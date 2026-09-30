import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_MODEL } from "@synapse/shared";
import { fillTemplate, loadPrompt } from "../../prompts/index";
import { SPEAKABLE } from "../../voice/front";
import { SdkFrontSession, type FrontTurn } from "../../voice/front-session";
import { realHomeForTest } from "../../../scripts/test-home";

/**
 * call-behaviour (plan items 13, 20, 27): the voice prompt BEFORE (a file you pass in) against the one in the repo,
 * on the same call-style turns, same model (the Bot's own, low effort, thinking off). Scored in code, no judge model:
 * the haiku-eval rules (small talk answered, requests delegated with a complete task, nothing claimed done before a
 * [result], a [result] as a short gist, the [approval] change delegated) plus: words spoken, answer-first (the first
 * sentence ≤ 12 words), a plain thanks answered in ≤ 4 words or [quiet], and no "done" while a [working] task is open.
 *
 * Run (real model calls, ~90k tokens, the user's own sign-in):
 *   PROMPT_BEFORE=/path/to/voice-front.before.md RUN_PROMPT_AB=1 npx vitest run --project host host/test/voice/prompt-ab.live.test.ts --silent=false
 * Report: test-reports/call-behaviour/prompt-ab.json and .md
 */

type Kind = "chat" | "ack" | "task" | "followup" | "result" | "approval" | "working";
interface Case { kind: Kind; msg: string; mustNot?: RegExp }

const CASES: Case[] = [
  { kind: "chat", msg: "User: hey, how's it going" },
  { kind: "chat", msg: "User: did you get a chance to look at the retainer numbers" },
  { kind: "task", msg: "User: text Sam that I'm running ten minutes late", mustNot: /\b(sent|texted him|done)\b/i },
  { kind: "ack", msg: "User: thanks" },
  { kind: "task", msg: "User: what's on my calendar tomorrow", mustNot: /\b\d{1,2}(:\d\d)?\s?(am|pm)\b/i },
  { kind: "working", msg: "[working] What's on the user's calendar tomorrow\nUser: is it done yet?", mustNot: /\b(it's done|all done|yes,? (it's|it is) done|here'?s what)\b/i },
  { kind: "followup", msg: "User: is the afternoon one the one with the lawyers", mustNot: /\byes, it is\b/i },
  { kind: "result", msg: "[result] Tomorrow: 9:30 standup with the team; 2:00 call with Harlow & Finch LLP about the retainer; 4:30 dentist." },
  { kind: "chat", msg: "User: nice, that's a light day" },
  { kind: "approval", msg: "[approval] Waiting for the user's OK: Send iMessage to Sam Lee: \"Running 10 minutes late\"\nUser: make it fifteen minutes, not ten" },
  { kind: "task", msg: "User: one more thing, remind me to call the bank on Friday", mustNot: /\b(reminder is set|i've set|all set)\b/i },
  { kind: "result", msg: "[result] Reminder created: \"Call the bank\" on Friday at 9:00 AM. It repeats weekly? No, just once. It's in your Reminders app under Personal, with an alert 15 minutes before." },
  { kind: "ack", msg: "User: okay" },
  { kind: "chat", msg: "User: what do you think, should I push the lawyers call to next week" },
  { kind: "chat", msg: "User: that's everything, talk later" },
];

const words = (t: string) => t.replace(/\[quiet\]/gi, "").split(/\s+/).filter(Boolean).length;

function score(c: Case, t: FrontTurn): { ok: boolean; why: string[] } {
  const why: string[] = [];
  const delegated = t.delegations.length > 0;
  const text = t.text.replace(/\[quiet\]/gi, "").trim();
  const quiet = /\[quiet\]/i.test(t.text);
  if (!text && !quiet && !delegated) why.push("said nothing");
  if (["chat", "followup", "result", "ack", "working"].includes(c.kind) && delegated) why.push("delegated a turn it should answer");
  if (c.kind === "task" || c.kind === "approval") {
    if (!delegated) why.push("didn't delegate the request");
    else if (t.delegations.some((d) => d.trim().split(/\s+/).length < 5)) why.push("delegated an incomplete task");
  }
  if (c.kind === "approval" && delegated && !t.delegations.some((d) => /fifteen|15/i.test(d))) why.push("the change (fifteen) isn't in the task");
  if (c.mustNot?.test(text)) why.push(`made something up: ${JSON.stringify(text.match(c.mustNot)?.[0])}`);
  if (c.kind === "result" && words(text) > 45) why.push("the gist ran long");
  if (c.kind === "ack" && !quiet && words(text) > 4) why.push("a plain thanks got a speech");
  if (text.split(/(?<=[.!?])\s+/).length > 3) why.push("more than three sentences");
  if (/[*#`]|https?:\/\//.test(text)) why.push("markdown or a link");
  return { ok: why.length === 0, why };
}

const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null; };

describe.skipIf(process.env.RUN_PROMPT_AB !== "1")("the voice prompt, before and after (REAL model)", () => {
  it("scores both prompts on the same call-style turns", async () => {
    const env: Record<string, string> = {
      HOME: realHomeForTest("the real claude CLI login lives there (opt-in live run)"), PATH: process.env.PATH ?? "/usr/bin:/bin", USER: process.env.USER ?? "user", LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh", TMPDIR: os.tmpdir(), ENABLE_TOOL_SEARCH: "false",
    };
    const vars = { BOT_NAME: "Nova", USER_NAME: "Alex", PERSONA: "Chief of Staff. Warm, quick, a little dry; keeps things moving." };
    const configs = [
      { name: "before", system: `${fillTemplate(fs.readFileSync(process.env.PROMPT_BEFORE!, "utf8"), vars)}\n${SPEAKABLE}` },
      { name: "after", system: `${fillTemplate(loadPrompt("voice-front.md"), vars)}\n${SPEAKABLE}` },
    ];
    const out: Record<string, unknown> = {};
    for (const cfg of configs) {
      const s = new SdkFrontSession({ botId: "eval", model: DEFAULT_BOT_MODEL, system: cfg.system }, { env, cwd: os.tmpdir() });
      const rows: { kind: Kind; msg: string; text: string; delegations: string[]; firstTextMs: number | null; words: number; firstSentenceWords: number; tokens: number; outputTokens: number; ok: boolean; why: string[] }[] = [];
      for (const c of CASES) {
        const t = await s.turn(c.msg, () => {}, () => {});
        const sc = score(c, t);
        const clean = t.text.replace(/\[quiet\]/gi, "").trim();
        rows.push({ kind: c.kind, msg: c.msg, text: t.text, delegations: t.delegations, firstTextMs: t.firstTextMs, words: words(clean), firstSentenceWords: words(clean.split(/(?<=[.!?])\s+/)[0] ?? ""), tokens: t.usage.inputTokens + t.usage.outputTokens + t.usage.cacheReadTokens + t.usage.cacheWriteTokens, outputTokens: t.usage.outputTokens, ...sc });
        if (t.error) { rows.at(-1)!.why.push(`error: ${t.error}`); break; }
      }
      s.close();
      const spoken = rows.filter((r) => r.words > 0);
      const byKind: Record<string, string> = {};
      for (const k of ["chat", "ack", "task", "working", "followup", "result", "approval"]) { const r = rows.filter((x) => x.kind === k); byKind[k] = `${r.filter((x) => x.ok).length}/${r.length}`; }
      out[cfg.name] = {
        systemChars: cfg.system.length, passed: `${rows.filter((r) => r.ok).length}/${rows.length}`, byKind,
        wordsP50: pct(spoken.map((r) => r.words), 0.5), wordsP90: pct(spoken.map((r) => r.words), 0.9),
        firstSentenceWordsP50: pct(spoken.map((r) => r.firstSentenceWords), 0.5),
        tokens: rows.reduce((a, r) => a + r.tokens, 0), outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0), rows,
      };
    }
    const dir = path.resolve(__dirname, "../../../test-reports/call-behaviour");
    fs.mkdirSync(dir, { recursive: true });
    // The live model sees the signed-in account and sometimes names it in a task: never into the repo.
    const redact = (s: string) => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "<email>");
    fs.writeFileSync(path.join(dir, "prompt-ab.json"), redact(`${JSON.stringify(out, null, 1)}\n`));
    const md = ["# The voice prompt, before and after (real model, one run of 15 turns each)", "", "| prompt | system chars | passed | chat | ack | task | working | followup | result | approval | words p50 / p90 | first sentence words p50 | tokens | output tokens |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
    for (const [k, v] of Object.entries(out) as [string, { systemChars: number; passed: string; byKind: Record<string, string>; wordsP50: number; wordsP90: number; firstSentenceWordsP50: number; tokens: number; outputTokens: number }][]) {
      const b = v.byKind;
      md.push(`| ${k} | ${v.systemChars} | ${v.passed} | ${b.chat} | ${b.ack} | ${b.task} | ${b.working} | ${b.followup} | ${b.result} | ${b.approval} | ${v.wordsP50} / ${v.wordsP90} | ${v.firstSentenceWordsP50} | ${v.tokens} | ${v.outputTokens} |`);
    }
    md.push("", "Every reply:");
    for (const [k, v] of Object.entries(out) as [string, { rows: { msg: string; text: string; delegations: string[]; why: string[]; ok: boolean }[] }][]) {
      for (const r of v.rows) md.push(`- **${k}** ${r.ok ? "ok" : "FAIL"} — ${JSON.stringify(r.msg.slice(0, 60))} → ${JSON.stringify(r.text.slice(0, 160))}${r.delegations.length ? ` (delegated: ${JSON.stringify(r.delegations[0]!.slice(0, 80))})` : ""}${r.why.length ? ` — ${r.why.join("; ")}` : ""}`);
    }
    fs.writeFileSync(path.join(dir, "prompt-ab.md"), redact(`${md.join("\n")}\n`));
    console.log(md.join("\n"));
    expect(Object.keys(out)).toHaveLength(2);
  }, 900_000);
});
