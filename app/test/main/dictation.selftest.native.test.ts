import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Bug 101: the helper's self-test mode feeds an audio FILE through the SAME recognition path the
 * microphone uses (buffers → 16 kHz mono → voice-activity detection → one recognition task per
 * utterance → end of turn on silence), so dictation and voice mode are tested without a mic.
 * `--simulate` reproduces the microphone's failure modes, including the one in the field log: the
 * audio engine stopping itself right after it starts ("iounit configuration changed").
 *
 * Needs macOS, Speech Recognition access for the process running the tests, and the built helper
 * (app/native/dictation/build.sh). RUN_NATIVE=1 opts in; DICTATION_BIN points at another build.
 */
const bin = process.env.DICTATION_BIN ?? path.resolve(__dirname, "../../dist/native/bots-dictation");
type Ev = { type: string; text?: string; code?: string; message?: string; reason?: string; id?: string; interrupted?: boolean; source?: string };

let dir = "";
function sayFile(name: string, text: string): string {
  const f = path.join(dir, `${name}.aiff`);
  execFileSync("say", ["-o", f, text]);
  return f;
}
/** 16-bit mono PCM WAV of pure silence. */
function silentWav(name: string, seconds: number): string {
  const rate = 16000;
  const data = Buffer.alloc(rate * seconds * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  const f = path.join(dir, `${name}.wav`);
  fs.writeFileSync(f, Buffer.concat([h, data]));
  return f;
}

function run(args: string[], o: { stdin?: (write: (l: string) => void, events: Ev[]) => void; closeStdin?: boolean; timeoutMs?: number } = {}): Promise<{ events: Ev[]; code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const events: Ev[] = [];
    let buf = "";
    let stderr = "";
    const kill = setTimeout(() => { c.kill("SIGKILL"); reject(new Error(`helper timed out; events=${JSON.stringify(events)}\n${stderr}`)); }, o.timeoutMs ?? 60_000);
    c.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { events.push(JSON.parse(line) as Ev); } catch { /* not an event */ }
        o.stdin?.((l) => c.stdin.write(`${l}\n`), events);
      }
    });
    c.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    if (o.closeStdin !== false) c.stdin.end();
    c.on("close", (code) => { clearTimeout(kill); resolve({ events, code, stderr }); });
  });
}
const types = (e: Ev[]) => e.map((x) => x.type);

describe.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("dictation helper self-test (bug 101)", () => {
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dict-selftest-")); });

  it("dictation: file audio runs the buffer path — ready, live audio, speech-start, partials, one final, end", async () => {
    const f = sayFile("calendar", "what is on my calendar today");
    const { events, code, stderr } = await run(["--file", f, "--mode", "dictation", "--locale", "en-US"]);
    expect(code, stderr).toBe(0);
    expect(events[0]).toMatchObject({ type: "ready", source: "file" });
    const t = types(events);
    expect(t).toContain("audio");
    expect(t.indexOf("speech-start")).toBeGreaterThan(-1);
    expect(t.indexOf("speech-start")).toBeLessThan(t.indexOf("partial"));
    const finals = events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text!.toLowerCase()).toContain("calendar");
    expect(t.at(-1)).toBe("end");
  }, 90_000);

  it("the engine stopping itself after start (the field log) is restarted, and the words still arrive", async () => {
    const f = sayFile("config", "what is on my calendar today");
    const { events, code, stderr } = await run(["--file", f, "--mode", "dictation", "--locale", "en-US", "--simulate", "config-change"]);
    expect(code, stderr).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "audio-restart", reason: "config-change" }));
    expect(events.find((e) => e.type === "final")?.text?.toLowerCase()).toContain("calendar");
  }, 90_000);

  it("a source that silently stops delivering is caught by the watchdog and restarted", async () => {
    const f = sayFile("stall", "what is on my calendar today");
    const { events, code } = await run(["--file", f, "--mode", "dictation", "--locale", "en-US", "--simulate", "stall"]);
    expect(code).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "audio-restart", reason: "stalled" }));
    expect(events.find((e) => e.type === "final")?.text?.toLowerCase()).toContain("calendar");
  }, 90_000);

  it("a microphone that never sends audio ends with a reason, never silently", async () => {
    const f = sayFile("dead", "hello");
    const { events, code } = await run(["--file", f, "--mode", "dictation", "--locale", "en-US", "--simulate", "dead"]);
    expect(code).toBe(1);
    const err = events.find((e) => e.type === "error");
    expect(err?.code).toBe("no-audio");
    expect(err?.message).toMatch(/microphone/i);
    expect(types(events).at(-1)).toBe("end");
  }, 90_000);

  it("dictation with nobody speaking ends with code no-speech", async () => {
    const f = silentWav("silence", 4);
    const { events, code } = await run(["--file", f, "--mode", "dictation", "--locale", "en-US", "--no-speech-ms", "2000"]);
    expect(code).toBe(0);
    expect(events.find((e) => e.type === "error")?.code).toBe("no-speech");
    expect(types(events)).not.toContain("final");
  }, 90_000);

  it("call mode keeps listening: two utterances separated by a pause give two finals in one session", async () => {
    const f = sayFile("two", "what time is it in Tokyo [[slnc 2600]] and what about London");
    const { events, code, stderr } = await run(["--file", f, "--mode", "call", "--locale", "en-US"]);
    expect(code, stderr).toBe(0);
    const finals = events.filter((e) => e.type === "final").map((e) => e.text!.toLowerCase());
    expect(finals).toHaveLength(2);
    expect(finals[0]).toContain("tokyo");
    expect(finals[1]).toContain("london");
    expect(events.filter((e) => e.type === "speech-start")).toHaveLength(2);
  }, 90_000);

  // Bug 142: the semantic end of turn — a finished question with a falling voice is flagged as a LIKELY end
  // well before the silence window closes, so the reply can start early; a trailing "and" never is.
  it("call mode flags a likely end before the final (and never on a trailing 'and')", async () => {
    const f = sayFile("likely", "what is on my calendar tomorrow? [[slnc 2600]] book the flight and [[slnc 2600]]");
    const { events, code, stderr } = await run(["--file", f, "--mode", "call", "--locale", "en-US", "--silence-ms", "700"]);
    expect(code, stderr).toBe(0);
    const t = types(events);
    const first = t.indexOf("likely-end");
    expect(first, stderr).toBeGreaterThan(-1);
    expect(first).toBeLessThan(t.indexOf("final"));
    const likely = events.filter((e) => e.type === "likely-end").map((e) => e.text!.toLowerCase());
    expect(likely).toHaveLength(1);
    expect(likely[0]).toContain("calendar");
    expect(stderr).toMatch(/likely end after \d+ ms/);
  }, 90_000);

  it("call mode speaks a reply on command and reports when it is done", async () => {
    const f = silentWav("quiet", 3);
    let sent = false;
    const { events, code } = await run(["--file", f, "--mode", "call", "--locale", "en-US"], {
      stdin: (write, evs) => {
        if (!sent && evs.some((e) => e.type === "ready")) { sent = true; write(JSON.stringify({ id: "s1", text: "You have two meetings today." }).replace(/^/, "speak ")); }
        if (evs.some((e) => e.type === "speak-end")) write("stop");
      },
      closeStdin: false,
    });
    expect(code).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "speak-start", id: "s1" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "speak-end", id: "s1", interrupted: false }));
  }, 90_000);
});
