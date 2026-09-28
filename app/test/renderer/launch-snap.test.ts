// launch-animation: "a little synapse animation when you cold start the app … sparks and a magnetic snap".
// The physics of the launch snap, stepped headlessly: two Bot halves pulled together by a magnet,
// one hard click and a quieter re-seat, then the Bot wakes and the overlay fades away.
import { describe, expect, it } from "vitest";
import { createLaunchSim, LAUNCH_MS } from "../../src/renderer/launch/launch-snap";

function run(stepMs = 1000 / 60) {
  const contacts: { t: number; level: number }[] = [];
  const sim = createLaunchSim({ onContact: (level) => contacts.push({ t: sim.t, level }) });
  const frames: ReturnType<typeof sim.frame>[] = [];
  while (!sim.done) { sim.step(stepMs); frames.push(sim.frame()); }
  return { sim, contacts, frames };
}

describe("launch snap", () => {
  it("snaps once, hard, at about half a second, then re-seats with a quieter tick", () => {
    const { contacts } = run();
    expect(contacts).toHaveLength(2);
    expect(contacts[0]!.t).toBeGreaterThan(450);
    expect(contacts[0]!.t).toBeLessThan(620);
    expect(contacts[0]!.level).toBe(1);
    expect(contacts[1]!.level).toBeLessThan(0.5);
    expect(contacts[1]!.t - contacts[0]!.t).toBeLessThan(60);
  });

  it("is over within 1.1 s and ends fully transparent, with the Bot whole", () => {
    const { sim, frames } = run();
    expect(sim.t).toBeGreaterThanOrEqual(LAUNCH_MS);
    expect(sim.t).toBeLessThan(LAUNCH_MS + 40);
    const last = frames[frames.length - 1]!;
    expect(last.bgAlpha).toBe(0);
    expect(last.whole).toBe(true);
  });

  it("keeps the halves apart with eyes shut until the snap, and opens the eyes after it", () => {
    const { frames, contacts } = run();
    const before = frames.filter((f) => f.t < contacts[0]!.t - 20);
    expect(before.length).toBeGreaterThan(10);
    expect(before.every((f) => f.gap > 0 && !f.whole && f.eye < 0.2)).toBe(true);
    const later = frames.find((f) => f.t > contacts[0]!.t + 250)!;
    expect(later.eye).toBeGreaterThan(0.8);
  });

  it("is the same every time, whatever the frame rate", () => {
    expect(run().contacts).toEqual(run().contacts);
    const slow = run(1000 / 30).contacts, fast = run(1000 / 120).contacts;
    expect(Math.abs(slow[0]!.t - fast[0]!.t)).toBeLessThan(40);
  });
});

describe("launch snap sound timing", () => {
  it("knows its clicks before it starts, exactly where the physics puts them", async () => {
    const { snapClicks } = await import("../../src/renderer/launch/launch-snap");
    const { contacts } = run();
    expect(snapClicks().map((c) => ({ t: Math.round(c.t), level: c.level }))).toEqual(contacts.map((c) => ({ t: Math.round(c.t), level: c.level })));
  });

  it("schedules both clicks on the audio clock when the snap starts, not when the frame gets there", async () => {
    const { scheduleSnapClicks } = await import("../../src/renderer/launch/snap-sound");
    const started: number[] = [];
    const node = () => ({ connect: (n: unknown) => n, gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, Q: { value: 0 }, type: "", buffer: null, start: (at: number) => started.push(at), stop() {}, disconnect() {} });
    const ac = { currentTime: 10, outputLatency: 0, state: "running", sampleRate: 48000, destination: {}, createGain: node, createBufferSource: node, createBiquadFilter: node, createOscillator: node, createBuffer: () => ({ getChannelData: () => new Float32Array(960) }) };
    const cancel = scheduleSnapClicks(ac as never, 0, [{ t: 525, level: 1 }, { t: 537, level: 0.3 }]);
    // the hit lands exactly on contact (nothing before it: the chosen recipe has no swish), its own
    // settle click follows 5 ms later, and the physics' quieter re-seat adds nothing of its own
    expect(Math.min(...started)).toBeCloseTo(10.525, 4);
    expect(started.some((s) => Math.abs(s - 10.530) < 0.0005)).toBe(true);
    expect(started.some((s) => Math.abs(s - 10.537) < 0.0005)).toBe(false);
    expect(typeof cancel).toBe("function");
  });
});
