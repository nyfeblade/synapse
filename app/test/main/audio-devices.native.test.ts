import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeviceList } from "../../src/main/native/audio-devices";

/**
 * Bug 105: the helper's CoreAudio device plumbing, headless. Choosing a device can't be heard in a
 * test, so this pins what can be checked without a person: the listing is real and parses, the
 * device arguments are understood, an unknown device falls back to the default (and says so), and
 * the pure selection logic passes its own self-test. None of it needs Speech or microphone access.
 */
const bin = process.env.DICTATION_BIN ?? path.resolve(__dirname, "../../dist/native/bots-dictation");
const run = (args: string[]) => spawnSync(bin, args, { timeout: 15_000, encoding: "utf8" });
const events = (out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("native audio devices (bug 105)", () => {
  it("--list-devices prints this Mac's devices as JSON the app parses", () => {
    const r = run(["--list-devices"]);
    expect(r.status).toBe(0);
    const d = parseDeviceList(r.stdout);
    expect(d.length).toBeGreaterThan(0);
    expect(d.filter((x) => x.defaultInput).length).toBeLessThanOrEqual(1);
    expect(d.filter((x) => x.defaultOutput).length).toBeLessThanOrEqual(1);
    for (const x of d) {
      expect(x.input || x.output).toBe(true);
      expect(x.uid).not.toMatch(/^(VPAUAggregateAudioDevice|CADefaultDeviceAggregate)/); // voice processing's private aggregates
    }
  });

  it("understands the device arguments", () => {
    const r = run(["--list-devices", "--input-device", "X", "--output-device", "Y"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("ignoring unknown argument");
  });

  it("an unknown output device falls back to the default and says so (dry run: nothing plays)", () => {
    const r = run(["--test-speaker", "--output-device", "no-such-device-uid", "--dry-run"]);
    expect(r.status).toBe(0);
    const ev = events(r.stdout);
    expect(ev).toContainEqual(expect.objectContaining({ type: "device-fallback", kind: "output", uid: "no-such-device-uid" }));
    const dev = ev.find((e) => e.type === "devices") as { output: { uid: string } } | undefined;
    expect(dev?.output.uid).not.toBe("no-such-device-uid");
  });

  it("a real device is selected as itself (dry run)", () => {
    const out = parseDeviceList(run(["--list-devices"]).stdout).find((x) => x.output);
    if (!out) return;
    const ev = events(run(["--test-speaker", "--output-device", out.uid, "--dry-run"]).stdout);
    expect(ev.some((e) => e.type === "device-fallback")).toBe(false);
    expect((ev.find((e) => e.type === "devices") as { output: { uid: string } }).output.uid).toBe(out.uid);
  });

  it("--self-test-devices passes the selection / fallback / restore logic", () => {
    const r = run(["--self-test-devices"]);
    expect(r.status, r.stderr).toBe(0);
    const res = events(r.stdout).find((e) => e.type === "self-test") as { ok: boolean; cases: number; failures: string[] };
    expect(res.failures).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.cases).toBeGreaterThanOrEqual(8);
  });
});
