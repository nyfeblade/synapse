import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, type KokoroEngine } from "../../src/main/native/kokoro";
import {
  KOKORO_LEVELS, KOKORO_LEVEL_DEFAULT, QWEN_VOICES, chooseEngine, findQwen, modelDirOk, probeQwen,
  qwenCommand, qwenVoiceId, registerQwen, targetRmsFor,
} from "../../src/main/native/qwen";
import { f5VoiceId } from "../../src/main/native/f5";
import { kokoroVoiceId } from "../../src/main/native/kokoro";
import { installNativeIpc } from "../../src/main/native";
import { helperArgs } from "../../src/main/native/dictation";

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid: number;
  };
  c.stdin = { write: vi.fn(), end: vi.fn() };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  c.pid = 4243;
  return c;
}
type Fake = ReturnType<typeof fakeChild>;
const written = (c: Fake) => c.stdin.write.mock.calls.map((x) => String(x[0]));
const ENGINE: KokoroEngine = { python: "/u/Library/Application Support/Synapse/qwen/.venv/bin/python", modelDir: "/u/model", source: "synapse" };

describe("a Qwen voice id is only ever a Qwen voice id (bug 164)", () => {
  it("reads the nine voices the model ships with", () => {
    expect(QWEN_VOICES).toHaveLength(9);
    expect(qwenVoiceId("qwen3:vivian")).toBe("vivian");
    expect(qwenVoiceId("qwen3:uncle_fu")).toBe("uncle_fu");
    expect(qwenVoiceId("qwen3:ono_anna")).toBe("ono_anna");
  });

  it("refuses a voice this build doesn't have, rather than passing it to the model", () => {
    expect(qwenVoiceId("qwen3:nobody")).toBe(null);
    expect(qwenVoiceId("qwen3:")).toBe(null);
    expect(qwenVoiceId("qwen3:../../etc/passwd")).toBe(null);
  });

  it("never claims another engine's voice, and they never claim its", () => {
    for (const v of ["kokoro:af_heart", "f5:my-voice", "com.apple.voice.premium.en-US.Ava", "", null, 7]) {
      expect(qwenVoiceId(v)).toBe(null);
    }
    // The three namespaces are disjoint, which is what lets one cache and one picker hold them all.
    expect(kokoroVoiceId("qwen3:vivian")).toBe(null);
    expect(f5VoiceId("qwen3:vivian")).toBe(null);
  });
});

describe("matching Qwen's level to the Bot's own Kokoro voice", () => {
  it("uses that voice's measured level, prefixed or bare", () => {
    expect(targetRmsFor("kokoro:am_puck")).toBe(KOKORO_LEVELS.am_puck);
    expect(targetRmsFor("am_puck")).toBe(KOKORO_LEVELS.am_puck);
  });

  it("falls back to the mean when there is no Kokoro voice to match", () => {
    expect(targetRmsFor(null)).toBe(KOKORO_LEVEL_DEFAULT);
    expect(targetRmsFor("kokoro:not_a_voice")).toBe(KOKORO_LEVEL_DEFAULT);
  });

  it("has a level for every voice the picker offers, or the handover would step", () => {
    // The spread is real — 4.9 dB between the quietest and the loudest — which is why this is a
    // per-voice table and not one global number.
    const levels = Object.values(KOKORO_LEVELS);
    expect(levels).toHaveLength(9);
    expect(Math.max(...levels) / Math.min(...levels)).toBeGreaterThan(1.5);
  });
});

describe("choosing the engine: no opener (decision 184)", () => {
  it("gives Qwen the whole reply, warm or cold, so long as it's ready", () => {
    // Bug 182: mixing engines inside one reply was a +19 semitone pitch jump at the switch. The
    // opener is gone — Qwen says every line, including the first, whenever it is available.
    expect(chooseEngine({ qwenReady: true, fallback: true }).engine).toBe("qwen");
    // No Kokoro voice to fall back to changes nothing when Qwen is ready anyway.
    expect(chooseEngine({ qwenReady: true, fallback: false }).engine).toBe("qwen");
  });

  it("falls back to Kokoro for the WHOLE reply when Qwen is genuinely unavailable", () => {
    // Not installed, its probe failed, Light voice mode, or the mode dropped Qwen mid-call — never
    // a mix, the whole reply goes to the Bot's Kokoro voice.
    expect(chooseEngine({ qwenReady: false, fallback: true }).engine).toBe("kokoro");
  });

  it("still asks for Qwen when it's unavailable and there is no Kokoro voice either", () => {
    // Nothing else to say it with: synthQwen reports the error and the line falls through to the
    // system voice, exactly as before this change.
    expect(chooseEngine({ qwenReady: false, fallback: false }).engine).toBe("qwen");
  });
});

describe("finding Qwen on this Mac", () => {
  const exists = (set: string[]) => (p: string) => set.includes(p);
  const CONFIG = '{"model_type":"qwen3_tts","architectures":["Qwen3TTSForConditionalGeneration"]}';

  it("accepts a model folder whose config really is this architecture", () => {
    const files = ["/m/config.json", "/m/model.safetensors"];
    expect(modelDirOk("/m", exists(files), () => CONFIG)).toBe(true);
  });

  it("rejects a folder holding some other model, however well named", () => {
    const files = ["/m/config.json", "/m/model.safetensors"];
    expect(modelDirOk("/m", exists(files), () => '{"model_type":"kokoro"}')).toBe(false);
    expect(modelDirOk("/m", exists(["/m/config.json"]), () => CONFIG)).toBe(false);
  });

  it("finds Synapse's own env and model, and never probes the Hugging Face cache (portable install)", () => {
    const py = "/u/qwen/.venv/bin/python";
    const snapRoot = "/home/.cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit/snapshots";
    const hf = [py, snapRoot, `${snapRoot}/abc/config.json`, `${snapRoot}/abc/model.safetensors`];
    const listDir = (p: string) => (p === snapRoot ? ["abc"] : []);
    expect(findQwen({ home: "/home", userData: "/u", exists: exists(hf), listDir, read: () => CONFIG })).toBe(null);
    const own = [py, "/u/qwen/model/config.json", "/u/qwen/model/model.safetensors"];
    expect(findQwen({ home: "/home", userData: "/u", exists: exists(own), listDir, read: () => CONFIG }))
      .toEqual({ python: py, modelDir: "/u/qwen/model", source: "synapse" });
  });

  it("never reaches for a voice path outside its own data, whose mlx-audio may not load this model", () => {
    const outside = "/home/voice-lab/.venv/bin/python";
    const snapRoot = "/home/.cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit/snapshots";
    const files = [outside, snapRoot, `${snapRoot}/abc/config.json`, `${snapRoot}/abc/model.safetensors`];
    expect(findQwen({
      home: "/home", userData: "/u", exists: exists(files),
      listDir: (p) => (p === snapRoot ? ["abc"] : []), read: () => CONFIG,
    })).toBe(null);
  });

  it("runs the sidecar under arm64, isolated from the user's shell", () => {
    const { cmd, args } = qwenCommand(ENGINE, "/app/qwen_server.py", { cacheDir: "/c", voice: "vivian" });
    expect(cmd).toBe("/usr/bin/arch");
    expect(args).toEqual(["-arm64", ENGINE.python, "-s", "-E", "/app/qwen_server.py", "--model-dir", ENGINE.modelDir, "--cache-dir", "/c", "--voice", "vivian"]);
  });

  it("drops a voice the model doesn't have rather than putting it on the command line", () => {
    expect(qwenCommand(ENGINE, "/s.py", { voice: "nobody" }).args).not.toContain("--voice");
  });
});

describe("the import probe", () => {
  const spawnOk = (code: number, stderr = "") => vi.fn(() => {
    const c = fakeChild();
    setImmediate(() => { if (stderr) c.stderr.emit("data", Buffer.from(stderr)); c.emit("close", code); });
    return c as unknown as ChildProcess;
  });

  it("checks mlx-audio's VERSION, not just that it imports", async () => {
    const spawnFn = spawnOk(0);
    await probeQwen(ENGINE, { spawnFn: spawnFn as never });
    const code = String((spawnFn.mock.calls[0] as unknown as [string, string[]])[1].at(-1));
    // 0.2.9 imports perfectly and then fails the LOAD; the probe has to catch that here instead.
    expect(code).toContain("0,5,5");
    expect(code).toContain("qwen3_tts");
  });

  it("reports the last line of the failure, so Settings can say what is wrong", async () => {
    const r = await probeQwen(ENGINE, { spawnFn: spawnOk(1, "Traceback\nAssertionError: mlx-audio 0.2.9 is too old for Qwen3 (needs 0.5.5)\n") as never });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("0.2.9 is too old");
  });
});

describe("Qwen costs nothing until a Bot uses it", () => {
  let dispose: (() => void) | null = null;
  beforeEach(() => { installNativeIpc({ handle: vi.fn() } as never, () => null); });
  afterEach(() => { dispose?.(); dispose = null; vi.restoreAllMocks(); });

  const setup = (o: { allowed?: () => boolean } = {}) => {
    const kids: Fake[] = [];
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      const c = fakeChild();
      kids.push(c);
      // The probe is a -c one-liner; the sidecar is the script. Only the probe exits by itself.
      if (args.includes("-c")) setImmediate(() => c.emit("close", 0));
      return c as unknown as ChildProcess;
    });
    const CONFIG = '{"model_type":"qwen3_tts"}';
    const files = ["/app/qwen_server.py", "/u/qwen/.venv/bin/python", "/u/qwen/model/config.json", "/u/qwen/model/model.safetensors"];
    const q = registerQwen({
      script: "/app/qwen_server.py", home: "/home", userData: "/u", log: vi.fn(), spawnFn: spawnFn as never,
      exists: (p) => files.includes(p), listDir: () => [], read: () => CONFIG, ...o,
    });
    dispose = () => q.dispose();
    /** Children that are the SIDECAR, not the one-shot probe. */
    const sidecars = () => spawnFn.mock.calls.filter((c) => !(c[1] as string[]).includes("-c"));
    return { q, kids, spawnFn, sidecars };
  };

  it("starts no process at all while no Bot is set to a Qwen voice", async () => {
    const { q, sidecars } = setup();
    // The status probe may run (it is a one-shot -c import test); the model must not be loaded.
    await q.status();
    q.warm([]);
    q.warm(["kokoro:af_heart", "f5:my-voice"]);
    await new Promise((r) => setImmediate(r));
    expect(sidecars()).toHaveLength(0);
    expect(q.memoryMb()).toBe(0);
  });

  it("starts one when a Bot's Qwen voice is about to speak", async () => {
    const { q, sidecars } = setup();
    await q.status();
    q.warm(["qwen3:vivian"]);
    await new Promise((r) => setImmediate(r));
    expect(sidecars()).toHaveLength(1);
    expect(sidecars()[0]![1]).toContain("--voice");
    expect(q.memoryMb()).toBeGreaterThan(0);
  });

  it("stays unloaded on Light however the Bot is set", async () => {
    const { q, sidecars } = setup({ allowed: () => false });
    await q.status();
    q.warm(["qwen3:vivian"]);
    await new Promise((r) => setImmediate(r));
    expect(sidecars()).toHaveLength(0);
    expect(q.isReady()).toBe(false);
    const h = { audio: vi.fn(), done: vi.fn(), error: vi.fn() };
    q.synthQwen({ id: "a", text: "Hello.", voice: "qwen3:vivian", speed: 1 }, h);
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining("Full voice quality"));
    expect(sidecars()).toHaveLength(0);
  });

  it("puts the quality and the level on the synth command the sidecar reads", async () => {
    const { q, kids, sidecars } = setup();
    await q.status();
    q.warm(["qwen3:vivian"]);
    await new Promise((r) => setImmediate(r));
    expect(sidecars()).toHaveLength(1);
    const child = kids.at(-1)!;
    child.stdout.emit("data", encodeFrame({ type: "ready", sampleRate: 24000, loadMs: 1600 }));
    child.stdout.emit("data", encodeFrame({ type: "warm", ms: 900 }));
    q.synthQwen({ id: "l1", text: "Hello there.", voice: "qwen3:vivian", speed: 1, quality: "full", targetRms: 0.0865 }, { audio: vi.fn(), done: vi.fn(), error: vi.fn() });
    const synth = written(child).map((l) => JSON.parse(l) as Record<string, unknown>).find((c) => c.op === "synth")!;
    expect(synth).toMatchObject({ op: "synth", id: "l1", voice: "vivian", quality: "full", targetRms: 0.0865 });
    // Bugs 182/183: the app never sends an `instruct`, so every line is rendered with the sidecar's
    // DEFAULT_INSTRUCT — which is what lets the phrase cache key on voice, speed and text alone, and
    // the sidecar learn one level per voice. A per-Bot instruct would have to join both.
    expect(synth).not.toHaveProperty("instruct");
  });

  it("defaults a live line to streaming, which is what makes a call usable", async () => {
    const { q, kids } = setup();
    await q.status();
    q.warm(["qwen3:vivian"]);
    await new Promise((r) => setImmediate(r));
    const child = kids.at(-1)!;
    q.synthQwen({ id: "l2", text: "Hello.", voice: "qwen3:vivian", speed: 1 }, { audio: vi.fn(), done: vi.fn(), error: vi.fn() });
    const synth = written(child).map((l) => JSON.parse(l) as Record<string, unknown>).find((c) => c.op === "synth")!;
    expect(synth.quality).toBe("live");
  });

  it("unloads on request, and reports nothing held afterwards", async () => {
    const { q, kids } = setup();
    await q.status();
    q.warm(["qwen3:vivian"]);
    await new Promise((r) => setImmediate(r));
    expect(q.memoryMb()).toBeGreaterThan(0);
    q.unload();
    kids.at(-1)!.emit("close", 0, null);
    expect(q.memoryMb()).toBe(0);
  });

  it("refuses a voice it doesn't have without touching the sidecar", async () => {
    const { q } = setup();
    await q.status();
    const h = { audio: vi.fn(), done: vi.fn(), error: vi.fn() };
    q.synthQwen({ id: "x", text: "Hi.", voice: "kokoro:af_heart", speed: 1 }, h);
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining("isn't available"));
  });
});

describe("a prefixed voice never reaches the Swift helper as an Apple identifier", () => {
  it("keeps every engine prefix off the session's command line", () => {
    // Bug 164: only "kokoro:" was stripped here, so a Settings → Voice choice of a Qwen or cloned
    // voice started the helper with "--voice qwen3:vivian" — an id AVSpeechSynthesizer has never
    // heard of, which it answers by quietly using some other voice.
    for (const v of ["kokoro:af_heart", "qwen3:vivian", "f5:my-voice"]) {
      expect(helperArgs("call", "en-US", undefined, v)).not.toContain("--voice");
    }
  });

  it("still passes a real Apple identifier through, which is what the argument is for", () => {
    expect(helperArgs("call", "en-US", undefined, "com.apple.voice.premium.en-US.Ava"))
      .toContain("com.apple.voice.premium.en-US.Ava");
  });
});

// Bug 167: install.sh puts Qwen in …/Bots/qwen, shared by every profile, but the app's userData is
// …/Bots/profiles/<name>. Looking only under userData found nothing on a Mac that had everything.
describe("findQwen across profiles (bug 167)", () => {
  const exists = (set: string[]) => (p: string) => set.includes(p);
  const CONFIG = '{"model_type":"qwen3_tts"}';
  const bots = "/Lib/Bots";
  const userData = `${bots}/profiles/default`;
  const snapRoot = "/home/.cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit/snapshots";

  it("finds the env and model the voice pack put in the shared Bots folder", () => {
    const py = `${bots}/qwen/.venv/bin/python`;
    const files = [py, snapRoot, `${snapRoot}/abc/config.json`, `${snapRoot}/abc/model.safetensors`, `${bots}/qwen/model/config.json`, `${bots}/qwen/model/model.safetensors`];
    expect(findQwen({
      home: "/home", userData, exists: exists(files),
      listDir: (p) => (p === snapRoot ? ["abc"] : []), read: () => CONFIG,
    })).toEqual({ python: py, modelDir: `${bots}/qwen/model`, source: "synapse" });
  });

  // Portable install: the "Natural voices" pack (voice-packs.ts) — its own Python and the model, in the shared folder.
  it("finds the downloaded voice pack, ahead of an older env in the same folder", () => {
    const pack = `${bots}/qwen/runtime/python/bin/python3.12`;
    const files = [pack, `${bots}/qwen/.venv/bin/python`, `${bots}/qwen/pack.json`, `${bots}/qwen/model/config.json`, `${bots}/qwen/model/model.safetensors`];
    expect(findQwen({ home: "/home", userData, exists: exists(files), listDir: () => [], read: () => CONFIG }))
      .toEqual({ python: pack, modelDir: `${bots}/qwen/model`, source: "pack" });
  });

  it("prefers the profile's own install over the shared one", () => {
    const own = `${userData}/qwen/.venv/bin/python`;
    const files = [own, `${bots}/qwen/.venv/bin/python`, `${userData}/qwen/model/config.json`, `${userData}/qwen/model/model.safetensors`];
    expect(findQwen({ home: "/home", userData, exists: exists(files), listDir: () => [], read: () => CONFIG }))
      .toEqual({ python: own, modelDir: `${userData}/qwen/model`, source: "synapse" });
  });
});
