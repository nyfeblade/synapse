import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { deviceArgs, parseDeviceList, registerAudioDevices, validDeviceUid, type AudioPrefs } from "../../src/main/native/audio-devices";
import { helperArgs, parseDictationLine, registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";

// Bug 105: choosing the microphone and speaker for dictation and voice mode.

const LIST = JSON.stringify({
  type: "devices",
  devices: [
    { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", input: true, output: false, transport: "built-in", defaultInput: true, defaultOutput: false },
    { uid: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers", input: false, output: true, transport: "built-in", defaultInput: false, defaultOutput: true },
    { uid: "AppleUSBAudioEngine:Shure:MV7:1", name: "Shure MV7", input: true, output: true, transport: "usb", defaultInput: false, defaultOutput: false },
    { uid: "", name: "no uid", input: true, output: false, transport: "usb", defaultInput: false, defaultOutput: false },
    { uid: "x", name: 42, input: true },
    { uid: "AA-BB:output", name: "AirPods", input: false, output: true, transport: "martian", defaultInput: false, defaultOutput: false },
  ],
});

describe("device list parsing", () => {
  it("keeps every device with a UID (a bad name is not a bad device) and maps an unknown transport to unknown", () => {
    const d = parseDeviceList(`[bots-dictation] noise\n${LIST}\n`);
    // Bug 151: only a missing / invalid UID drops a device; "x" has a nonsense name but is real.
    expect(d.map((x) => x.uid)).toEqual(["BuiltInMicrophoneDevice", "BuiltInSpeakerDevice", "AppleUSBAudioEngine:Shure:MV7:1", "x", "AA-BB:output"]);
    expect(d[2]).toEqual({ uid: "AppleUSBAudioEngine:Shure:MV7:1", name: "Shure MV7", input: true, output: true, transport: "usb", defaultInput: false, defaultOutput: false });
    expect(d[3]).toMatchObject({ uid: "x", name: "Audio device (x)", unnamed: true, transport: "unknown" });
    expect(d[4]!.transport).toBe("unknown");
  });

  it("returns an empty list for output with no devices line", () => {
    expect(parseDeviceList("")).toEqual([]);
    expect(parseDeviceList("{not json\n")).toEqual([]);
    expect(parseDeviceList('{"type":"ready"}')).toEqual([]);
  });

  it("validates device UIDs: printable, bounded, never a flag", () => {
    expect(validDeviceUid("BuiltInMicrophoneDevice")).toBe(true);
    expect(validDeviceUid("AppleUSBAudioEngine:Shure:MV7:1")).toBe(true);
    expect(validDeviceUid("")).toBe(false);
    expect(validDeviceUid("--list-devices")).toBe(false);
    expect(validDeviceUid("a\nstop")).toBe(false);
    expect(validDeviceUid("x".repeat(257))).toBe(false);
    expect(validDeviceUid(7)).toBe(false);
  });
});

describe("device arguments for each helper mode", () => {
  const both: AudioPrefs = { input: "MIC", output: "SPK" };
  it("passes only the device each mode uses; system default passes nothing", () => {
    expect(deviceArgs(both, "dictation")).toEqual(["--input-device", "MIC"]);
    expect(deviceArgs(both, "call")).toEqual(["--input-device", "MIC", "--output-device", "SPK"]);
    expect(deviceArgs(both, "meter")).toEqual(["--input-device", "MIC"]);
    expect(deviceArgs(both, "speaker")).toEqual(["--output-device", "SPK"]);
    expect(deviceArgs({ input: null, output: null }, "call")).toEqual([]);
    expect(deviceArgs({ input: "--evil", output: null }, "call")).toEqual([]);
  });

  it("every dictation / call session carries the chosen devices", () => {
    expect(helperArgs("dictation", "en-US", both)).toEqual(["--locale", "en-US", "--input-device", "MIC"]);
    expect(helperArgs("call", undefined, both).slice(-4)).toEqual(["--input-device", "MIC", "--output-device", "SPK"]);
  });

  it("parses the helper's device events", () => {
    expect(parseDictationLine('{"type":"devices","input":{"uid":"MIC","name":"Shure"},"output":{"uid":"SPK","name":"Speakers"},"echoCancellation":true}'))
      .toEqual({ type: "devices", input: { uid: "MIC", name: "Shure" }, output: { uid: "SPK", name: "Speakers" }, echoCancellation: true });
    expect(parseDictationLine('{"type":"device-fallback","kind":"input","uid":"MIC","name":"Shure","fallback":"MacBook Pro Microphone"}'))
      .toEqual({ type: "device-fallback", kind: "input", uid: "MIC", name: "Shure", fallback: "MacBook Pro Microphone" });
    expect(parseDictationLine('{"type":"device-restored","kind":"output","uid":"SPK","name":"Speakers"}'))
      .toEqual({ type: "device-restored", kind: "output", uid: "SPK", name: "Speakers" });
    expect(parseDictationLine('{"type":"echo-unavailable","reason":"-10875"}')).toEqual({ type: "echo-unavailable", reason: "-10875" });
    expect(parseDictationLine('{"type":"device-fallback","kind":"sideways","uid":"MIC"}')).toBeNull();
  });
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

function setup(initial: AudioPrefs = { input: null, output: null }) {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const win = { isDestroyed: () => false, webContents: { send: (_c: string, m: { channel: string; payload: Record<string, unknown> }) => sent.push(m) } };
  const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>>();
  installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn = vi.fn((_bin: string, _args: string[]) => { const c = fakeChild(); children.push(c); return c as unknown as ChildProcess; });
  let prefs = { ...initial };
  const writePrefs = vi.fn((p: AudioPrefs) => { prefs = { ...p }; return prefs; });
  const applyLive = vi.fn();
  const api = registerAudioDevices({ binary: "bots-dictation", spawnFn: spawnFn as never, readPrefs: () => prefs, writePrefs, applyLive });
  const dispatch = (name: string, args: unknown = {}) => handlers.get("native")!({}, { name, args });
  return { sent, children, spawnFn, writePrefs, applyLive, api, dispatch, prefs: () => prefs };
}

const answer = (c: ReturnType<typeof fakeChild>, out = LIST) => { c.stdout.emit("data", Buffer.from(`${out}\n`)); c.emit("close", 0, null); };

describe("audio.devices natives", () => {
  it("lists devices once and serves the cache until invalidated (focus / a device event)", async () => {
    const h = setup({ input: "MIC", output: null });
    const p1 = h.dispatch("audio.devices.list");
    await Promise.resolve();
    expect(h.spawnFn.mock.calls[0]![1]).toEqual(["--list-devices"]);
    answer(h.children[0]!);
    const r1 = await p1;
    expect((r1.result as { devices: unknown[]; prefs: AudioPrefs }).devices).toHaveLength(5);
    expect((r1.result as { prefs: AudioPrefs }).prefs).toEqual({ input: "MIC", output: null });
    await h.dispatch("audio.devices.list");
    expect(h.spawnFn).toHaveBeenCalledTimes(1); // cached
    h.api.invalidate();
    const p3 = h.dispatch("audio.devices.list");
    await Promise.resolve();
    expect(h.spawnFn).toHaveBeenCalledTimes(2);
    answer(h.children[1]!);
    await p3;
    const p4 = h.dispatch("audio.devices.list", { refresh: true });
    await Promise.resolve();
    expect(h.spawnFn).toHaveBeenCalledTimes(3);
    answer(h.children[2]!);
    await p4;
  });

  it("a failed listing is an error, not an empty device list that looks real", async () => {
    const h = setup();
    const p = h.dispatch("audio.devices.list");
    await Promise.resolve();
    h.children[0]!.emit("close", 1, null);
    expect((await p).ok).toBe(false);
  });

  it("set persists the choice (null = system default), leaves the other kind alone, and applies it to a live session", async () => {
    const h = setup({ input: "MIC", output: "SPK" });
    const r = await h.dispatch("audio.devices.set", { output: null });
    expect(r.result).toEqual({ input: "MIC", output: null });
    expect(h.writePrefs).toHaveBeenLastCalledWith({ input: "MIC", output: null });
    expect(h.applyLive).toHaveBeenLastCalledWith({ input: "MIC", output: null });
    await h.dispatch("audio.devices.set", { input: "AppleUSBAudioEngine:Shure:MV7:1" });
    expect(h.prefs()).toEqual({ input: "AppleUSBAudioEngine:Shure:MV7:1", output: null });
    const bad = await h.dispatch("audio.devices.set", { input: "--evil" });
    expect(bad.ok).toBe(false);
    expect(h.prefs().input).toBe("AppleUSBAudioEngine:Shure:MV7:1");
  });

  it("the level meter runs the helper on the chosen microphone and forwards levels; stop ends it", async () => {
    const h = setup({ input: "MIC", output: "SPK" });
    await h.dispatch("audio.meter.start");
    expect(h.spawnFn.mock.calls[0]![1]).toEqual(["--meter", "--input-device", "MIC"]);
    h.children[0]!.stdout.emit("data", Buffer.from('{"type":"level","db":-23.5}\n{"type":"level","db":"loud"}\n'));
    expect(h.sent.filter((s) => s.channel === "audio-level").map((s) => s.payload)).toEqual([{ type: "level", db: -23.5 }]);
    await h.dispatch("audio.meter.start"); // a second start replaces the first meter
    expect(h.children[0]!.stdin.end).toHaveBeenCalled();
    await h.dispatch("audio.meter.stop");
    expect(h.children[1]!.stdin.end).toHaveBeenCalled();
  });

  it("test speaker plays through the chosen output and reports how it went", async () => {
    const h = setup({ input: null, output: "SPK" });
    const p = h.dispatch("audio.testSpeaker");
    await Promise.resolve();
    expect(h.spawnFn.mock.calls[0]![1]).toEqual(["--test-speaker", "--output-device", "SPK"]);
    h.children[0]!.emit("close", 0, null);
    expect((await p).result).toEqual({ ok: true });
    const p2 = h.dispatch("audio.testSpeaker");
    await Promise.resolve();
    h.children[1]!.stdout.emit("data", Buffer.from('{"type":"error","code":"no-audio","message":"The speaker couldn\'t start"}\n'));
    h.children[1]!.emit("close", 1, null);
    expect((await p2).result).toEqual({ ok: false, message: "The speaker couldn't start" });
  });
});

describe("live device switch", () => {
  it("writes a devices command to the live session's helper, and nothing when none is running", async () => {
    const sent: unknown[] = [];
    const win = { isDestroyed: () => false, webContents: { send: (_c: string, m: unknown) => sent.push(m) } };
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<unknown>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
    const kids: ReturnType<typeof fakeChild>[] = [];
    const onDeviceEvent = vi.fn();
    const d = registerDictation({ binary: "b", spawnFn: (() => { const c = fakeChild(); kids.push(c); return c; }) as never, devices: () => ({ input: "MIC", output: null }), onDeviceEvent });
    d.switchDevices({ input: "MIC", output: "SPK" }); // no session: a no-op
    await handlers.get("native")!({}, { name: "dictation.start", args: { sessionId: "c1", mode: "call" } });
    expect(kids).toHaveLength(1);
    d.switchDevices({ input: null, output: "SPK" });
    expect(kids[0]!.stdin.write).toHaveBeenLastCalledWith('devices {"input":null,"output":"SPK"}\n');
    kids[0]!.stdout.emit("data", Buffer.from('{"type":"device-fallback","kind":"input","uid":"MIC","name":"Shure","fallback":"Built-in"}\n'));
    expect(onDeviceEvent).toHaveBeenCalledTimes(1);
  });

  it("the session's helper is spawned with the persisted devices", async () => {
    const handlers = new Map<string, (e: unknown, m: unknown) => Promise<unknown>>();
    installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => null);
    const spawnFn = vi.fn(() => fakeChild());
    registerDictation({ binary: "b", spawnFn: spawnFn as never, devices: () => ({ input: "MIC", output: "SPK" }) });
    await handlers.get("native")!({}, { name: "dictation.start", args: { sessionId: "d1" } });
    expect((spawnFn.mock.calls[0] as unknown[])[1]).toEqual(["--input-device", "MIC"]);
  });
});
