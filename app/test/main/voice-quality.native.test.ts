import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseVoiceList } from "../../src/main/native/audio-devices";

/**
 * Bug 106: voice mode sounded bad (the compact "Samantha" voice), cut the user off after a fixed
 * silence, and could barge in on itself. The helper now lists the installed voices by quality and
 * picks the best one, decides end of turn from the words as well as the silence, gates barge-in on
 * sustained speech above the playback's echo, and logs every one of those decisions with a time.
 *
 * RUN_NATIVE=1 opts in (macOS + the built helper, app/native/dictation/build.sh).
 */
const bin = process.env.DICTATION_BIN ?? path.resolve(__dirname, "../../dist/native/bots-dictation");
const run = (args: string[]) => spawnSync(bin, args, { timeout: 30_000, encoding: "utf8" });
const events = (out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const RANK = { premium: 3, enhanced: 2, default: 1 } as const;

describe.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("voice quality, end of turn and barge-in (bug 106)", () => {
  it("the pure voice / end-of-turn / barge-in logic passes its own self-test", () => {
    const r = run(["--self-test-voice"]);
    const ev = events(r.stdout).find((e) => e.type === "self-test");
    expect(ev, r.stderr).toMatchObject({ ok: true });
    expect(ev!.cases as number).toBeGreaterThanOrEqual(12);
    expect(r.status).toBe(0);
  });

  it("--list-voices lists this Mac's voices for the locale, best quality first, no novelty voices", () => {
    const r = run(["--list-voices", "--locale", "en-US"]);
    expect(r.status, r.stderr).toBe(0);
    const v = parseVoiceList(r.stdout);
    expect(v.length).toBeGreaterThan(0);
    for (const x of v) expect(x.lang.startsWith("en")).toBe(true);
    for (let i = 1; i < v.length; i++) expect(RANK[v[i - 1]!.quality]).toBeGreaterThanOrEqual(RANK[v[i]!.quality]);
    expect(v.some((x) => /Bells|Boing|Bubbles|Zarvox|Whisper/.test(x.name))).toBe(false);
  });

  it("the speaker test (Preview) uses the requested voice, and the best installed voice when none is given (dry run)", () => {
    const best = parseVoiceList(run(["--list-voices", "--locale", "en-US"]).stdout);
    const worst = best.at(-1)!;
    const chosen = events(run(["--test-speaker", "--voice", worst.id, "--dry-run", "--locale", "en-US"]).stdout).find((e) => e.type === "voice");
    expect(chosen).toMatchObject({ id: worst.id });
    const auto = events(run(["--test-speaker", "--dry-run", "--locale", "en-US"]).stdout).find((e) => e.type === "voice");
    expect(auto).toMatchObject({ id: best[0]!.id, quality: best[0]!.quality });
    // A voice asked for by NAME (the per-Bot setting) is the best-quality voice of that name.
    const same = best.filter((x) => x.name === worst.name);
    const byName = events(run(["--test-speaker", "--voice", worst.name, "--dry-run", "--locale", "en-US"]).stdout).find((e) => e.type === "voice");
    expect(byName).toMatchObject({ id: same[0]!.id });
  });

  it("a call logs end of turn with its reason and the first audio out of a reply, with times", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-q-"));
    const f = path.join(dir, "turn.aiff");
    execFileSync("say", ["-o", f, "what time is it in Tokyo"]);
    let stdout = "";
    const stderr = await new Promise<string>((resolve, reject) => {
      const c = spawn(bin, ["--file", f, "--mode", "call", "--locale", "en-US", "--silence-ms", "700"], { stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      let out = "";
      let spoke = false;
      const kill = setTimeout(() => { c.kill("SIGKILL"); reject(new Error(err)); }, 60_000);
      c.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      c.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (!spoke && out.includes('"final"')) { spoke = true; c.stdin.write(`speak ${JSON.stringify({ id: "sp-1", text: "It is nine in the morning." })}\n`); }
        if (out.includes('"speak-end"')) c.stdin.write("stop\n");
      });
      c.on("close", () => { clearTimeout(kill); stdout = out; resolve(err); });
    });
    expect(stderr).toMatch(/utterance 1 end of turn \(reason=[a-z-]+, silence=\d+ms/);
    expect(stderr).toMatch(/first audio out sp-1 after \d+ ms/);
    // Voice calls: the call screen's levels and the first-audio mark reach the app as events.
    const ev = events(stdout);
    expect(ev).toContainEqual(expect.objectContaining({ type: "speak-audio", id: "sp-1" }));
    expect(ev.some((e) => e.type === "level" && typeof e.mic === "number")).toBe(true);
  }, 90_000);
});
