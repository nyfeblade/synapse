import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { activeInput, cleanWakeNames, parseWakeLine, WakeWord, wakeFault, wakeStatusText, WAKE_HANDOFF_MS, type WakeSettings, type WakeState } from "../../src/main/native/wake-word";
import type { AudioDevice } from "../../src/main/native/audio-devices";

type Child = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn>; args: string[] };
const dev = (uid: string, transport: AudioDevice["transport"], defaultInput = false): AudioDevice => ({ uid, name: uid, input: true, output: false, transport, defaultInput, defaultOutput: false });

function setup(o: { settings?: Partial<WakeSettings>; devices?: AudioDevice[] | null } = {}) {
  const children: Child[] = [];
  let settings: WakeSettings = { enabled: true, pauseOnBattery: true, ...o.settings };
  const states: WakeState[] = [];
  const wakes: string[] = [];
  const logs: string[] = [];
  const spawnFn = vi.fn((_bin: string, args: string[]) => {
    const c = new EventEmitter() as Child;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.stdin = { write: vi.fn(), end: vi.fn() };
    c.kill = vi.fn(() => { queueMicrotask(() => c.emit("close", null, "SIGTERM")); });
    c.args = args;
    children.push(c);
    return c;
  });
  let devices = o.devices === undefined ? [dev("builtin", "built-in", true)] : o.devices;
  const w = new WakeWord({
    binary: "/helper", spawnFn: spawnFn as never,
    settings: () => settings,
    saveSettings: (p) => (settings = { ...settings, ...p }),
    devices: () => ({ input: null, output: null }),
    listDevices: async () => devices,
    log: (l) => logs.push(l),
    onWake: (e) => wakes.push(e.name),
    onState: (s) => states.push(s),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { w, children, states, wakes, logs, spawnFn, flush, setDevices: (d: AudioDevice[]) => { devices = d; } };
}
const say = (c: Child, e: object) => c.stdout.emit("data", Buffer.from(`${JSON.stringify(e)}\n`));

describe("wake word controller", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("is off by default in the sense that nothing listens until it's enabled and has names", async () => {
    const t = setup({ settings: { enabled: false } });
    t.w.setNames(["Nova"]);
    await t.flush();
    expect(t.spawnFn).not.toHaveBeenCalled();
    expect(t.w.state()).toMatchObject({ listening: false, pausedFor: ["off"] });
    t.w.set({ enabled: true });
    await t.flush();
    expect(t.spawnFn).toHaveBeenCalledTimes(1);
    expect(t.children[0]!.args).toEqual(expect.arrayContaining(["--mode", "wake", "--names", "Nova"]));
    expect(t.w.state()).toMatchObject({ listening: true, pausedFor: [] });
  });

  it("needs at least one name", async () => {
    const t = setup();
    t.w.setNames([]);
    await t.flush();
    expect(t.spawnFn).not.toHaveBeenCalled();
    expect(t.w.state().pausedFor).toEqual(["no-names"]);
  });

  it("new names reach a running listener on stdin, without a restart", async () => {
    const t = setup();
    t.w.setNames(["Nova"]);
    await t.flush();
    t.w.setNames(["Nova", "Atlas"]);
    expect(t.spawnFn).toHaveBeenCalledTimes(1);
    expect(t.children[0]!.stdin.write).toHaveBeenCalledWith(`names ${JSON.stringify({ names: ["Nova", "Atlas"] })}\n`);
  });

  it("pauses (the helper stops and the mic closes) on screen lock, during dictation or a call, and resumes after", async () => {
    const t = setup();
    t.w.setNames(["Nova"]);
    await t.flush();
    t.w.pause("locked", true);
    expect(t.children[0]!.kill).toHaveBeenCalled();
    expect(t.w.state()).toMatchObject({ listening: false, pausedFor: ["locked"] });
    t.w.pause("busy", true);
    t.w.pause("locked", false);
    await t.flush();
    expect(t.spawnFn).toHaveBeenCalledTimes(1);
    expect(t.w.state().pausedFor).toEqual(["busy"]);
    t.w.pause("busy", false);
    await t.flush();
    expect(t.spawnFn).toHaveBeenCalledTimes(2);
    expect(t.w.state().listening).toBe(true);
  });

  it("pauses on battery only when the user wants that", async () => {
    const t = setup({ settings: { pauseOnBattery: false } });
    t.w.setNames(["Nova"]);
    t.w.setOnBattery(true);
    await t.flush();
    expect(t.w.state().listening).toBe(true);
    t.w.set({ pauseOnBattery: true });
    expect(t.w.state()).toMatchObject({ listening: false, pausedFor: ["battery"] });
    t.w.setOnBattery(false);
    await t.flush();
    expect(t.w.state().listening).toBe(true);
  });

  it("never opens a Bluetooth headset's microphone (it would drop to call quality)", async () => {
    const t = setup({ devices: [dev("builtin", "built-in"), dev("airpods", "bluetooth", true)] });
    t.w.setNames(["Nova"]);
    await t.flush();
    expect(t.spawnFn).not.toHaveBeenCalled();
    expect(t.w.state().pausedFor).toEqual(["bluetooth"]);
    expect(wakeStatusText(t.w.state())).toMatch(/Bluetooth/);
    t.setDevices([dev("builtin", "built-in", true)]);
    t.w.devicesChanged();
    await t.flush();
    expect(t.spawnFn).toHaveBeenCalledTimes(1);
  });

  it("a wake reports the Bot, stops listening for the hand-off to the call, and resumes if no call came", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.w.setNames(["Nova"]);
    await vi.advanceTimersByTimeAsync(0);
    say(t.children[0]!, { type: "wake", name: "Nova", confidence: 0.61, ms: 900 });
    expect(t.wakes).toEqual(["Nova"]);
    expect(t.w.state().pausedFor).toEqual(["waking"]);
    expect(t.logs.some((l) => l.includes("Hey Nova") && l.includes("0.61"))).toBe(true);
    await vi.advanceTimersByTimeAsync(WAKE_HANDOFF_MS + 10);
    expect(t.spawnFn).toHaveBeenCalledTimes(2);
  });

  it("logs a rejected near-miss (no words, just the name and confidence)", async () => {
    const t = setup();
    t.w.setNames(["Nova"]);
    await t.flush();
    say(t.children[0]!, { type: "wake-rejected", name: "Nova", confidence: 0.12 });
    expect(t.wakes).toEqual([]);
    expect(t.logs).toContain("wake: rejected Nova (confidence 0.12)");
  });

  it("a permission or offline-recognizer failure stops for good and says why; a crash retries with backoff", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.w.setNames(["Nova"]);
    await vi.advanceTimersByTimeAsync(0);
    t.children[0]!.emit("close", 1, null);
    expect(t.w.state().listening).toBe(false);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(t.spawnFn).toHaveBeenCalledTimes(2);
    say(t.children[1]!, { type: "error", code: "offline-unavailable", message: "needs on-device speech recognition" });
    t.children[1]!.emit("close", 3, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.spawnFn).toHaveBeenCalledTimes(2);
    expect(t.w.state()).toMatchObject({ pausedFor: ["error"], error: "needs on-device speech recognition", errorPane: null });
  });

  it("a permission failure is said in plain words with the pane that fixes it, never as a code", async () => {
    const t = setup();
    t.w.setNames(["Nova"]);
    await t.flush();
    say(t.children[0]!, { type: "error", code: "permission", message: "permission:speech:denied" });
    t.children[0]!.emit("close", 2, null);
    expect(t.w.state()).toMatchObject({ pausedFor: ["error"], error: STR5.speechAccessDenied, errorPane: "speech" });
    expect(wakeStatusText(t.w.state())).toBe(STR5.speechAccessDenied);
    expect(wakeStatusText(t.w.state())).not.toMatch(/permission:/);
  });

  it("wakeFault: every permission code maps to words and a pane; other failures keep their reason", () => {
    expect(wakeFault("permission", "permission:microphone:denied")).toEqual({ text: STR5.micAccessDenied, pane: "microphone" });
    expect(wakeFault("permission", "permission:microphone:restricted")).toEqual({ text: STR5.micAccessRestricted, pane: "microphone" });
    expect(wakeFault("permission", "permission:speech:restricted")).toEqual({ text: STR5.speechAccessRestricted, pane: "speech" });
    expect(wakeFault("permission", "not-authorized")).toEqual({ text: STR5.micDenied, pane: "speech" });
    expect(wakeFault("offline-unavailable", "Download the language")).toEqual({ text: "Download the language", pane: null });
  });

  it("the menu-bar Pause holds until Resume", async () => {
    const t = setup();
    t.w.setNames(["Nova"]);
    await t.flush();
    t.w.pause("user", true);
    expect(wakeStatusText(t.w.state())).toBe("Paused");
    t.w.pause("user", false);
    await t.flush();
    expect(wakeStatusText(t.w.state())).toMatch(/Listening/);
  });
});

describe("wake word helpers", () => {
  it("parses detections and rounds the confidence", () => {
    expect(parseWakeLine('{"type":"wake","name":"Nova","confidence":0.5799999,"ms":1040}')).toEqual({ type: "wake", name: "Nova", confidence: 0.58, ms: 1040 });
    expect(parseWakeLine('{"type":"partial","text":"hey nova"}')).toBeNull();
    // Bug 213: "Hey Nova and Scout" — the other names ride along (names only, each 1–40 characters, at most 5).
    expect(parseWakeLine('{"type":"wake","name":"Nova","confidence":0.6,"ms":900,"also":["Scout","",7,"x"]}')).toEqual({ type: "wake", name: "Nova", confidence: 0.6, ms: 900, also: ["Scout", "x"] });
    expect(parseWakeLine("not json")).toBeNull();
  });
  it("cleans names: trims, drops blanks, commas and duplicates, caps length and count", () => {
    expect(cleanWakeNames([" Nova ", "nova", "", "!!", "a,b", "x".repeat(41), 5, "Atlas"])).toEqual(["Nova", "a b", "Atlas"]);
    expect(cleanWakeNames("Nova")).toEqual([]);
    expect(cleanWakeNames(Array.from({ length: 80 }, (_, i) => `Bot ${i}`))).toHaveLength(50);
  });
  it("the active microphone is the chosen one when connected, else the default", () => {
    const devs = [dev("a", "built-in", true), dev("b", "usb")];
    expect(activeInput(devs, { input: "b", output: null })?.uid).toBe("b");
    expect(activeInput(devs, { input: "gone", output: null })?.uid).toBe("a");
  });
});
