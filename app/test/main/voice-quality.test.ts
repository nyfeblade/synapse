import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { LIMITS5 } from "@synapse/shared";
import { parseVoiceList, registerAudioDevices, validVoiceId, VOICE_DOWNLOADS_URL, type AudioPrefs } from "../../src/main/native/audio-devices";
import { helperArgs, parseDictationLine, registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";

// Bug 106: voice mode's voice quality, end of turn, and measurable latency.

const VOICES = JSON.stringify({
  type: "voices",
  voices: [
    { id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", lang: "en-US", quality: "premium" },
    { id: "com.apple.siri.natural.Aaron", name: "Voice 1", lang: "en-US", quality: "enhanced", siri: true },
    { id: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", lang: "en-US", quality: "default" },
    { id: "--evil", name: "x", lang: "en-US", quality: "default" },
    { id: "com.apple.voice.compact.en-GB.Daniel", name: "Daniel", lang: "en-GB", quality: "martian" },
    { id: "ok.id", name: 3, lang: "en-US", quality: "default" },
  ],
});

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> };
  c.stdin = { write: vi.fn(), end: vi.fn() };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.kill = vi.fn();
  return c;
}

function setup(voice: string | null = null) {
  const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>>();
  installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => null);
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn = vi.fn((_bin: string, _args: string[]) => { const c = fakeChild(); children.push(c); return c as unknown as ChildProcess; });
  const prefs: AudioPrefs = { input: null, output: "SPK" };
  let saved = voice;
  const writeVoice = vi.fn((v: string | null) => { saved = v; return saved; });
  const openExternal = vi.fn(async () => {});
  registerAudioDevices({ binary: "b", spawnFn: spawnFn as never, readPrefs: () => prefs, writePrefs: (p) => p, readVoice: () => saved, writeVoice, openExternal });
  const dispatch = (name: string, args: unknown = {}) => handlers.get("native")!({}, { name, args });
  return { children, spawnFn, writeVoice, openExternal, dispatch, saved: () => saved };
}

describe("voice list (bug 106)", () => {
  it("keeps well-formed voices, drops malformed ones, and orders premium → enhanced → default", () => {
    const v = parseVoiceList(`noise\n${VOICES}\n`);
    expect(v.map((x) => x.id)).toEqual(["com.apple.voice.premium.en-US.Zoe", "com.apple.siri.natural.Aaron", "com.apple.voice.compact.en-US.Samantha", "com.apple.voice.compact.en-GB.Daniel"]);
    expect(v[1]).toEqual({ id: "com.apple.siri.natural.Aaron", name: "Voice 1", lang: "en-US", quality: "enhanced", siri: true, personal: false });
    expect(v[3]!.quality).toBe("default");
    expect(parseVoiceList("")).toEqual([]);
  });

  it("voice ids are printable, bounded and never a flag", () => {
    expect(validVoiceId("com.apple.voice.premium.en-US.Zoe")).toBe(true);
    expect(validVoiceId("Samantha")).toBe(true);
    expect(validVoiceId("--list-voices")).toBe(false);
    expect(validVoiceId("a\nstop")).toBe(false);
    expect(validVoiceId("x".repeat(201))).toBe(false);
    expect(validVoiceId(null)).toBe(false);
  });
});

describe("voice natives (bug 106)", () => {
  it("lists the installed voices with the saved choice", async () => {
    const h = setup("com.apple.siri.natural.Aaron");
    const p = h.dispatch("audio.voices.list");
    await Promise.resolve();
    expect(h.spawnFn.mock.calls[0]![1]).toEqual(["--list-voices"]);
    h.children[0]!.stdout.emit("data", Buffer.from(`${VOICES}\n`));
    h.children[0]!.emit("close", 0, null);
    const r = (await p).result as { voices: unknown[]; chosen: string | null };
    expect(r.voices).toHaveLength(4);
    expect(r.chosen).toBe("com.apple.siri.natural.Aaron");
  });

  it("persists the chosen voice (null = the best installed), rejecting a bad id", async () => {
    const h = setup();
    expect((await h.dispatch("audio.voice.set", { voice: "com.apple.voice.premium.en-US.Zoe" })).result).toEqual({ voice: "com.apple.voice.premium.en-US.Zoe" });
    expect(h.saved()).toBe("com.apple.voice.premium.en-US.Zoe");
    expect((await h.dispatch("audio.voice.set", { voice: "--evil" })).ok).toBe(false);
    expect(h.saved()).toBe("com.apple.voice.premium.en-US.Zoe");
    await h.dispatch("audio.voice.set", { voice: null });
    expect(h.saved()).toBeNull();
  });

  it("Preview speaks through the chosen output with the voice being previewed, else the saved voice", async () => {
    const h = setup("com.apple.siri.natural.Aaron");
    const p = h.dispatch("audio.testSpeaker", { voice: "com.apple.voice.premium.en-US.Zoe" });
    await Promise.resolve();
    expect(h.spawnFn.mock.calls[0]![1]).toEqual(["--test-speaker", "--voice", "com.apple.voice.premium.en-US.Zoe", "--output-device", "SPK"]);
    h.children[0]!.emit("close", 0, null);
    await p;
    const p2 = h.dispatch("audio.testSpeaker");
    await Promise.resolve();
    expect(h.spawnFn.mock.calls[1]![1]).toEqual(["--test-speaker", "--voice", "com.apple.siri.natural.Aaron", "--output-device", "SPK"]);
    h.children[1]!.emit("close", 0, null);
    await p2;
    expect((await h.dispatch("audio.testSpeaker", { voice: "--evil" })).ok).toBe(false);
  });

  it("the download link opens only the fixed Spoken Content settings URL", async () => {
    const h = setup();
    await h.dispatch("audio.voices.openDownloads", { url: "https://evil.example" });
    expect(h.openExternal).toHaveBeenCalledWith(VOICE_DOWNLOADS_URL);
    expect(VOICE_DOWNLOADS_URL).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.universalaccess\?SpokenContent$/);
  });
});

describe("call events (voice calls)", () => {
  it("parses the call's level meter and the first-audio-out of a line", () => {
    expect(parseDictationLine('{"type":"level","mic":-31.5,"out":-18}')).toEqual({ type: "level", mic: -31.5, out: -18 });
    expect(parseDictationLine('{"type":"level","mic":"loud"}')).toBeNull();
    expect(parseDictationLine('{"type":"speak-audio","id":"sp-3"}')).toEqual({ type: "speak-audio", id: "sp-3" });
  });
});

describe("voice call session (bug 106)", () => {
  it("the end-of-turn silence is short (~700 ms); the helper's word heuristics hold longer when needed", () => {
    expect(LIMITS5.voiceSilenceMs).toBeGreaterThanOrEqual(600);
    expect(LIMITS5.voiceSilenceMs).toBeLessThanOrEqual(800);
  });

  it("a call carries the chosen voice so the helper can warm it up; dictation never does", () => {
    expect(helperArgs("call", undefined, { input: null, output: null }, "com.apple.voice.premium.en-US.Zoe")).toEqual(["--mode", "call", "--voice-processing", "--silence-ms", String(LIMITS5.voiceSilenceMs), "--voice", "com.apple.voice.premium.en-US.Zoe"]);
    expect(helperArgs("dictation", undefined, { input: null, output: null }, "com.apple.voice.premium.en-US.Zoe")).toEqual([]);
    expect(helperArgs("call", undefined, undefined, "--evil")).not.toContain("--evil");
  });

  it("dictation.mark writes a timed latency mark for the live call to the voice log", async () => {
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean }>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => null);
    const log = vi.fn();
    registerDictation({ binary: "b", spawnFn: (() => fakeChild()) as never, log, voice: () => null });
    const d = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
    await d("dictation.start", { sessionId: "abcdef1234", mode: "call" });
    await d("dictation.mark", { sessionId: "abcdef1234", what: "sent", ms: 12 });
    await d("dictation.mark", { sessionId: "abcdef1234", what: "first-text" });
    expect(log.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["dictation[abcdef12] mark sent (+12 ms)", "dictation[abcdef12] mark first-text"]));
    expect((await d("dictation.mark", { sessionId: "abcdef1234", what: "rm -rf" })).ok).toBe(false);
  });
});
