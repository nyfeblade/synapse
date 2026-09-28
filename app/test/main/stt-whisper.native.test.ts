import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { whisperRoot } from "../../src/main/native/stt-whisper";

/**
 * Bug 165: whisper.cpp re-transcribes the finished utterance. These run the REAL helper, because
 * the thing worth proving is the thing a unit test cannot: that a helper pointed at a model that is
 * not there, or built with no whisper in it at all, still transcribes with Apple and still exits
 * cleanly — and that when whisper IS there the hybrid actually lands.
 *
 * RUN_NATIVE=1 opts in (macOS + the built helper, app/native/dictation/build.sh).
 */
const bin = process.env.DICTATION_BIN ?? path.resolve(__dirname, "../../dist/native/bots-dictation");
const run = (args: string[], timeout = 120_000) => spawnSync(bin, args, { timeout, encoding: "utf8" });
const events = (out: string) => out.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });

/** The weights install.sh put in place, if this machine has them. */
function installedModel(): string | null {
  const dir = path.join(whisperRoot(path.join(os.homedir(), "Library", "Application Support", "Synapse")), "models");
  try {
    const f = fs.readdirSync(dir).filter((x) => x.startsWith("ggml-") && x.endsWith(".bin")).sort();
    return f.length ? path.join(dir, f[0]!) : null;
  } catch {
    return null;
  }
}

/** A short spoken clip at 16 kHz mono, the format the microphone tap already delivers. */
function clip(text: string, dir: string): string {
  const aiff = path.join(dir, "clip.aiff");
  const wav = path.join(dir, "clip.wav");
  spawnSync("say", ["-v", "Samantha", "-o", aiff, text], { timeout: 30_000 });
  spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav], { timeout: 30_000 });
  return wav;
}

const native = process.env.RUN_NATIVE !== "1" || process.platform !== "darwin";

describe.skipIf(native)("whisper, when it is not there (bug 165)", () => {
  it("a model path that does not exist never costs a word: the helper says so and exits 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-missing-"));
    try {
      const wav = clip("open OrbStack please", dir);
      const r = run([
        "--file", wav, "--locale", "en-US",
        "--whisper-model", path.join(dir, "no-such-model.bin"),
      ]);
      const ev = events(r.stdout);
      // It reported that whisper could not load...
      expect(ev.find((e) => e.type === "whisper"), r.stderr).toMatchObject({ ok: false });
      // ...and dictation still produced a transcript, from Apple.
      const final = ev.find((e) => e.type === "final");
      expect(final, r.stderr).toBeTruthy();
      expect(String(final!.text).length).toBeGreaterThan(0);
      expect(final!.engine === undefined || final!.engine === "apple").toBe(true);
      expect(ev.at(-1)).toMatchObject({ type: "end" });
      // Bug 165: the helper used to abort() in ggml's Metal destructor on the way out. Never again.
      expect(r.signal).toBeNull();
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no --whisper-model at all is Light mode: not a word about whisper, and the old behaviour", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-light-"));
    try {
      const r = run(["--file", clip("open OrbStack please", dir), "--locale", "en-US"]);
      const ev = events(r.stdout);
      expect(ev.some((e) => e.type === "whisper"), r.stderr).toBe(false);
      expect(ev.find((e) => e.type === "final"), r.stderr).toBeTruthy();
      expect(ev.find((e) => e.type === "final")!.whisperMs).toBeUndefined();
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bug 185: a pause mid-speech neither ends dictation nor loses what came before it (Light mode)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-long-pause-"));
    try {
      // Two sentences with a 1.5 s thinking pause: the old helper ended dictation at the first, and
      // Apple's recognizer started its text over after the pause, so the first one was lost too.
      const wav = clip("I want to plan the week before anything else lands on my desk. [[slnc 1500]] After lunch I should look at the voice settings again.", dir);
      const r = run(["--file", wav, "--locale", "en-US"]);
      const ev = events(r.stdout);
      const text = ev.filter((e) => e.type === "final").map((e) => String(e.text)).join(" ").toLowerCase();
      expect(text, r.stderr).toContain("plan the week");
      expect(text, r.stderr).toContain("voice settings");
      expect(ev.at(-1)).toMatchObject({ type: "end" });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("--whisper-bench without a model fails loudly rather than reporting a transcript", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-bench-"));
    try {
      const r = run(["--whisper-bench", clip("hello", dir), "--whisper-model", path.join(dir, "gone.bin")]);
      expect(events(r.stdout).find((e) => e.type === "whisper-bench")).toMatchObject({ ok: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(native || !installedModel())("whisper, when it is there (bug 165)", () => {
  const model = installedModel()!;

  it("re-transcribes a turn, and the vocabulary in the prompt reaches the text", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-hit-"));
    try {
      const ctx = path.join(dir, "ctx.json");
      fs.writeFileSync(ctx, JSON.stringify({ strings: ["OrbStack", "Kokoro", "Disk Saver"] }));
      const wav = clip("Ask Disk Saver to check OrbStack and tell Priya about Kokoro", dir);
      const r = run(["--whisper-bench", wav, "--whisper-model", model, "--context-file", ctx, "--locale", "en-US"]);
      const b = events(r.stdout).find((e) => e.type === "whisper-bench");
      expect(b, r.stderr).toMatchObject({ ok: true });
      expect(String(b!.text)).toContain("OrbStack");
      expect(String(b!.text)).toContain("Kokoro");
      // The measured floor: never the value that made whisper repeat the sentence.
      expect(b!.audioCtx as number).toBeGreaterThanOrEqual(768);
      // It did not come back with the sentence over and over.
      expect(String(b!.text).split("OrbStack").length - 1).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a budget it cannot possibly meet keeps Apple's text, and never hangs the session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-budget-"));
    try {
      const wav = clip("open OrbStack and restart the Kokoro server", dir);
      const r = run(["--file", wav, "--locale", "en-US", "--whisper-model", model, "--whisper-budget-ms", "100"]);
      const ev = events(r.stdout);
      const final = ev.find((e) => e.type === "final");
      expect(final, r.stderr).toBeTruthy();
      expect(final!.engine).toBe("apple");
      expect(String(final!.text).length).toBeGreaterThan(0);
      expect(ev.at(-1)).toMatchObject({ type: "end" });
      expect(r.signal).toBeNull();
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bug 185: a turn longer than one 30 s window is chunked, and every word comes back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-long-"));
    try {
      const script = "Here is what I think we should do about the onboarding flow. Right now a new user opens the app and sees an empty chat with a blinking cursor, and nothing tells them what the assistant can actually do. The first thing I would change is the greeting. Instead of a single line, the assistant should introduce itself, say what it is good at, and offer three things to try, each one a button the user can press. The second change is about permissions. At the moment we ask for the microphone, the calendar and the files all at once, before the user has any reason to trust us.";
      const r = run(["--file", clip(script, dir), "--locale", "en-US", "--whisper-model", model], 180_000);
      const ev = events(r.stdout);
      const finals = ev.filter((e) => e.type === "final");
      // Before: "skipped whisper: the utterance is longer than one encoder window" and Apple's
      // restarted text — the final held only the last sentence.
      expect(r.stderr).toMatch(/whisper chunk 1:/);
      expect(finals.every((f) => f.engine === "whisper"), r.stderr).toBe(true);
      const said = (s: string) => s.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
      const heard = new Set(said(finals.map((f) => String(f.text)).join(" ")));
      const want = said(script);
      expect(want.filter((w) => heard.has(w)).length / want.length, finals.map((f) => f.text).join(" | ")).toBeGreaterThanOrEqual(0.95);
      // Nothing said twice at a seam: no longer than the script (with a little room for spelling).
      expect(said(finals.map((f) => String(f.text)).join(" ")).length).toBeLessThanOrEqual(want.length + 4);
      expect(ev.at(-1)).toMatchObject({ type: "end" });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 200_000);

  it("a whole session with whisper on ends cleanly and says which engine won", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-session-"));
    try {
      const ctx = path.join(dir, "ctx.json");
      fs.writeFileSync(ctx, JSON.stringify({ strings: ["OrbStack", "Kokoro"] }));
      const wav = clip("open OrbStack and restart the Kokoro server", dir);
      const r = run(["--file", wav, "--locale", "en-US", "--context-file", ctx, "--whisper-model", model]);
      const ev = events(r.stdout);
      expect(ev.find((e) => e.type === "whisper"), r.stderr).toMatchObject({ ok: true });
      const final = ev.find((e) => e.type === "final");
      expect(final, r.stderr).toBeTruthy();
      expect(["apple", "whisper"]).toContain(final!.engine);
      expect(typeof final!.whisperMs).toBe("number");
      expect(r.signal).toBeNull();
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
