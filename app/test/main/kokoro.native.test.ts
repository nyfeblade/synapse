import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FrameReader, findKokoro, kokoroCommand, probeKokoro } from "../../src/main/native/kokoro";

/**
 * Bug 107: the helper plays Kokoro's PCM (24 kHz mono float32, streamed in chunks) through the same
 * player node as Apple's voice — FIFO with it, gapless, cut by hush / barge-in, and falling back to
 * Apple's voice for a line Kokoro couldn't say. The file source (no speakers) counts what it would
 * play, so timings are checkable without sound. RUN_NATIVE=1 opts in (macOS + the built helper).
 */
const bin = process.env.DICTATION_BIN ?? path.resolve(__dirname, "../../dist/native/bots-dictation");
const script = path.resolve(__dirname, "../../native/kokoro/kokoro_server.py");
type Ev = Record<string, unknown>;
const events = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Ev);
const chunk = (secs: number, hz = 220) => Buffer.from(Float32Array.from({ length: Math.round(24000 * secs) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / 24000)).buffer).toString("base64");

/** Runs a call-mode helper over a silent file, feeds it `script` once it is ready, and returns its events. */
function session(feed: (w: (line: string) => void, ev: Ev[]) => void, until: (ev: Ev[]) => boolean): Promise<{ ev: Ev[]; err: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-pcm-"));
  const f = path.join(dir, "silence.aiff");
  execFileSync("say", ["-o", f, "[[slnc 6000]]"]);
  return new Promise((resolve, reject) => {
    const c = spawn(bin, ["--file", f, "--mode", "call", "--locale", "en-US"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", fed = false, stopped = false;
    const kill = setTimeout(() => { c.kill("SIGKILL"); reject(new Error(`timed out\n${err.slice(-2000)}`)); }, 45_000);
    c.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    c.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      const ev = events(out);
      if (!fed && ev.some((e) => e.type === "ready")) { fed = true; feed((l) => c.stdin.write(`${l}\n`), ev); }
      if (fed && !stopped && until(ev)) { stopped = true; c.stdin.write("stop\n"); }
    });
    c.on("close", () => { clearTimeout(kill); resolve({ ev: events(out), err }); });
  });
}
const ends = (ev: Ev[]) => ev.filter((e) => e.type === "speak-end");

describe.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("the helper plays Kokoro PCM (bug 107)", () => {
  it("the PCM decoding and the sentence pause pass the helper's own self-test", () => {
    const r = spawnSync(bin, ["--self-test-voice"], { encoding: "utf8", timeout: 30_000 });
    const ev = events(r.stdout).find((e) => e.type === "self-test");
    expect(ev, r.stderr).toMatchObject({ ok: true });
    expect(ev!.cases as number).toBeGreaterThanOrEqual(24);
  });

  // Bug 141 (calls 444eb49f / 015c5b35): the greeting was queued, voice processing's configuration change
  // restarted the engine ~0.1 s later, and the player's queue was flushed but logged as "spoke". The
  // helper's offline-engine self-test counts the frames that really render across such a restart.
  it("a configuration change right after the greeting is queued still plays all of it (and a line waits for a settled path)", () => {
    const r = spawnSync(bin, ["--self-test-playback"], { encoding: "utf8", timeout: 30_000 });
    const ev = events(r.stdout).find((e) => e.type === "self-test");
    expect(ev, r.stderr).toMatchObject({ ok: true, failures: [] });
    expect(ev!.cases as number).toBeGreaterThanOrEqual(8);
  });

  it("a PCM line streams in chunks, reports its first audio, and ends after all of it plus the pause", async () => {
    const { ev, err } = await session((w) => {
      w(`speak ${JSON.stringify({ id: "p1", text: "Hello there.", engine: "pcm", pauseMs: 120 })}`);
      for (let i = 0; i < 3; i++) w(`pcm ${JSON.stringify({ id: "p1", data: chunk(0.5) })}`);
      w(`pcm-end ${JSON.stringify({ id: "p1" })}`);
    }, (e) => ends(e).length >= 1);
    expect(ev).toContainEqual(expect.objectContaining({ type: "speak-start", id: "p1" }));
    expect(ev).toContainEqual(expect.objectContaining({ type: "speak-audio", id: "p1" }));
    const end = ends(ev)[0]!;
    expect(end).toMatchObject({ id: "p1", interrupted: false });
    expect(end.seconds as number).toBeCloseTo(1.62, 1);
    expect(err).toMatch(/speak p1: .*engine=pcm/);
  });

  it("PCM and Apple lines stay in order: a PCM line queued behind an Apple one waits its turn", async () => {
    const { ev } = await session((w) => {
      w(`speak ${JSON.stringify({ id: "a1", text: "First, the Apple voice." })}`);
      w(`speak ${JSON.stringify({ id: "p2", text: "Then Kokoro.", engine: "pcm", queue: true })}`);
      w(`pcm ${JSON.stringify({ id: "p2", data: chunk(0.4) })}`);
      w(`pcm-end ${JSON.stringify({ id: "p2" })}`);
    }, (e) => ends(e).length >= 2);
    expect(ends(ev).map((e) => e.id)).toEqual(["a1", "p2"]);
    expect(ends(ev).every((e) => e.interrupted === false)).toBe(true);
  });

  it("pcm-fail before any audio says the line with Apple's voice instead", async () => {
    const { ev, err } = await session((w) => {
      w(`speak ${JSON.stringify({ id: "p3", text: "Kokoro couldn't say this one.", engine: "pcm" })}`);
      w(`pcm-fail ${JSON.stringify({ id: "p3" })}`);
    }, (e) => ends(e).length >= 1);
    expect(ends(ev)[0]).toMatchObject({ id: "p3", interrupted: false });
    expect(ends(ev)[0]!.seconds as number).toBeGreaterThan(0.5);
    expect(err).toMatch(/p3.*falling back to the Apple voice/);
  });

  it("hush cuts a streaming PCM line; its late chunks are ignored", async () => {
    const { ev } = await session((w) => {
      w(`speak ${JSON.stringify({ id: "p4", text: "A long answer.", engine: "pcm" })}`);
      w(`pcm ${JSON.stringify({ id: "p4", data: chunk(0.5) })}`);
      w("hush");
      w(`pcm ${JSON.stringify({ id: "p4", data: chunk(0.5) })}`);
      w(`pcm-end ${JSON.stringify({ id: "p4" })}`);
      w(`speak ${JSON.stringify({ id: "a5", text: "Next." })}`);
    }, (e) => ends(e).some((x) => x.id === "a5"));
    expect(ends(ev).map((e) => [e.id, e.interrupted])).toEqual([["p4", true], ["a5", false]]);
  });
});

// The real engine, on this Mac, when the user's Kokoro is installed (never downloaded, never bundled).
const engine = process.platform === "darwin" ? findKokoro({ home: os.homedir(), userData: "/nonexistent", exists: fs.existsSync, listDir: (p) => fs.readdirSync(p) }) : null;
describe.skipIf(process.env.RUN_NATIVE !== "1" || !engine)("the Kokoro sidecar on this Mac (bug 107)", () => {
  it("passes the 3 s import probe", async () => {
    await expect(probeKokoro(engine!)).resolves.toMatchObject({ ok: true });
  }, 10_000);

  it("loads, warms, synthesizes faster than real time and streams frames the app decodes", async () => {
    const { cmd, args } = kokoroCommand(engine!, script);
    const frames = await new Promise<ReturnType<FrameReader["push"]>>((resolve, reject) => {
      const c = spawn(cmd, [...args, "--self-test", "The meeting is at three thirty tomorrow afternoon."], { stdio: ["pipe", "pipe", "pipe"] });
      const r = new FrameReader();
      const got: ReturnType<FrameReader["push"]> = [];
      let err = "";
      const kill = setTimeout(() => { c.kill("SIGKILL"); reject(new Error(err.slice(-2000))); }, 90_000);
      c.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      c.stdout.on("data", (d: Buffer) => got.push(...r.push(d)));
      c.on("close", () => { clearTimeout(kill); resolve(got); });
    });
    const types = frames.map((f) => f.header.type);
    expect(types[0]).toBe("ready");
    expect(types).toContain("warm");
    const audio = frames.filter((f) => f.header.type === "audio");
    expect(audio.length).toBeGreaterThan(1);
    for (const a of audio) expect(a.pcm.length).toBe((a.header.samples as number) * 4);
    const done = frames.find((f) => f.header.type === "done")!.header;
    expect(done.rtf as number).toBeLessThan(1);
    expect(done.audioMs as number).toBeGreaterThan(1500);
  }, 100_000);
});
