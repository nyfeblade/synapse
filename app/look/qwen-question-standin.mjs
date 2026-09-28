#!/usr/bin/env node
/**
 * LOOK's before/after for bug 190's stand-in path (dev only).
 *
 * A Qwen Bot's line is said by its KOKORO stand-in whenever the call drops to Light mode (a short
 * Mac — both of the user's calls after the bug-183 install did, at 200 and 393 MB free) or the hybrid
 * opens a reply in Kokoro. Before bug 190 that stand-in got the bug-151 question ramp; after it, it
 * gets plainProsody (Kokoro's trim, no ramp). tts-glitch.mjs scores BOTH on the same synthesis — its
 * "ramp" variant is the before, its "trim" variant is byte for byte what plainProsody hands the helper
 * (test/main/qwen-no-question.test.ts) — so this reads its report and lays the two side by side.
 *
 *   node app/look/tts-glitch.mjs --voices af_heart,bf_emma --out <before>/standin
 *   node app/look/qwen-question-standin.mjs --in <before>/standin --out <after>/standin
 */
import fs from "node:fs";
import path from "node:path";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const IN = path.resolve(arg("in"));
const OUT = path.resolve(arg("out"));
const report = JSON.parse(fs.readFileSync(path.join(IN, "report.json"), "utf8"));
const rows = [];
for (const r of report.filter((x) => x.variant === "ramp" && x.liftSt !== null && x.liftSt !== 0)) {
  const t = report.find((x) => x.case === r.case && x.voice === r.voice && x.variant === "trim");
  const pick = (x) => ({ clickRatio: x.clickRatio ?? 1, click: x.click, clickMsFromEnd: Math.round(x.ms - x.clickAtMs), holeDb: x.holeDb, winStepRatio: x.winStepRatio, tailHz: x.tailHz, lastSample: x.lastSample });
  rows.push({ case: r.case, voice: r.voice, liftSt: r.liftSt, before: pick(r), after: pick(t) });
  fs.mkdirSync(OUT, { recursive: true });
  for (const [v, tag] of [["ramp", "before"], ["trim", "after"]]) {
    const src = path.join(IN, `${r.case}-${r.voice}-${v}.wav`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, `${tag}-${r.case}-${r.voice}.wav`));
  }
  console.log(`${r.case.padEnd(8)} ${r.voice.padEnd(8)} before: lift +${r.liftSt} st, click ${r.clickRatio}x (${Math.round(r.ms - r.clickAtMs)} ms from end), hole ${r.holeDb} dB | after: lift 0, click ${t.clickRatio}x, hole ${t.holeDb} dB`);
}
fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(rows, null, 2)}\n`);
