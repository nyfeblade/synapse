// Review round 1: the voice log records device events without device names (they carry the
// user's name: "Jane's AirPods") or raw ids (a Bluetooth id holds the hardware address).
import { describe, expect, it } from "vitest";
import { deviceLogLine } from "../../src/main/native/dictation";

describe("deviceLogLine", () => {
  it("names no device and shows no raw id", () => {
    const uid = "BT-HEADSET-UID-0001:output";
    for (const e of [
      { type: "devices", input: { uid, name: "Jane's AirPods Pro" }, output: { uid: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers" }, echoCancellation: true },
      { type: "device-fallback", kind: "output", uid, name: "Jane's AirPods Pro", fallback: "MacBook Pro Speakers" },
      { type: "device-restored", kind: "input", uid, name: "Jane's AirPods Pro" },
      { type: "echo-unavailable", reason: "no voice processing" },
    ] as const) {
      const line = deviceLogLine(e as never);
      expect(line).toMatch(new RegExp(`^${e.type}`));
      expect(line).not.toMatch(/Jane|AirPods|MacBook|Speakers|BT-HEADSET/);
    }
  });
  it("keeps a stable short id so the same device can be followed through a session", () => {
    const a = deviceLogLine({ type: "device-restored", kind: "input", uid: "X1", name: "n" } as never);
    const b = deviceLogLine({ type: "device-restored", kind: "input", uid: "X1", name: "other" } as never);
    expect(a).toBe(b);
  });
});
