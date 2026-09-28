// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { deviceName, deviceNotice, deviceOptions, levelPercent, type AudioDeviceView } from "../../src/renderer/voice/audio-devices";
import { VoiceSection } from "../../src/renderer/components/settings/VoiceSection";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";

// Bug 105: choosing the microphone and speaker for dictation and voice mode.

const DEVICES: AudioDeviceView[] = [
  { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", input: true, output: false, transport: "built-in", defaultInput: true, defaultOutput: false },
  { uid: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers", input: false, output: true, transport: "built-in", defaultInput: false, defaultOutput: true },
  { uid: "USB-MV7", name: "Shure MV7", input: true, output: true, transport: "usb", defaultInput: false, defaultOutput: false },
  { uid: "BT-AirPods", name: "AirPods Pro", input: true, output: true, transport: "bluetooth", defaultInput: false, defaultOutput: false },
];

describe("device options", () => {
  it("puts System default (<name>) first, then each device of that kind with a type hint", () => {
    expect(deviceOptions(DEVICES, "input", null)).toEqual([
      { value: "", label: STR5.systemDefault("MacBook Pro Microphone") },
      { value: "BuiltInMicrophoneDevice", label: "MacBook Pro Microphone · Built-in" },
      { value: "USB-MV7", label: "Shure MV7 · USB" },
      { value: "BT-AirPods", label: "AirPods Pro · Bluetooth" },
    ]);
    expect(deviceOptions(DEVICES, "output", null).map((o) => o.value)).toEqual(["", "BuiltInSpeakerDevice", "USB-MV7", "BT-AirPods"]);
  });

  it("a saved device that isn't plugged in stays selectable and says so", () => {
    const o = deviceOptions(DEVICES, "input", "USB-Gone");
    expect(o.at(-1)).toEqual({ value: "USB-Gone", label: STR5.savedDeviceNotConnected });
    expect(deviceOptions([], "output", null)).toEqual([{ value: "", label: STR5.systemDefault(null) }]);
  });

  it("a device the OS hasn't named is still listed and pickable, with a label instead of a blank row (bug 151)", () => {
    const unnamed: AudioDeviceView[] = [...DEVICES, { uid: "00-00-5E-00-53-01:input", name: "", input: true, output: false, transport: "bluetooth", defaultInput: false, defaultOutput: false, unnamed: true }];
    const o = deviceOptions(unnamed, "input", "00-00-5E-00-53-01:input");
    expect(o.at(-1)).toEqual({ value: "00-00-5E-00-53-01:input", label: "Bluetooth device (00-00-5E-00-53-01) · Bluetooth" });
    expect(o.every((x) => x.label.trim() !== "")).toBe(true);
    // It is present, so it is the chosen row — never the "saved device (not connected)" row.
    expect(o.some((x) => x.label === STR5.savedDeviceNotConnected)).toBe(false);
    expect(deviceName({ uid: "any-uid", name: "  " })).toBe("Audio device (any-uid)");
    expect(deviceName({ uid: "any-uid", name: " Shure MV7 " })).toBe("Shure MV7");
  });

  it("maps device events to plain notices", () => {
    expect(deviceNotice({ type: "device-fallback", kind: "input", name: "Shure MV7", fallback: "MacBook Pro Microphone" })).toBe(STR5.deviceFellBack("input", "Shure MV7", "MacBook Pro Microphone"));
    expect(deviceNotice({ type: "device-restored", kind: "output", name: "AirPods Pro" })).toBe(STR5.deviceRestored("AirPods Pro"));
    expect(deviceNotice({ type: "echo-unavailable" })).toBe(STR5.echoUnavailable);
    expect(deviceNotice({ type: "partial" })).toBeNull();
  });

  it("maps dBFS to a 0–100 meter", () => {
    expect(levelPercent(-80)).toBe(0);
    expect(levelPercent(-60)).toBe(0);
    expect(levelPercent(-30)).toBe(50);
    expect(levelPercent(0)).toBe(100);
    expect(levelPercent(Number.NaN)).toBe(0);
  });
});

function installBridge(prefs = { input: null as string | null, output: null as string | null }, over: Record<string, unknown> = {}) {
  const subs = new Map<string, (p: unknown) => void>();
  const invoked: [string, Record<string, unknown>][] = [];
  const results: Record<string, unknown> = { "audio.devices.list": { devices: DEVICES, prefs }, "audio.devices.set": prefs, "audio.testSpeaker": { ok: true }, "dictation.speak": { spoken: true }, ...over };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { entryId: "t" } })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "audio.devices.set") return { ok: true, result: { ...prefs, ...a } };
        return { ok: true, result: results[n] ?? {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
  return { subs, invoked, results };
}

describe("Settings → Voice", () => {
  afterEach(() => cleanup());

  it("offers Microphone and Speaker selects and saves a choice (system default saves null)", async () => {
    const b = installBridge();
    render(<VoiceSection />);
    const mic = await screen.findByRole("combobox", { name: STR5.microphone });
    expect((mic as HTMLSelectElement).options[0]!.textContent).toBe(STR5.systemDefault("MacBook Pro Microphone"));
    const spk = screen.getByRole("combobox", { name: STR5.speaker });
    expect((spk as HTMLSelectElement).options[0]!.textContent).toBe(STR5.systemDefault("MacBook Pro Speakers"));
    fireEvent.change(mic, { target: { value: "USB-MV7" } });
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.devices.set", { input: "USB-MV7" }]));
    fireEvent.change(spk, { target: { value: "" } });
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.devices.set", { output: null }]));
  });

  it("shows a live input level from the meter, restarts it on a new microphone, and stops it on leave", async () => {
    const b = installBridge();
    const { unmount } = render(<VoiceSection />);
    await vi.waitFor(() => expect(b.invoked.some(([n]) => n === "audio.meter.start")).toBe(true));
    act(() => b.subs.get("audio-level")!({ type: "level", db: -30 }));
    const meter = screen.getByRole("meter", { name: STR5.inputLevel });
    expect(meter.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.change(await screen.findByRole("combobox", { name: STR5.microphone }), { target: { value: "USB-MV7" } });
    await vi.waitFor(() => expect(b.invoked.filter(([n]) => n === "audio.meter.start")).toHaveLength(2));
    unmount();
    expect(b.invoked.at(-1)![0]).toBe("audio.meter.stop");
  });

  it("Test speaker plays through the chosen output and reports a failure in words", async () => {
    const b = installBridge({ input: null, output: null }, { "audio.testSpeaker": { ok: false, message: "The speaker couldn't start" } });
    render(<VoiceSection />);
    fireEvent.click(await screen.findByRole("button", { name: STR5.testSpeaker }));
    await vi.waitFor(() => expect(b.invoked.some(([n]) => n === "audio.testSpeaker")).toBe(true));
    expect(await screen.findByText(STR5.speakerTestFailed("The speaker couldn't start"))).toBeTruthy();
  });

  it("refreshes the list when the window regains focus", async () => {
    const b = installBridge();
    render(<VoiceSection />);
    await screen.findByRole("combobox", { name: STR5.microphone });
    act(() => { window.dispatchEvent(new Event("focus")); });
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.devices.list", { refresh: true }]));
  });

  it("a saved microphone that is unplugged is shown as not connected", async () => {
    installBridge({ input: "USB-Gone", output: null });
    render(<VoiceSection />);
    const mic = await screen.findByRole("combobox", { name: STR5.microphone }) as HTMLSelectElement;
    await vi.waitFor(() => expect(mic.value).toBe("USB-Gone"));
    expect(mic.selectedOptions[0]!.textContent).toBe(STR5.savedDeviceNotConnected);
  });
});

describe("voice-call device switcher", () => {
  beforeEach(() => {
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
    useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {} } } as never });
    useVoice.getState().open("a");
  });
  afterEach(() => { useVoice.getState().close(); cleanup(); });

  it("opens from a button, lists devices, and switching applies mid-call without ending it", async () => {
    const b = installBridge();
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(b.invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    const toggle = screen.getByRole("button", { name: STR5.audioDevices });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const spk = await screen.findByRole("combobox", { name: STR5.speaker });
    fireEvent.change(spk, { target: { value: "BT-AirPods" } });
    await vi.waitFor(() => expect(b.invoked).toContainEqual(["audio.devices.set", { output: "BT-AirPods" }]));
    expect(b.invoked.some(([n]) => n === "dictation.stop")).toBe(false);
    expect(b.invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1);
  });

  it("says when a device dropped out, came back, or echo cancellation is off", async () => {
    const b = installBridge();
    render(<VoiceOverlay botId="a" />);
    await vi.waitFor(() => expect(b.invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    const sessionId = b.invoked.find(([n]) => n === "dictation.start")![1].sessionId;
    const fire = (e: Record<string, unknown>) => act(() => b.subs.get("dictation")!({ sessionId, ...e }));
    fire({ type: "echo-unavailable", reason: "-10875" });
    expect(screen.getByText(STR5.echoUnavailable)).toBeTruthy();
    fire({ type: "device-fallback", kind: "input", uid: "USB-MV7", name: "Shure MV7", fallback: "MacBook Pro Microphone" });
    expect(screen.getByText(STR5.deviceFellBack("input", "Shure MV7", "MacBook Pro Microphone"))).toBeTruthy();
    fire({ type: "device-restored", kind: "input", uid: "USB-MV7", name: "Shure MV7" });
    expect(screen.getByText(STR5.deviceRestored("Shure MV7"))).toBeTruthy();
    expect(screen.getByTestId("voice-state").textContent).toBe(STR5.listening); // the call carries on
  });
});
