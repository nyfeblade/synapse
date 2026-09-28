import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  F5_DEFAULTS, F5_PREFIX, deleteProfile, f5Command, f5VoiceId, findF5, listProfiles,
  readProfile, renameProfile, saveProfile, voiceIdFor, voicesDir,
} from "../../src/main/native/f5";
import { kokoroVoiceId } from "../../src/main/native/kokoro";

let dir = "";
const WAV = Buffer.from("RIFF....WAVEfmt ", "utf8");

const save = (id: string, extra: Partial<Parameters<typeof saveProfile>[1]> = {}) =>
  saveProfile(dir, {
    id, name: id, transcript: "Honestly, is it going to rain later today?",
    scriptId: "asks", wav: WAV, loudness: 0.1, ...extra,
  });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("voice ids", () => {
  it("reads an f5 id and leaves other engines alone", () => {
    expect(f5VoiceId("f5:my-voice")).toBe("my-voice");
    expect(f5VoiceId("kokoro:af_heart")).toBeNull();
    expect(f5VoiceId("com.apple.voice.premium.en-US.Ava")).toBeNull();
    expect(f5VoiceId(null)).toBeNull();
    expect(f5VoiceId("f5:")).toBeNull();
  });

  it("rejects an id that could escape the voices folder", () => {
    expect(f5VoiceId("f5:../../etc/passwd")).toBeNull();
    expect(f5VoiceId("f5:a/b")).toBeNull();
    expect(f5VoiceId(`f5:${"x".repeat(65)}`)).toBeNull();
  });

  it("the two engines never claim each other's voices", () => {
    expect(kokoroVoiceId("f5:my-voice")).toBeNull();
    expect(f5VoiceId(`${F5_PREFIX}af_heart`)).toBe("af_heart"); // an f5 profile may be named anything
  });
});

describe("the voice profile store", () => {
  it("saves a profile with the transcript, a fixed seed and the generation parameters", () => {
    const p = save("mine");
    expect(p.version).toBe(1);
    expect(p.transcript).toMatch(/rain later today/);
    expect(p.seed).toBe(F5_DEFAULTS.seed);
    expect(p.steps).toBe(F5_DEFAULTS.steps);
    expect(p.cfgStrength).toBe(F5_DEFAULTS.cfgStrength);
    expect(p.loudness).toBe(0.1);
    expect(p.createdAt).toMatch(/^\d{4}-/);
    expect(fs.existsSync(path.join(dir, "mine", "clip.wav"))).toBe(true);
  });

  it("reads it back, and a later session sees the same parameters", () => {
    const saved = save("mine");
    expect(readProfile(dir, "mine")).toEqual(saved);
  });

  it("refuses a profile with no transcript, because the clone would be poor", () => {
    expect(() => save("empty", { transcript: "   " })).toThrow(/transcript/);
  });

  it("refuses an id that would write outside the voices folder", () => {
    expect(() => save("../escape")).toThrow(/bad voice id/);
  });

  it("drops the cached conditioning when the clip is re-recorded", () => {
    save("mine");
    const cond = path.join(dir, "mine", "cond.npy");
    fs.writeFileSync(cond, "stale");
    save("mine", { transcript: "A different sentence entirely." });
    expect(fs.existsSync(cond)).toBe(false);
  });

  it("lists saved voices newest first and ignores half-written ones", () => {
    save("old", { createdAt: "2026-01-01T00:00:00.000Z" });
    save("new", { createdAt: "2026-09-01T00:00:00.000Z" });
    fs.mkdirSync(path.join(dir, "junk"), { recursive: true });
    fs.writeFileSync(path.join(dir, "junk", "profile.json"), "{ not json");
    expect(listProfiles(dir).map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("ignores a profile whose clip has gone missing", () => {
    save("mine");
    fs.rmSync(path.join(dir, "mine", "clip.wav"));
    expect(readProfile(dir, "mine")).toBeNull();
  });

  it("renames and deletes", () => {
    save("mine");
    expect(renameProfile(dir, "mine", "My voice")?.name).toBe("My voice");
    expect(readProfile(dir, "mine")?.name).toBe("My voice");
    expect(deleteProfile(dir, "mine")).toBe(true);
    expect(readProfile(dir, "mine")).toBeNull();
  });

  it("makes a safe, unique id from a name", () => {
    expect(voiceIdFor(dir, "My Voice!")).toBe("my-voice");
    save("my-voice");
    expect(voiceIdFor(dir, "My Voice!")).toBe("my-voice-2");
  });

  it("keeps voices under the app's data dir", () => {
    expect(voicesDir("/Users/x/Library/Application Support/Synapse")).toBe("/Users/x/Library/Application Support/Synapse/voices");
  });
});

describe("finding and launching the sidecar", () => {
  const home = "/Users/x";
  const userData = "/Users/x/Library/Application Support/Synapse";
  const own = path.join(userData, "f5", ".venv", "bin", "python");
  const outside = path.join(home, "voice-lab", ".venv", "bin", "python");

  it("uses Synapse's own env and never auto-detects a voice path outside its own data (portable install)", () => {
    expect(findF5({ home, userData, exists: (p) => !p.endsWith("pack.json") })?.source).toBe("synapse");
    expect(findF5({ home, userData, exists: (p) => p === own })?.python).toBe(own);
    expect(findF5({ home, userData, exists: (p) => p === outside })).toBeNull();
    expect(findF5({ home, userData, exists: () => false })).toBeNull();
  });

  it("a python saved in settings wins", () => {
    const e = findF5({ home, userData, exists: () => true, python: "/opt/py" });
    expect(e).toEqual({ python: "/opt/py", modelDir: "", source: "settings" });
  });

  it("runs arm64 Python isolated from the user's shell, pointed at the voices folder", () => {
    const e = { python: own, modelDir: "", source: "synapse" as const };
    const { cmd, args } = f5Command(e, "/app/f5_server.py", { profilesDir: "/data/voices", voice: "mine" });
    expect(cmd).toBe("/usr/bin/arch");
    expect(args.slice(0, 5)).toEqual(["-arm64", own, "-s", "-E", "/app/f5_server.py"]);
    expect(args).toContain("--profiles-dir");
    expect(args[args.indexOf("--profiles-dir") + 1]).toBe("/data/voices");
    expect(args[args.indexOf("--voice") + 1]).toBe("mine");
  });

  // Portable install: the "Cloned voices" pack — its own Python, and the weights in its own Hugging Face layout,
  // which the sidecar reads through HF_HOME (offline) instead of the user's ~/.cache/huggingface.
  it("finds the downloaded pack and points the sidecar at the pack's weights", () => {
    const root = path.join(userData, "f5");
    const pack = path.join(root, "runtime", "python", "bin", "python3.12");
    const e = findF5({ home, userData, exists: (p) => p === pack || p === own || p === path.join(root, "pack.json") });
    expect(e).toEqual({ python: pack, modelDir: path.join(root, "hf"), source: "pack" });
    const { cmd, args } = f5Command(e!, "/app/f5_server.py", { profilesDir: "/data/voices" });
    expect(cmd).toBe("/usr/bin/env");
    expect(args.slice(0, 5)).toEqual([`HF_HOME=${path.join(root, "hf")}`, "/usr/bin/arch", "-arm64", pack, "-s"]);
  });

  it("never passes a voice id it would not accept", () => {
    const e = { python: own, modelDir: "", source: "synapse" as const };
    const { args } = f5Command(e, "/s.py", { profilesDir: "/d", voice: "../escape" });
    expect(args).not.toContain("--voice");
  });
});

describe("what a user with no cloned voice pays", () => {
  it("does not start Python until a Bot that uses a cloned voice speaks", async () => {
    const { registerF5 } = await import("../../src/main/native/f5");
    const spawnFn = vi.fn();
    const f5 = registerF5({
      script: "/app/f5_server.py", home: "/Users/x", userData: dir, log: () => {},
      spawnFn: spawnFn as never, exists: () => true,
    });
    // warming with no cloned voices must not reach for Python at all
    f5.warm([]);
    f5.warm(["kokoro:af_heart"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnFn).not.toHaveBeenCalled();
    expect(f5.isReady()).toBe(false);
    f5.dispose();
  });

  it("reports no-voices rather than missing when Python is there but nothing is recorded", async () => {
    const { registerF5 } = await import("../../src/main/native/f5");
    const spawnFn = vi.fn(() => {
      const { EventEmitter } = require("node:events");
      const c: Record<string, unknown> = new EventEmitter();
      c.stderr = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stdin = { write: () => true, end: () => {} };
      c.kill = () => {};
      setImmediate(() => (c as { emit(e: string, c: number): void }).emit("close", 0));
      return c;
    });
    const f5 = registerF5({
      script: "/app/f5_server.py", home: "/Users/x", userData: dir, log: () => {},
      spawnFn: spawnFn as never, exists: () => true,
    });
    const s = await f5.status();
    expect(s.state).toBe("no-voices");
    expect(s.voices).toEqual([]);
    f5.dispose();
  });
});

describe("findF5 across profiles (bug 167)", () => {
  it("finds the env install.sh put in the shared Bots folder", () => {
    const py = "/Lib/Bots/f5/.venv/bin/python";
    expect(findF5({ home: "/home", userData: "/Lib/Bots/profiles/default", exists: (p) => p === py }))
      .toEqual({ python: py, modelDir: "", source: "synapse" });
  });
});
