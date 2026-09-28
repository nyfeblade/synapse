import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WHISPER_BUDGET_FREE_SECONDS, WHISPER_BUDGET_MS, WHISPER_BUDGET_PER_SECOND_MS, WHISPER_CHUNK_SECONDS, WHISPER_MAX_BUDGET_MS,
  WHISPER_BACKGROUND_BUDGET_FACTOR, WHISPER_STOP_WAIT_MS, downloadModel, helperHasWhisper, helperWhisperArgs, humanBytes, modelUrl,
  whisperBudgetMs, whisperRoot, whisperStatus,
} from "../../src/main/native/stt-whisper";
import { helperArgs, parseDictationLine } from "../../src/main/native/dictation";

// Bug 165: whisper.cpp re-transcribes the finished utterance. The rules under test here are the
// ones that decide whether the helper loads it at all — which is the whole of "Light mode costs
// nothing" and the whole of "a missing model never breaks dictation".

let userData: string;
beforeEach(() => { userData = fs.mkdtempSync(path.join(os.tmpdir(), "stt-whisper-")); });
afterEach(() => { fs.rmSync(userData, { recursive: true, force: true }); });

/** Pretend install.sh put weights of `bytes` bytes in place. */
function fakeModel(name: string, bytes = 1024): void {
  const dir = path.join(whisperRoot(userData), "models");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `ggml-${name}.bin`), Buffer.alloc(bytes));
  fs.writeFileSync(path.join(whisperRoot(userData), "model"), name);
}

describe("whisperStatus", () => {
  it("is 'light' in Light mode, whatever is installed", () => {
    fakeModel("large-v3-turbo-q5_0");
    const s = whisperStatus({ userData, mode: "light", builtIn: true });
    expect(s.state).toBe("light");
    // Nothing to load: Light mode must not even name a file.
    expect(s.model).toBeNull();
  });

  it("is 'ready' in Full mode once the weights are there", () => {
    fakeModel("large-v3-turbo-q5_0", 4096);
    const s = whisperStatus({ userData, mode: "full", builtIn: true });
    expect(s.state).toBe("ready");
    expect(s.name).toBe("large-v3-turbo-q5_0");
    expect(s.bytes).toBe(4096);
    expect(s.model).toContain("ggml-large-v3-turbo-q5_0.bin");
  });

  it("says 'no-model' rather than pretending, when nothing is installed", () => {
    expect(whisperStatus({ userData, mode: "full", builtIn: true }).state).toBe("no-model");
  });

  it("says 'no-build' when the helper was compiled without whisper", () => {
    fakeModel("large-v3-turbo-q5_0");
    expect(whisperStatus({ userData, mode: "full", builtIn: false }).state).toBe("no-build");
  });

  it("ignores a recorded model whose file is gone, and finds what is really there", () => {
    fakeModel("small.en", 2048);
    fs.writeFileSync(path.join(whisperRoot(userData), "model"), "large-v3-turbo-q5_0");
    const s = whisperStatus({ userData, mode: "full", builtIn: true });
    expect(s.state).toBe("ready");
    expect(s.name).toBe("small.en");
  });

  it("prefers the better weights when both are installed", () => {
    fakeModel("small.en", 1000);
    fs.writeFileSync(path.join(whisperRoot(userData), "models", "ggml-large-v3-turbo-q5_0.bin"), Buffer.alloc(5000));
    fs.rmSync(path.join(whisperRoot(userData), "model"));
    expect(whisperStatus({ userData, mode: "full", builtIn: true }).name).toBe("large-v3-turbo-q5_0");
  });

  it("an empty file is not a model", () => {
    const dir = path.join(whisperRoot(userData), "models");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ggml-small.en.bin"), "");
    expect(whisperStatus({ userData, mode: "full", builtIn: true }).state).toBe("no-model");
  });
});

describe("helperWhisperArgs", () => {
  const ready = () => { fakeModel("large-v3-turbo-q5_0"); return whisperStatus({ userData, mode: "full", builtIn: true }); };

  it("passes the model and the budget for dictation in Full mode", () => {
    const args = helperWhisperArgs({ status: ready(), mode: "dictation", dictationOnly: true });
    expect(args[0]).toBe("--whisper-model");
    expect(args).toContain("--whisper-budget-ms");
    expect(args).toContain(String(WHISPER_BUDGET_MS));
  });

  it("passes NOTHING in Light mode — the helper loads no model and keeps no audio", () => {
    fakeModel("large-v3-turbo-q5_0");
    const light = whisperStatus({ userData, mode: "light", builtIn: true });
    expect(helperWhisperArgs({ status: light, mode: "dictation", dictationOnly: false })).toEqual([]);
  });

  it("leaves calls alone by default, and joins them when the user asks", () => {
    expect(helperWhisperArgs({ status: ready(), mode: "call", dictationOnly: true })).toEqual([]);
    expect(helperWhisperArgs({ status: ready(), mode: "call", dictationOnly: false })).toContain("--whisper-model");
  });

  it("passes nothing when the model is missing, so dictation just runs on Apple", () => {
    const missing = whisperStatus({ userData, mode: "full", builtIn: true });
    expect(helperWhisperArgs({ status: missing, mode: "dictation", dictationOnly: true })).toEqual([]);
  });

  it("passes nothing when the helper has no whisper in it", () => {
    fakeModel("large-v3-turbo-q5_0");
    const noBuild = whisperStatus({ userData, mode: "full", builtIn: false });
    expect(helperWhisperArgs({ status: noBuild, mode: "dictation", dictationOnly: true })).toEqual([]);
  });
});

describe("whisper's budget grows with the speech (bug 185)", () => {
  it("a short turn keeps the measured 900 ms; a long one gets what it needs, within a bound", () => {
    expect(whisperBudgetMs(4)).toBe(WHISPER_BUDGET_MS);
    expect(whisperBudgetMs(20)).toBeGreaterThan(whisperBudgetMs(10));
    // A 26 s turn aborted at 900 ms every time before (measured); a 28 s chunk now has room.
    expect(whisperBudgetMs(28)).toBeGreaterThanOrEqual(2 * 1132); // twice what a 28 s chunk measured
    expect(whisperBudgetMs(600)).toBe(WHISPER_MAX_BUDGET_MS);
  });

  it("the stop grace covers Apple's last final plus the in-flight chunk and the tail", () => {
    // Apple's final, the chunk in flight (background budget) and the tail, each possibly retried once.
    expect(WHISPER_STOP_WAIT_MS).toBeGreaterThanOrEqual(2_000 + 2 * WHISPER_BACKGROUND_BUDGET_FACTOR * whisperBudgetMs(28) + 2 * whisperBudgetMs(28));
    expect(WHISPER_STOP_WAIT_MS).toBeLessThanOrEqual(20_000);
  });

  it("mirrors the helper's own constants, so the two sides cannot drift", () => {
    const swift = fs.readFileSync(path.resolve(__dirname, "../../native/dictation/Dictation.swift"), "utf8");
    const grab = (name: string) => Number(new RegExp(`static let ${name} = ([\\d_.]+)`).exec(swift)?.[1]?.replace(/_/g, ""));
    expect(grab("budgetPerSecondMs")).toBe(WHISPER_BUDGET_PER_SECOND_MS);
    expect(grab("maxBudgetMs")).toBe(WHISPER_MAX_BUDGET_MS);
    expect(grab("budgetFreeSamples") / 16_000).toBe(WHISPER_BUDGET_FREE_SECONDS);
    expect(grab("chunkSamples") / 16_000).toBe(WHISPER_CHUNK_SECONDS);
    expect(grab("backgroundBudgetFactor")).toBe(WHISPER_BACKGROUND_BUDGET_FACTOR);
  });
});

describe("helperArgs", () => {
  it("appends the whisper arguments after the existing ones, and changes nothing without them", () => {
    const without = helperArgs("dictation", "en-US", undefined, null, "/tmp/ctx.json", "/tmp/lm");
    const with_ = helperArgs("dictation", "en-US", undefined, null, "/tmp/ctx.json", "/tmp/lm", ["--whisper-model", "/m.bin"]);
    expect(with_.slice(0, without.length)).toEqual(without);
    expect(with_.slice(without.length)).toEqual(["--whisper-model", "/m.bin"]);
    expect(helperArgs("dictation", "en-US", undefined, null, undefined, undefined, [])).not.toContain("--whisper-model");
  });
});

describe("the final event", () => {
  it("carries which engine won and what it cost", () => {
    expect(parseDictationLine(JSON.stringify({ type: "final", text: "hi", engine: "whisper", whisperMs: 470 })))
      .toEqual({ type: "final", text: "hi", engine: "whisper", whisperMs: 470 });
  });

  it("is exactly what it always was from a helper with no whisper in it", () => {
    expect(parseDictationLine(JSON.stringify({ type: "final", text: "hi" }))).toEqual({ type: "final", text: "hi" });
  });

  it("ignores an engine it does not know, rather than passing it on", () => {
    expect(parseDictationLine(JSON.stringify({ type: "final", text: "hi", engine: "??" }))).toEqual({ type: "final", text: "hi" });
  });

  it("reads the whisper load event", () => {
    expect(parseDictationLine(JSON.stringify({ type: "whisper", ok: true, ms: 247, model: "ggml-large-v3-turbo-q5_0.bin" })))
      .toEqual({ type: "whisper", ok: true, ms: 247, model: "ggml-large-v3-turbo-q5_0.bin" });
    expect(parseDictationLine(JSON.stringify({ type: "whisper", ok: false, reason: "load-failed" })))
      .toEqual({ type: "whisper", ok: false, reason: "load-failed" });
  });
});

describe("downloadModel", () => {
  const body = (bytes: number) => ({
    ok: true,
    headers: new Map([["content-length", String(bytes)]]) as unknown as Headers,
    body: (async function* () { yield new Uint8Array(bytes); })(),
  });

  it("writes the weights and records which ones they are", async () => {
    const seen: unknown[] = [];
    const got = await downloadModel({
      userData, onProgress: (p) => seen.push(p), models: [{ name: "small.en", bytes: 100 }],
      fetchFn: (async () => body(100)) as unknown as typeof fetch,
    });
    expect(got).toBe("small.en");
    expect(fs.readFileSync(path.join(whisperRoot(userData), "model"), "utf8")).toBe("small.en");
    expect(fs.statSync(path.join(whisperRoot(userData), "models", "ggml-small.en.bin")).size).toBe(100);
    expect(seen.at(-1)).toEqual({ state: "ready", name: "small.en" });
    // The status must now agree with what is on disk.
    expect(whisperStatus({ userData, mode: "full", builtIn: true }).state).toBe("ready");
  });

  it("falls back to the smaller weights and SAYS which ones it got", async () => {
    const calls: string[] = [];
    const got = await downloadModel({
      userData, onProgress: () => {},
      models: [{ name: "large-v3-turbo-q5_0", bytes: 100 }, { name: "small.en", bytes: 50 }],
      fetchFn: (async (u: string) => {
        calls.push(u);
        if (u.includes("large")) throw new Error("network");
        return body(50);
      }) as unknown as typeof fetch,
    });
    expect(got).toBe("small.en");
    expect(calls).toEqual([modelUrl("large-v3-turbo-q5_0"), modelUrl("small.en")]);
  });

  it("never leaves a half-download looking like a model", async () => {
    const got = await downloadModel({
      userData, onProgress: () => {}, models: [{ name: "small.en", bytes: 1000 }],
      fetchFn: (async () => ({ ...body(10), headers: new Map([["content-length", "1000"]]) as unknown as Headers })) as unknown as typeof fetch,
    });
    expect(got).toBeNull();
    expect(whisperStatus({ userData, mode: "full", builtIn: true }).state).toBe("no-model");
    expect(fs.existsSync(path.join(whisperRoot(userData), "models", "ggml-small.en.bin"))).toBe(false);
  });

  it("reports a failure instead of throwing at the caller", async () => {
    const seen: { state: string }[] = [];
    const got = await downloadModel({
      userData, onProgress: (p) => seen.push(p), models: [{ name: "small.en", bytes: 10 }],
      fetchFn: (async () => ({ ok: false, status: 503, body: null })) as unknown as typeof fetch,
    });
    expect(got).toBeNull();
    expect(seen.at(-1)?.state).toBe("failed");
  });
});

describe("helperHasWhisper", () => {
  it("is false for a binary that never linked it — and for one that is not there at all", () => {
    const f = path.join(userData, "fake-helper");
    fs.writeFileSync(f, "just a shell script");
    expect(helperHasWhisper(f)).toBe(false);
    expect(helperHasWhisper(path.join(userData, "nothing-here"))).toBe(false);
  });

  it("is true when the whisper symbol is in the binary", () => {
    const f = path.join(userData, "linked-helper");
    fs.writeFileSync(f, Buffer.concat([Buffer.alloc(64), Buffer.from("whisper_init_from_file_with_params")]));
    expect(helperHasWhisper(f)).toBe(true);
  });
});

describe("humanBytes", () => {
  it("reports what is really on disk", () => {
    expect(humanBytes(574_041_195)).toBe("574 MB");
    expect(humanBytes(1_400_000_000)).toBe("1.4 GB");
    expect(humanBytes(0)).toBe("0 MB");
  });
});

// Bug 167: install.sh builds into …/Bots/whisper; the app's userData is …/Bots/profiles/<name>.
describe("whisperRoot across profiles (bug 167)", () => {
  let bots: string;
  beforeEach(() => { bots = fs.mkdtempSync(path.join(os.tmpdir(), "stt-whisper-bots-")); });
  afterEach(() => { fs.rmSync(bots, { recursive: true, force: true }); });

  it("uses the shared Bots folder where install.sh put the model", () => {
    const profile = path.join(bots, "profiles", "default");
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(path.join(bots, "whisper", "models"), { recursive: true });
    fs.writeFileSync(path.join(bots, "whisper", "models", "ggml-small.en.bin"), Buffer.alloc(8));
    fs.writeFileSync(path.join(bots, "whisper", "model"), "small.en");
    expect(whisperRoot(profile)).toBe(path.join(bots, "whisper"));
    expect(whisperStatus({ userData: profile, mode: "full", builtIn: true }).state).toBe("ready");
  });

  it("keeps a profile's own whisper folder when it has one", () => {
    const profile = path.join(bots, "profiles", "default");
    fs.mkdirSync(path.join(profile, "whisper"), { recursive: true });
    fs.mkdirSync(path.join(bots, "whisper"), { recursive: true });
    expect(whisperRoot(profile)).toBe(path.join(profile, "whisper"));
  });
});
