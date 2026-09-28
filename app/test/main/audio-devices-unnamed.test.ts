import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { deviceArgs, deviceLabel, findDevice, namedDevice, parseDeviceList, registerAudioDevices, type AudioDevice, type AudioPrefs } from "../../src/main/native/audio-devices";
import { installNativeIpc } from "../../src/main/native";

/**
 * Bug 151: a Bluetooth headset (call 51da6968, uid "00-00-5E-00-53-01:input") reported an empty
 * name, and both the microphone and the speaker fell back to the built-in ones for the whole call.
 * A name says nothing about whether a device is there: only absence from the listing does.
 */
const AIRPODS_IN = "00-00-5E-00-53-01:input";
const AIRPODS_OUT = "00-00-5E-00-53-01:output";

const line = (devices: unknown[]) => `${JSON.stringify({ type: "devices", devices })}\n`;
const builtIn = [
  { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", input: true, output: false, transport: "built-in", defaultInput: true, defaultOutput: false },
  { uid: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers", input: false, output: true, transport: "built-in", defaultInput: false, defaultOutput: true },
];
/** The headset as the OS first reports it: real, connected, and with no name yet. */
const headset = (name: unknown) => [
  { uid: AIRPODS_IN, name, input: true, output: false, transport: "bluetooth", defaultInput: false, defaultOutput: false },
  { uid: AIRPODS_OUT, name, input: false, output: true, transport: "bluetooth", defaultInput: false, defaultOutput: false },
];

describe("a device with no name (bug 151)", () => {
  it("is kept in the list whether its name is empty, blank, missing or not a string", () => {
    for (const name of ["", "   ", undefined, null, 42]) {
      const d = parseDeviceList(line([...builtIn, ...headset(name)]));
      expect(d.map((x) => x.uid)).toEqual(["BuiltInMicrophoneDevice", "BuiltInSpeakerDevice", AIRPODS_IN, AIRPODS_OUT]);
      expect(d[2]!.unnamed).toBe(true);
      expect(d[2]!.name.trim()).not.toBe("");
      expect(d[2]!.input).toBe(true);
      expect(d[3]!.output).toBe(true);
    }
  });

  it("gets a label from its UID, and a named device keeps its own name", () => {
    expect(deviceLabel({ uid: AIRPODS_IN, name: "", transport: "bluetooth" })).toBe("Bluetooth device (00-00-5E-00-53-01)");
    expect(deviceLabel({ uid: "00-00-5E-00-53-01:output", transport: "unknown" })).toBe("Bluetooth device (00-00-5E-00-53-01)"); // a MAC-shaped UID is a headset
    expect(deviceLabel({ uid: "AppleUSBAudioEngine:Shure:MV7:1", name: "   ", transport: "usb" })).toBe("Audio device (AppleUSBAudioEngine:Shure:MV7:1)");
    expect(deviceLabel({ uid: AIRPODS_IN, name: " AirPods Pro ", transport: "bluetooth" })).toBe("AirPods Pro");
    expect(namedDevice("")).toBe(false);
    expect(namedDevice("\t ")).toBe(false);
    expect(namedDevice(undefined)).toBe(false);
    expect(namedDevice("AirPods Pro")).toBe(true);
  });

  it("is matched by UID, never by name, and only for its own direction", () => {
    const d = parseDeviceList(line([...builtIn, ...headset("")]));
    expect(findDevice(d, "input", AIRPODS_IN)!.uid).toBe(AIRPODS_IN);
    expect(findDevice(d, "output", AIRPODS_OUT)!.uid).toBe(AIRPODS_OUT);
    expect(findDevice(d, "output", AIRPODS_IN)).toBeNull(); // the input half is not an output
    expect(findDevice(d, "input", "no-such-device")).toBeNull();
    expect(findDevice(d, "input", null)).toBeNull();
    // The label never leaks into matching: two unnamed devices share a shape, not an identity.
    expect(findDevice(d, "input", "Bluetooth device (00-00-5E-00-53-01)")).toBeNull();
  });

  it("is still passed to the helper as the chosen device", () => {
    const prefs: AudioPrefs = { input: AIRPODS_IN, output: AIRPODS_OUT };
    expect(deviceArgs(prefs, "call")).toEqual(["--input-device", AIRPODS_IN, "--output-device", AIRPODS_OUT]);
  });
});

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  c.stdin = { write: vi.fn(), end: vi.fn() };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

function setup(initial: AudioPrefs) {
  const win = { isDestroyed: () => false, webContents: { send: () => {} } };
  const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown }>>();
  installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => win as never);
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn = vi.fn(() => { const c = fakeChild(); children.push(c); return c as unknown as ChildProcess; });
  let prefs = { ...initial };
  const logs: string[] = [];
  const applyLive = vi.fn();
  const api = registerAudioDevices({
    binary: "bots-dictation", spawnFn: spawnFn as never,
    readPrefs: () => prefs, writePrefs: (p: AudioPrefs) => { prefs = { ...p }; return prefs; },
    applyLive, log: (l) => logs.push(l),
  });
  const dispatch = (name: string, args: unknown = {}) => handlers.get("native")!({}, { name, args });
  /** One fresh listing: invalidate the cache, run it, and answer with these devices. */
  const list = async (devices: unknown[]) => {
    api.invalidate();
    const p = dispatch("audio.devices.list", { refresh: true });
    await Promise.resolve();
    const c = children[children.length - 1]!;
    c.stdout.emit("data", Buffer.from(line(devices)));
    c.emit("close", 0, null);
    return (await p).result as { devices: AudioDevice[]; prefs: AudioPrefs };
  };
  return { api, dispatch, list, logs, applyLive, prefs: () => prefs };
}

describe("the chosen device across a disappearance (bug 151)", () => {
  it("an unnamed headset is selectable, is listed with a label, and never falls back", async () => {
    const h = setup({ input: null, output: null });
    await h.dispatch("audio.devices.set", { input: AIRPODS_IN, output: AIRPODS_OUT });
    h.applyLive.mockClear(); // the choice itself was applied; the listing must not move it again
    const r = await h.list([...builtIn, ...headset("")]);
    expect(r.prefs).toEqual({ input: AIRPODS_IN, output: AIRPODS_OUT });
    expect(r.devices.find((d) => d.uid === AIRPODS_IN)!.name).toBe("Bluetooth device (00-00-5E-00-53-01)");
    expect(h.logs.filter((l) => l.includes("unnamed"))).toHaveLength(2);
    expect(h.logs.some((l) => l.includes("gone from the device list"))).toBe(false);
    expect(h.applyLive).not.toHaveBeenCalled(); // nothing to re-apply: the choice never moved
  });

  it("the name arriving late changes the label, not the choice", async () => {
    const h = setup({ input: AIRPODS_IN, output: AIRPODS_OUT });
    await h.list([...builtIn, ...headset("")]);
    const r = await h.list([...builtIn, ...headset("AirPods Pro")]);
    expect(r.devices.find((d) => d.uid === AIRPODS_IN)!.name).toBe("AirPods Pro");
    expect(r.devices.find((d) => d.uid === AIRPODS_IN)!.unnamed).toBeUndefined();
    expect(h.prefs()).toEqual({ input: AIRPODS_IN, output: AIRPODS_OUT });
    expect(h.logs.some((l) => l.includes("gone from the device list"))).toBe(false);
  });

  it("a device that really goes away is reported gone, but the choice is remembered", async () => {
    const h = setup({ input: AIRPODS_IN, output: AIRPODS_OUT });
    await h.list([...builtIn, ...headset("AirPods Pro")]);
    const r = await h.list(builtIn);
    expect(findDevice(r.devices, "input", AIRPODS_IN)).toBeNull();
    expect(h.logs.filter((l) => l.includes("gone from the device list"))).toHaveLength(2);
    expect(h.prefs()).toEqual({ input: AIRPODS_IN, output: AIRPODS_OUT }); // kept, so it can come back
    expect(h.applyLive).not.toHaveBeenCalled();
    await h.list(builtIn); // still gone: said once, not every listing
    expect(h.logs.filter((l) => l.includes("gone from the device list"))).toHaveLength(2);
  });

  it("a device that comes back is re-selected, even if it comes back unnamed", async () => {
    const h = setup({ input: AIRPODS_IN, output: AIRPODS_OUT });
    await h.list([...builtIn, ...headset("AirPods Pro")]);
    await h.list(builtIn);
    await h.list([...builtIn, ...headset("")]);
    expect(h.applyLive).toHaveBeenCalledTimes(1);
    expect(h.applyLive).toHaveBeenLastCalledWith({ input: AIRPODS_IN, output: AIRPODS_OUT });
    expect(h.logs.filter((l) => l.includes("is back — re-selecting it"))).toHaveLength(2);
    await h.list([...builtIn, ...headset("")]); // still here: re-selected once, not on every listing
    expect(h.applyLive).toHaveBeenCalledTimes(1);
  });

  it("the system default (no choice) is never reported gone or re-selected", async () => {
    const h = setup({ input: null, output: null });
    await h.list(builtIn);
    await h.list([]);
    expect(h.logs.filter((l) => l.includes("gone from the device list"))).toHaveLength(0);
    expect(h.applyLive).not.toHaveBeenCalled();
  });
});
